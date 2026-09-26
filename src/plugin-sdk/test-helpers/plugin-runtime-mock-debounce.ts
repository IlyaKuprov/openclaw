import type { InboundDebounceCreateParams } from "../../auto-reply/inbound-debounce.js";

type InboundDebounceFlushFactory = Parameters<InboundDebounceCreateParams<unknown>["onFlush"]>[1];

export const createTestInboundDebounceFlush: InboundDebounceFlushFactory = (params) => {
  const source = params.lifecycle;
  const completion = params.dispatch({
    abortSignal: source?.abortSignal ?? new AbortController().signal,
    onAdopted: async () => await source?.onAdopted?.(),
    onDeferred: () => source?.onDeferred?.(),
    onDeferredHeartbeat: () => source?.onDeferredHeartbeat?.(),
    deferredHeartbeatIntervalMs: source?.deferredHeartbeatIntervalMs,
    onAdoptionFinalizing: () => source?.onAdoptionFinalizing?.(),
    onFailed: source?.onFailed ? async (error) => await source.onFailed?.(error) : undefined,
    onAbandoned: async () => await source?.onAbandoned?.(),
  });
  return { admission: completion, completion };
};
