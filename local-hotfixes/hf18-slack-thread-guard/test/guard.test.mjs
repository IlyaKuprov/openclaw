import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

const tempState = fs.mkdtempSync(path.join(os.tmpdir(), "slack-guard-p0-4a-"));
const sessionsPath = path.join(tempState, "agents", "main", "sessions", "sessions.json");
process.env.OPENCLAW_STATE_DIR = tempState;
fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
fs.writeFileSync(sessionsPath, "{}\n");

const guard = await import("../index.js");
const register = guard.default;
const reset = guard._resetStateForTests;
const SESSION = "agent:main:slack:channel:c012audit";

function makeApi() {
  const hooks = new Map();
  const sends = [];
  const api = {
    config: { channels: { slack: { enabled: true } } },
    pluginConfig: { auditLog: path.join(tempState, "guard.jsonl") },
    runtime: {
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async (ctx) => {
              sends.push({ kind: "text", ...ctx });
              return { channel: "slack", messageId: String(sends.length) };
            },
            sendPayload: async (ctx) => {
              sends.push({ kind: "payload", ...ctx });
              return { channel: "slack", messageId: String(sends.length) };
            },
          }),
        },
      },
    },
    on(name, handler) {
      hooks.set(name, handler);
    },
  };
  register(api);
  return { hooks, sends };
}

function sentToolResult(messageId = "1700000000.000001") {
  return {
    content: [{ type: "text", text: "sent" }],
    details: {
      channel: "slack",
      deliveryStatus: "sent",
      dryRun: false,
      result: {
        receipt: {
          primaryPlatformMessageId: messageId,
          platformMessageIds: [messageId],
          sentAt: Date.now(),
        },
      },
    },
  };
}

// The canonical final on the Slack surface itself: the core delivers it unless
// the guard cancels it as a restatement of this run's message-tool delivery.
function slackFinal(hooks, runId, text) {
  return hooks.get("reply_payload_sending")(
    { payload: { text }, kind: "final", channel: "slack", sessionKey: SESSION, runId },
    { channelId: "slack", sessionKey: SESSION, runId },
  );
}

afterEach(() => {
  reset();
  fs.writeFileSync(sessionsPath, "{}\n");
});
after(() => fs.rmSync(tempState, { recursive: true, force: true }));

describe("core no-visible-reply notice (OpenClaw 2026.9.5)", () => {
  const NOTICE =
    "⚠️ OpenClaw couldn't produce or deliver a reply. Please try again. If this keeps happening, ask the operator to check the gateway logs. Reference: run-a.";

  it("drops the notice when the guard already delivered content for the run", async () => {
    const { hooks, sends } = makeApi();
    const call = (text, runId) =>
      hooks.get("reply_payload_sending")(
        { payload: { text }, channel: "webchat", sessionKey: SESSION, runId },
        { channelId: "webchat", sessionKey: SESSION, runId },
      );
    const first = await call("Session reset.", "run-a");
    assert.equal(first?.cancel, true);
    assert.equal(sends.length, 1);
    const second = await call(NOTICE, "run-a");
    assert.equal(second?.cancel, true);
    assert.equal(sends.length, 1);
    const third = await hooks.get("message_sending")(
      { content: NOTICE },
      { channelId: "webchat", sessionKey: SESSION, runId: "run-a" },
    );
    assert.equal(third?.cancel, true);
    assert.equal(sends.length, 1);
  });

  it("still forwards the notice when nothing was delivered for the run", async () => {
    const { hooks, sends } = makeApi();
    await hooks.get("reply_payload_sending")(
      { payload: { text: NOTICE }, channel: "webchat", sessionKey: SESSION, runId: "run-b" },
      { channelId: "webchat", sessionKey: SESSION, runId: "run-b" },
    );
    assert.equal(sends.length, 1);
  });
});

describe("P0-4a run-scoped delivery identity", () => {
  it("does not deduplicate identical finals from distinct runs", async () => {
    const { hooks, sends } = makeApi();
    for (const runId of ["run-one", "run-two"]) {
      await hooks.get("reply_payload_sending")(
        { payload: { text: "Repeated final" }, kind: "final", channel: "webchat", sessionKey: SESSION, runId },
        { channelId: "webchat", sessionKey: SESSION, runId },
      );
    }
    assert.equal(sends.length, 2);
  });

  it("deduplicates the same final within one run", async () => {
    const { hooks, sends } = makeApi();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await hooks.get("reply_payload_sending")(
        { payload: { text: "One final" }, kind: "final", channel: "webchat", sessionKey: SESSION, runId: "same-run" },
        { channelId: "webchat", sessionKey: SESSION, runId: "same-run" },
      );
    }
    assert.equal(sends.length, 1);
  });

  it("does not collapse distinct media-only payloads from distinct runs", async () => {
    const { hooks, sends } = makeApi();
    for (const [runId, mediaUrl] of [
      ["media-one", "file:///a"],
      ["media-two", "file:///b"],
    ]) {
      await hooks.get("reply_payload_sending")(
        {
          payload: { text: "", mediaUrls: [mediaUrl] },
          channel: "webchat",
          sessionKey: SESSION,
          runId,
        },
        { channelId: "webchat", sessionKey: SESSION, runId },
      );
    }
    assert.equal(sends.length, 2);
  });

  it("does not collapse distinct media-only payloads within one run", async () => {
    const { hooks, sends } = makeApi();
    for (const mediaUrl of ["file:///a", "file:///b"]) {
      await hooks.get("reply_payload_sending")(
        {
          payload: { text: "", mediaUrls: [mediaUrl] },
          channel: "webchat",
          sessionKey: SESSION,
          runId: "media-same-run",
        },
        { channelId: "webchat", sessionKey: SESSION, runId: "media-same-run" },
      );
    }
    assert.equal(sends.length, 2);
  });

  it("uses full normalized payload identity for the uncorrelated fallback", async () => {
    const { hooks, sends } = makeApi();
    for (const mediaUrl of ["file:///one", "file:///two"]) {
      await hooks.get("reply_payload_sending")(
        { payload: { text: "", mediaUrls: [mediaUrl] }, channel: "webchat", sessionKey: SESSION },
        { channelId: "webchat", sessionKey: SESSION },
      );
    }
    assert.equal(sends.length, 2);
  });

  it("normalizes payload key order before uncorrelated fallback dedupe", async () => {
    const { hooks, sends } = makeApi();
    for (const payload of [
      { text: "", mediaUrls: ["file:///same"], meta: { b: 2, a: 1 } },
      { meta: { a: 1, b: 2 }, mediaUrls: ["file:///same"], text: "" },
    ]) {
      await hooks.get("reply_payload_sending")(
        { payload, channel: "webchat", sessionKey: SESSION },
        { channelId: "webchat", sessionKey: SESSION },
      );
    }
    assert.equal(sends.length, 1);
  });

  it("expires the uncorrelated fallback after 30 seconds", async () => {
    const { hooks, sends } = makeApi();
    const originalNow = Date.now;
    let now = 1_800_000_000_000;
    Date.now = () => now;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await hooks.get("reply_payload_sending")(
          {
            payload: { text: "", mediaUrls: ["file:///same"] },
            channel: "webchat",
            sessionKey: SESSION,
          },
          { channelId: "webchat", sessionKey: SESSION },
        );
        now += 30_001;
      }
    } finally {
      Date.now = originalNow;
    }
    assert.equal(sends.length, 2);
  });
});

describe("P0-4a exact tool-send receipts", () => {
  it("accepts a structurally valid sent Slack receipt", async () => {
    const { hooks, sends } = makeApi();
    await hooks.get("after_tool_call")(
      {
        toolName: "message",
        runId: "receipt-run",
        params: { action: "send", channel: "slack", message: "Delivered text" },
        result: sentToolResult(),
      },
      { sessionKey: SESSION, runId: "receipt-run" },
    );
    const result = await slackFinal(hooks, "receipt-run", "Delivered text");
    assert.equal(result?.cancel, true);
    assert.equal(sends.length, 0);
  });

  it("rejects a dry-run even when it names Slack and direct delivery", async () => {
    const { hooks, sends } = makeApi();
    await hooks.get("after_tool_call")(
      {
        toolName: "message",
        runId: "dry-run",
        params: { action: "send", channel: "slack", message: "Dry text", dryRun: true },
        result: {
          details: {
            channel: "slack",
            via: "direct",
            deliveryStatus: "dry_run",
            dryRun: true,
            result: { receipt: { primaryPlatformMessageId: "not-sent" } },
          },
        },
      },
      { sessionKey: SESSION, runId: "dry-run" },
    );
    assert.equal(await slackFinal(hooks, "dry-run", "Dry text"), undefined);
    assert.equal(sends.length, 0);
  });

  it("rejects sent status without a typed receipt", async () => {
    const { hooks, sends } = makeApi();
    await hooks.get("after_tool_call")(
      {
        toolName: "message",
        runId: "missing-receipt",
        params: { action: "send", channel: "slack", message: "Unproven" },
        result: { details: { channel: "slack", deliveryStatus: "sent", via: "direct" } },
      },
      { sessionKey: SESSION, runId: "missing-receipt" },
    );
    assert.equal(await slackFinal(hooks, "missing-receipt", "Unproven"), undefined);
    assert.equal(sends.length, 0);
  });

  it("rejects a failed result even if it carries a receipt", async () => {
    const { hooks, sends } = makeApi();
    const result = sentToolResult();
    result.details.deliveryStatus = "failed";
    await hooks.get("after_tool_call")(
      {
        toolName: "message",
        runId: "failed-send",
        params: { action: "send", channel: "slack", message: "Failed text" },
        result,
      },
      { sessionKey: SESSION, runId: "failed-send" },
    );
    assert.equal(await slackFinal(hooks, "failed-send", "Failed text"), undefined);
    assert.equal(sends.length, 0);
  });

  it("does not record an uncorrelated sent receipt as cross-run delivery evidence", async () => {
    const { hooks, sends } = makeApi();
    await hooks.get("after_tool_call")(
      {
        toolName: "message",
        params: { action: "send", channel: "slack", message: "Repeated later" },
        result: sentToolResult(),
      },
      { sessionKey: SESSION },
    );
    assert.equal(await slackFinal(hooks, "later-run", "Repeated later"), undefined);
    assert.equal(sends.length, 0);
  });
});

describe("P0-4a route and hook contracts", () => {
  it("resolves a key-only Slack route with an explicit default account", async () => {
    const resolution = await guard.resolveSlackSessionRoute(SESSION, {});
    assert.equal(resolution.ok, true);
    assert.equal(resolution.route.accountId, "default");
  });

  it("always rewrites an absent canonical account to default", async () => {
    const { hooks } = makeApi();
    const result = await hooks.get("before_tool_call")(
      {
        toolName: "message",
        runId: "account-run",
        params: {
          action: "send",
          channel: "slack",
          target: "C999WRONG",
          accountId: "other",
          message: "x",
        },
      },
      { sessionKey: SESSION, channelId: "slack", runId: "account-run" },
    );
    assert.equal(result.params.target, "C012AUDIT");
    assert.equal(result.params.accountId, "default");
  });

  it("writes an explicit canonical persisted account", async () => {
    fs.writeFileSync(
      sessionsPath,
      `${JSON.stringify({
        [SESSION]: {
          sessionId: "persisted-account-session",
          deliveryContext: {
            channel: "slack",
            to: "channel:C012AUDIT",
            accountId: "teamA",
          },
        },
      })}\n`,
    );
    const { hooks } = makeApi();
    const result = await hooks.get("before_tool_call")(
      {
        toolName: "message",
        runId: "persisted-account-run",
        params: {
          action: "send",
          channel: "slack",
          target: "C999WRONG",
          accountId: "other",
          message: "x",
        },
      },
      { sessionKey: SESSION, channelId: "slack", runId: "persisted-account-run" },
    );
    assert.equal(result.params.target, "C012AUDIT");
    assert.equal(result.params.accountId, "teamA");
  });

  it("returns the installed reply_payload_sending reason field", async () => {
    const { hooks } = makeApi();
    const result = await hooks.get("reply_payload_sending")(
      {
        payload: { text: "x" },
        channel: "webchat",
        sessionKey: SESSION,
        runId: "reason-run",
      },
      { channelId: "webchat", sessionKey: SESSION, runId: "reason-run" },
    );
    assert.equal(result.cancel, true);
    assert.equal(typeof result.reason, "string");
    assert.equal(result.cancelReason, undefined);
  });

  it("leaves the distinct message_sending cancelReason contract intact", async () => {
    const { hooks } = makeApi();
    const result = await hooks.get("message_sending")(
      { content: "rerouted", channel: "webchat" },
      { channelId: "webchat", sessionKey: SESSION, runId: "message-contract-run" },
    );
    assert.equal(result.cancel, true);
    assert.match(result.cancelReason, /cannot send visible content/i);
    assert.equal(result.reason, undefined);
  });
});
