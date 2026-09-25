import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const tempState = fs.mkdtempSync(path.join(os.tmpdir(), "slack-guard-route-"));
const guard = await import("../index.js");
const SESSION = "agent:main:slack:channel:c012audit";
const TARGET = "channel:C012AUDIT";
const rows = new Map();

function makeApi(config = {}) {
  const hooks = new Map();
  const reads = [];
  let adapterLoads = 0;
  guard.default({
    pluginConfig: { auditLog: path.join(tempState, "guard.jsonl"), ...config },
    runtime: {
      agent: {
        session: {
          getSessionEntry(input) {
            reads.push(input);
            return rows.get(input.sessionKey);
          },
        },
      },
      channel: {
        outbound: {
          loadAdapter() {
            adapterLoads += 1;
            throw new Error("Plugin must never acquire an outbound adapter");
          },
        },
      },
    },
    on(name, handler) {
      hooks.set(name, handler);
    },
  });
  return { hooks, reads, adapterLoads: () => adapterLoads };
}

function persisted(key = SESSION, accountId = "work") {
  rows.set(key, {
    sessionId: "canonical-session",
    deliveryContext: { channel: "slack", to: TARGET, accountId },
  });
}

function route(hooks, sessionKey = SESSION, original = { channel: "webchat", to: "web-user" }) {
  return hooks.get("outbound_route_decision")({ sessionKey, original }, { channelId: "slack" });
}

afterEach(() => {
  guard._resetStateForTests();
  rows.clear();
});
after(() => fs.rmSync(tempState, { recursive: true, force: true }));

describe("pure declarative route decision", () => {
  it("requests the persisted Slack channel, account, and root from a webchat-origin Slack session", () => {
    persisted();
    const { hooks, reads, adapterLoads } = makeApi();
    const decision = route(hooks);
    assert.deepEqual(decision, {
      channel: "slack",
      to: TARGET,
      accountId: "work",
      threadPolicy: "root",
    });
    assert.equal(decision instanceof Promise, false);
    assert.deepEqual(reads, [{ sessionKey: SESSION, readConsistency: "latest" }]);
    assert.equal(adapterLoads(), 0);
  });

  it("requests root even when the direct Slack reply inherited a thread", () => {
    const threaded = `${SESSION}:thread:1712345678.123456`;
    persisted(threaded);
    const { hooks } = makeApi();
    assert.deepEqual(
      route(hooks, threaded, {
        channel: "slack",
        to: TARGET,
        accountId: "work",
        threadId: "1712345678.123456",
      }),
      { channel: "slack", to: TARGET, accountId: "work", threadPolicy: "root" },
    );
  });

  it("returns no route for an ordinary session", () => {
    const { hooks, reads } = makeApi();
    assert.equal(route(hooks, "agent:main:main"), undefined);
    assert.equal(reads.length, 0);
  });

  it("retains the explicit cross-surface opt-out without skipping direct Slack root policy", () => {
    persisted();
    const { hooks } = makeApi({ rerouteNonSlackDelivery: false });
    assert.equal(route(hooks), undefined);
    assert.deepEqual(route(hooks, SESSION, { channel: "slack", to: TARGET, accountId: "work" }), {
      channel: "slack",
      to: TARGET,
      accountId: "work",
      threadPolicy: "root",
    });
  });

  it("fails closed on a missing canonical row or persisted Slack account, without key fallback", () => {
    const { hooks, adapterLoads } = makeApi();
    assert.throws(() => route(hooks), /matching persisted channel and account/);
    rows.set(SESSION, { deliveryContext: { channel: "slack", to: TARGET } });
    assert.throws(() => route(hooks), /matching persisted channel and account/);
    assert.equal(adapterLoads(), 0);
  });

  it("fails closed on conflicting persisted destinations or accounts", () => {
    persisted();
    rows.get(SESSION).lastChannel = "slack";
    rows.get(SESSION).lastTo = "channel:C999WRONG";
    rows.get(SESSION).lastAccountId = "work";
    const { hooks } = makeApi();
    assert.throws(() => route(hooks), /matching persisted channel and account/);
    rows.get(SESSION).lastTo = TARGET;
    rows.get(SESSION).lastAccountId = "other";
    assert.throws(() => route(hooks), /matching persisted channel and account/);
  });

  it("rejects a persisted target that conflicts with the canonical session key", () => {
    rows.set(SESSION, {
      deliveryContext: { channel: "slack", to: "channel:C999WRONG", accountId: "work" },
    });
    const { hooks } = makeApi();
    assert.throws(() => route(hooks), /matching persisted channel and account/);
  });

  it("rejects noncanonical targets and non-channel Slack sessions", () => {
    rows.set(SESSION, {
      deliveryContext: { channel: "slack", to: "C012AUDIT", accountId: "work" },
    });
    const { hooks } = makeApi();
    assert.throws(() => route(hooks), /canonical persisted channel target/);
    const dm = "agent:main:slack:direct:u123";
    rows.set(dm, { deliveryContext: { channel: "slack", to: "user:U123", accountId: "work" } });
    assert.throws(() => route(hooks, dm), /matching persisted channel and account/);
  });

  it("does not send if the host discards a decision after a deadline", async () => {
    persisted();
    const { hooks, adapterLoads } = makeApi();
    const decision = route(hooks);
    assert.equal(decision.threadPolicy, "root");
    // Only the host is permitted to take custody; discarding a timed-out
    // decision cannot leave an in-flight plugin send to complete later.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(adapterLoads(), 0);
  });
});

describe("message-tool root and identity guard", () => {
  it("rewrites target, account, and all inherited thread fields", async () => {
    persisted();
    const { hooks } = makeApi();
    const result = await hooks.get("before_tool_call")(
      {
        toolName: "message",
        runId: "tool-run",
        params: {
          action: "send",
          channel: "webchat",
          target: "C999WRONG",
          accountId: "other",
          message: "Answer",
          threadId: "old-thread",
          replyTo: "old-reply",
          topLevel: false,
          targets: ["C999WRONG"],
        },
      },
      { sessionKey: SESSION, channelId: "webchat", runId: "tool-run" },
    );
    assert.equal(result.params.channel, "slack");
    assert.equal(result.params.target, "C012AUDIT");
    assert.equal(result.params.accountId, "work");
    assert.equal(result.params.threadId, null);
    assert.equal(result.params.replyTo, null);
    assert.equal(result.params.topLevel, true);
    assert.deepEqual(result.params.targets, []);
  });

  it("blocks a tool send when the persisted route conflicts", async () => {
    rows.set(SESSION, {
      deliveryContext: { channel: "slack", to: "channel:C999WRONG", accountId: "work" },
    });
    const { hooks } = makeApi();
    const result = await hooks.get("before_tool_call")(
      { toolName: "message", params: { action: "send", channel: "slack", message: "Answer" } },
      { sessionKey: SESSION },
    );
    assert.equal(result.block, true);
  });
});
