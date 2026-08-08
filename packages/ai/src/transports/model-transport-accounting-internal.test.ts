import { describe, expect, it, vi } from "vitest";
import { createDispatchCompatibilityObservers } from "./model-transport-accounting-internal.js";

describe("dispatch compatibility observers", () => {
  it("retains one dispatch from legacy-only hosts", () => {
    const onDispatch = vi.fn();
    const observers = createDispatchCompatibilityObservers(onDispatch);

    observers.onFetchDispatch();

    expect(onDispatch).toHaveBeenCalledOnce();
  });

  it("deduplicates hosts that report both physical and legacy dispatch", () => {
    const onDispatch = vi.fn();
    const observers = createDispatchCompatibilityObservers(onDispatch);

    observers.onPhysicalFetchDispatch();
    observers.onFetchDispatch();

    expect(onDispatch).toHaveBeenCalledOnce();
  });

  it("retains every physical redirect hop before the legacy completion callback", () => {
    const onDispatch = vi.fn();
    const observers = createDispatchCompatibilityObservers(onDispatch);

    observers.onPhysicalFetchDispatch();
    observers.onPhysicalFetchDispatch();
    observers.onFetchDispatch();

    expect(onDispatch).toHaveBeenCalledTimes(2);
  });

  it("resets compatibility state for a later legacy-only invocation", () => {
    const onDispatch = vi.fn();
    const observers = createDispatchCompatibilityObservers(onDispatch);

    observers.onPhysicalFetchDispatch();
    observers.onFetchDispatch();
    observers.onFetchDispatch();

    expect(onDispatch).toHaveBeenCalledTimes(2);
  });
});
