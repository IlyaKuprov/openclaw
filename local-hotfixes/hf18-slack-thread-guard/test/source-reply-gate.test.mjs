import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

// Regression coverage for the per-run source-reply generation gate that
// suppresses Slack answer repetition. See diagnosis job 1785365205-063909:
//   - immediate paraphrased double-send in one logical run, and
//   - post-compaction restatement before any new substantive work.
// The gate must NOT touch legitimate flows: the first reply, a genuine progress
// update after real work, identical text in a new run, or artefact delivery.

const tempState = fs.mkdtempSync(path.join(os.tmpdir(), "slack-guard-gate-"));
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

function beforeTextSend(hooks, runId, message, extra = {}) {
  return hooks.get("before_tool_call")(
    { toolName: "message", runId, params: { action: "send", channel: "slack", message, ...extra } },
    { sessionKey: SESSION, channelId: "slack", runId },
  );
}

function afterMessageDelivered(hooks, runId, params, result = sentToolResult()) {
  return hooks.get("after_tool_call")(
    { toolName: "message", runId, params, result },
    { sessionKey: SESSION, runId },
  );
}

function afterTextSent(hooks, runId, message, extra = {}) {
  return afterMessageDelivered(hooks, runId, { action: "send", channel: "slack", message, ...extra });
}

function afterOtherTool(hooks, runId, toolName = "read") {
  return hooks.get("after_tool_call")(
    { toolName, runId, params: {}, result: { ok: true } },
    { sessionKey: SESSION, runId },
  );
}

afterEach(() => {
  reset();
  fs.writeFileSync(sessionsPath, "{}\n");
});
after(() => fs.rmSync(tempState, { recursive: true, force: true }));

describe("source-reply generation gate", () => {
  it("allows the first plain-text reply in a fresh run", async () => {
    const { hooks } = makeApi();
    const result = await beforeTextSend(hooks, "run-a", "First answer");
    assert.notEqual(result?.block, true);
  });

  it("blocks an immediate paraphrased second send with no work between", async () => {
    const { hooks } = makeApi();
    assert.notEqual((await beforeTextSend(hooks, "run-a", "The answer is 42."))?.block, true);
    await afterTextSent(hooks, "run-a", "The answer is 42.");
    const second = await beforeTextSend(hooks, "run-a", "In short, it is 42.");
    assert.equal(second.block, true);
    assert.match(second.blockReason, /already delivered/i);
  });

  it("blocks a post-compaction restatement (state persists across attempts, same run)", async () => {
    const { hooks } = makeApi();
    await afterTextSent(hooks, "run-a", "Progress: parsing complete.");
    // A compaction retry runs no tool between the prior send and the resend;
    // module-scoped gate state and the stable runId keep the gate armed.
    const resend = await beforeTextSend(hooks, "run-a", "Update: I have finished parsing.");
    assert.equal(resend.block, true);
  });

  it("allows a genuine progress update after a non-message tool advances the generation", async () => {
    const { hooks } = makeApi();
    await afterTextSent(hooks, "run-a", "Working on it.");
    await afterOtherTool(hooks, "run-a", "read");
    const update = await beforeTextSend(hooks, "run-a", "Here is the result.");
    assert.notEqual(update?.block, true);
  });

  it("allows identical text in a different run (new inbound event)", async () => {
    const { hooks } = makeApi();
    await afterTextSent(hooks, "run-a", "Same answer.");
    const other = await beforeTextSend(hooks, "run-b", "Same answer.");
    assert.notEqual(other?.block, true);
  });

  it("never gates an upload-file delivery, and an upload advances the generation", async () => {
    const { hooks } = makeApi();
    await afterTextSent(hooks, "run-a", "Here is the plot.");
    const upload = await hooks.get("before_tool_call")(
      {
        toolName: "message",
        runId: "run-a",
        params: { action: "upload-file", channel: "slack", media: "file:///p.png", caption: "plot" },
      },
      { sessionKey: SESSION, channelId: "slack", runId: "run-a" },
    );
    assert.notEqual(upload?.block, true);
    await afterMessageDelivered(hooks, "run-a", {
      action: "upload-file",
      channel: "slack",
      media: "file:///p.png",
    });
    const followUp = await beforeTextSend(hooks, "run-a", "That plot shows the fit.");
    assert.notEqual(followUp?.block, true);
  });

  it("does not gate a text send that also carries an artefact", async () => {
    const { hooks } = makeApi();
    await afterTextSent(hooks, "run-a", "Answer.");
    const withMedia = await beforeTextSend(hooks, "run-a", "See attached.", { media: "file:///x.png" });
    assert.notEqual(withMedia?.block, true);
  });

  it("does not arm the gate on a failed send, so the retry is allowed", async () => {
    const { hooks } = makeApi();
    const failed = sentToolResult();
    failed.details.deliveryStatus = "failed";
    await afterMessageDelivered(hooks, "run-a", { action: "send", channel: "slack", message: "Answer." }, failed);
    const retry = await beforeTextSend(hooks, "run-a", "Answer.");
    assert.notEqual(retry?.block, true);
  });

  it("cancels a paraphrased canonical final once the model already replied", async () => {
    const { hooks, sends } = makeApi();
    await afterTextSent(hooks, "run-a", "The coupling constant is 7.2 Hz.");
    const result = await hooks.get("reply_payload_sending")(
      { payload: { text: "To summarise, J = 7.2 Hz." }, kind: "final", channel: "slack", sessionKey: SESSION, runId: "run-a" },
      { channelId: "slack", sessionKey: SESSION, runId: "run-a" },
    );
    assert.equal(result?.cancel, true);
    assert.equal(sends.length, 0);
  });

  it("lets a genuine canonical final through after real work advanced the generation", async () => {
    const { hooks, sends } = makeApi();
    await afterTextSent(hooks, "run-b", "Working on it.");
    await afterOtherTool(hooks, "run-b", "bash");
    const result = await hooks.get("reply_payload_sending")(
      { payload: { text: "Done: the fit converged." }, kind: "final", channel: "slack", sessionKey: SESSION, runId: "run-b" },
      { channelId: "slack", sessionKey: SESSION, runId: "run-b" },
    );
    assert.equal(result, undefined);
    assert.equal(sends.length, 0);
  });
});
