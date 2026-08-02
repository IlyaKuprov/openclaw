import { describe, expect, it } from "vitest";
import { formatInstallPolicyWarning } from "./install-policy-warning.js";

describe("formatInstallPolicyWarning", () => {
  it("shows every structured finding field needed for acknowledgement", () => {
    expect(
      formatInstallPolicyWarning({
        reason: "Review package behavior.",
        findings: [
          {
            ruleId: "network.postinstall",
            severity: "critical",
            message: "Postinstall opens a network connection.",
            file: "package.json",
            line: 12,
            evidence: '"postinstall": "node setup.js"',
          },
        ],
      }),
    ).toBe(
      'Review package behavior.\n- [critical] network.postinstall: Postinstall opens a network connection. (package.json:12) — "postinstall": "node setup.js"',
    );
  });
});
