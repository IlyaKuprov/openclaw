import { describe, expect, it } from "vitest";
import { projectPairingConnectivityUrls } from "./pairing-connectivity-urls.js";

describe("pairing connectivity URL projection", () => {
  it("deduplicates, sorts, and keeps the deterministic first eight origins", () => {
    const urls = Array.from(
      { length: 10 },
      (_, index) => `wss://gateway-${String(index).padStart(2, "0")}.example.com`,
    ).toReversed();
    expect(projectPairingConnectivityUrls([...urls, urls[0] ?? ""])).toEqual(
      urls.toSorted().slice(0, 8),
    );
  });

  it("rejects credentials, non-origin paths, oversized URLs, and insecure public ws", () => {
    expect(
      projectPairingConnectivityUrls([
        "wss://user:pass@gateway.example.com",
        "wss://gateway.example.com/path",
        "wss://gateway.example.com?token=secret",
        "wss://gateway.example.com/#fragment",
        `wss://${"a".repeat(2050)}.example.com`,
        "ws://gateway.example.com",
        "ws://192.168.1.20:18789",
      ]),
    ).toEqual(["ws://192.168.1.20:18789"]);
  });
});
