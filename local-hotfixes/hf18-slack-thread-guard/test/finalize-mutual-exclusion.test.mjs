import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

// Canonical-final mutual exclusion on the Slack surface (guard 2.0.5). The
// core delivers the final itself; the guard must cancel it only when this run
// already delivered the content through the message tool, and must let it
// through otherwise (no silent loss). The core's no-visible-reply notice that a
// cancel provokes must be dropped, never posted.

const tempState = fs.mkdtempSync(path.join(os.tmpdir(), "slack-guard-mutex-"));
const sessionsPath = path.join(tempState, "agents", "main", "sessions", "sessions.json");
process.env.OPENCLAW_STATE_DIR = tempState;
fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
fs.writeFileSync(sessionsPath, "{}\n");

const guard = await import("../index.js");
const register = guard.default;
const reset = guard._resetStateForTests;
const SESSION = "agent:main:slack:channel:c012mutex";
const NOTICE =
  "⚠️ OpenClaw couldn't produce or deliver a reply. Please try again. If this keeps happening, ask the operator to check the gateway logs. Reference: run-a.";

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

function toolSent(hooks, runId, message) {
  return hooks.get("after_tool_call")(
    {
      toolName: "message",
      runId,
      params: { action: "send", channel: "slack", message },
      result: sentToolResult(),
    },
    { sessionKey: SESSION, runId },
  );
}

function slackFinal(hooks, runId, text, kind = "final") {
  return hooks.get("reply_payload_sending")(
    { payload: { text }, kind, channel: "slack", sessionKey: SESSION, runId },
    { channelId: "slack", sessionKey: SESSION, runId },
  );
}

afterEach(() => {
  reset();
  fs.writeFileSync(sessionsPath, "{}\n");
});
after(() => fs.rmSync(tempState, { recursive: true, force: true }));

describe("canonical final mutual exclusion on the Slack surface", () => {
  it("lets a fresh final through untouched (the core delivers it)", async () => {
    const { hooks, sends } = makeApi();
    assert.equal(await slackFinal(hooks, "run-a", "Fresh answer."), undefined);
    assert.equal(sends.length, 0);
  });

  it("cancels a final that repeats what the message tool already sent", async () => {
    const { hooks, sends } = makeApi();
    await toolSent(hooks, "run-a", "Same answer.");
    const result = await slackFinal(hooks, "run-a", "Same answer.");
    assert.equal(result?.cancel, true);
    assert.equal(sends.length, 0);
  });

  it("does not cancel a streamed block reply", async () => {
    const { hooks } = makeApi();
    await toolSent(hooks, "run-a", "Same answer.");
    assert.equal(await slackFinal(hooks, "run-a", "Same answer.", "block"), undefined);
  });

  it("drops the core notice after a cancel, but forwards it for an undelivered run", async () => {
    const { hooks } = makeApi();
    await toolSent(hooks, "run-a", "Same answer.");
    await slackFinal(hooks, "run-a", "Same answer.");
    assert.equal((await slackFinal(hooks, "run-a", NOTICE))?.cancel, true);
    assert.equal(await slackFinal(hooks, "run-z", NOTICE), undefined);
  });

  it("registers no before_agent_finalize hook (2026.9.5 revise rewinds fail the run)", () => {
    const { hooks } = makeApi();
    assert.equal(hooks.has("before_agent_finalize"), false);
  });
});
