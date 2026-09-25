import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const tempState = fs.mkdtempSync(path.join(os.tmpdir(), "slack-guard-final-"));
const guard = await import("../index.js");
const SESSION = "agent:main:slack:channel:c012mutex";
const hooks = new Map();
guard.default({
  pluginConfig: { auditLog: path.join(tempState, "guard.jsonl") },
  runtime: {
    agent: {
      session: {
        getSessionEntry: () => ({
          deliveryContext: { channel: "slack", to: "channel:C012MUTEX", accountId: "default" },
        }),
      },
    },
  },
  on: (name, handler) => hooks.set(name, handler),
});

function final(runId, text, kind = "final", channel = "slack") {
  return hooks.get("reply_payload_sending")(
    { payload: { text }, kind, channel, sessionKey: SESSION, runId },
    { channelId: channel, sessionKey: SESSION, runId },
  );
}

function sentToolResult() {
  return {
    details: {
      channel: "slack",
      deliveryStatus: "sent",
      dryRun: false,
      result: { receipt: { primaryPlatformMessageId: "1700000000.000001" } },
    },
  };
}

function toolSent(runId, message) {
  return hooks.get("after_tool_call")(
    {
      toolName: "message",
      runId,
      params: {
        action: "send",
        channel: "slack",
        target: "C012MUTEX",
        accountId: "default",
        message,
      },
      result: sentToolResult(),
    },
    { sessionKey: SESSION, runId },
  );
}

afterEach(() => guard._resetStateForTests());
after(() => fs.rmSync(tempState, { recursive: true, force: true }));

describe("final reply generation gate", () => {
  it("leaves a fresh final to core host delivery", () => {
    assert.equal(final("run-fresh", "Fresh answer."), undefined);
  });

  it("suppresses an immediate paraphrase after a proven message-tool send", async () => {
    await toolSent("run-one", "Answer sent.");
    assert.equal(final("run-one", "In summary, answer sent.")?.cancel, true);
    assert.equal(final("run-two", "In summary, answer sent."), undefined);
  });

  it("also suppresses a duplicate from webchat-origin Slack session without adapter re-send", async () => {
    await toolSent("run-web", "Delivered by tool.");
    assert.equal(final("run-web", "Delivered by tool.", "final", "webchat")?.cancel, true);
    assert.equal(hooks.has("message_sending"), false);
    assert.equal(hooks.has("message_sent"), false);
  });

  it("does not cancel streamed blocks, media payloads, or a final after real work", async () => {
    await toolSent("run-progress", "Working.");
    assert.equal(final("run-progress", "Working.", "block"), undefined);
    assert.equal(
      hooks.get("reply_payload_sending")(
        {
          payload: { text: "See attachment", mediaUrl: "file:///plot.png" },
          kind: "final",
          sessionKey: SESSION,
          runId: "run-progress",
        },
        { sessionKey: SESSION, runId: "run-progress" },
      ),
      undefined,
    );
    await hooks.get("after_tool_call")(
      { toolName: "read", runId: "run-progress", result: { ok: true } },
      { sessionKey: SESSION, runId: "run-progress" },
    );
    assert.equal(final("run-progress", "Done."), undefined);
  });
});
