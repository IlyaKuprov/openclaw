import { describe, expect, it } from "vitest";
import {
  CodeModePrivateAuthority,
  consumeActiveCodeModeConversationAuthority,
  markTrustedCodeModePreflightSettlement,
  runWithCodeModeConversationAuthority,
} from "./code-mode-private-authority.js";
import type { SettledBridgeRequest } from "./code-mode-runtime.js";

function failedSettlement(id: string): SettledBridgeRequest {
  return { id, ok: false, error: "trusted preparation failed" };
}

function conversation(
  conversationRef = "conv_0123456789abcdef0123456789abcdef",
): Record<string, unknown> {
  return {
    conversationRef,
    channel: "reef",
    accountId: "default",
    kind: "direct",
    target: "reef:peer",
    firstSeenAt: 1,
    lastSeenAt: 2,
  };
}

function deliverConversationList(
  authority: CodeModePrivateAuthority,
  result: unknown,
  id = "bridge:callValue:1",
): void {
  authority.beginBridgeFrontier([
    {
      id,
      conversationListIntent: true,
      conversationListEligible: true,
    },
  ]);
  authority.deliverBridgeSettlements([{ id, conversationListResult: result }]);
}

describe("CodeModePrivateAuthority", () => {
  it("leaves direct exact conversation references on normal tool authorization", async () => {
    const authority = new CodeModePrivateAuthority();
    await runWithCodeModeConversationAuthority(authority, async () => {
      expect(
        consumeActiveCodeModeConversationAuthority("conv_0123456789abcdef0123456789abcdef"),
      ).toBe(true);
    });
  });

  it("accepts only the exact marked failed settlement and consumes it once", () => {
    const authority = new CodeModePrivateAuthority();
    const settlement = failedSettlement("bridge:callValue:1");
    markTrustedCodeModePreflightSettlement(settlement);
    authority.beginBridgeRequest(settlement.id);

    authority.issueTrustedPreflight(settlement);

    expect(authority.consumeTrustedPreflight(settlement.id)).toBe(true);
    expect(authority.consumeTrustedPreflight(settlement.id)).toBe(false);
  });

  it("rejects structural clones, reconstructed failures, and cancellation substitutions", () => {
    const authority = new CodeModePrivateAuthority();
    const exact = failedSettlement("bridge:callValue:1");
    markTrustedCodeModePreflightSettlement(exact);
    authority.beginBridgeRequest(exact.id);

    authority.issueTrustedPreflight({ ...exact });
    authority.issueTrustedPreflight(structuredClone(exact));
    authority.issueTrustedPreflight({
      id: exact.id,
      ok: false,
      error: "code mode bridge call cancelled",
    });

    expect(authority.consumeTrustedPreflight(exact.id)).toBe(false);
  });

  it("invalidates repair authority when any bridge request precedes or follows the preflight", () => {
    const earlier = new CodeModePrivateAuthority();
    earlier.beginBridgeRequest("bridge:callValue:1");
    const laterPreflight = failedSettlement("bridge:callValue:2");
    markTrustedCodeModePreflightSettlement(laterPreflight);
    earlier.beginBridgeRequest(laterPreflight.id);
    earlier.issueTrustedPreflight(laterPreflight);
    expect(earlier.consumeTrustedPreflight(laterPreflight.id)).toBe(false);

    const authority = new CodeModePrivateAuthority();
    const preflight = failedSettlement("bridge:callValue:1");
    markTrustedCodeModePreflightSettlement(preflight);
    authority.beginBridgeRequest(preflight.id);
    authority.issueTrustedPreflight(preflight);
    authority.beginBridgeRequest("bridge:yield:1");
    expect(authority.consumeTrustedPreflight(preflight.id)).toBe(false);
  });

  it("issues conversation authority only for one complete exact address", async () => {
    const authority = new CodeModePrivateAuthority();
    const exact = conversation();
    deliverConversationList(authority, { conversations: [exact], complete: true });

    expect(consumeActiveCodeModeConversationAuthority(exact.conversationRef as string)).toBe(
      undefined,
    );
    await runWithCodeModeConversationAuthority(authority, async () => {
      expect(
        consumeActiveCodeModeConversationAuthority("conv_abcdef0123456789abcdef0123456789"),
      ).toBe(false);
      expect(consumeActiveCodeModeConversationAuthority(exact.conversationRef as string)).toBe(
        true,
      );
      expect(consumeActiveCodeModeConversationAuthority(exact.conversationRef as string)).toBe(
        false,
      );
    });
  });

  it("clears conversation authority before invalid, failed, incomplete, or ambiguous lists", async () => {
    const authority = new CodeModePrivateAuthority();
    const exact = conversation();
    const consumeExact = async () =>
      await runWithCodeModeConversationAuthority(authority, async () =>
        consumeActiveCodeModeConversationAuthority(exact.conversationRef as string),
      );

    for (const next of [
      undefined,
      { conversations: [exact] },
      { conversations: [exact], complete: false },
      { conversations: [], complete: true },
      {
        conversations: [exact, conversation("conv_abcdef0123456789abcdef0123456789")],
        complete: true,
      },
    ]) {
      deliverConversationList(authority, { conversations: [exact], complete: true });
      deliverConversationList(authority, next, "bridge:callValue:2");
      expect(await consumeExact()).toBe(false);
    }
  });

  it("promotes only one isolated delivered list frontier", async () => {
    const exact = conversation();
    const consume = async (authority: CodeModePrivateAuthority) =>
      await runWithCodeModeConversationAuthority(authority, async () =>
        consumeActiveCodeModeConversationAuthority(exact.conversationRef as string),
      );

    for (const frontier of [
      [
        {
          id: "bridge:callValue:1",
          conversationListIntent: true,
          conversationListEligible: true,
        },
        {
          id: "bridge:callValue:2",
          conversationListIntent: false,
          conversationListEligible: false,
        },
      ],
      [
        {
          id: "bridge:callValue:1",
          conversationListIntent: true,
          conversationListEligible: true,
        },
        {
          id: "bridge:callValue:2",
          conversationListIntent: true,
          conversationListEligible: true,
        },
      ],
    ]) {
      const authority = new CodeModePrivateAuthority();
      authority.beginBridgeFrontier(frontier);
      authority.deliverBridgeSettlements(
        frontier.map(({ id, conversationListEligible }) =>
          conversationListEligible
            ? { id, conversationListResult: { conversations: [exact], complete: true } }
            : { id },
        ),
      );
      expect(await consume(authority)).toBe(false);
    }
  });

  it("retains exact pending promotion until delivery and rejects it after revocation", async () => {
    const exact = conversation();
    const retained = new CodeModePrivateAuthority();
    const revoked = new CodeModePrivateAuthority();
    for (const authority of [retained, revoked]) {
      authority.beginBridgeFrontier([
        {
          id: "bridge:callValue:1",
          conversationListIntent: true,
          conversationListEligible: true,
        },
      ]);
    }
    revoked.revoke();
    for (const authority of [retained, revoked]) {
      authority.deliverBridgeSettlements([
        {
          id: "bridge:callValue:1",
          conversationListResult: { conversations: [exact], complete: true },
        },
      ]);
    }

    await runWithCodeModeConversationAuthority(retained, async () => {
      expect(consumeActiveCodeModeConversationAuthority(exact.conversationRef as string)).toBe(
        true,
      );
    });
    await runWithCodeModeConversationAuthority(revoked, async () => {
      expect(consumeActiveCodeModeConversationAuthority(exact.conversationRef as string)).toBe(
        false,
      );
    });
  });

  it("revokes both ledgers and does not serialize private state", async () => {
    const authority = new CodeModePrivateAuthority();
    const settlement = failedSettlement("bridge:callValue:1");
    markTrustedCodeModePreflightSettlement(settlement);
    authority.beginBridgeRequest(settlement.id);
    authority.issueTrustedPreflight(settlement);
    const exact = conversation();
    deliverConversationList(authority, { conversations: [exact], complete: true });

    expect(JSON.stringify(authority)).toBe("{}");
    expect(Object.keys(authority)).toEqual([]);
    authority.revoke();

    expect(authority.consumeTrustedPreflight(settlement.id)).toBe(false);
    await runWithCodeModeConversationAuthority(authority, async () => {
      expect(consumeActiveCodeModeConversationAuthority(exact.conversationRef as string)).toBe(
        false,
      );
    });
  });
});
