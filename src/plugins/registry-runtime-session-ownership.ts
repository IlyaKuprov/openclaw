import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveInitialEmbeddedRunModel } from "../agents/embedded-agent-runner/run/runtime-resolution.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import {
  parseSqliteSessionFileMarker,
  sqliteSessionFileMarkerMatchesTarget,
} from "../config/sessions/legacy-sqlite-marker.js";
import { resolveSessionEntryAccessTarget } from "../config/sessions/session-accessor.entry.js";
import { resolveSessionOwnershipBySessionId } from "../config/sessions/session-accessor.sqlite-entry.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  isAgentHarnessSessionKey,
  isAgentHarnessSessionKeyOwnedBy,
  resolveSessionPinnedHarnessId,
} from "../sessions/agent-harness-session-key.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRegistry } from "./registry-types.js";
import type { PluginRuntime } from "./runtime/types.js";

function isInternalEffectsStoreKey(sessionKey: string): boolean {
  const normalized = normalizeStoreSessionKey(sessionKey);
  // SQLite adds the agent wrapper to legacy keys; both spellings reach the same row.
  return (
    isInternalSessionEffectsKey(normalized) || normalized.startsWith("internal-session-effects:")
  );
}

const PLUGIN_GATEWAY_SESSION_MUTATION_METHODS = new Set([
  "agent",
  "chat.abort",
  "chat.inject",
  "chat.send",
  "message.action",
  "plugins.sessionAction",
  "send",
  "sessions.abort",
  "sessions.compact",
  "sessions.compaction.branch",
  "sessions.compaction.restore",
  "sessions.branches.switch",
  "sessions.rewind",
  "sessions.fork",
  "sessions.create",
  "sessions.delete",
  "sessions.patchMany",
  "sessions.patch",
  "sessions.pluginPatch",
  "sessions.reset",
  "sessions.send",
  "sessions.steer",
  "wake",
]);

const PLUGIN_GATEWAY_GLOBAL_SESSION_MUTATION_METHODS = new Set([
  "sessions.cleanup",
  "sessions.groups.delete",
  "sessions.groups.rename",
]);

/** Session ownership checks loaded only when a plugin invokes an async action. */
export function createPluginSessionOwnership(
  state: PluginRegistryState,
  pluginId: string,
  resolveRegistry: () => PluginRegistry = () => state.registry,
) {
  const { registryParams } = state;
  // SAFETY: Logical session resolution only reads the immutable runtime config snapshot.
  const currentSessionConfig = () => registryParams.runtime.config.current() as OpenClawConfig;
  const resolveHarnessRegistration = (harnessId: unknown) => {
    const normalizedHarnessId = normalizeOptionalAgentRuntimeId(harnessId);
    return normalizedHarnessId
      ? resolveRegistry().agentHarnesses.find(
          (entry) => normalizeOptionalAgentRuntimeId(entry.harness.id) === normalizedHarnessId,
        )
      : undefined;
  };
  const resolveHarnessRegistrationForSessionKey = (sessionKey: string) =>
    resolveRegistry().agentHarnesses.find((entry) => {
      const rawHarnessId = normalizeOptionalString(entry.harness.id)?.toLowerCase();
      return (
        rawHarnessId === normalizeOptionalAgentRuntimeId(rawHarnessId) &&
        isAgentHarnessSessionKeyOwnedBy(sessionKey, rawHarnessId)
      );
    });
  const assertOwnedHarness = (harnessId: unknown, action: string): string => {
    const normalizedHarnessId = normalizeOptionalAgentRuntimeId(harnessId);
    if (!normalizedHarnessId) {
      throw new Error(
        `Plugin "${pluginId}" must provide a registered agent harness id to ${action}.`,
      );
    }
    const registration = resolveHarnessRegistration(normalizedHarnessId);
    if (!registration) {
      throw new Error(
        `Plugin "${pluginId}" must register agent harness "${normalizedHarnessId}" before it can ${action}.`,
      );
    }
    if (registration.pluginId !== pluginId) {
      throw new Error(
        `Agent harness "${normalizedHarnessId}" is owned by plugin "${registration.pluginId}", not "${pluginId}".`,
      );
    }
    return normalizedHarnessId;
  };
  const assertReservedSessionKeyOwned = (sessionKey: unknown, action: string): void => {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey || !isAgentHarnessSessionKey(normalizedSessionKey)) {
      return;
    }
    const registration = resolveHarnessRegistrationForSessionKey(normalizedSessionKey);
    if (!registration) {
      throw new Error(
        `Plugin "${pluginId}" cannot ${action} reserved agent harness session "${normalizedSessionKey}" because its harness is not registered.`,
      );
    }
    if (registration.pluginId !== pluginId) {
      throw new Error(
        `Plugin "${pluginId}" cannot ${action} reserved agent harness session "${normalizedSessionKey}" owned by plugin "${registration.pluginId}".`,
      );
    }
  };
  const resolveLockedSessionHarnessRegistration = (
    sessionKey: string,
    entry: SessionEntry,
    action: string,
  ) => {
    if (entry.modelSelectionLocked !== true) {
      return undefined;
    }
    const pluginOwnerId = normalizeOptionalString(entry.pluginOwnerId);
    if (pluginOwnerId) {
      if (isAgentHarnessSessionKey(sessionKey)) {
        throw new Error(
          `Locked session "${sessionKey}" mixes plugin and reserved harness ownership.`,
        );
      }
      return { ownerPluginId: pluginOwnerId };
    }
    const harnessId = resolveSessionPinnedHarnessId(entry);
    if (!harnessId) {
      throw new Error(
        `Plugin "${pluginId}" must provide a registered agent harness id to ${action} locked sessions.`,
      );
    }
    const registration = resolveHarnessRegistration(harnessId);
    if (!registration) {
      throw new Error(
        `Plugin "${pluginId}" must register agent harness "${harnessId}" before it can ${action} locked sessions.`,
      );
    }
    if (
      isAgentHarnessSessionKey(sessionKey) &&
      !isAgentHarnessSessionKeyOwnedBy(sessionKey, harnessId)
    ) {
      throw new Error(
        `Locked session "${sessionKey}" belongs to agent harness "${harnessId}", which does not match its reserved session key.`,
      );
    }
    return { ownerPluginId: registration.pluginId, harnessId, registration };
  };
  const assertLockedSessionEntryOwned = (
    sessionKey: string,
    entry: SessionEntry,
    action: string,
  ): void => {
    const resolved = resolveLockedSessionHarnessRegistration(sessionKey, entry, action);
    if (!resolved) {
      return;
    }
    if (resolved.ownerPluginId !== pluginId) {
      throw new Error(
        `Locked session "${sessionKey}" is owned by plugin "${resolved.ownerPluginId}", not "${pluginId}".`,
      );
    }
  };
  const assertSessionEntryOwned = (params: {
    action: string;
    entry?: SessionEntry;
    sessionKey: string;
  }): void => {
    if (params.entry) {
      const ownerPluginId = normalizeOptionalString(params.entry.pluginOwnerId);
      if (isInternalEffectsStoreKey(params.sessionKey) && ownerPluginId !== pluginId) {
        throw new Error(
          ownerPluginId
            ? `Internal session "${params.sessionKey}" is owned by plugin "${ownerPluginId}", not "${pluginId}".`
            : `Plugin "${pluginId}" cannot ${params.action} ownerless internal session "${params.sessionKey}".`,
        );
      }
      // Before harness locking shipped, plugins could create ordinary sessions
      // whose user-chosen key happened to start with `harness:`.
      assertLockedSessionEntryOwned(params.sessionKey, params.entry, params.action);
      return;
    }
    assertReservedSessionKeyOwned(params.sessionKey, params.action);
  };
  const resolveStoredSessionOwnershipTarget = (params: {
    agentId?: string;
    env?: NodeJS.ProcessEnv;
    sessionKey: string;
    storePath?: string;
  }): { entry?: SessionEntry; sessionKey: string } => {
    if (
      classifySessionKeyShape(params.sessionKey) === "legacy_or_alias" &&
      !isUnscopedSessionKeySentinel(params.sessionKey) &&
      params.agentId === undefined &&
      params.storePath === undefined
    ) {
      // Logical keys need their configured agent before SQLite ownership admission.
      const target = resolveSessionEntryAccessTarget({
        cfg: currentSessionConfig(),
        sessionKey: params.sessionKey,
        ...(params.env !== undefined ? { env: params.env } : {}),
      });
      return { entry: target.entry, sessionKey: target.canonicalKey };
    }
    return {
      entry: registryParams.runtime.agent.session.getSessionEntry({
        sessionKey: params.sessionKey,
        readConsistency: "latest",
        ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
        ...(params.env !== undefined ? { env: params.env } : {}),
        ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
      }),
      sessionKey: params.sessionKey,
    };
  };
  const assertStoredSessionEntryOwned = (params: {
    action: string;
    agentId?: string;
    env?: NodeJS.ProcessEnv;
    sessionKey: string;
    storePath?: string;
  }): SessionEntry | undefined => {
    const target = resolveStoredSessionOwnershipTarget(params);
    assertSessionEntryOwned({ action: params.action, ...target });
    return target.entry;
  };
  const resolveStoredSessionExecutionOwner = (params: {
    action: string;
    agentId?: string;
    sessionKey: string;
    storePath?: string;
  }): string | undefined => {
    const target = resolveStoredSessionOwnershipTarget(params);
    const { entry, sessionKey } = target;
    const locked = entry
      ? resolveLockedSessionHarnessRegistration(sessionKey, entry, params.action)
      : undefined;
    if (!entry || !locked || locked.ownerPluginId === pluginId) {
      assertSessionEntryOwned({ action: params.action, ...target });
      return undefined;
    }
    const registration = "registration" in locked ? locked.registration : undefined;
    if (!registration) {
      throw new Error(
        `Locked session "${sessionKey}" is owned by plugin "${locked.ownerPluginId}", not "${pluginId}".`,
      );
    }
    if (!registration.harness.delegatedExecutionPluginIds?.includes(pluginId)) {
      assertLockedSessionEntryOwned(sessionKey, entry, params.action);
    }
    return locked.ownerPluginId;
  };
  const assertSessionIdentitiesOwned = (params: {
    action: string;
    agentId?: unknown;
    sessionFiles?: unknown[];
    sessionIds?: unknown[];
    sessionKeys?: unknown[];
    storePath?: unknown;
    requireExactInternalRunTarget?: boolean;
  }): void => {
    const agentId = normalizeOptionalString(params.agentId);
    const storePath = normalizeOptionalString(params.storePath);
    const requireExactInternalRunTarget = (sessionKey: string) => {
      if (params.requireExactInternalRunTarget && isInternalEffectsStoreKey(sessionKey)) {
        throw new Error(
          `Plugin "${pluginId}" may execute a persisted internal session only with its exact session target identity.`,
        );
      }
    };
    const sessionKeys = new Set<string>();
    for (const value of params.sessionKeys ?? []) {
      const sessionKey = normalizeOptionalString(value);
      if (sessionKey) {
        sessionKeys.add(sessionKey);
      }
    }
    for (const sessionKey of sessionKeys) {
      assertStoredSessionEntryOwned({
        action: params.action,
        sessionKey,
        ...(agentId ? { agentId } : {}),
        ...(storePath ? { storePath } : {}),
      });
    }

    const sessionIds = new Set<string>();
    for (const value of params.sessionIds ?? []) {
      const sessionId = normalizeOptionalString(value);
      if (sessionId) {
        sessionIds.add(sessionId);
      }
    }
    const sessionFiles = new Set<string>();
    for (const value of params.sessionFiles ?? []) {
      const sessionFile = normalizeOptionalString(value);
      if (sessionFile) {
        sessionFiles.add(sessionFile);
      }
    }
    if (sessionIds.size === 0 && sessionFiles.size === 0) {
      return;
    }
    const entries = registryParams.runtime.agent.session.listSessionEntries({
      ...(agentId ? { agentId } : {}),
      ...(storePath ? { storePath } : {}),
      readOnly: true,
    });
    for (const { sessionKey, entry } of entries) {
      if (sessionIds.has(entry.sessionId)) {
        assertSessionEntryOwned({ action: params.action, entry, sessionKey });
        requireExactInternalRunTarget(sessionKey);
      }
    }
    const lookupAgentId =
      sessionIds.size > 0 ? (agentId ?? resolveDefaultAgentId(currentSessionConfig())) : undefined;
    for (const sessionId of sessionIds) {
      const window = resolveSessionOwnershipBySessionId({
        agentId: lookupAgentId,
        sessionId,
        ...(storePath ? { storePath } : {}),
      });
      if (!window) {
        continue;
      }
      const ownerPluginId = normalizeOptionalString(window.pluginOwnerId);
      if (isInternalEffectsStoreKey(window.sessionKey) && ownerPluginId !== pluginId) {
        throw new Error(
          ownerPluginId
            ? `Internal session "${window.sessionKey}" is owned by plugin "${ownerPluginId}", not "${pluginId}".`
            : `Plugin "${pluginId}" cannot ${params.action} ownerless internal session "${window.sessionKey}".`,
        );
      }
      requireExactInternalRunTarget(window.sessionKey);
      assertStoredSessionEntryOwned({
        action: params.action,
        agentId: lookupAgentId,
        sessionKey: window.sessionKey,
        ...(storePath ? { storePath } : {}),
      });
    }
    for (const sessionFile of sessionFiles) {
      const sessionKeyMatches = entries.filter(({ sessionKey }) => sessionKey === sessionFile);
      if (sessionKeyMatches.length > 0) {
        for (const match of sessionKeyMatches) {
          assertSessionEntryOwned({
            action: params.action,
            entry: match.entry,
            sessionKey: match.sessionKey,
          });
          requireExactInternalRunTarget(match.sessionKey);
        }
        const matchedSessionIds = new Set(
          sessionKeyMatches
            .map(({ entry }) => normalizeOptionalString(entry.sessionId))
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
        );
        for (const match of entries) {
          const matchSessionId = normalizeOptionalString(match.entry.sessionId);
          if (matchSessionId && matchedSessionIds.has(matchSessionId)) {
            assertSessionEntryOwned({
              action: params.action,
              entry: match.entry,
              sessionKey: match.sessionKey,
            });
            requireExactInternalRunTarget(match.sessionKey);
          }
        }
        continue;
      }
      if (sessionKeys.has(sessionFile)) {
        const target = resolveStoredSessionOwnershipTarget({
          sessionKey: sessionFile,
          ...(agentId ? { agentId } : {}),
          ...(storePath ? { storePath } : {}),
        });
        if (target.entry) {
          assertSessionEntryOwned({
            action: params.action,
            entry: target.entry,
            sessionKey: target.sessionKey,
          });
          requireExactInternalRunTarget(target.sessionKey);
          continue;
        }
      }
      const marker = parseSqliteSessionFileMarker(sessionFile);
      if (!marker) {
        throw new Error("Plugin session ownership checks require a SQLite transcript marker.");
      }
      const markerEntries = registryParams.runtime.agent.session.listSessionEntries({
        agentId: marker.agentId,
        storePath: marker.storePath,
        readOnly: true,
      });
      const matches = markerEntries.filter(({ entry }) => entry.sessionId === marker.sessionId);
      if (matches.length === 0) {
        // Full listings deliberately hide internal-effects rows. A plugin child
        // nested under such a parent must still prove its exact persisted key.
        for (const sessionKey of sessionKeys) {
          if (!isInternalEffectsStoreKey(sessionKey)) {
            continue;
          }
          const entry = registryParams.runtime.agent.session.getSessionEntry({
            agentId: marker.agentId,
            sessionKey,
            storePath: marker.storePath,
            readConsistency: "latest",
          });
          if (entry?.sessionId === marker.sessionId) {
            const ownerPluginId = normalizeOptionalString(entry.pluginOwnerId);
            if (ownerPluginId !== pluginId) {
              throw new Error(
                `Plugin "${pluginId}" cannot ${params.action} internal session owned by plugin "${ownerPluginId ?? "unknown"}".`,
              );
            }
            matches.push({ entry, sessionKey });
          }
        }
      }
      if (matches.length === 0) {
        throw new Error(`Plugin session ownership target not found: ${marker.sessionId}`);
      }
      for (const match of matches) {
        assertSessionEntryOwned({
          action: params.action,
          entry: match.entry,
          sessionKey: match.sessionKey,
        });
        requireExactInternalRunTarget(match.sessionKey);
      }
    }
  };
  const prepareRunSessionExecution = (
    params: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0],
  ): { ownerPluginId?: string; agentHarnessRuntimeOverride?: string } => {
    const target = params.sessionTarget;
    const targetSessionKey = normalizeOptionalString(target?.sessionKey);
    const directSessionKey = normalizeOptionalString(params.sessionKey);
    if (targetSessionKey && directSessionKey && targetSessionKey !== directSessionKey) {
      throw new Error("Delegated agent execution requires one exact session key.");
    }
    const sessionKey = targetSessionKey ?? directSessionKey;
    // Legacy key/ID pairs do not identify the SQLite store or the same-row
    // generation after an await. Internal plugin work needs the exact target.
    if (sessionKey && isInternalEffectsStoreKey(sessionKey) && !target) {
      throw new Error(
        `Plugin "${pluginId}" may execute a persisted internal session only with its exact session target identity.`,
      );
    }
    const storePath = normalizeOptionalString(target?.storePath);
    const agentId = normalizeOptionalString(target?.agentId ?? params.agentId);
    const sessionKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
    const normalizedAgentId = agentId ? normalizeAgentId(agentId) : undefined;
    if (sessionKeyAgentId && normalizedAgentId && normalizedAgentId !== sessionKeyAgentId) {
      throw new Error(
        `Plugin session ownership agent "${normalizedAgentId}" does not match session key agent "${sessionKeyAgentId}".`,
      );
    }
    const ownershipAgentId = sessionKeyAgentId ?? normalizedAgentId;
    // Embedded runs accept one exact key. Carry its resolved store into the
    // keyless ID/file scan so incognito ownership stays in the process-held DB.
    const ownershipStorePath =
      sessionKey && sessionKeyAgentId
        ? resolveSessionStorePathForScope({
            agentId: sessionKeyAgentId,
            sessionKey,
            ...(storePath ? { storePath } : {}),
          })
        : storePath;
    const entry = sessionKey
      ? registryParams.runtime.agent.session.getSessionEntry({
          sessionKey,
          readConsistency: "latest",
          ...(agentId ? { agentId } : {}),
          ...(storePath ? { storePath } : {}),
        })
      : undefined;
    const targetSessionId = normalizeOptionalString(target?.sessionId);
    const targetAgentId = normalizeOptionalString(target?.agentId);
    const directSessionId = normalizeOptionalString(params.sessionId);
    const directAgentId = normalizeOptionalString(params.agentId);
    const sessionFile = normalizeOptionalString(params.sessionFile);
    if (target) {
      const legacySessionIdentityMatches =
        Boolean(sessionFile) &&
        Boolean(agentId) &&
        Boolean(storePath) &&
        Boolean(entry?.sessionId) &&
        sqliteSessionFileMarkerMatchesTarget(sessionFile, {
          agentId: agentId!,
          sessionId: entry!.sessionId,
          storePath: storePath!,
        });
      const targetIdentityMatches =
        targetSessionKey === sessionKey &&
        Boolean(storePath) &&
        Boolean(entry) &&
        targetSessionId === entry?.sessionId &&
        directSessionId === entry?.sessionId &&
        targetAgentId === directAgentId &&
        (!sessionFile || sessionFile === sessionKey || legacySessionIdentityMatches);
      if (!targetIdentityMatches) {
        throw new Error(
          `Plugin "${pluginId}" may execute a persisted session only with its exact session target identity.`,
        );
      }
    }
    const locked =
      sessionKey && entry
        ? resolveLockedSessionHarnessRegistration(sessionKey, entry, "run")
        : undefined;
    const ownerPluginId = locked?.ownerPluginId;
    if (locked && entry && sessionKey && ownerPluginId !== pluginId) {
      const registration = "registration" in locked ? locked.registration : undefined;
      if (!registration) {
        throw new Error(
          `Locked session "${sessionKey}" is owned by plugin "${locked.ownerPluginId}", not "${pluginId}".`,
        );
      }
      if (!registration.harness.delegatedExecutionPluginIds?.includes(pluginId)) {
        assertLockedSessionEntryOwned(sessionKey, entry, "run");
      }
      const requestedHarnessId = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
      const requestedRuntimeOverride = normalizeOptionalAgentRuntimeId(
        params.agentHarnessRuntimeOverride,
      );
      const identityMatches =
        Boolean(target) &&
        targetSessionId === entry.sessionId &&
        directSessionId === entry.sessionId;
      const harnessMatches =
        params.modelSelectionLocked === true &&
        requestedHarnessId === locked.harnessId &&
        requestedRuntimeOverride === locked.harnessId;
      if (!identityMatches || !harnessMatches) {
        throw new Error(
          `Plugin "${pluginId}" may execute locked session "${sessionKey}" only with its exact persisted identity and harness.`,
        );
      }
      return { ownerPluginId };
    }
    assertSessionIdentitiesOwned({
      action: "run",
      agentId: ownershipAgentId,
      sessionFiles: [params.sessionFile],
      sessionIds: [target?.sessionId ?? params.sessionId],
      sessionKeys: [target?.sessionKey ?? params.sessionKey],
      storePath: ownershipStorePath,
      requireExactInternalRunTarget: !target,
    });
    // Reuse the authorized snapshot, but never manufacture a native pin or replace
    // a turn-local request (including auto). Detached and raw-model runs own their selection.
    if (
      !entry?.agentRuntimeOverride ||
      params.agentHarnessRuntimeOverride !== undefined ||
      params.sessionPersistence === "detached" ||
      params.modelRun ||
      resolveSessionPinnedHarnessId(entry)
    ) {
      return {};
    }
    const cfg = params.config ?? currentSessionConfig();
    const { provider } = resolveInitialEmbeddedRunModel({
      config: cfg,
      agentId: ownershipAgentId,
      provider: params.provider,
      model: params.model,
    });
    return {
      agentHarnessRuntimeOverride: resolveSessionRuntimeOverrideForProvider({
        provider,
        entry,
        cfg,
      }),
    };
  };
  const assertGatewaySessionRequestOwned = (
    method: string,
    params: Record<string, unknown> | undefined,
  ): void => {
    if (PLUGIN_GATEWAY_GLOBAL_SESSION_MUTATION_METHODS.has(method)) {
      throw new Error(`Plugin "${pluginId}" cannot request global session mutation "${method}".`);
    }
    if (!PLUGIN_GATEWAY_SESSION_MUTATION_METHODS.has(method)) {
      return;
    }
    const request = params ?? {};
    if (method === "sessions.patchMany" && Array.isArray(request.targets)) {
      for (const target of request.targets) {
        if (!isRecord(target)) {
          continue;
        }
        assertSessionIdentitiesOwned({
          action: `request gateway method "${method}" for`,
          agentId: target.agentId,
          sessionKeys: [target.key],
        });
      }
      return;
    }
    const sessionKeys = [request.sessionKey, request.key, request.parentSessionKey];
    const sessionIds = [request.sessionId];
    assertSessionIdentitiesOwned({
      action: `request gateway method "${method}" for`,
      agentId: request.agentId,
      sessionIds,
      sessionKeys,
    });
    if (
      method === "sessions.abort" &&
      !sessionKeys.some((value) => normalizeOptionalString(value)) &&
      !sessionIds.some((value) => normalizeOptionalString(value))
    ) {
      throw new Error(
        `Plugin "${pluginId}" must provide a session key when requesting gateway method "${method}".`,
      );
    }
  };
  const assertStoreEntryOwned = (params: {
    action: string;
    agentId?: string;
    before?: SessionEntry;
    entry: SessionEntry;
    sessionKey: string;
    storePath?: string;
  }): void => {
    const sessionId = normalizeOptionalString(params.entry.sessionId);
    if (sessionId) {
      const window = resolveSessionOwnershipBySessionId({
        agentId:
          params.agentId ??
          parseAgentSessionKey(params.sessionKey)?.agentId ??
          resolveDefaultAgentId(currentSessionConfig()),
        sessionId,
        ...(params.storePath ? { storePath: params.storePath } : {}),
      });
      if (window) {
        const windowOwner = normalizeOptionalString(window.pluginOwnerId);
        if (windowOwner && windowOwner !== pluginId) {
          throw new Error(
            `Session window "${window.sessionKey}" is owned by plugin "${windowOwner}", not "${pluginId}".`,
          );
        }
        if (
          isInternalEffectsStoreKey(window.sessionKey) &&
          (windowOwner !== pluginId ||
            normalizeStoreSessionKey(window.sessionKey) !==
              normalizeStoreSessionKey(params.sessionKey))
        ) {
          throw new Error(`Plugin "${pluginId}" cannot rehome an internal session window.`);
        }
      }
    }
    const ownerPluginId = normalizeOptionalString(params.before?.pluginOwnerId);
    if (isInternalEffectsStoreKey(params.sessionKey)) {
      const incomingOwner = normalizeOptionalString(params.entry.pluginOwnerId);
      if (ownerPluginId && incomingOwner !== ownerPluginId) {
        throw new Error(`Plugin "${pluginId}" cannot change the owner of an internal session.`);
      }
      if (incomingOwner !== pluginId) {
        throw new Error(
          incomingOwner
            ? `Internal session "${params.sessionKey}" is owned by plugin "${incomingOwner}", not "${pluginId}".`
            : `Internal session "${params.sessionKey}" requires its plugin owner "${pluginId}".`,
        );
      }
    }
    if (params.entry.modelSelectionLocked === true) {
      assertLockedSessionEntryOwned(params.sessionKey, params.entry, params.action);
      return;
    }
    if (params.before?.modelSelectionLocked === true) {
      assertLockedSessionEntryOwned(params.sessionKey, params.before, params.action);
      return;
    }
    if (isAgentHarnessSessionKey(params.sessionKey) && !params.before) {
      assertReservedSessionKeyOwned(params.sessionKey, params.action);
    }
  };
  return {
    assertOwnedHarness,
    assertReservedSessionKeyOwned,
    assertSessionEntryOwned,
    assertStoredSessionEntryOwned,
    assertStoreEntryOwned,
    resolveStoredSessionExecutionOwner,
    prepareRunSessionExecution,
    assertGatewaySessionRequestOwned,
    assertSessionIdentitiesOwned,
  };
}
