import { afterEach, describe, expect, it } from "vitest";
import { createAnthropicTransportAccounting } from "./anthropic-transport-accounting.js";
import {
  captureEvents,
  model,
  restoreTransportHost,
  terminalUsage,
} from "./anthropic-transport-accounting.test-support.js";

afterEach(restoreTransportHost);

describe("Anthropic transport accounting fallbacks", () => {
  it("reconciles a no-boundary provider fallback from terminal usage", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-no-boundary" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeTerminalUsage(terminalUsage("claude-opus-5"));
    accounting.sealTerminalUsage();
    const resolution = accounting.completeSuccess();

    expect(resolution).toMatchObject({
      traceValid: true,
      servingModel: "claude-opus-5",
      transitions: [{ fromModel: "claude-fable-5", toModel: "claude-opus-5" }],
    });
    expect(events.map((event) => event.type)).toEqual(["provider_fallback", "attempt"]);
  });

  it.each([
    {
      label: "named direct terminal usage with both models absent",
      usage: { iterations: [{ type: "message", model: model.id }] },
      boundary: { fromModel: null, toModel: null },
    },
    {
      label: "named direct terminal usage with the source absent",
      usage: { iterations: [{ type: "message", model: model.id }] },
      boundary: { fromModel: null, toModel: "claude-opus-5" },
    },
    {
      label: "named direct terminal usage with the target absent",
      usage: { iterations: [{ type: "message", model: model.id }] },
      boundary: { fromModel: model.id, toModel: null },
    },
    {
      label: "unknown direct terminal usage with both models absent",
      usage: { iterations: [{ type: "message" }] },
      boundary: { fromModel: null, toModel: null },
    },
    {
      label: "unknown direct terminal usage with the source absent",
      usage: { iterations: [{ type: "message" }] },
      boundary: { fromModel: null, toModel: "claude-opus-5" },
    },
    {
      label: "unknown direct terminal usage with the target absent",
      usage: { iterations: [{ type: "message" }] },
      boundary: { fromModel: model.id, toModel: null },
    },
  ])("rejects $label", async ({ boundary, usage }) => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-invalid-direct-boundary" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary(boundary);
    accounting.observeTerminalUsage(usage);
    accounting.sealTerminalUsage();

    expect(accounting.completeSuccess()).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("reconciles and deduplicates a contiguous two-hop fallback chain", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-two-hop" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-sonnet-5",
    });
    accounting.observeFallbackBoundary({
      fromModel: "claude-sonnet-5",
      toModel: "claude-opus-5",
    });
    accounting.observeTerminalUsage(
      terminalUsage("claude-opus-5", ["claude-fable-5", "claude-sonnet-5"]),
    );
    accounting.sealTerminalUsage();
    accounting.completeSuccess();

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider_fallback",
        fromModel: "claude-fable-5",
        toModel: "claude-sonnet-5",
      }),
      expect.objectContaining({
        type: "provider_fallback",
        fromModel: "claude-sonnet-5",
        toModel: "claude-opus-5",
      }),
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
    ]);
  });

  it("rejects contradictory same-source fallback blocks as actual declined hops", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-failed-fallback-seam" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-sonnet-5",
    });
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-opus-5",
    });
    accounting.observeTerminalUsage(terminalUsage("claude-opus-5", ["claude-fable-5"]));
    accounting.sealTerminalUsage();
    const resolution = accounting.completeSuccess();

    expect(resolution).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("selects the terminal middleware hop from provisional same-source candidates", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      fallbackBoundaryAuthority: "client_provisional",
      model,
      options: { requestId: "call-middleware-failed-candidate" },
      serverFallbackEnabled: false,
    });
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-sonnet-5",
    });
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-opus-5",
    });
    accounting.observeFallbackContent();
    accounting.observeTerminalUsage(terminalUsage("claude-opus-5", ["claude-fable-5"]));
    accounting.sealTerminalUsage();

    expect(accounting.completeSuccess()).toEqual({
      traceValid: true,
      transitions: [{ fromModel: "claude-fable-5", toModel: "claude-opus-5" }],
      productTransitions: [{ fromModel: "claude-fable-5", toModel: "claude-opus-5" }],
      servingModel: "claude-opus-5",
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("rejects a trailing provisional middleware candidate after the served route", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      fallbackBoundaryAuthority: "client_provisional",
      model,
      options: { requestId: "call-middleware-trailing-candidate" },
      serverFallbackEnabled: false,
    });
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-opus-5",
    });
    accounting.observeFallbackContent();
    accounting.observeFallbackBoundary({
      fromModel: "claude-opus-5",
      toModel: "claude-sonnet-5",
    });
    accounting.observeTerminalUsage(terminalUsage("claude-opus-5", ["claude-fable-5"]));
    accounting.sealTerminalUsage();

    expect(accounting.completeSuccess()).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [{ fromModel: "claude-fable-5", toModel: "claude-opus-5" }],
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("requires one fallback block for every declined terminal hop", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-missing-fallback-block" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeTerminalUsage(terminalUsage("claude-opus-5", ["claude-fable-5"]));
    accounting.sealTerminalUsage();

    expect(accounting.completeSuccess()).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("rejects a non-adjacent fallback route cycle", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-fallback-cycle" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-sonnet-5",
    });
    accounting.observeFallbackBoundary({
      fromModel: "claude-sonnet-5",
      toModel: "claude-fable-5",
    });
    accounting.observeTerminalUsage(
      terminalUsage("claude-fable-5", ["claude-fable-5", "claude-sonnet-5"]),
    );
    accounting.sealTerminalUsage();

    expect(accounting.completeSuccess()).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("accepts a boundary-free direct iteration with no model identity", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-direct-undefined-model" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeTerminalUsage({ iterations: [{ type: "message" }] });
    accounting.sealTerminalUsage();
    const resolution = accounting.completeSuccess();

    expect(resolution).toEqual({
      traceValid: true,
      transitions: [],
      productTransitions: [],
    });
    expect(events).toEqual([expect.objectContaining({ type: "attempt", outcome: "completed" })]);
  });

  it("collapses repeated sampling iterations from the same fallback hop", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-tool-loop" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-opus-5",
    });
    accounting.observeTerminalUsage(
      terminalUsage("claude-opus-5", ["claude-fable-5", "claude-fable-5"]),
    );
    accounting.sealTerminalUsage();
    const resolution = accounting.completeSuccess();

    expect(resolution.traceValid).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({
        type: "provider_fallback",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      }),
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
    ]);
  });

  it.each([
    { label: "missing usage", usage: undefined },
    { label: "null iterations", usage: { iterations: null } },
    { label: "malformed iterations", usage: { iterations: [{}] } },
    {
      label: "unknown iteration type",
      usage: { iterations: [{ type: "future_iteration", model: "claude-fable-5" }] },
    },
    {
      label: "compaction-only iterations",
      usage: { iterations: [{ type: "compaction" }] },
    },
    {
      label: "advisor-only iterations",
      usage: {
        iterations: [{ type: "advisor_message", model: "claude-fable-5" }],
      },
    },
    {
      label: "mixed non-serving iterations",
      usage: {
        iterations: [
          { type: "compaction" },
          { type: "advisor_message", model: "claude-fable-5" },
          { type: "compaction" },
        ],
      },
    },
    {
      label: "contradictory boundary",
      usage: terminalUsage("claude-opus-5", ["claude-fable-5"]),
      boundaries: [{ fromModel: "claude-fable-5", toModel: "claude-sonnet-5" }],
    },
    {
      label: "contradictory intermediate hop",
      usage: terminalUsage("claude-opus-5", ["claude-fable-5", "claude-haiku-5"]),
      boundaries: [
        { fromModel: "claude-fable-5", toModel: "claude-sonnet-5" },
        { fromModel: "claude-sonnet-5", toModel: "claude-opus-5" },
      ],
    },
  ])(
    "preserves the physical attempt and lowers fallback coverage for $label",
    async ({ usage, boundaries }) => {
      const events = captureEvents();
      const accounting = createAnthropicTransportAccounting({
        model,
        options: { requestId: "call-invalid-fallback" },
        serverFallbackEnabled: true,
      });
      await accounting.wrapFetch(async () => {
        accounting.onFetchDispatch();
        return new Response("", { status: 200 });
      }, "dispatch_attested")("https://example.test");
      for (const boundary of boundaries ?? []) {
        accounting.observeFallbackBoundary(boundary);
      }
      accounting.observeTerminalUsage(usage);
      accounting.sealTerminalUsage();
      const resolution = accounting.completeSuccess();

      expect(resolution.traceValid).toBe(false);
      expect(resolution.productTransitions).toEqual([]);
      expect(resolution.servingModel).toBeUndefined();
      expect(events).toEqual([
        expect.objectContaining({
          type: "attempt",
          outcome: "completed",
          statusCode: 200,
        }),
        expect.objectContaining({
          type: "coverage",
          scope: "provider_fallbacks",
          state: "lower_bound",
          reason: "terminal_metadata_unavailable",
        }),
      ]);
    },
  );

  it("lowers injected no-boundary fallback accounting when terminal metadata is invalid", () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-injected-invalid-terminal-fallback" },
      serverFallbackEnabled: false,
    });
    accounting.observeSemanticCoverage("transport_endpoint_authority_partial");
    accounting.observeTerminalUsage({
      iterations: [
        { type: "fallback_message", model: "claude-opus-5" },
        { type: "message", model: "claude-fable-5" },
      ],
    });
    accounting.sealTerminalUsage();

    expect(accounting.completeSuccess()).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [],
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "coverage",
          scope: "transport_semantics",
          reason: "transport_endpoint_authority_partial",
        }),
        expect.objectContaining({
          type: "coverage",
          scope: "provider_fallbacks",
          state: "lower_bound",
        }),
      ]),
    );
  });

  it("retains a content-confirmed product transition when terminal usage is malformed", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-product-boundary-malformed-usage" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-opus-5",
    });
    accounting.observeFallbackContent();
    accounting.observeTerminalUsage({ iterations: [{}] });
    accounting.sealTerminalUsage();
    const resolution = accounting.completeSuccess();

    expect(resolution).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [
        {
          fromModel: "claude-fable-5",
          toModel: "claude-opus-5",
        },
      ],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("retains every contiguous product hop confirmed before malformed terminal usage", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-product-chain-malformed-usage" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-sonnet-5",
    });
    accounting.observeFallbackBoundary({
      fromModel: "claude-sonnet-5",
      toModel: "claude-opus-5",
    });
    accounting.observeFallbackContent();
    accounting.observeTerminalUsage({ iterations: [{}] });
    accounting.sealTerminalUsage();

    expect(accounting.completeSuccess()).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [
        {
          fromModel: "claude-fable-5",
          toModel: "claude-sonnet-5",
        },
        {
          fromModel: "claude-sonnet-5",
          toModel: "claude-opus-5",
        },
      ],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("does not commit a contiguous product chain without following content", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-product-chain-no-content" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-sonnet-5",
    });
    accounting.observeFallbackBoundary({
      fromModel: "claude-sonnet-5",
      toModel: "claude-opus-5",
    });
    accounting.observeTerminalUsage({ iterations: [{}] });
    accounting.sealTerminalUsage();

    expect(accounting.completeSuccess()).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("does not project malformed fallback identities into product attribution", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-malformed-product-boundary" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: null,
      toModel: null,
    });
    accounting.observeFallbackContent();
    accounting.observeTerminalUsage({ iterations: [{}] });
    accounting.sealTerminalUsage();

    expect(accounting.completeSuccess()).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });
});
