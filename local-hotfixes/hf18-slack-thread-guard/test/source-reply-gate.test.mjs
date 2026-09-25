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

it("declares the trusted pre-model result middleware contract", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url)));
  assert.deepEqual(manifest.contracts.agentToolResultMiddleware, ["openclaw"]);
});

function makeApi() {
  const hooks = new Map();
  const api = {
    config: { channels: { slack: { enabled: true } } },
    pluginConfig: { auditLog: path.join(tempState, "guard.jsonl") },
    on(name, handler) {
      hooks.set(name, handler);
    },
    registerAgentToolResultMiddleware(handler, options) {
      assert.deepEqual(options, { runtimes: ["openclaw"] });
      hooks.set("tool_result", handler);
    },
  };
  register(api);
  return { hooks };
}

function sentToolResult(messageId = "1700000000.000001") {
  return {
    content: [{ type: "text", text: "Message sent" }],
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
      messageDelivery: { status: "settled", partialDelivery: false },
    },
  };
}

function beforeTextSend(hooks, runId, message, extra = {}) {
  return hooks.get("before_tool_call")(
    { toolName: "message", runId, params: { action: "send", channel: "slack", message, ...extra } },
    { sessionKey: SESSION, channelId: "slack", runId },
  );
}

function afterMessageDelivered(
  hooks,
  runId,
  params,
  result = sentToolResult(),
  sessionKey = SESSION,
) {
  return hooks.get("tool_result")(
    { toolName: "message", args: params, result },
    { runtime: "openclaw", sessionKey, runId },
  );
}

function afterTextSent(hooks, runId, message, extra = {}) {
  return afterMessageDelivered(hooks, runId, {
    action: "send",
    channel: "slack",
    target: "C012AUDIT",
    accountId: "default",
    message,
    ...extra,
  });
}

function afterOtherTool(hooks, runId, toolName = "read") {
  return hooks.get("tool_result")(
    { toolName, args: {}, result: { content: [], details: { ok: true } } },
    { runtime: "openclaw", sessionKey: SESSION, runId },
  );
}

afterEach(() => {
  reset();
  fs.writeFileSync(sessionsPath, "{}\n");
});
after(() => fs.rmSync(tempState, { recursive: true, force: true }));

describe("source-reply generation gate", () => {
  it("settles before a final even while detached after_tool_call has not completed", () => {
    const { hooks } = makeApi();
    assert.equal(hooks.has("after_tool_call"), false);
    const event = {
      toolName: "message",
      args: {
        action: "send",
        channel: "slack",
        target: "C012AUDIT",
        accountId: "default",
        message: "Answer.",
      },
      result: sentToolResult(),
    };
    const ctx = { runtime: "openclaw", sessionKey: SESSION, runId: "ordered-run" };
    // The host awaits this pre-model result stage. The handler itself does
    // not defer its state transition behind an async route lookup.
    assert.equal(hooks.get("tool_result")(event, ctx), undefined);
    const final = hooks.get("reply_payload_sending")(
      {
        kind: "final",
        sessionKey: SESSION,
        runId: ctx.runId,
        payload: { text: "In short, answer." },
      },
      ctx,
    );
    assert.equal(final?.cancel, true);
    assert.equal(
      hooks.get("tool_result")({ toolName: "read", args: {}, result: {} }, ctx),
      undefined,
    );
    const freshFinal = hooks.get("reply_payload_sending")(
      { kind: "final", sessionKey: SESSION, runId: ctx.runId, payload: { text: "New result." } },
      ctx,
    );
    assert.equal(freshFinal, undefined);
  });

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
        params: {
          action: "upload-file",
          channel: "slack",
          media: "file:///p.png",
          caption: "plot",
        },
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
    const withMedia = await beforeTextSend(hooks, "run-a", "See attached.", {
      media: "file:///x.png",
    });
    assert.notEqual(withMedia?.block, true);
  });

  for (const [field, value] of [
    ["presentation", { blocks: [{ type: "text", text: "chart" }] }],
    ["interactive", { buttons: [{ label: "Open" }] }],
    ["location", { latitude: 1, longitude: 2 }],
    ["channelData", { slack: { blocks: [{ type: "section", text: "detail" }] } }],
    ["mediaUrls", ["file:///plot.png"]],
    ["voiceText", "Spoken answer"],
    ["fallbackText", "Accessible detail"],
    ["btw", true],
    ["delivery", { pin: "recipient" }],
  ]) {
    it(`does not gate a text send with recipient-visible ${field}`, async () => {
      const { hooks } = makeApi();
      await afterTextSent(hooks, "run-rich", "Answer.");
      const rich = await beforeTextSend(hooks, "run-rich", "New item", { [field]: value });
      assert.notEqual(rich?.block, true);
    });
  }

  it("does not arm the gate on a failed send, so the retry is allowed", async () => {
    const { hooks } = makeApi();
    const failed = sentToolResult();
    failed.details.deliveryStatus = "failed";
    failed.details.messageDelivery.status = "failed";
    await afterMessageDelivered(
      hooks,
      "run-a",
      { action: "send", channel: "slack", message: "Answer." },
      failed,
    );
    const retry = await beforeTextSend(hooks, "run-a", "Answer.");
    assert.notEqual(retry?.block, true);
  });

  it("does not arm on partial delivery even with a platform receipt", async () => {
    const { hooks } = makeApi();
    const partial = sentToolResult();
    partial.details.deliveryStatus = "partial_failed";
    partial.details.messageDelivery.partialDelivery = true;
    await afterMessageDelivered(
      hooks,
      "partial-run",
      {
        action: "send",
        channel: "slack",
        target: "C012AUDIT",
        accountId: "default",
        message: "Part",
      },
      partial,
    );
    assert.equal(
      hooks.get("reply_payload_sending")(
        {
          kind: "final",
          sessionKey: SESSION,
          runId: "partial-run",
          payload: { text: "Complete answer" },
        },
        { sessionKey: SESSION, runId: "partial-run" },
      ),
      undefined,
    );
  });

  it("does not gate distinct Slack notifications from a non-Slack source session", async () => {
    const { hooks } = makeApi();
    const ctx = { sessionKey: "agent:main:main", channelId: "webchat", runId: "web-run" };
    await afterMessageDelivered(
      hooks,
      "web-run",
      { action: "send", channel: "slack", target: "C111", message: "First" },
      sentToolResult(),
      ctx.sessionKey,
    );
    const next = await hooks.get("before_tool_call")(
      {
        toolName: "message",
        runId: "web-run",
        params: { action: "send", channel: "slack", target: "C222", message: "Second" },
      },
      ctx,
    );
    assert.notEqual(next?.block, true);
  });

  it("does not arm a source-reply gate for a different Slack target", async () => {
    const { hooks } = makeApi();
    await afterTextSent(hooks, "cross-target", "First", { target: "C999OTHER" });
    const next = await beforeTextSend(hooks, "cross-target", "Second", { target: "C012AUDIT" });
    assert.notEqual(next?.block, true);
  });

  it("does not suppress the final for a send to the right target under a different account", async () => {
    const { hooks } = makeApi();
    await afterTextSent(hooks, "cross-account", "Wrong account", { accountId: "other" });
    const final = hooks.get("reply_payload_sending")(
      {
        payload: { text: "Correct account final" },
        kind: "final",
        channel: "slack",
        sessionKey: SESSION,
        runId: "cross-account",
      },
      { channelId: "slack", sessionKey: SESSION, runId: "cross-account" },
    );
    assert.equal(final, undefined);
  });

  it("cancels a paraphrased canonical final once the model already replied", async () => {
    const { hooks } = makeApi();
    await afterTextSent(hooks, "run-a", "The coupling constant is 7.2 Hz.");
    const result = await hooks.get("reply_payload_sending")(
      {
        payload: { text: "To summarise, J = 7.2 Hz." },
        kind: "final",
        channel: "slack",
        sessionKey: SESSION,
        runId: "run-a",
      },
      { channelId: "slack", sessionKey: SESSION, runId: "run-a" },
    );
    assert.equal(result?.cancel, true);
  });

  it("lets a genuine canonical final through after real work advanced the generation", async () => {
    const { hooks } = makeApi();
    await afterTextSent(hooks, "run-b", "Working on it.");
    await afterOtherTool(hooks, "run-b", "bash");
    const result = await hooks.get("reply_payload_sending")(
      {
        payload: { text: "Done: the fit converged." },
        kind: "final",
        channel: "slack",
        sessionKey: SESSION,
        runId: "run-b",
      },
      { channelId: "slack", sessionKey: SESSION, runId: "run-b" },
    );
    assert.equal(result, undefined);
  });
});
