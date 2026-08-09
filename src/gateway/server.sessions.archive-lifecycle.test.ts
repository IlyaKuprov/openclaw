// Archive lifecycle tests protect fence-before-cancel, terminal drains, and sentinels.
import { afterEach, expect, test, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { loadSessionEntry, upsertSessionEntry } from "../config/sessions/session-accessor.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { registerChatAbortController, removeChatAbortControllerEntry } from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  createDeferred,
  directSessionReq,
  expectNoSessionQueueCleanup,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const {
  createConfiguredGlobalAgentSessionStore,
  createSessionStoreDir,
  resetConfiguredGlobalAgentSessionStore,
} = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function activeRunContext(params: {
  runId: string;
  sessionId: string;
  sessionKey: string;
  persistence: ReturnType<typeof createDeferred<void>>;
  ownerConnId?: string;
}) {
  const chatAbortControllers = new Map();
  const registration = registerChatAbortController({
    chatAbortControllers,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    timeoutMs: 60_000,
    ownerConnId: params.ownerConnId,
  });
  if (!registration.entry) {
    throw new Error("expected active run registration");
  }
  const entry = registration.entry;
  const unsubscribe = onAgentEvent((event) => {
    if (
      event.runId !== params.runId ||
      event.stream !== "lifecycle" ||
      event.data.phase !== "end"
    ) {
      return;
    }
    entry.projectSessionTerminalPending = false;
    entry.projectSessionTerminalPersistence = params.persistence.promise;
    void params.persistence.promise.then(
      () => {
        entry.projectSessionTerminalPersistence = undefined;
        entry.projectSessionTerminalPersisted = true;
        removeChatAbortControllerEntry(chatAbortControllers, params.runId, entry);
      },
      (error: unknown) => {
        entry.projectSessionTerminalPersistenceError = error;
        removeChatAbortControllerEntry(chatAbortControllers, params.runId, entry);
      },
    );
  });
  const chatRunState = createChatRunState();
  return {
    context: {
      agentRunSeq: new Map([[params.runId, 0]]),
      broadcast: vi.fn(),
      cancelRunBoundApprovals: vi.fn(),
      chatAbortControllers,
      chatRunState,
      logGateway: { warn: vi.fn() },
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(() => ({
        sessionKey: params.sessionKey,
        clientRunId: params.runId,
      })),
    },
    controller: registration.controller,
    unsubscribe,
  };
}

test("sessions.patch cancels active work and commits only after admission and terminal persistence drain", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-active";
  const sessionId = "session-archive-active";
  const runId = "run-archive-active";
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(sessionId) },
  });
  let interrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, sessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });
  const persistence = createDeferred<void>();
  const active = activeRunContext({
    runId,
    sessionId,
    sessionKey,
    persistence,
    ownerConnId: "different-connection",
  });
  try {
    const archive = directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true },
      {
        context: active.context,
        client: { connId: "archive-writer", connect: { scopes: ["operator.write"] } } as never,
      },
    );
    await vi.waitFor(() => {
      expect(interrupted).toBe(true);
      expect(active.controller.signal.aborted).toBe(true);
    });
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();

    let replacementAdmitted = false;
    const replacement = beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {
        replacementAdmitted = true;
        if (loadSessionEntry({ storePath, sessionKey })?.archivedAt !== undefined) {
          throw new Error("archived");
        }
      },
    }).then(
      (lease) => lease,
      (error: unknown) => error,
    );
    await Promise.resolve();
    expect(replacementAdmitted).toBe(false);

    admission.release();
    await Promise.resolve();
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    persistence.resolve();

    const archived = await archive;
    expect(archived.ok).toBe(true);
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
    expect(await replacement).toBeInstanceOf(Error);
  } finally {
    admission.release();
    active.unsubscribe();
  }
});

test("sessions.patch returns retryable UNAVAILABLE when runtime drain does not settle", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-stuck";
  const sessionId = "session-archive-stuck";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  embeddedRunMock.activeIds.add(sessionId);
  embeddedRunMock.waitResults.set(sessionId, false);

  const archived = await directSessionReq("sessions.patch", { key: sessionKey, archived: true });

  expect(archived.ok).toBe(false);
  expect(archived.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
});

test("sessions.patch rechecks authoritative worker work before projection and releases the drain", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-worker-recheck";
  const sessionId = "session-archive-worker-recheck";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const release = vi.fn();

  const archived = await directSessionReq(
    "sessions.patch",
    { key: sessionKey, archived: true },
    {
      context: {
        workerEnvironmentService: {
          beginInferenceSessionDrain: vi.fn(() => ({
            drained: Promise.resolve(),
            hasWork: () => true,
            release,
          })),
          cancelInferenceForSession: vi.fn(() => []),
          hasInferenceForSession: vi.fn(() => false),
          resolveInferenceSessionForRunId: vi.fn(),
        },
      },
    },
  );

  expect(archived.ok).toBe(false);
  expect(archived.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
  expect(release).toHaveBeenCalledOnce();
});

test("sessions.patch retains the archive drain through the ordered audit append", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-drain-audit";
  const sessionId = "session-archive-drain-audit";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const release = vi.fn();
  const append = vi.spyOn(SessionManager, "appendMessageToTranscript");
  try {
    const archived = await directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true },
      {
        client: {
          authenticatedUserId: "archive-reviewer@example.com",
          authenticatedUserProfile: {
            profileId: "archive-reviewer",
            displayName: "Archive Reviewer",
            hasAvatar: false,
            updatedAt: 1,
          },
          connect: { scopes: ["operator.write"] },
        } as never,
        context: {
          workerEnvironmentService: {
            beginInferenceSessionDrain: vi.fn(() => ({
              drained: Promise.resolve(),
              hasWork: () => false,
              release,
            })),
            cancelInferenceForSession: vi.fn(() => []),
            hasInferenceForSession: vi.fn(() => false),
            resolveInferenceSessionForRunId: vi.fn(),
          },
        },
      },
    );

    expect(archived.ok).toBe(true);
    expect(append).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(append.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]!);
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
  } finally {
    append.mockRestore();
  }
});

test("sessions.patch returns UNAVAILABLE when terminal persistence fails", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-persistence-failure";
  const sessionId = "session-archive-persistence-failure";
  const runId = "run-archive-persistence-failure";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const persistence = createDeferred<void>();
  const active = activeRunContext({ runId, sessionId, sessionKey, persistence });
  try {
    const archive = directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true },
      {
        context: active.context,
      },
    );
    await vi.waitFor(() => expect(active.controller.signal.aborted).toBe(true));
    persistence.reject(new Error("disk full"));

    const archived = await archive;
    expect(archived.ok).toBe(false);
    expect(archived.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
  } finally {
    active.unsubscribe();
  }
});

test("sessions.patch rejects main and global archives before cancellation side effects", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("session-main") } });
  embeddedRunMock.activeIds.add("session-main");

  const main = await directSessionReq("sessions.patch", { key: "main", archived: true });
  expect(main.ok).toBe(false);
  expect(main.error?.message).toContain("main session");
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expectNoSessionQueueCleanup();
  expect(loadSessionEntry({ storePath, sessionKey: "main" })?.archivedAt).toBeUndefined();

  const globalFixture = await createConfiguredGlobalAgentSessionStore();
  try {
    embeddedRunMock.activeIds.add("sess-main-global");
    const global = await directSessionReq("sessions.patch", {
      key: "global",
      agentId: "main",
      archived: true,
    });
    expect(global.ok).toBe(false);
    expect(global.error?.message).toContain("main session");
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expectNoSessionQueueCleanup();
  } finally {
    await resetConfiguredGlobalAgentSessionStore(globalFixture);
  }
});

test("sessions.patch rejects unknown without materializing a session entry", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: {} });

  const archived = await directSessionReq("sessions.patch", { key: "unknown", archived: true });

  expect(archived.ok).toBe(false);
  expect(archived.error?.message).toContain("unknown session sentinel");
  expect(loadSessionEntry({ storePath, sessionKey: "unknown" })).toBeUndefined();
  expectNoSessionQueueCleanup();
});

test("sessions.patchMany independently archives active and idle sessions in target order", async () => {
  const { storePath } = await createSessionStoreDir();
  const activeKey = "agent:main:archive-batch-active";
  const idleKey = "agent:main:archive-batch-idle";
  const activeSessionId = "session-batch-active";
  await writeSessionStore({
    entries: {
      [activeKey]: sessionStoreEntry(activeSessionId),
      [idleKey]: sessionStoreEntry("session-batch-idle"),
    },
  });
  embeddedRunMock.activeIds.add(activeSessionId);
  embeddedRunMock.waitResults.set(activeSessionId, true);

  const result = await directSessionReq<{ outcomes: Array<{ key: string; ok: boolean }> }>(
    "sessions.patchMany",
    {
      targets: [{ key: activeKey }, { key: idleKey }],
      patch: { archived: true },
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload?.outcomes).toEqual([
    { key: activeKey, ok: true },
    { key: idleKey, ok: true },
  ]);
  expect(loadSessionEntry({ storePath, sessionKey: activeKey })?.archivedAt).toEqual(
    expect.any(Number),
  );
  expect(loadSessionEntry({ storePath, sessionKey: idleKey })?.archivedAt).toEqual(
    expect.any(Number),
  );
});

test("sessions.patchMany prepares independent archive drains concurrently and releases in target order", async () => {
  const { storePath } = await createSessionStoreDir();
  const firstKey = "agent:main:archive-batch-concurrent-first";
  const secondKey = "agent:main:archive-batch-concurrent-second";
  const firstSessionId = "session-batch-concurrent-first";
  const secondSessionId = "session-batch-concurrent-second";
  await writeSessionStore({
    entries: {
      [firstKey]: sessionStoreEntry(firstSessionId),
      [secondKey]: sessionStoreEntry(secondSessionId),
    },
  });
  const firstDrained = createDeferred<void>();
  const firstRelease = vi.fn();
  const secondRelease = vi.fn();
  const beginInferenceSessionDrain = vi.fn((sessionId: string) => ({
    drained: sessionId === firstSessionId ? firstDrained.promise : Promise.resolve(),
    hasWork: () => false,
    release: sessionId === firstSessionId ? firstRelease : secondRelease,
  }));

  const archive = directSessionReq<{ outcomes: Array<{ key: string; ok: boolean }> }>(
    "sessions.patchMany",
    {
      targets: [{ key: firstKey }, { key: secondKey }],
      patch: { archived: true },
    },
    {
      context: {
        workerEnvironmentService: {
          beginInferenceSessionDrain,
          cancelInferenceForSession: vi.fn(() => []),
          hasInferenceForSession: vi.fn(() => false),
          resolveInferenceSessionForRunId: vi.fn(),
        },
      },
    },
  );

  await vi.waitFor(() => expect(beginInferenceSessionDrain).toHaveBeenCalledTimes(2));
  expect(beginInferenceSessionDrain.mock.calls.map(([sessionId]) => sessionId)).toEqual([
    firstSessionId,
    secondSessionId,
  ]);
  expect(firstRelease).not.toHaveBeenCalled();
  expect(secondRelease).not.toHaveBeenCalled();
  firstDrained.resolve();

  const result = await archive;
  expect(result.payload?.outcomes).toEqual([
    { key: firstKey, ok: true },
    { key: secondKey, ok: true },
  ]);
  expect(firstRelease).toHaveBeenCalledOnce();
  expect(secondRelease).toHaveBeenCalledOnce();
  expect(firstRelease.mock.invocationCallOrder[0]).toBeLessThan(
    secondRelease.mock.invocationCallOrder[0]!,
  );
  expect(loadSessionEntry({ storePath, sessionKey: firstKey })?.archivedAt).toEqual(
    expect.any(Number),
  );
  expect(loadSessionEntry({ storePath, sessionKey: secondKey })?.archivedAt).toEqual(
    expect.any(Number),
  );
});

test("sessions.patchMany isolates a failed archive drain and continues later targets", async () => {
  const { storePath } = await createSessionStoreDir();
  const stuckKey = "agent:main:archive-batch-stuck";
  const idleKey = "agent:main:archive-batch-after-stuck";
  const stuckSessionId = "session-batch-stuck";
  await writeSessionStore({
    entries: {
      [stuckKey]: sessionStoreEntry(stuckSessionId),
      [idleKey]: sessionStoreEntry("session-batch-after-stuck"),
    },
  });
  embeddedRunMock.activeIds.add(stuckSessionId);
  embeddedRunMock.waitResults.set(stuckSessionId, false);

  const result = await directSessionReq<{
    outcomes: Array<{ error?: { code: string; retryable?: boolean }; key: string; ok: boolean }>;
  }>("sessions.patchMany", {
    targets: [{ key: stuckKey }, { key: idleKey }],
    patch: { archived: true },
  });

  expect(result.ok).toBe(true);
  expect(result.payload?.outcomes).toEqual([
    {
      key: stuckKey,
      ok: false,
      error: expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    },
    { key: idleKey, ok: true },
  ]);
  expect(loadSessionEntry({ storePath, sessionKey: stuckKey })?.archivedAt).toBeUndefined();
  expect(loadSessionEntry({ storePath, sessionKey: idleKey })?.archivedAt).toEqual(
    expect.any(Number),
  );
});

test("sessions.patch rejects a generation replaced after the exact preparation read", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:archive-generation-race";
  const sessionId = "session-archive-generation-race";
  const runId = "run-archive-generation-race";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
  const persistence = createDeferred<void>();
  const active = activeRunContext({ runId, sessionId, sessionKey, persistence });
  try {
    const archive = directSessionReq(
      "sessions.patch",
      { key: sessionKey, archived: true },
      {
        context: active.context,
      },
    );
    await vi.waitFor(() => expect(active.controller.signal.aborted).toBe(true));
    await upsertSessionEntry(
      { storePath, sessionKey },
      { sessionId: "session-archive-generation-replacement", updatedAt: 2 },
    );
    persistence.resolve();

    const archived = await archive;
    expect(archived.ok).toBe(false);
    expect(archived.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      sessionId: "session-archive-generation-replacement",
    });
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
  } finally {
    active.unsubscribe();
  }
});
