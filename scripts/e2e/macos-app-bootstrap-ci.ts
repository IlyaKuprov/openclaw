#!/usr/bin/env -S pnpm tsx
// Native macOS CI proof for the packaged app's first-launch CLI bootstrap.
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { redactSensitiveText } from "../../src/logging/redact.ts";
import { sleep as delay } from "../lib/sleep.mjs";
import { run, runStreaming, say } from "./parallels/host-command.ts";
import { startNpmRegistryServer } from "./parallels/host-server.ts";
import { packOpenClaw, packageVersionFromTgz } from "./parallels/package-artifact.ts";
import type { NpmRegistryServer } from "./parallels/types.ts";

const gatewayLabel = "ai.openclaw.gateway";
const gatewayPort = 18789;
const bundleId = "ai.openclaw.mac.debug";
const installerProcessPattern = "Contents/Resources/[i]nstall-cli.sh";

type Lane = "matching" | "mismatch";

type CommandOptions = {
  check?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

function requireEphemeralCiHome(input: {
  allowReset?: string;
  ci?: string;
  home: string;
  platform: NodeJS.Platform;
}): void {
  if (input.platform !== "darwin") {
    throw new Error("macOS app bootstrap CI requires a Darwin runner");
  }
  if (input.ci !== "true" || input.allowReset !== "1") {
    throw new Error(
      "refusing to reset ~/.openclaw outside explicit CI; set CI=true and OPENCLAW_E2E_ALLOW_HOME_RESET=1",
    );
  }
  const resolvedHome = path.resolve(input.home);
  if (!resolvedHome.startsWith("/Users/") || resolvedHome.split(path.sep).length !== 3) {
    throw new Error(`refusing unsafe CI home: ${resolvedHome}`);
  }
}

async function portIsOpen(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function safeArtifactText(text: string): string {
  return redactSensitiveText(text);
}

function appBootstrapMismatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
  if (!match) {
    throw new Error(`cannot derive app bootstrap mismatch version from ${version}`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

class MacosAppBootstrapCi {
  private readonly artifactDir = path.resolve(
    process.env.OPENCLAW_MACOS_APP_BOOTSTRAP_ARTIFACT_DIR ?? ".artifacts/macos-app-bootstrap",
  );
  private readonly commandLog = path.join(this.artifactDir, "commands.log");
  private readonly home = homedir();
  private readonly stateDir = path.join(this.home, ".openclaw");
  private readonly launchAgentPath = path.join(
    this.home,
    "Library/LaunchAgents",
    `${gatewayLabel}.plist`,
  );
  private readonly uid = process.getuid?.();
  private registryServer: NpmRegistryServer | null = null;
  private tempRoot = "";
  private candidateVersion = "";

  async run(): Promise<void> {
    requireEphemeralCiHome({
      allowReset: process.env.OPENCLAW_E2E_ALLOW_HOME_RESET,
      ci: process.env.CI,
      home: this.home,
      platform: process.platform,
    });
    if (this.uid == null) {
      throw new Error("cannot resolve current macOS user id");
    }

    await mkdir(this.artifactDir, { recursive: true });
    this.tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-macos-app-bootstrap-ci."));

    try {
      await this.preflight();
      const apps = await this.prepareArtifacts();

      await this.runLane("mismatch", apps.mismatch);
      await this.runLane("matching", apps.matching);

      await writeFile(
        path.join(this.artifactDir, "summary.json"),
        `${JSON.stringify(
          {
            candidateVersion: this.candidateVersion,
            matching: "pass",
            mismatch: "pass",
          },
          null,
          2,
        )}\n`,
      );
      say("Packaged macOS app bootstrap passed: mismatch rejected, matching Gateway ready");
    } catch (error) {
      await writeFile(
        path.join(this.artifactDir, "failure.log"),
        `${safeArtifactText(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`,
      ).catch(() => undefined);
      await this.captureDiagnostics("failure").catch(() => undefined);
      throw error;
    } finally {
      await this.resetState().catch((error: unknown) => {
        process.stderr.write(`cleanup warning: ${this.errorMessage(error)}\n`);
      });
      await this.registryServer?.stop().catch((error: unknown) => {
        process.stderr.write(`registry cleanup warning: ${this.errorMessage(error)}\n`);
      });
      if (this.tempRoot) {
        await rm(this.tempRoot, { force: true, recursive: true });
      }
    }
  }

  private async preflight(): Promise<void> {
    say("Verify logged-in macOS launchd and LaunchServices session");
    this.runStatus("/bin/launchctl", ["print", `gui/${this.uid}`], { timeoutMs: 30_000 });
    this.runLogged("/bin/test", ["-x", "/usr/bin/open"]);
    this.runLogged("/usr/bin/stat", ["-f", "console-user=%Su", "/dev/console"]);
    await this.resetState();
  }

  private async prepareArtifacts(): Promise<{ matching: string; mismatch: string }> {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version?: unknown };
    if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
      throw new Error("package.json does not contain a package version");
    }
    this.candidateVersion = packageJson.version.trim();

    const matchingApp = path.resolve("dist/macos-app-bootstrap-ci/OpenClaw.app");
    say(`Build packaged debug app ${this.candidateVersion}`);
    const packageStatus = await runStreaming("bash", ["scripts/package-mac-app.sh"], {
      env: {
        ...process.env,
        ALLOW_ADHOC_SIGNING: "1",
        APP_VERSION: this.candidateVersion,
        BUILD_CONFIG: "debug",
        OPENCLAW_PACKAGE_APP_ROOT: matchingApp,
        SIGN_IDENTITY: "-",
        SKIP_PNPM_INSTALL: "1",
      },
      logPath: path.join(this.artifactDir, "package-mac-app.log"),
      timeoutMs: 30 * 60_000,
    });
    if (packageStatus !== 0) {
      throw new Error(`package-mac-app failed with exit ${packageStatus}`);
    }

    say("Pack exact-head OpenClaw npm artifact");
    const packageDir = path.join(this.tempRoot, "package");
    const artifact = await packOpenClaw({
      destination: packageDir,
      requireControlUi: true,
    });
    const packedVersion = await packageVersionFromTgz(artifact.path);
    if (packedVersion !== this.candidateVersion) {
      throw new Error(
        `packed CLI version ${packedVersion} does not match app ${this.candidateVersion}`,
      );
    }
    this.registryServer = await startNpmRegistryServer({
      hostIp: "127.0.0.1",
      packages: [
        {
          name: "openclaw",
          tarballPath: artifact.path,
          version: this.candidateVersion,
        },
      ],
    });

    const mismatchApp = path.join(this.tempRoot, "mismatch", "OpenClaw.app");
    await mkdir(path.dirname(mismatchApp), { recursive: true });
    this.runLogged("/usr/bin/ditto", [matchingApp, mismatchApp], { timeoutMs: 120_000 });
    this.runLogged("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :CFBundleShortVersionString ${appBootstrapMismatchVersion(this.candidateVersion)}`,
      path.join(mismatchApp, "Contents/Info.plist"),
    ]);
    this.runLogged("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", mismatchApp], {
      timeoutMs: 120_000,
    });

    return { matching: matchingApp, mismatch: mismatchApp };
  }

  private async runLane(lane: Lane, appPath: string): Promise<void> {
    say(`Run packaged app bootstrap lane: ${lane}`);
    await this.resetState();
    await this.configureApp(appPath, lane);
    this.runLogged("/usr/bin/open", ["-n", appPath, "--args", "--e2e-cli-channel", "stable"], {
      timeoutMs: 30_000,
    });

    if (lane === "mismatch") {
      await this.waitFor(
        "incompatible installer rejection",
        15 * 60_000,
        () =>
          existsSync(path.join(this.stateDir, "tools/node/bin/node")) && !this.installerIsRunning(),
      );
      await this.verifyMismatch();
    } else {
      await this.waitFor("managed CLI install", 15 * 60_000, () =>
        existsSync(path.join(this.stateDir, "bin/openclaw")),
      );
      await this.verifyMatching();
    }

    await this.captureDiagnostics(lane);
  }

  private async configureApp(appPath: string, lane: Lane): Promise<void> {
    const actualBundleId = this.runLogged("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIdentifier",
      path.join(appPath, "Contents/Info.plist"),
    ]).stdout.trim();
    if (actualBundleId !== bundleId) {
      throw new Error(`unexpected debug bundle id: ${actualBundleId}`);
    }

    for (const [key, type, value] of [
      ["openclaw.onboardingSeen", "-bool", "true"],
      ["openclaw.onboardingVersion", "-int", "8"],
      ["openclaw.connectionMode", "-string", "local"],
      ["openclaw.pauseEnabled", "-bool", "false"],
      ["openclaw.showDockIcon", "-bool", "true"],
      ["openclaw.debug.fileLogEnabled", "-bool", "true"],
      ["openclaw.debug.appLogLevel", "-string", "debug"],
    ] as const) {
      this.runLogged("/usr/bin/defaults", ["write", actualBundleId, key, type, value]);
    }

    if (!this.registryServer) {
      throw new Error("local npm registry is unavailable");
    }
    const laneLogDir = path.join(this.artifactDir, lane);
    await mkdir(laneLogDir, { recursive: true });
    for (const [key, value] of [
      ["NPM_CONFIG_REGISTRY", this.registryServer.hostUrl],
      ["npm_config_registry", this.registryServer.hostUrl],
      ["OPENCLAW_LOG_DIR", laneLogDir],
    ] as const) {
      this.runLogged("/bin/launchctl", ["setenv", key, value]);
    }
  }

  private async verifyMismatch(): Promise<void> {
    const managedCli = path.join(this.stateDir, "bin/openclaw");
    if (existsSync(managedCli)) {
      throw new Error("incompatible channel replaced the managed CLI before rejection");
    }
    await this.verifyConfig(appBootstrapMismatchVersion(this.candidateVersion));
    await delay(5_000);
    const service = this.runStatus("/bin/launchctl", ["print", `gui/${this.uid}/${gatewayLabel}`], {
      check: false,
    });
    if (service.status === 0) {
      throw new Error("incompatible CLI reached LaunchAgent installation");
    }
    if (await portIsOpen(gatewayPort)) {
      throw new Error(`incompatible CLI unexpectedly opened port ${gatewayPort}`);
    }
  }

  private async verifyMatching(): Promise<void> {
    const managedCli = path.join(this.stateDir, "bin/openclaw");
    await this.waitFor("Gateway RPC readiness", 5 * 60_000, async () => {
      const status = this.runLogged(
        managedCli,
        ["gateway", "status", "--deep", "--require-rpc", "--timeout", "15000"],
        { check: false, timeoutMs: 30_000 },
      );
      return status.status === 0 && (await portIsOpen(gatewayPort));
    });

    this.runLogged(managedCli, ["config", "validate"], { timeoutMs: 60_000 });
    this.runStatus("/bin/launchctl", ["print", `gui/${this.uid}/${gatewayLabel}`], {
      timeoutMs: 30_000,
    });
    if (!(await portIsOpen(gatewayPort))) {
      throw new Error(`Gateway port ${gatewayPort} is closed`);
    }
    this.runLogged(
      managedCli,
      ["gateway", "status", "--deep", "--require-rpc", "--timeout", "15000"],
      { timeoutMs: 30_000 },
    );
    await this.verifyConfig(this.candidateVersion);
  }

  private async verifyConfig(expectedVersion: string): Promise<void> {
    const configPath = path.join(this.stateDir, "openclaw.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      meta?: Record<string, unknown>;
    };
    if (config.meta?.lastTouchedVersion !== expectedVersion) {
      throw new Error(`unexpected lastTouchedVersion: ${String(config.meta?.lastTouchedVersion)}`);
    }
    if (config.meta && "lastTouchedAt" in config.meta) {
      throw new Error("packaged app wrote retired meta.lastTouchedAt");
    }
  }

  private installerIsRunning(): boolean {
    return (
      this.runLogged("/usr/bin/pgrep", ["-f", installerProcessPattern], { check: false }).status ===
      0
    );
  }

  private async waitFor(
    description: string,
    timeoutMs: number,
    predicate: () => boolean | Promise<boolean>,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return;
      }
      await delay(2_000);
    }
    throw new Error(`timed out waiting for ${description}`);
  }

  private async resetState(): Promise<void> {
    if (this.uid == null) {
      return;
    }
    this.runLogged("/usr/bin/pkill", ["-x", "OpenClaw"], { check: false });
    this.runLogged("/usr/bin/pkill", ["-f", installerProcessPattern], { check: false });
    await this.waitFor(
      "OpenClaw app cleanup",
      15_000,
      () => run("/usr/bin/pgrep", ["-x", "OpenClaw"], { check: false, quiet: true }).status !== 0,
    );
    this.runLogged("/bin/launchctl", ["bootout", `gui/${this.uid}/${gatewayLabel}`], {
      check: false,
    });
    for (const key of ["NPM_CONFIG_REGISTRY", "npm_config_registry", "OPENCLAW_LOG_DIR"]) {
      this.runLogged("/bin/launchctl", ["unsetenv", key], { check: false });
    }
    await rm(this.launchAgentPath, { force: true });
    await rm(this.stateDir, { force: true, recursive: true });
    this.runLogged("/usr/bin/defaults", ["delete", bundleId], { check: false });
    await this.waitFor(
      "Gateway port cleanup",
      30_000,
      async () => !(await portIsOpen(gatewayPort)),
    );
  }

  private async captureDiagnostics(label: string): Promise<void> {
    const diagnostics: string[] = [];
    const capture = (title: string, command: string, args: string[]): void => {
      const result = run(command, args, { check: false, quiet: true, timeoutMs: 30_000 });
      diagnostics.push(
        `## ${title}\nexit=${result.status}\n${result.stdout}${result.stderr}`.trimEnd(),
      );
    };

    capture("console user", "/usr/bin/stat", ["-f", "%Su", "/dev/console"]);
    capture("OpenClaw processes", "/usr/bin/pgrep", ["-alf", "OpenClaw|openclaw|install-cli"]);
    const launchd = run("/bin/launchctl", ["print", `gui/${this.uid}/${gatewayLabel}`], {
      check: false,
      quiet: true,
      timeoutMs: 30_000,
    });
    const launchdSummary = `${launchd.stdout}${launchd.stderr}`
      .split("\n")
      .filter((line) => /\b(?:state|pid|last exit code)\s*=/u.test(line))
      .join("\n");
    diagnostics.push(`## Gateway LaunchAgent\nexit=${launchd.status}\n${launchdSummary}`);
    capture("debug defaults", "/usr/bin/defaults", ["read", bundleId]);
    capture("app unified log", "/usr/bin/log", [
      "show",
      "--last",
      "30m",
      "--style",
      "compact",
      "--predicate",
      'subsystem == "ai.openclaw"',
    ]);

    const configPath = path.join(this.stateDir, "openclaw.json");
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(await readFile(configPath, "utf8")) as {
          gateway?: Record<string, unknown>;
          meta?: Record<string, unknown>;
        };
        diagnostics.push(
          `## Config summary\n${JSON.stringify(
            {
              gateway: {
                bind: config.gateway?.bind,
                mode: config.gateway?.mode,
                port: config.gateway?.port,
              },
              meta: config.meta,
            },
            null,
            2,
          )}`,
        );
      } catch (error) {
        diagnostics.push(`## Config summary\n${this.errorMessage(error)}`);
      }
    }

    await writeFile(
      path.join(this.artifactDir, `diagnostics-${label}.log`),
      `${safeArtifactText(diagnostics.join("\n\n"))}\n`,
    );
  }

  private runLogged(command: string, args: string[], options: CommandOptions = {}) {
    const header = `$ ${[command, ...args].join(" ")}\n`;
    const result = run(command, args, {
      check: false,
      env: options.env,
      quiet: true,
      timeoutMs: options.timeoutMs,
    });
    const output = `${result.stdout}${result.stderr}`;
    appendFileSync(this.commandLog, safeArtifactText(`${header}${output}\n`), "utf8");
    if (result.stdout) {
      process.stdout.write(safeArtifactText(result.stdout));
    }
    if (result.stderr) {
      process.stderr.write(safeArtifactText(result.stderr));
    }
    if (options.check !== false && result.status !== 0) {
      throw new Error(`command failed (${result.status}): ${command} ${args.join(" ")}`);
    }
    return result;
  }

  private runStatus(command: string, args: string[], options: CommandOptions = {}) {
    const result = run(command, args, {
      check: false,
      env: options.env,
      quiet: true,
      timeoutMs: options.timeoutMs,
    });
    appendFileSync(
      this.commandLog,
      `$ ${[command, ...args].join(" ")}\nexit=${result.status}\n\n`,
      "utf8",
    );
    if (options.check !== false && result.status !== 0) {
      throw new Error(`command failed (${result.status}): ${command} ${args.join(" ")}`);
    }
    return result;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export const testing = {
  appBootstrapMismatchVersion,
  requireEphemeralCiHome,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await new MacosAppBootstrapCi().run().catch((error: unknown) => {
    process.stderr.write(`macOS app bootstrap CI failed: ${safeArtifactText(String(error))}\n`);
    process.exitCode = 1;
  });
}
