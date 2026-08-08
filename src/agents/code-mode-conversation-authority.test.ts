import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../shared/deferred.js";
import {
  applyCodeModeCatalog,
  createCodeModeTools,
  runCodeModeScriptHeadless,
} from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginTool,
  resetCodeModeTestState,
  resultDetails,
  runUntilCompleted,
  testing,
} from "./code-mode.test-support.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  type ToolSearchToolContext,
} from "./tool-search.js";
import type { AnyAgentTool } from "./tools/common.js";
import {
  createConversationsListTool,
  createConversationsSendTool,
  createConversationsTurnTool,
} from "./tools/conversation-tools.js";

type ConversationGatewayCall = (request: { method: string; params: unknown }) => Promise<unknown>;

let nextAuthorityRun = 0;

function createConversationHarness(
  callGateway: ConversationGatewayCall,
  extraTools: AnyAgentTool[] = [],
) {
  const list = createConversationsListTool(
    { agentId: "main", senderIsOwner: true },
    { callGateway: callGateway as never },
  );
  const send = createConversationsSendTool(
    { agentId: "main", senderIsOwner: true },
    { callGateway: callGateway as never },
  );
  const turn = createConversationsTurnTool(
    { agentId: "main", senderIsOwner: true },
    { callGateway: callGateway as never },
  );
  const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
  applyCodeModeCatalog({
    tools: [...codeModeTools, list, send, turn, ...extraTools],
    config,
    sessionId: "session-code-mode",
    sessionKey: "agent:main:main",
    runId: `run-conversation-authority-${nextAuthorityRun++}`,
    catalogRef,
  });
  return codeModeTools;
}

function createHeadlessHarness(tools: AnyAgentTool[]): ToolSearchToolContext {
  const config = {
    tools: {
      codeMode: { enabled: false, timeoutMs: 60_000 },
    },
  } as never;
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  return {
    config,
    runtimeConfig: config,
    agentId: "main",
    catalogRef,
  };
}

describe("Code Mode private authority integration", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("enforces single-use conversation authority before Gateway mutation", async () => {
    const selectedRef = "conv_0123456789abcdef0123456789abcdef";
    const decoyRef = "conv_abcdef0123456789abcdef0123456789";
    const selected = {
      conversationRef: selectedRef,
      channel: "discord",
      accountId: "default",
      kind: "direct" as const,
      target: "build-bot",
      firstSeenAt: 1,
      lastSeenAt: 2,
    };
    const runCase = async (params: {
      code: string;
      listResponses: unknown[];
      failFirstMutation?: boolean;
    }) => {
      let listIndex = 0;
      let mutationCount = 0;
      const callGateway = vi.fn(async (request: { method: string; params: unknown }) => {
        if (request.method === "conversations.list") {
          const response = params.listResponses[listIndex++];
          if (response instanceof Error) {
            throw response;
          }
          return response;
        }
        mutationCount += 1;
        if (params.failFirstMutation && mutationCount === 1) {
          throw new Error("gateway unavailable");
        }
        const input = request.params as { conversationRef: string };
        if (request.method === "conversations.send") {
          return {
            status: "sent",
            conversationRef: input.conversationRef,
            channel: "discord",
            messageId: `message-${mutationCount}`,
          };
        }
        if (request.method === "conversations.turn") {
          return {
            status: "replied",
            conversationRef: input.conversationRef,
            channel: "discord",
            messageId: `message-${mutationCount}`,
            correlationPersisted: true,
            reply: {
              conversationRef: input.conversationRef,
              messageId: `reply-${mutationCount}`,
              replyToId: `message-${mutationCount}`,
              text: "acknowledged",
              timestamp: 3,
            },
          };
        }
        throw new Error(`unexpected gateway method: ${request.method}`);
      });
      const codeModeTools = createConversationHarness(callGateway);
      const details = await runUntilCompleted({
        execTool: expectDefined(codeModeTools[0], "Code Mode exec test invariant"),
        waitTool: expectDefined(codeModeTools[1], "Code Mode wait test invariant"),
        code: params.code,
      });
      return { callGateway, details };
    };

    const direct = await runCase({
      listResponses: [],
      code: `
        return await tools.conversations_send({
          conversationRef: ${JSON.stringify(selectedRef)},
          message: "direct",
        });
      `,
    });
    expect(direct.details).toMatchObject({ status: "completed", value: { status: "sent" } });
    expect(direct.callGateway).toHaveBeenCalledTimes(1);

    const send = await runCase({
      listResponses: [{ conversations: [selected], complete: true }],
      code: `
        await tools.call("openclaw:core:conversations_list", {});
        return await tools.conversations_send({
          conversationRef: ${JSON.stringify(selectedRef)},
          message: "done",
        });
      `,
    });
    expect(send.details).toMatchObject({ status: "completed", value: { status: "sent" } });
    expect(send.callGateway).toHaveBeenCalledTimes(2);

    const turn = await runCase({
      listResponses: [{ conversations: [selected], complete: true }],
      code: `
        const listed = await tools.conversations_list({});
        return await tools.conversations_turn({
          conversationRef: listed.conversations[0].conversationRef,
          message: "status?",
        });
      `,
    });
    expect(turn.details).toMatchObject({ status: "completed", value: { status: "replied" } });
    expect(turn.callGateway).toHaveBeenCalledTimes(2);

    for (const listResponse of [
      { conversations: [selected], complete: false },
      { conversations: [], complete: true },
      { conversations: [selected, { ...selected, conversationRef: decoyRef }], complete: true },
    ]) {
      const blocked = await runCase({
        listResponses: [listResponse],
        code: `
          await tools.conversations_list({});
          return await tools.conversations_send({
            conversationRef: ${JSON.stringify(selectedRef)},
            message: "blocked",
          });
        `,
      });
      expect(blocked.details).toMatchObject({ status: "failed" });
      expect(blocked.callGateway).toHaveBeenCalledTimes(1);
    }

    const decoy = await runCase({
      listResponses: [{ conversations: [selected], complete: true }],
      code: `
        await tools.conversations_list({});
        return await tools.conversations_send({
          conversationRef: ${JSON.stringify(decoyRef)},
          message: "wrong target",
        });
      `,
    });
    expect(decoy.details).toMatchObject({ status: "failed" });
    expect(decoy.callGateway).toHaveBeenCalledTimes(1);

    const reuse = await runCase({
      listResponses: [{ conversations: [selected], complete: true }],
      code: `
        await tools.conversations_list({});
        await tools.conversations_send({
          conversationRef: ${JSON.stringify(selectedRef)},
          message: "first",
        });
        return await tools.conversations_turn({
          conversationRef: ${JSON.stringify(selectedRef)},
          message: "second",
        });
      `,
    });
    expect(reuse.details).toMatchObject({ status: "failed" });
    expect(reuse.callGateway).toHaveBeenCalledTimes(2);

    const consumedOnFailure = await runCase({
      listResponses: [{ conversations: [selected], complete: true }],
      failFirstMutation: true,
      code: `
        await tools.conversations_list({});
        try {
          await tools.conversations_send({
            conversationRef: ${JSON.stringify(selectedRef)},
            message: "first",
          });
        } catch {}
        return await tools.conversations_send({
          conversationRef: ${JSON.stringify(selectedRef)},
          message: "retry",
        });
      `,
    });
    expect(consumedOnFailure.details).toMatchObject({ status: "failed" });
    expect(consumedOnFailure.callGateway).toHaveBeenCalledTimes(2);

    for (const clearCode of [
      `
        await tools.conversations_list({});
        try { await tools.conversations_list({ limit: "invalid" }); } catch {}
      `,
      `
        await tools.conversations_list({});
        try { await tools.conversations_list({}); } catch {}
      `,
    ]) {
      const cleared = await runCase({
        listResponses: [{ conversations: [selected], complete: true }, new Error("list failed")],
        code: `
          ${clearCode}
          return await tools.conversations_send({
            conversationRef: ${JSON.stringify(selectedRef)},
            message: "stale",
          });
        `,
      });
      expect(cleared.details).toMatchObject({ status: "failed" });
      expect(
        cleared.callGateway.mock.calls.filter(
          ([request]) => request.method !== "conversations.list",
        ),
      ).toHaveLength(0);
    }
  });

  it.each(["list-first", "mutation-first"] as const)(
    "rejects same-frontier list and mutation when %s settles first",
    async (order) => {
      const selectedRef = "conv_0123456789abcdef0123456789abcdef";
      const selected = {
        conversationRef: selectedRef,
        channel: "discord",
        accountId: "default",
        kind: "direct" as const,
        target: "build-bot",
        firstSeenAt: 1,
        lastSeenAt: 2,
      };
      const listStarted = createDeferred();
      const releaseList = createDeferred<unknown>();
      const callGateway = vi.fn(async (request: { method: string; params: unknown }) => {
        if (request.method !== "conversations.list") {
          throw new Error("same-frontier mutation reached Gateway");
        }
        listStarted.resolve();
        return order === "list-first"
          ? { conversations: [selected], complete: true }
          : await releaseList.promise;
      });
      const codeModeTools = createConversationHarness(callGateway);
      const completion = runUntilCompleted({
        execTool: expectDefined(codeModeTools[0], "Code Mode exec test invariant"),
        waitTool: expectDefined(codeModeTools[1], "Code Mode wait test invariant"),
        code: `
          const settle = (promise) => promise.then(
            () => "fulfilled",
            (error) => String(error).includes(
              "requires one complete, unique conversations_list result",
            ) ? "authority-rejected" : "other-error",
          );
          return await Promise.all([
            settle(tools.conversations_list({})),
            settle(tools.conversations_send({
              conversationRef: ${JSON.stringify(selectedRef)},
              message: "must not send",
            })),
          ]);
        `,
      });
      await listStarted.promise;
      if (order === "mutation-first") {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        releaseList.resolve({ conversations: [selected], complete: true });
      }
      const details = await completion;

      expect(details).toMatchObject({
        status: "completed",
        value: ["fulfilled", "authority-rejected"],
      });
      expect(callGateway).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["first-list-first", [0, 1]],
    ["second-list-first", [1, 0]],
  ] as const)("rejects competing lists in either completion order: %s", async (_label, order) => {
    const firstRef = "conv_0123456789abcdef0123456789abcdef";
    const secondRef = "conv_abcdef0123456789abcdef0123456789";
    const conversations = [firstRef, secondRef].map((conversationRef, index) => ({
      conversationRef,
      channel: "discord",
      accountId: "default",
      kind: "direct" as const,
      target: `build-bot-${index}`,
      firstSeenAt: 1,
      lastSeenAt: 2,
    }));
    const releases = [createDeferred<unknown>(), createDeferred<unknown>()];
    const bothStarted = createDeferred();
    let listIndex = 0;
    const callGateway = vi.fn(async (request: { method: string; params: unknown }) => {
      if (request.method !== "conversations.list") {
        throw new Error("competing-list mutation reached Gateway");
      }
      const index = listIndex++;
      if (listIndex === 2) {
        bothStarted.resolve();
      }
      return await expectDefined(releases[index], "list release test invariant").promise;
    });
    const codeModeTools = createConversationHarness(callGateway);
    const completion = runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "Code Mode exec test invariant"),
      waitTool: expectDefined(codeModeTools[1], "Code Mode wait test invariant"),
      code: `
        const [first] = await Promise.all([
          tools.conversations_list({ query: "build-bot-0" }),
          tools.conversations_list({ query: "build-bot-1" }),
        ]);
        try {
          await tools.conversations_send({
            conversationRef: first.conversations[0].conversationRef,
            message: "must not send",
          });
          return "sent";
        } catch (error) {
          return String(error).includes(
            "requires one complete, unique conversations_list result",
          ) ? "authority-rejected" : "other-error";
        }
      `,
    });
    await bothStarted.promise;
    for (const index of order) {
      expectDefined(releases[index], "list release test invariant").resolve({
        conversations: [conversations[index]],
        complete: true,
      });
    }
    const details = await completion;

    expect(details).toMatchObject({ status: "completed", value: "authority-rejected" });
    expect(callGateway).toHaveBeenCalledTimes(2);
  });

  it("rejects list authority overlapped by another bridge and clears ambiguous list intent", async () => {
    const selectedRef = "conv_0123456789abcdef0123456789abcdef";
    const selected = {
      conversationRef: selectedRef,
      channel: "discord",
      accountId: "default",
      kind: "direct" as const,
      target: "build-bot",
      firstSeenAt: 1,
      lastSeenAt: 2,
    };
    let listCalls = 0;
    const callGateway = vi.fn(async (request: { method: string; params: unknown }) => {
      if (request.method === "conversations.list") {
        listCalls += 1;
        return { conversations: [selected], complete: true };
      }
      if (request.method === "conversations.send") {
        return {
          status: "sent",
          conversationRef: selectedRef,
          channel: "discord",
          messageId: "message-1",
        };
      }
      throw new Error(`unexpected gateway method: ${request.method}`);
    });
    const duplicateList = pluginTool("conversations_list", "Ambiguous list decoy");
    const noop = pluginTool("fake_authority_noop", "Authority overlap helper");
    const codeModeTools = createConversationHarness(callGateway, [duplicateList, noop]);
    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "Code Mode exec test invariant"),
      waitTool: expectDefined(codeModeTools[1], "Code Mode wait test invariant"),
      code: `
        const rejectSend = async () => {
          try {
            await tools.conversations_send({
              conversationRef: ${JSON.stringify(selectedRef)},
              message: "must not send",
            });
            return false;
          } catch (error) {
            return String(error).includes(
              "requires one complete, unique conversations_list result",
            );
          }
        };
        await Promise.all([
          tools.callValue("openclaw:core:conversations_list", {}),
          tools.fake_authority_noop({}),
        ]);
        const overlapRejected = await rejectSend();
        await tools.callValue("openclaw:core:conversations_list", {});
        try {
          await tools.callValue("conversations_list", {});
        } catch {}
        const ambiguousRejected = await rejectSend();
        return { overlapRejected, ambiguousRejected };
      `,
    });

    expect(details).toMatchObject({
      status: "completed",
      value: { overlapRejected: true, ambiguousRejected: true },
    });
    expect(listCalls).toBe(2);
    expect(callGateway).toHaveBeenCalledTimes(2);
  });

  it("enforces complete unique conversation authority in headless runs", async () => {
    const conversation = {
      conversationRef: "conv_0123456789abcdef0123456789abcdef",
      channel: "reef",
      accountId: "default",
      kind: "direct" as const,
      target: "reef:peer",
      firstSeenAt: 1,
      lastSeenAt: 2,
    };
    const listResults = [
      { conversations: [conversation], complete: true },
      { conversations: [conversation], complete: false },
      {
        conversations: [
          conversation,
          {
            ...conversation,
            conversationRef: "conv_abcdef0123456789abcdef0123456789",
          },
        ],
        complete: true,
      },
    ];
    let listIndex = 0;
    const callGateway = vi.fn(async (request: { method: string; params: unknown }) => {
      if (request.method === "conversations.list") {
        return listResults[listIndex++];
      }
      const params = request.params as { conversationRef: string };
      return {
        status: "sent",
        conversationRef: params.conversationRef,
        channel: "reef",
        messageId: "message-1",
      };
    });
    const list = createConversationsListTool(
      { agentId: "main", senderIsOwner: true },
      { callGateway: callGateway as never },
    );
    const send = createConversationsSendTool(
      { agentId: "main", senderIsOwner: true },
      { callGateway: callGateway as never },
    );
    const result = await runCodeModeScriptHeadless({
      ctx: createHeadlessHarness([list, send]),
      code: `
        await tools.callValue("openclaw:core:conversations_list", {});
        const sent = await tools.callValue("openclaw:core:conversations_send", {
          conversationRef: ${JSON.stringify(conversation.conversationRef)},
          message: "done",
        });
        await tools.callValue("openclaw:core:conversations_list", {});
        await tools.callValue("openclaw:core:conversations_list", {});
        let blocked = false;
        try {
          await tools.callValue("openclaw:core:conversations_send", {
            conversationRef: ${JSON.stringify(conversation.conversationRef)},
            message: "blocked",
          });
        } catch (error) {
          blocked = String(error).includes(
            "requires one complete, unique conversations_list result",
          );
        }
        return { sent, blocked };
      `,
      wallClockMs: 60_000,
    });

    expect(result).toMatchObject({
      status: "completed",
      value: {
        sent: { status: "sent" },
        blocked: true,
      },
    });
    expect(callGateway).toHaveBeenCalledTimes(4);
  });

  it("preserves one private authority object across repeated park and resume", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode-authority-identity",
      catalogRef,
    });

    const execTool = expectDefined(codeModeTools[0], "Code Mode exec test invariant");
    const waitTool = expectDefined(codeModeTools[1], "Code Mode wait test invariant");
    const first = resultDetails(
      await execTool.execute("code-call-authority-identity", {
        code: `
          await yield_control("first");
          await yield_control("second");
          return "done";
        `,
      }),
    );
    const firstRunId = first.runId as string;
    const privateAuthority = testing.activeRuns.get(firstRunId)?.privateAuthority;
    expect(privateAuthority).toBeDefined();
    expect(JSON.stringify(first)).not.toMatch(
      /bridgeRequestId|settlementCapability|privateAuthority/u,
    );

    const second = resultDetails(
      await waitTool.execute("code-wait-authority-identity-1", { runId: firstRunId }),
    );
    expect(second.status).toBe("waiting");
    expect(testing.activeRuns.get(second.runId as string)?.privateAuthority).toBe(privateAuthority);
    expect(JSON.stringify(second)).not.toMatch(
      /bridgeRequestId|settlementCapability|privateAuthority/u,
    );

    const completed = resultDetails(
      await waitTool.execute("code-wait-authority-identity-2", { runId: second.runId }),
    );
    expect(completed).toMatchObject({ status: "completed", value: "done" });
    expect(testing.activeRuns.has(second.runId as string)).toBe(false);
  });

  it("delivers isolated list authority after park and wait before sending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const selected = {
      conversationRef: "conv_0123456789abcdef0123456789abcdef",
      channel: "reef",
      accountId: "default",
      kind: "direct" as const,
      target: "reef:peer",
      firstSeenAt: 1,
      lastSeenAt: 2,
    };
    const listStarted = createDeferred<void>();
    const releaseList = createDeferred<unknown>();
    const callGateway = vi.fn(async (request: { method: string; params: unknown }) => {
      if (request.method === "conversations.list") {
        listStarted.resolve();
        return await releaseList.promise;
      }
      return {
        status: "sent",
        conversationRef: selected.conversationRef,
        channel: selected.channel,
        messageId: "message-after-wait",
      };
    });
    const list = createConversationsListTool(
      { agentId: "main", senderIsOwner: true },
      { callGateway: callGateway as never },
    );
    const send = createConversationsSendTool(
      { agentId: "main", senderIsOwner: true },
      { callGateway: callGateway as never },
    );
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          timeoutMs: 60_000,
        },
      },
    } as never;
    const catalogRef = createToolSearchCatalogRef();
    const ctx = {
      config,
      runtimeConfig: config,
      agentId: "main",
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-conversation-authority-park",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [...codeModeTools, list, send],
      config,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      runId: ctx.runId,
      catalogRef,
    });

    const suspendedPromise = expectDefined(
      codeModeTools[0],
      "Code Mode exec test invariant",
    ).execute("code-call-conversation-authority-park", {
      code: `
        await tools.conversations_list({});
        return await tools.conversations_send({
          conversationRef: ${JSON.stringify(selected.conversationRef)},
          message: "done",
        });
      `,
    });
    await listStarted.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    const suspended = resultDetails(await suspendedPromise);
    expect(suspended.status).toBe("waiting");
    const runId = suspended.runId;
    expect(typeof runId).toBe("string");
    if (typeof runId !== "string") {
      throw new Error("expected a parked Code Mode run");
    }
    const parked = testing.activeRuns.get(runId);
    expect(parked?.pending).toHaveLength(1);
    expect(callGateway).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    releaseList.resolve({ conversations: [selected], complete: true });
    await parked?.pending[0]?.promise;
    const completed = resultDetails(
      await expectDefined(codeModeTools[1], "Code Mode wait test invariant").execute(
        "code-wait-conversation-authority-park",
        { runId },
      ),
    );

    expect(completed).toMatchObject({
      status: "completed",
      value: {
        status: "sent",
        conversationRef: selected.conversationRef,
      },
    });
    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(testing.activeRuns.has(runId)).toBe(false);
  });
});
