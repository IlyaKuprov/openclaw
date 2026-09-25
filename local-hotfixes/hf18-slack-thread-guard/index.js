import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_AUDIT_LOG = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "logs",
  "slack-thread-guard.jsonl",
);
const DEFAULT_SLACK_ACCOUNT_ID = "default";
const THREAD_FIELDS = ["replyTo", "replyToId", "threadId", "threadTs", "message_id", "messageId"];
const TOP_LEVEL_ACTIONS = new Set(["send", "upload-file"]);
const SLACK_PEER_KINDS = new Set(["channel", "group", "direct", "dm"]);
const STATE_TTL_MS = 60 * 60 * 1000;
const MAX_STATE_ENTRIES = 2048;

// Per-run answer-repetition gate for message-tool replies. This is not delivery custody.
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
  const qualified = /^team:(T[a-z0-9]+):(channel|user):([a-z0-9]+)$/i.exec(target);
  if (qualified) {
    const [, team, kind, id] = qualified;
    const validId =
      kind.toLowerCase() === "channel"
        ? /^[cdg][a-z0-9]+$/i.test(id)
        : /^[buw][a-z0-9]+$/i.test(id);
    return validId
      ? `team:${team.toUpperCase()}:${kind.toLowerCase()}:${id.toUpperCase()}`
      : undefined;
  }
  target = target.replace(/^(?:channel|group|direct|dm|user|slack):/i, "");
  if (/^[bcdguw][a-z0-9]+$/i.test(target)) {
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
    const target = normalizeSlackTarget(
      parts[peerIndex]?.toLowerCase() === "team"
        ? parts.slice(peerIndex, peerIndex + 4).join(":")
        : parts[peerIndex],
    );
    if (!target) {
      continue;
    }
    return {
      channel: "slack",
      target,
      accountId: accountId ?? DEFAULT_SLACK_ACCOUNT_ID,
      accountIdExplicit: accountId !== undefined,
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
      persistedTo: normalizeString(to),
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
    persistedTo: routes[0].persistedTo,
    accountId: routes.find((route) => route.accountId)?.accountId ?? DEFAULT_SLACK_ACCOUNT_ID,
    source: routes.map((route) => route.source).join("+"),
  };
}

export function resolveSlackSessionRoute(sessionKey, sessionRecord, api) {
  if (!isSlackNamedSession(sessionKey)) {
    return { matched: false };
  }
  // SQLite is canonical; sessions.json may be a stale migration artifact.
  let record = sessionRecord;
  if (record === undefined) {
    try {
      record = api?.runtime?.agent?.session?.getSessionEntry({
        sessionKey,
        readConsistency: "latest",
      });
    } catch (err) {
      return {
        matched: true,
        ok: false,
        reason: `canonical session lookup failed: ${String(err)}`,
      };
    }
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
  return (
    Boolean(normalizeSlackTarget(target)) ||
    (typeof target === "string" && target.toLowerCase().includes("slack:"))
  );
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
    fs.appendFileSync(auditLog, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", {
      mode: 0o600,
    });
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

/** A read-only, synchronous route request; the host independently validates its persisted proof. */
export function decideOutboundRoute(event, record) {
  const sessionKey = event?.sessionKey;
  if (!isSlackNamedSession(sessionKey)) {
    return;
  }
  const keyRoute = parseSlackRouteFromSessionKey(sessionKey);
  const persisted = resolveSlackRouteFromSessionRecord(record);
  const peerKind = keyRoute?.peerKind;
  const canonicalTarget = persisted?.persistedTo;
  const expectedKind =
    peerKind === "channel" || peerKind === "group"
      ? "channel"
      : peerKind === "direct" || peerKind === "dm"
        ? /^[BUW]/.test(keyRoute.target.split(":").at(-1))
          ? "user"
          : "channel"
        : undefined;
  if (
    !expectedKind ||
    !persisted ||
    persisted.conflict ||
    keyRoute.target !== persisted.target ||
    (keyRoute.accountIdExplicit && keyRoute.accountId !== persisted.accountId) ||
    !collectPersistedSlackRoutes(record).some((route) => route.accountId)
  ) {
    throw new Error("Slack outbound route lacks matching persisted peer and account");
  }
  // The host accepts only canonical typed targets, not aliases.
  if (
    !new RegExp(
      `^(?:team:T[A-Z0-9]+:)?${expectedKind}:${expectedKind === "user" ? "[BUW]" : "[CDG]"}[A-Z0-9]+$`,
      "i",
    ).test(canonicalTarget)
  ) {
    throw new Error("Slack outbound route lacks a canonical persisted peer target");
  }
  return {
    channel: "slack",
    to: persisted.persistedTo,
    accountId: persisted.accountId,
    threadPolicy: "root",
  };
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
    normalizeChannel(details.channel) !== "slack" ||
    asRecord(details.messageDelivery).status !== "settled" ||
    asRecord(details.messageDelivery).partialDelivery === true
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

function isBareTextFinalPayload(payload) {
  return (
    typeof payload?.text === "string" &&
    payload.text.trim().length > 0 &&
    payload.text.trim() !== "NO_REPLY" &&
    !payload.media &&
    !payload.mediaUrl &&
    !payload.buffer &&
    !payload.mediaUrls?.length &&
    !payload.attachments?.length &&
    !payload.presentation &&
    !payload.interactive &&
    !payload.channelData &&
    !payload.location &&
    !payload.fallbackText &&
    !payload.btw &&
    !payload.delivery &&
    !payload.replyToId &&
    !payload.replyToTag &&
    !payload.replyToCurrent
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
  sourceReplyGate.clear();
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
      if (
        isPlainTextSend(params) &&
        isSlackNamedSession(ctx?.sessionKey) &&
        isSourceReplyGateArmed(gateRunId)
      ) {
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
        ? await resolveSlackSessionRoute(ctx?.sessionKey, undefined, api)
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

  // The harness awaits tool-result middleware before giving the result to the
  // model or finalizing the turn. after_tool_call and message_sent are detached
  // observers: neither can safely order this state transition against a final.
  api.registerAgentToolResultMiddleware(
    (event, ctx) => {
      const runId = ctx.runId;
      // A non-message completion (including a failed one) advances the step.
      if (event.toolName !== "message" || event.isError || !isSlackSendResult(event.result)) {
        advanceSourceReplyGeneration(runId);
        return;
      }
      const params = asRecord(event.args);
      const action = typeof params.action === "string" ? params.action : "send";
      if (!TOP_LEVEL_ACTIONS.has(action)) {
        advanceSourceReplyGeneration(runId);
        return;
      }
      // The synchronous canonical lookup keeps the decision in this settled
      // result's order; no asynchronous read may overtake another completion.
      const sourceRoute = isSlackNamedSession(ctx.sessionKey)
        ? resolveSlackSessionRoute(ctx.sessionKey, undefined, api)
        : { ok: false };
      if (
        isPlainTextSend(params) &&
        sourceRoute.ok &&
        normalizeChannel(params.channel) === "slack" &&
        normalizeSlackTarget(params.target) === sourceRoute.route.target &&
        normalizeString(params.accountId) === sourceRoute.route.accountId &&
        !(Array.isArray(params.targets) && params.targets.length > 0)
      ) {
        armSourceReplyGate(runId);
      } else {
        advanceSourceReplyGeneration(runId);
      }
    },
    { runtimes: ["openclaw"] },
  );

  // Decide before the host acquires direct or queued delivery custody. No adapter
  // access, await, audit write, or plugin-side delivery ledger belongs here.
  api.on("outbound_route_decision", (event) => {
    const sourceChannel = normalizeChannel(event?.original?.channel);
    if (
      !config.enforceSessionIdentity ||
      !isSlackNamedSession(event?.sessionKey) ||
      (!config.rerouteNonSlackDelivery && sourceChannel !== "slack")
    ) {
      return;
    }
    if (!config.enforceRootDelivery) {
      if (sourceChannel !== "slack") {
        // This host route contract cannot redirect without also rooting. Reject
        // instead of sending on the source surface or overriding the opt-out.
        throw new Error("cross-surface Slack routing requires root delivery enforcement");
      }
      return;
    }
    const record = api.runtime.agent.session.getSessionEntry({
      sessionKey: event.sessionKey,
      readConsistency: "latest",
    });
    return decideOutboundRoute(event, record);
  });

  // The tool gate also suppresses an immediate paraphrased canonical final.
  // Host delivery applies the route above; payload and message hooks do not send.
  api.on("reply_payload_sending", (event, ctx) => {
    const sessionKey = event.sessionKey ?? ctx?.sessionKey;
    const runId = event.runId ?? ctx?.runId;
    if (
      config.enforceSessionIdentity &&
      isSlackNamedSession(sessionKey) &&
      (event.kind === undefined || event.kind === "final") &&
      isSourceReplyGateArmed(runId) &&
      isBareTextFinalPayload(event.payload)
    ) {
      return { cancel: true, reason: "This run already delivered a Slack reply to this step" };
    }
  });
}
