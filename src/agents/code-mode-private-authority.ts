import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SettledBridgeRequest } from "./code-mode-runtime.js";

const MAX_CONVERSATION_LIST_ITEMS = 100;
const CONVERSATION_REF_PATTERN = /^conv_[a-f0-9]{32}$/u;
const trustedPreflightSettlements = new WeakSet<object>();
const activeConversationAuthority = new AsyncLocalStorage<CodeModePrivateAuthority>();

type ConversationAddress = {
  conversationRef: string;
  channel: string;
  accountId: string;
  kind: "direct" | "group" | "channel";
  target: string;
  threadId?: string;
};

function readConversationAddress(value: unknown): ConversationAddress | undefined {
  if (
    !isRecord(value) ||
    typeof value.conversationRef !== "string" ||
    !CONVERSATION_REF_PATTERN.test(value.conversationRef) ||
    typeof value.channel !== "string" ||
    !value.channel ||
    typeof value.accountId !== "string" ||
    !value.accountId ||
    (value.kind !== "direct" && value.kind !== "group" && value.kind !== "channel") ||
    typeof value.target !== "string" ||
    !value.target ||
    (value.threadId !== undefined && (typeof value.threadId !== "string" || !value.threadId))
  ) {
    return undefined;
  }
  return {
    conversationRef: value.conversationRef,
    channel: value.channel,
    accountId: value.accountId,
    kind: value.kind,
    target: value.target,
    ...(value.threadId ? { threadId: value.threadId } : {}),
  };
}

/** Mark the exact failed settlement produced by a trusted host preparation boundary. */
export function markTrustedCodeModePreflightSettlement(settlement: SettledBridgeRequest): void {
  if (!settlement.ok) {
    trustedPreflightSettlements.add(settlement);
  }
}

/**
 * Opaque process-local authority for one outer Code Mode exec.
 *
 * Private fields keep both ledgers out of JSON, worker data, snapshots, and
 * transcript projection. The same object is retained while a run is parked.
 */
export class CodeModePrivateAuthority {
  readonly #trustedPreflightClaims = new Set<string>();
  readonly #bridgeRequestIds = new Set<string>();
  readonly #undeliveredBridgeRequestIds = new Set<string>();
  #conversation?: ConversationAddress;
  #pendingConversationListRequestId?: string;
  #conversationSelectionRequired = false;
  #repairRevoked = false;
  #revoked = false;

  beginBridgeRequest(bridgeRequestId: string): void {
    if (this.#revoked || this.#bridgeRequestIds.has(bridgeRequestId)) {
      return;
    }
    this.#bridgeRequestIds.add(bridgeRequestId);
    if (this.#bridgeRequestIds.size > 1) {
      this.#trustedPreflightClaims.clear();
      this.#repairRevoked = true;
    }
  }

  beginBridgeFrontier(
    requests: readonly {
      id: string;
      conversationListIntent: boolean;
      conversationListEligible: boolean;
    }[],
  ): void {
    if (this.#revoked || requests.length === 0) {
      return;
    }
    const hadUndeliveredRequests = this.#undeliveredBridgeRequestIds.size > 0;
    const conversationListRequests = requests.filter((request) => request.conversationListIntent);
    for (const request of requests) {
      this.beginBridgeRequest(request.id);
      this.#undeliveredBridgeRequestIds.add(request.id);
    }
    if (conversationListRequests.length > 0) {
      this.#conversationSelectionRequired = true;
      this.#conversation = undefined;
    }
    this.#pendingConversationListRequestId = undefined;
    const [request] = conversationListRequests;
    if (
      !hadUndeliveredRequests &&
      requests.length === 1 &&
      conversationListRequests.length === 1 &&
      request?.conversationListEligible
    ) {
      this.#pendingConversationListRequestId = request.id;
    }
  }

  deliverBridgeSettlements(
    settlements: readonly {
      id: string;
      conversationListResult?: unknown;
    }[],
  ): void {
    for (const settlement of settlements) {
      this.#undeliveredBridgeRequestIds.delete(settlement.id);
    }
    const pendingRequestId = this.#pendingConversationListRequestId;
    if (!pendingRequestId) {
      return;
    }
    const delivered = settlements.find((settlement) => settlement.id === pendingRequestId);
    if (!delivered) {
      return;
    }
    this.#pendingConversationListRequestId = undefined;
    this.#conversation = undefined;
    const result = delivered.conversationListResult;
    if (!isRecord(result) || result.complete !== true || !Array.isArray(result.conversations)) {
      return;
    }
    if (result.conversations.length > MAX_CONVERSATION_LIST_ITEMS) {
      return;
    }
    if (result.conversations.length !== 1) {
      return;
    }
    this.#conversation = readConversationAddress(result.conversations[0]);
  }

  consumeConversation(conversationRef: string): boolean {
    if (this.#revoked) {
      return false;
    }
    if (!this.#conversationSelectionRequired) {
      return true;
    }
    if (this.#conversation?.conversationRef !== conversationRef) {
      return false;
    }
    this.#conversation = undefined;
    return true;
  }

  issueTrustedPreflight(settlement: SettledBridgeRequest): void {
    if (
      this.#revoked ||
      this.#repairRevoked ||
      settlement.ok ||
      this.#bridgeRequestIds.size !== 1 ||
      !this.#bridgeRequestIds.has(settlement.id) ||
      !trustedPreflightSettlements.has(settlement) ||
      this.#trustedPreflightClaims.has(settlement.id)
    ) {
      return;
    }
    this.#trustedPreflightClaims.add(settlement.id);
  }

  consumeTrustedPreflight(bridgeRequestId: string | undefined): boolean {
    if (this.#revoked || this.#repairRevoked || !bridgeRequestId) {
      return false;
    }
    if (!this.#trustedPreflightClaims.has(bridgeRequestId)) {
      return false;
    }
    this.#trustedPreflightClaims.delete(bridgeRequestId);
    return true;
  }

  revoke(): void {
    this.#revoked = true;
    this.#repairRevoked = true;
    this.#trustedPreflightClaims.clear();
    this.#bridgeRequestIds.clear();
    this.#undeliveredBridgeRequestIds.clear();
    this.#conversationSelectionRequired = true;
    this.#conversation = undefined;
    this.#pendingConversationListRequestId = undefined;
  }
}

/** Scope one nested tool execution to its owning Code Mode run authority. */
export async function runWithCodeModeConversationAuthority<T>(
  authority: CodeModePrivateAuthority,
  operation: () => Promise<T>,
): Promise<T> {
  return await activeConversationAuthority.run(authority, operation);
}

/**
 * Consume the active Code Mode conversation claim.
 *
 * `undefined` means this is a direct/non-Code-Mode call and must retain its
 * existing Gateway authorization behavior.
 */
export function consumeActiveCodeModeConversationAuthority(
  conversationRef: string,
): boolean | undefined {
  return activeConversationAuthority.getStore()?.consumeConversation(conversationRef);
}
