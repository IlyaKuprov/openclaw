import { afterEach, expect, test, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { revokePluginRecord } from "../plugins/registry-lifecycle.js";
import { createRuntimeTestRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import * as sessionLifecycle from "../sessions/session-lifecycle-admission.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { chatHandlers } from "./server-methods/chat.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

test.each(["revoked", "replaced"])(
  "trusted Gateway sessions.patch cannot commit after its %s plugin runtime loses custody",
  async (retirement) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const key = "agent:main:plugin-revocation";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        { sessionId: "plugin-revocation", updatedAt: 1, pluginOwnerId: "runtime-revocation" },
      );
      const context = {
        trackExecution: trackAsyncWork,
        getRuntimeConfig: () => ({}),
        loadGatewayModelCatalogSnapshot: async () => ({ entries: [], routeVariants: [] }),
        getSessionEventSubscriberConnIds: () => new Set(),
        broadcastToConnIds: vi.fn(),
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
        dedupe: new Map(),
        logGateway: { error: vi.fn(), warn: vi.fn() },
        getGatewayMethodRegistry: () =>
          createGatewayMethodRegistry([
            {
              name: "sessions.patch",
              scope: "operator.write",
              owner: { kind: "core", area: "sessions" },
              handler: sessionMutationHandlers["sessions.patch"]!,
            },
          ]),
      } as unknown as GatewayRequestContext;
      const registry = createRuntimeTestRegistry(createPluginRuntime());
      const record = createPluginRecord({
        id: "runtime-revocation",
        source: "/plugins/runtime-revocation/index.js",
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      const api = registry.createApi(record, { config: {} });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const original = sessionLifecycle.runExclusiveSessionLifecycleMutation;
      vi.spyOn(sessionLifecycle, "runExclusiveSessionLifecycleMutation").mockImplementation(
        (params) =>
          original({
            ...params,
            prepare: async (owner) => {
              entered.resolve();
              await release.promise;
              await params.prepare?.(owner);
            },
          }),
      );
      const pending = withPluginRuntimeGatewayRequestScope(
        { context, isWebchatConnect: () => false },
        () => api.runtime.gateway.request("sessions.patch", { key, pinned: true }),
      );
      try {
        await Promise.race([entered.promise, pending]);
        if (retirement === "revoked") {
          revokePluginRecord(registry.registry, record);
        } else {
          registry.registry.plugins.splice(0, 1);
          registry.registry.plugins.push(
            createPluginRecord({
              id: record.id,
              source: "/plugins/runtime-revocation/replacement.js",
              origin: "bundled",
              enabled: true,
              configSchema: false,
            }),
          );
        }
        release.resolve();
        await expect(pending).rejects.toThrow();
        expect(loadSessionEntry({ agentId: "main", sessionKey: key })?.pinnedAt).toBeUndefined();
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
      }
    });
  },
);

test("revocation during lazy Gateway dispatch import rejects a real sessions.patch write", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:lazy-gateway-dispatch";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key },
      { sessionId: "lazy-gateway-dispatch", updatedAt: 1, pluginOwnerId: "lazy-dispatch" },
    );
    const context = {
      trackExecution: trackAsyncWork,
      getRuntimeConfig: () => ({}),
      loadGatewayModelCatalogSnapshot: async () => ({ entries: [], routeVariants: [] }),
      getSessionEventSubscriberConnIds: () => new Set(),
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      dedupe: new Map(),
      logGateway: { error: vi.fn(), warn: vi.fn() },
      getGatewayMethodRegistry: () =>
        createGatewayMethodRegistry([
          {
            name: "sessions.patch",
            scope: "operator.write",
            owner: { kind: "core", area: "sessions" },
            handler: sessionMutationHandlers["sessions.patch"]!,
          },
        ]),
    } as unknown as GatewayRequestContext;
    const importing = createDeferredCore();
    const release = createDeferredCore();
    vi.doMock("./server-plugins.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("./server-plugins.js")>();
      importing.resolve();
      await release.promise;
      return original;
    });
    vi.resetModules();
    const { createPluginRuntime: createFreshRuntime } = await import("../plugins/runtime/index.js");
    const registry = createRuntimeTestRegistry(createFreshRuntime());
    const record = createPluginRecord({
      id: "lazy-dispatch",
      source: "/plugins/lazy-dispatch/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = registry.createApi(record, { config: {} });
    const pending = withPluginRuntimeGatewayRequestScope(
      { context, isWebchatConnect: () => false },
      () => api.runtime.gateway.request("sessions.patch", { key, pinned: true }),
    );
    try {
      await Promise.race([importing.promise, pending]);
      revokePluginRecord(registry.registry, record);
      release.resolve();
      await expect(pending).rejects.toThrow("runtime is no longer active");
      expect(loadSessionEntry({ agentId: "main", sessionKey: key })?.pinnedAt).toBeUndefined();
    } finally {
      release.resolve();
      vi.doUnmock("./server-plugins.js");
      await Promise.allSettled([pending]);
    }
  });
});

test("trusted Gateway chat.inject cannot append after plugin revocation during admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const agentId = "main";
    const sessionKey = "agent:main:plugin-inject-revocation";
    const sessionId = "plugin-inject-revocation";
    const storePath = resolveSessionStorePathCore(undefined, { agentId });
    await upsertSessionEntryCore(
      { agentId, sessionKey, storePath },
      { sessionId, updatedAt: 1, pluginOwnerId: "inject-plugin" },
    );
    const before = await loadTranscriptEvents({ agentId, sessionKey, sessionId, storePath });
    const context = {
      trackExecution: trackAsyncWork,
      getRuntimeConfig: () => ({}),
      loadGatewayModelCatalogSnapshot: async () => ({ entries: [], routeVariants: [] }),
      getSessionEventSubscriberConnIds: () => new Set(),
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      dedupe: new Map(),
      logGateway: { error: vi.fn(), warn: vi.fn() },
      getGatewayMethodRegistry: () =>
        createGatewayMethodRegistry([
          {
            name: "chat.inject",
            scope: "operator.admin",
            owner: { kind: "core", area: "chat" },
            handler: chatHandlers["chat.inject"]!,
          },
        ]),
    } as unknown as GatewayRequestContext;
    const registry = createRuntimeTestRegistry(createPluginRuntime());
    const record = createPluginRecord({
      id: "inject-plugin",
      source: "/plugins/inject-plugin/index.js",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = registry.createApi(record, { config: {} });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const original = sessionLifecycle.beginSessionWorkAdmission;
    vi.spyOn(sessionLifecycle, "beginSessionWorkAdmission").mockImplementation(async (params) => {
      const admission = await original(params);
      entered.resolve();
      await release.promise;
      return admission;
    });
    const pending = withPluginRuntimeGatewayRequestScope(
      { context, isWebchatConnect: () => false },
      () =>
        api.runtime.gateway.request(
          "chat.inject",
          { sessionKey, message: "stale plugin injection" },
          { scopes: ["operator.admin"] },
        ),
    );
    try {
      await Promise.race([entered.promise, pending]);
      revokePluginRecord(registry.registry, record);
      release.resolve();
      await expect(pending).rejects.toThrow();
      expect(await loadTranscriptEvents({ agentId, sessionKey, sessionId, storePath })).toEqual(
        before,
      );
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });
});
