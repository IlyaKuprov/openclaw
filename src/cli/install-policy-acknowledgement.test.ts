import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  appendInstallPolicyAcknowledgementFlag,
  preserveBareInstallPolicyAcknowledgementFlag,
  resolveInstallPolicyAcknowledgementOption,
  type InstallPolicyAcknowledgementOption,
} from "./install-policy-acknowledgement.js";

const ACKNOWLEDGEMENT_ID = `sha256:${"a".repeat(64)}`;
const ACKNOWLEDGEMENT_SEQUENCE = `${ACKNOWLEDGEMENT_ID},sha256:${"b".repeat(64)}`;
const INSTALL_POLICY_ACK_FLAG = "--dangerously-force-unsafe-install";

describe("install policy acknowledgement CLI option", () => {
  it("keeps the existing bare force flag for intrinsic unsafe-install overrides", () => {
    expect(resolveInstallPolicyAcknowledgementOption(true)).toEqual({
      dangerouslyForceUnsafeInstall: true,
    });
  });

  it("carries an artifact-bound warning token through the same flag", () => {
    expect(resolveInstallPolicyAcknowledgementOption(ACKNOWLEDGEMENT_ID)).toEqual({
      dangerouslyForceUnsafeInstall: true,
      installPolicyAcknowledgementId: ACKNOWLEDGEMENT_ID,
    });
  });

  it("does not consume a following positional operand for the bare flag", async () => {
    const program = new Command();
    preserveBareInstallPolicyAcknowledgementFlag(program);
    let received: { target?: string; option?: InstallPolicyAcknowledgementOption } = {};
    program
      .command("install")
      .argument("<target>")
      .option(`${INSTALL_POLICY_ACK_FLAG} [acknowledgement-id]`, "Acknowledge warning", false)
      .action((target: string, options: { dangerouslyForceUnsafeInstall?: string | boolean }) => {
        received = { target, option: options.dangerouslyForceUnsafeInstall };
      });

    await program.parseAsync(["install", INSTALL_POLICY_ACK_FLAG, "npm:demo"], { from: "user" });

    expect(received).toEqual({ target: "npm:demo", option: "true" });
    expect(resolveInstallPolicyAcknowledgementOption(received.option)).toEqual({
      dangerouslyForceUnsafeInstall: true,
    });
  });

  it.each([ACKNOWLEDGEMENT_ID, ACKNOWLEDGEMENT_SEQUENCE])(
    "still consumes an exact acknowledgement value: %s",
    async (acknowledgementId) => {
      const program = new Command();
      preserveBareInstallPolicyAcknowledgementFlag(program);
      let received: { target?: string; option?: InstallPolicyAcknowledgementOption } = {};
      program
        .command("install")
        .argument("<target>")
        .option(`${INSTALL_POLICY_ACK_FLAG} [acknowledgement-id]`, "Acknowledge warning", false)
        .action((target: string, options: { dangerouslyForceUnsafeInstall?: string | boolean }) => {
          received = { target, option: options.dangerouslyForceUnsafeInstall };
        });

      await program.parseAsync(
        ["install", "npm:demo", INSTALL_POLICY_ACK_FLAG, acknowledgementId],
        {
          from: "user",
        },
      );

      expect(received).toEqual({ target: "npm:demo", option: acknowledgementId });
    },
  );

  it("does not rewrite a literal force flag after the option terminator", async () => {
    const program = new Command();
    preserveBareInstallPolicyAcknowledgementFlag(program);
    let received: string[] = [];
    program
      .command("run")
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .argument("[args...]")
      .action((args: string[]) => {
        received = args;
      });

    await program.parseAsync(["run", "--", "echo", INSTALL_POLICY_ACK_FLAG], { from: "user" });

    expect(received).toEqual(["echo", INSTALL_POLICY_ACK_FLAG]);
  });

  it("prints the exact token required by the blocked attempt", () => {
    expect(
      appendInstallPolicyAcknowledgementFlag("Review required.", {
        reason: "Review package behavior.",
        acknowledgementId: ACKNOWLEDGEMENT_ID,
      }),
    ).toContain(`--dangerously-force-unsafe-install ${ACKNOWLEDGEMENT_ID}`);
  });

  it("upgrades lower-level bare-flag guidance with the exact token", () => {
    expect(
      appendInstallPolicyAcknowledgementFlag(
        "Re-run with --dangerously-force-unsafe-install after reviewing the findings.",
        { reason: "Review package behavior.", acknowledgementId: ACKNOWLEDGEMENT_ID },
      ),
    ).toContain(`--dangerously-force-unsafe-install ${ACKNOWLEDGEMENT_ID}`);
  });
});
