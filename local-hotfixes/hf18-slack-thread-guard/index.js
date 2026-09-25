import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_AUDIT_LOG = path.join(os.homedir(), ".openclaw", "workspace", "logs", "slack-thread-guard.jsonl");
const DEFAULT_SLACK_ACCOUNT_ID = "default";
const THREAD_FIELDS = ["replyTo", "replyToId", "threadId", "threadTs", "message_id", "messageId"];
const TOP_LEVEL_ACTIONS = new Set(["send", "upload-file"]);
const SLACK_PEER_KINDS = new Set(["channel", "group", "direct", "dm"]);
const SILENT_REPLY_TOKENS = new Set(["NO_REPLY"]);
const STATE_TTL_MS = 60 * 60 * 1000;
const UNCORRELATED_FALLBACK_TTL_MS = 30 * 1000;
const MAX_STATE_ENTRIES = 2048;

const directDeliveries = new Map();
const toolDeliveries = new Map();
// Per-run source-reply generation gate (answer-repetition control). Diagnosis
// job 1785365205-063909: within one run, at most one plain-text Slack source
// reply is permitted per "generation". Any other completed tool action (or run
// end) advances the generation and re-permits a genuinely new update. This
// suppresses an immediate paraphrased second send and a post-compaction
// restatement without a runtime-wide ledger or a core-runtime change.
const sourceReplyGate = new Map();

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeConfig(value) {
  const cfg = asRecord(value);
  return {
    mainChannelOnly: cfg.mainChannelOnly !== false,
    stripThreadFields: cfg.stripThreadFields !== false,
    forceTopLevel: cfg.forceTopLevel !== false,
    enforceRootDelivery: cfg.enforceRootDelivery !== false,
    enforceSessionIdentity: cfg.enforceSessionIdentity !== false,
    rerouteNonSlackDelivery: cfg.rerouteNonSlackDelivery !== false,
    failClosed: cfg.failClosed !== false,
    auditLog:
      typeof cfg.auditLog === "string" && cfg.auditLog.trim()
        ? cfg.auditLog.trim()
        : DEFAULT_AUDIT_LOG,
  };
}

/** The operator's session identity rule: any canonical session key containing "slack" is Slack-bound. */
export function isSlackNamedSession(sessionKey) {
  return typeof sessionKey === "string" && sessionKey.toLowerCase().includes("slack");
}

function normalizeChannel(value) {
  return normalizeString(value)?.toLowerCase();
}

export function normalizeSlackTarget(value) {
  let target = normalizeString(value);
  if (!target) {
    return undefined;
  }
  target = target.replace(/^(?:channel|group|direct|dm|user):/i, "");
  if (/^[cdgu][a-z0-9]+$/i.test(target)) {
    return target.toUpperCase();
  }
  if (target.startsWith("#") && target.length > 1) {
    return target;
  }
  return undefined;
}

export function parseSlackRouteFromSessionKey(sessionKey) {
  if (!isSlackNamedSession(sessionKey)) {
    return undefined;
  }
  const parts = sessionKey.split(":");
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].toLowerCase() !== "slack") {
      continue;
    }
    let accountId;
    let peerKind = parts[index + 1]?.toLowerCase();
    let peerIndex = index + 2;
    if (!SLACK_PEER_KINDS.has(peerKind)) {
      accountId = normalizeString(parts[index + 1]);
      peerKind = parts[index + 2]?.toLowerCase();
      peerIndex = index + 3;
    }
    if (!SLACK_PEER_KINDS.has(peerKind)) {
      continue;
    }
    const target = normalizeSlackTarget(parts[peerIndex]);
    if (!target) {
      continue;
    }
    return {
      channel: "slack",
      target,
      accountId: accountId ?? DEFAULT_SLACK_ACCOUNT_ID,
      peerKind,
      source: "session-key",
    };
  }
  return undefined;
}

function collectPersistedSlackRoutes(record) {
  const row = asRecord(record);
  const routes = [];
  const add = (channel, to, accountId, source) => {
    if (normalizeChannel(channel) !== "slack") {
      return;
    }
    const target = normalizeSlackTarget(to);
    if (!target) {
      return;
    }
    routes.push({
      channel: "slack",
      target,
      accountId: normalizeString(accountId),
      source,
    });
  };

  const deliveryContext = asRecord(row.deliveryContext);
  add(deliveryContext.channel, deliveryContext.to, deliveryContext.accountId, "deliveryContext");

  const route = asRecord(row.route);
  const routeTarget = asRecord(route.target);
  add(route.channel, routeTarget.to, route.accountId, "route");

  add(row.lastChannel, row.lastTo, row.lastAccountId, "lastRoute");

  const origin = asRecord(row.origin);
  add(origin.provider ?? origin.surface, origin.to, row.lastAccountId, "origin");

  if (normalizeChannel(row.channel) === "slack") {
    add("slack", row.groupId ?? row.lastTo, row.lastAccountId, "sessionMetadata");
  }
  return routes;
}

export function resolveSlackRouteFromSessionRecord(record) {
  const routes = collectPersistedSlackRoutes(record);
  if (routes.length === 0) {
    return undefined;
  }
  const targets = new Set(routes.map((route) => route.target.toUpperCase()));
  if (targets.size !== 1) {
    return { conflict: true, reason: "persisted Slack targets disagree", routes };
  }
  const accounts = new Set(routes.map((route) => route.accountId).filter(Boolean));
  if (accounts.size > 1) {
    return { conflict: true, reason: "persisted Slack accounts disagree", routes };
  }
  return {
    channel: "slack",
    target: routes[0].target,
    accountId: routes.find((route) => route.accountId)?.accountId ?? DEFAULT_SLACK_ACCOUNT_ID,
    source: routes.map((route) => route.source).join("+"),
  };
}

function parseAgentId(sessionKey) {
  const parts = typeof sessionKey === "string" ? sessionKey.split(":") : [];
  if (parts[0]?.toLowerCase() !== "agent" || !/^[a-z0-9_-]+$/i.test(parts[1] ?? "")) {
    return undefined;
  }
  return parts[1].toLowerCase();
}

// mtime+size-keyed cache of parsed session stores. The delivery hooks used to
// synchronously read a multi-MiB sessions.json on every call; now the read is
// async and a store whose (mtimeMs,size) is unchanged is reused without a
// re-read. (size guards the sub-millisecond case where two writes could share
// an mtime; a changed store almost always changes size too.)
const sessionStoreCache = new Map();

async function readSessionRecord(sessionKey) {
  const agentId = parseAgentId(sessionKey);
  if (!agentId) {
    return undefined;
  }
  const stateRoot =
    normalizeString(process.env.OPENCLAW_STATE_DIR) ?? path.join(os.homedir(), ".openclaw");
  const storePath = path.join(stateRoot, "agents", agentId, "sessions", "sessions.json");
  try {
    const stat = await fs.promises.stat(storePath);
    const cached = sessionStoreCache.get(storePath);
    let store;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      store = cached.store;
    } else {
      store = asRecord(JSON.parse(await fs.promises.readFile(storePath, "utf8")));
      sessionStoreCache.set(storePath, { mtimeMs: stat.mtimeMs, size: stat.size, store });
    }
    if (Object.prototype.hasOwnProperty.call(store, sessionKey)) {
      return asRecord(store[sessionKey]);
    }
    const lowerKey = sessionKey.toLowerCase();
    const matchingKey = Object.keys(store).find((key) => key.toLowerCase() === lowerKey);
    return matchingKey ? asRecord(store[matchingKey]) : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveSlackSessionRoute(sessionKey, sessionRecord) {
  const record =
    sessionRecord === undefined ? await readSessionRecord(sessionKey) : sessionRecord;
  if (!isSlackNamedSession(sessionKey)) {
    return { matched: false };
  }
  const keyRoute = parseSlackRouteFromSessionKey(sessionKey);
  const persistedRoute = resolveSlackRouteFromSessionRecord(record);
  if (persistedRoute?.conflict) {
    return { matched: true, ok: false, reason: persistedRoute.reason };
  }
  if (
    keyRoute &&
    persistedRoute?.target &&
    keyRoute.target.toUpperCase() !== persistedRoute.target.toUpperCase()
  ) {
    return {
      matched: true,
      ok: false,
      reason: `session-key target ${keyRoute.target} conflicts with persisted target ${persistedRoute.target}`,
    };
  }
  const route = persistedRoute?.target ? persistedRoute : keyRoute;
  if (!route) {
    return {
      matched: true,
      ok: false,
      reason: "Slack-named session has no canonical or persisted Slack target",
    };
  }
  return { matched: true, ok: true, route };
}

function isSlackTarget(target) {
  return Boolean(normalizeSlackTarget(target)) ||
    (typeof target === "string" && target.toLowerCase().includes("slack:"));
}

function isSlackTopLevelAction(params, ctx) {
  const action = typeof params.action === "string" ? params.action : "send";
  if (!TOP_LEVEL_ACTIONS.has(action)) {
    return false;
  }
  return (
    isSlackNamedSession(ctx?.sessionKey) ||
    normalizeChannel(params.channel) === "slack" ||
    isSlackTarget(params.target) ||
    normalizeChannel(ctx?.channel) === "slack" ||
    normalizeChannel(ctx?.channelId) === "slack" ||
    normalizeChannel(ctx?.messageChannel) === "slack" ||
    normalizeChannel(ctx?.messageProvider) === "slack"
  );
}

const AUDIT_LOG_MAX_BYTES = 5 * 1024 * 1024;

function writeAudit(auditLog, entry) {
  try {
    fs.mkdirSync(path.dirname(auditLog), { recursive: true });
    // Bound growth: rotate a single generation once the log exceeds the cap.
    if (fs.existsSync(auditLog) && fs.statSync(auditLog).size > AUDIT_LOG_MAX_BYTES) {
      fs.renameSync(auditLog, auditLog + ".1");
    }
    fs.appendFileSync(
      auditLog,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
      { mode: 0o600 },
    );
    // Tighten to owner-only even if the file pre-existed with wider perms.
    try {
      fs.chmodSync(auditLog, 0o600);
    } catch {
      // best-effort; leave perms as-is if chmod is unavailable
    }
  } catch (err) {
    console.warn("[slack-thread-guard] audit write failed: " + String(err));
  }
}

function stripThreadFields(params) {
  const next = { ...params };
  const stripped = [];
  for (const field of THREAD_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(next, field)) {
      stripped.push(field);
      next[field] = null;
    }
  }
  return { next, stripped };
}

function visibleTextFromToolParams(params) {
  return [params.message, params.caption]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n\n");
}

function isSilentReply(text) {
  return SILENT_REPLY_TOKENS.has(normalizeString(text) ?? "");
}

function fingerprint(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function canonicalizeDeliveryValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeDeliveryValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) {
      out[key] = canonicalizeDeliveryValue(value[key]);
    }
  }
  return out;
}

function deliveryMaterial(runId, text, payload) {
  const normalizedText = normalizeString(text) ?? "";
  // A correlated run only needs content identity to join the message-tool and
  // finalization hooks. Media-only deliveries need the complete payload so two
  // different files never collapse onto the same empty-text fingerprint.
  if (normalizeString(runId) && normalizedText) {
    return normalizedText;
  }
  if (payload && typeof payload === "object") {
    return JSON.stringify(
      canonicalizeDeliveryValue({ text: normalizedText, payload: asRecord(payload) }),
    );
  }
  return normalizedText;
}

function deliveryKey(runId, sessionKey, material) {
  const correlatedRunId = normalizeString(runId);
  const normalizedSessionKey = normalizeString(sessionKey);
  if (!correlatedRunId && !normalizedSessionKey) {
    return undefined;
  }
  const identity = correlatedRunId
    ? `run:${correlatedRunId}:session:${normalizedSessionKey ?? "unknown-session"}`
    : `fallback:session:${normalizedSessionKey}`;
  return `${identity}:${fingerprint(material)}`;
}

function pruneState(now = Date.now()) {
  for (const map of [directDeliveries, toolDeliveries]) {
    for (const [key, value] of map) {
      if (now - value.at > (value.ttlMs ?? STATE_TTL_MS)) {
        map.delete(key);
      }
    }
    while (map.size > MAX_STATE_ENTRIES) {
      map.delete(map.keys().next().value);
    }
  }
}

function rememberToolDelivery(runId, sessionKey, text, payload) {
  const material = deliveryMaterial(runId, text, payload);
  const key = material ? deliveryKey(runId, sessionKey, material) : undefined;
  if (!key) {
    return false;
  }
  const at = Date.now();
  toolDeliveries.set(key, {
    at,
    status: "sent",
    ttlMs: normalizeString(runId) ? STATE_TTL_MS : UNCORRELATED_FALLBACK_TTL_MS,
  });
  pruneState(at);
  return true;
}

function hasKnownDelivery(runId, sessionKey, text, payload) {
  pruneState();
  const exactKey = deliveryKey(runId, sessionKey, deliveryMaterial(runId, text, payload));
  if (!exactKey) {
    return false;
  }
  return (
    directDeliveries.get(exactKey)?.status === "sent" ||
    toolDeliveries.get(exactKey)?.status === "sent"
  );
}

// OpenClaw 2026.9.5 posts this notice to the originating surface when its own
// reply ledger saw no visible delivery. For a Slack-named session driven from
// another surface the guard cancels every originating-surface payload after
// rerouting it to Slack, so that ledger is always empty and the notice is a
// false alarm whenever the guard already delivered content for the run.
const CORE_NO_VISIBLE_REPLY_NOTICE = "OpenClaw couldn't produce or deliver a reply";

function isCoreNoVisibleReplyNotice(text) {
  return (
    typeof text === "string" &&
    text.replace(/^[\s⚠️]+/u, "").startsWith(CORE_NO_VISIBLE_REPLY_NOTICE)
  );
}

function hasAnyRunDelivery(runId, sessionKey) {
  const prefix = normalizeString(runId)
    ? `run:${normalizeString(runId)}:session:${normalizeString(sessionKey) ?? "unknown-session"}:`
    : undefined;
  if (!prefix) {
    return false;
  }
  pruneState();
  for (const map of [directDeliveries, toolDeliveries]) {
    for (const [key, value] of map) {
      if (key.startsWith(prefix) && value.status === "sent") {
        return true;
      }
    }
  }
  return false;
}

function resultMessageId(result) {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  return normalizeString(result.messageId) ?? normalizeString(result.ts);
}

async function deliverSlackOnce({ api, config, route, sessionKey, runId, text, payload, reason }) {
  const normalizedText = normalizeString(text) ?? "";
  const material = deliveryMaterial(runId, normalizedText, payload);
  const key = deliveryKey(runId, sessionKey, material);
  if (!key) {
    auditRouteFailure(config, {
      hook: "deliverSlackOnce",
      sessionKey,
      runId,
      reason: `missing runId delivery correlation (${reason})`,
    });
    return { at: Date.now(), status: "blocked", source: "missing-correlation" };
  }
  pruneState();
  const existing = directDeliveries.get(key);
  if (existing) {
    return existing.promise ? await existing.promise : existing;
  }
  if (hasKnownDelivery(runId, sessionKey, normalizedText, payload)) {
    return { at: Date.now(), status: "sent", source: "known-delivery" };
  }

  const promise = (async () => {
    try {
      const adapter = await api.runtime.channel.outbound.loadAdapter("slack");
      if (!adapter) {
        throw new Error("Slack outbound adapter unavailable");
      }
      let result;
      if (payload && typeof adapter.sendPayload === "function") {
        result = await adapter.sendPayload({
          cfg: api.config,
          to: route.target,
          text: normalizedText,
          payload,
          accountId: route.accountId,
          replyToId: null,
          threadId: null,
        });
      } else if (typeof adapter.sendText === "function") {
        result = await adapter.sendText({
          cfg: api.config,
          to: route.target,
          text: normalizedText,
          accountId: route.accountId,
          replyToId: null,
          threadId: null,
        });
      } else {
        throw new Error("Slack outbound adapter has no usable send method");
      }
      const state = {
        at: Date.now(),
        status: "sent",
        source: "guard",
        messageId: resultMessageId(result),
        ttlMs: normalizeString(runId) ? STATE_TTL_MS : UNCORRELATED_FALLBACK_TTL_MS,
      };
      directDeliveries.set(key, state);
      writeAudit(config.auditLog, {
        action: "session_identity_rerouted",
        reason,
        outcome: "sent",
        sessionKey,
        runId,
        target: route.target,
        accountId: route.accountId ?? null,
        routeSource: route.source,
        messageId: state.messageId ?? null,
      });
      return state;
    } catch (err) {
      const state = {
        at: Date.now(),
        status: "unknown",
        source: "guard",
        error: String(err),
      };
      directDeliveries.set(key, state);
      writeAudit(config.auditLog, {
        action: "session_identity_reroute_failed",
        reason,
        outcome: "unknown_no_replay",
        sessionKey,
        runId,
        target: route.target,
        accountId: route.accountId ?? null,
        routeSource: route.source,
        error: String(err),
      });
      return state;
    }
  })();

  directDeliveries.set(key, { at: Date.now(), status: "pending", promise });
  return await promise;
}

function auditRouteFailure(config, { sessionKey, runId, reason, hook }) {
  writeAudit(config.auditLog, {
    action: "session_identity_fail_closed",
    hook,
    sessionKey,
    runId,
    reason,
  });
}

function isSlackSendResult(result) {
  const resultRecord = asRecord(result);
  const details = Object.keys(asRecord(resultRecord.details)).length
    ? asRecord(resultRecord.details)
    : resultRecord;
  const sendResult = asRecord(details.result);
  const receipt = asRecord(sendResult.receipt);
  const platformMessageIds = Array.isArray(receipt.platformMessageIds)
    ? receipt.platformMessageIds
    : [];
  const hasReceipt = Boolean(
    normalizeString(receipt.primaryPlatformMessageId) ||
      platformMessageIds.some((value) => Boolean(normalizeString(value))),
  );
  if (
    details.deliveryStatus !== "sent" ||
    details.dryRun === true ||
    normalizeChannel(details.channel) !== "slack"
  ) {
    return false;
  }
  return hasReceipt;
}

function isPlainTextSend(params) {
  const action = typeof params.action === "string" ? params.action : "send";
  if (action !== "send") {
    return false;
  }
  if (!normalizeString(visibleTextFromToolParams(params))) {
    return false;
  }
  // A text send that also carries an artefact is a delivery, not a bare
  // restatement, so it is not gated.
  return !(
    params.media ||
    params.buffer ||
    (Array.isArray(params.attachments) && params.attachments.length > 0)
  );
}

function pruneSourceReplyGate(now = Date.now()) {
  for (const [key, value] of sourceReplyGate) {
    if (now - value.at > STATE_TTL_MS) {
      sourceReplyGate.delete(key);
    }
  }
  while (sourceReplyGate.size > MAX_STATE_ENTRIES) {
    sourceReplyGate.delete(sourceReplyGate.keys().next().value);
  }
}

function armSourceReplyGate(runId) {
  const id = normalizeString(runId);
  if (!id) {
    return;
  }
  const at = Date.now();
  sourceReplyGate.set(id, { armed: true, at });
  pruneSourceReplyGate(at);
}

function advanceSourceReplyGeneration(runId) {
  const id = normalizeString(runId);
  if (!id) {
    return;
  }
  const existing = sourceReplyGate.get(id);
  if (existing?.armed) {
    sourceReplyGate.set(id, { armed: false, at: Date.now() });
  }
}

function isSourceReplyGateArmed(runId) {
  const id = normalizeString(runId);
  if (!id) {
    return false;
  }
  const entry = sourceReplyGate.get(id);
  if (!entry) {
    return false;
  }
  if (Date.now() - entry.at > STATE_TTL_MS) {
    sourceReplyGate.delete(id);
    return false;
  }
  return entry.armed === true;
}

export function _resetStateForTests() {
  directDeliveries.clear();
  toolDeliveries.clear();
  sourceReplyGate.clear();
  sessionStoreCache.clear();
}

export default function register(api) {
  const config = normalizeConfig(api.pluginConfig);

  api.on(
    "before_tool_call",
    async (event, ctx) => {
      if (event.toolName !== "message") {
        return;
      }
      const params = asRecord(event.params);
      const action = typeof params.action === "string" ? params.action : "send";
      if (!TOP_LEVEL_ACTIONS.has(action) || !isSlackTopLevelAction(params, ctx)) {
        return;
      }

      const gateRunId = event.runId ?? ctx?.runId;
      if (isPlainTextSend(params) && isSourceReplyGateArmed(gateRunId)) {
        writeAudit(config.auditLog, {
          action: "source_reply_repeat_suppressed",
          runId: gateRunId ?? null,
          sessionKey: ctx?.sessionKey,
          toolAction: action,
        });
        return {
          block: true,
          blockReason:
            "A Slack text reply was already delivered for this step and no other tool action has run " +
            "since. Do not resend or paraphrase it. If a further update is genuinely warranted, do the " +
            "real work first; otherwise return NO_REPLY. Any content still owed to the user must be folded " +
            "into a later message after a real action, never sent as an immediate duplicate.",
        };
      }

      const sessionRoute = config.enforceSessionIdentity
        ? await resolveSlackSessionRoute(ctx?.sessionKey)
        : { matched: false };
      if (sessionRoute.matched && !sessionRoute.ok) {
        auditRouteFailure(config, {
          hook: "before_tool_call",
          sessionKey: ctx?.sessionKey,
          runId: event.runId ?? ctx?.runId,
          reason: sessionRoute.reason,
        });
        if (config.failClosed) {
          return {
            block: true,
            blockReason: `Slack session delivery blocked: ${sessionRoute.reason}`,
          };
        }
      }

      const strippedResult =
        config.enforceRootDelivery && config.stripThreadFields
          ? stripThreadFields(params)
          : { next: { ...params }, stripped: [] };
      const next = strippedResult.next;
      const stripped = strippedResult.stripped;
      let forcedSlackRoute = false;
      if (sessionRoute.ok) {
        const canonicalAccountId = sessionRoute.route.accountId ?? DEFAULT_SLACK_ACCOUNT_ID;
        forcedSlackRoute = Boolean(
          normalizeChannel(next.channel) !== "slack" ||
            normalizeSlackTarget(next.target) !== sessionRoute.route.target ||
            normalizeString(next.accountId) !== canonicalAccountId ||
            (Array.isArray(next.targets) && next.targets.length > 0),
        );
        next.channel = "slack";
        next.target = sessionRoute.route.target;
        next.accountId = canonicalAccountId;
        // Hook params are shallow-merged over the original call. An empty array
        // overrides an original multi-target list; deleting it would restore it.
        if (Object.prototype.hasOwnProperty.call(next, "targets")) {
          next.targets = [];
        }
      }
      const forcedTopLevel =
        config.enforceRootDelivery &&
        config.mainChannelOnly &&
        config.forceTopLevel &&
        next.topLevel !== true;
      if (forcedTopLevel) {
        next.topLevel = true;
      }
      if (stripped.length === 0 && !forcedTopLevel && !forcedSlackRoute) {
        return;
      }
      writeAudit(config.auditLog, {
        action: "top_level_enforced",
        stripped,
        forcedTopLevel,
        forcedSlackRoute,
        toolAction: action,
        matchedBy: {
          sessionName: isSlackNamedSession(ctx?.sessionKey),
          channel: normalizeChannel(params.channel) === "slack",
          target: isSlackTarget(params.target),
          contextChannel: normalizeChannel(ctx?.channelId) === "slack",
        },
        runId: event.runId ?? ctx?.runId,
        sessionKey: ctx?.sessionKey,
        target: typeof next.target === "string" ? next.target : null,
      });
      return { params: next };
    },
    { priority: 100 },
  );

  api.on(
    "after_tool_call",
    async (event, ctx) => {
      const runId = event.runId ?? ctx?.runId;
      // Any non-message tool completion advances the source-reply generation,
      // re-permitting a later, genuinely new progress update.
      if (event.toolName !== "message") {
        advanceSourceReplyGeneration(runId);
        return;
      }
      if (event.error || !isSlackSendResult(event.result)) {
        // A failed or non-delivery message action must not arm the gate; treat
        // it as advancing so a legitimate retry is never blocked.
        advanceSourceReplyGeneration(runId);
        return;
      }
      const params = asRecord(event.params);
      const action = typeof params.action === "string" ? params.action : "send";
      if (!TOP_LEVEL_ACTIONS.has(action)) {
        advanceSourceReplyGeneration(runId);
        return;
      }
      // A successful plain-text reply arms the gate; a media/file delivery is a
      // legitimate distinct artefact and advances the generation instead.
      if (isPlainTextSend(params)) {
        armSourceReplyGate(runId);
      } else {
        advanceSourceReplyGeneration(runId);
      }
      const remembered = rememberToolDelivery(
        runId,
        ctx?.sessionKey,
        visibleTextFromToolParams(params),
        params,
      );
      if (!remembered) {
        auditRouteFailure(config, {
          hook: "after_tool_call",
          sessionKey: ctx?.sessionKey,
          runId,
          reason: "sent Slack tool result lacked runId delivery correlation",
        });
      }
    },
    { priority: 100 },
  );

  // Canonical-final handling. Until 2.0.4 a before_agent_finalize hook
  // delivered the final to Slack itself and returned action "revise" so the
  // model would answer NO_REPLY. OpenClaw 2026.9.5 implements "revise" by
  // rewinding the transcript leaf, and every rewind measured on 2026-09-23
  // (28 of 28, including a fresh one-turn session) failed the run with
  // "Session transcript projection is rebuilding". The core now delivers the
  // final; the guard only cancels a final that restates what this run already
  // sent through the message tool (exact repeat, or armed source-reply gate),
  // and drops the core's no-visible-reply notice that a cancel provokes.
  api.on(
    "reply_payload_sending",
    async (event, ctx) => {
      const sessionKey = event.sessionKey ?? ctx?.sessionKey;
      if (!config.enforceSessionIdentity || !isSlackNamedSession(sessionKey)) {
        return;
      }
      const runId = event.runId ?? ctx?.runId;
      const payload = asRecord(event.payload);
      const text = normalizeString(payload.text) ?? "";
      const channel = normalizeChannel(event.channel ?? ctx?.channelId);
      if (isCoreNoVisibleReplyNotice(text) && hasAnyRunDelivery(runId, sessionKey)) {
        writeAudit(config.auditLog, {
          action: "core_no_visible_reply_notice_dropped",
          hook: "reply_payload_sending",
          sessionKey,
          runId,
        });
        return { cancel: true, reason: "The guard already delivered this run's reply" };
      }
      const restatement =
        Boolean(text) &&
        !isSilentReply(text) &&
        (event.kind === undefined || event.kind === "final") &&
        (hasKnownDelivery(runId, sessionKey, text, payload) || isSourceReplyGateArmed(runId));
      if (channel === "slack") {
        if (!restatement) {
          return;
        }
        writeAudit(config.auditLog, {
          action: "canonical_final_suppressed",
          hook: "reply_payload_sending",
          sessionKey,
          runId,
        });
        return { cancel: true, reason: "This run already delivered its reply to Slack" };
      }
      if (!config.rerouteNonSlackDelivery) {
        return;
      }
      const resolution = await resolveSlackSessionRoute(sessionKey);
      if (!resolution.ok) {
        auditRouteFailure(config, {
          hook: "reply_payload_sending",
          sessionKey,
          runId,
          reason: resolution.reason,
        });
      } else if (!isSilentReply(text) && !restatement) {
        await deliverSlackOnce({
          api,
          config,
          route: resolution.route,
          sessionKey,
          runId,
          text,
          payload,
          reason: `reply_payload_sending:${event.channel ?? ctx?.channelId ?? "unknown"}`,
        });
      }
      return {
        cancel: true,
        reason: "Slack-named sessions cannot deliver reply payloads to non-Slack surfaces",
      };
    },
    { priority: 100, timeoutMs: 30000 },
  );

  api.on(
    "message_sending",
    async (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (
        !config.enforceSessionIdentity ||
        !config.rerouteNonSlackDelivery ||
        !isSlackNamedSession(sessionKey) ||
        normalizeChannel(ctx?.channelId) === "slack"
      ) {
        return;
      }
      const text = normalizeString(event.content) ?? "";
      const resolution = await resolveSlackSessionRoute(sessionKey);
      if (!resolution.ok) {
        auditRouteFailure(config, {
          hook: "message_sending",
          sessionKey,
          runId: ctx?.runId,
          reason: resolution.reason,
        });
      } else if (isCoreNoVisibleReplyNotice(text) && hasAnyRunDelivery(ctx?.runId, sessionKey)) {
        writeAudit(config.auditLog, {
          action: "core_no_visible_reply_notice_dropped",
          hook: "message_sending",
          sessionKey,
          runId: ctx?.runId,
        });
      } else if (!isSilentReply(text) && !hasKnownDelivery(ctx?.runId, sessionKey, text)) {
        await deliverSlackOnce({
          api,
          config,
          route: resolution.route,
          sessionKey,
          runId: ctx?.runId,
          text,
          reason: `message_sending:${ctx?.channelId ?? "unknown"}`,
        });
      }
      return {
        cancel: true,
        cancelReason: "Slack-named sessions cannot send visible content to non-Slack surfaces",
      };
    },
    { priority: 100, timeoutMs: 30000 },
  );

  api.on(
    "message_sent",
    async (event, ctx) => {
      if (
        event.success &&
        normalizeChannel(ctx?.channelId) === "slack" &&
        isSlackNamedSession(event.sessionKey ?? ctx?.sessionKey)
      ) {
        const remembered = rememberToolDelivery(
          event.runId ?? ctx?.runId,
          event.sessionKey ?? ctx?.sessionKey,
          event.content,
        );
        if (!remembered) {
          auditRouteFailure(config, {
            hook: "message_sent",
            sessionKey: event.sessionKey ?? ctx?.sessionKey,
            runId: event.runId ?? ctx?.runId,
            reason: "sent Slack message lacked runId delivery correlation",
          });
        }
      }
    },
    { priority: 100 },
  );
}
