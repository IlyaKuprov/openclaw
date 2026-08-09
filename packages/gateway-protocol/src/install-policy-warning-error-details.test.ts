import { describe, expect, it } from "vitest";
import {
  INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
  buildInstallPolicyWarningErrorDetails,
} from "./install-policy-warning-error-details.js";

describe("install policy warning error details", () => {
  it("builds a stable client-facing warning payload", () => {
    expect(
      buildInstallPolicyWarningErrorDetails({
        targetName: "demo-plugin",
        targetType: "plugin",
        requestMode: "install",
        reason: "Scanner found behavior that needs review",
        findings: [
          {
            ruleId: "dynamic-eval",
            severity: "warn",
            message: "Dynamic code execution",
            file: "index.js",
            line: 12,
          },
        ],
      }),
    ).toEqual({
      installPolicyCode: INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
      targetName: "demo-plugin",
      targetType: "plugin",
      requestMode: "install",
      reason: "Scanner found behavior that needs review",
      findings: [
        {
          ruleId: "dynamic-eval",
          severity: "warn",
          message: "Dynamic code execution",
          file: "index.js",
          line: 12,
        },
      ],
    });
  });
});
