import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createConfigIO } from "./io.factory.js";
import { resetConfigRuntimeState } from "./io.js";

describe("config ownership writes with includes", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
  });

  it("does not copy include-owned migration fields into the root config", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ownership-includes-"));
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const defaultsPath = path.join(stateDir, "defaults.json5");
    const talkPath = path.join(stateDir, "talk.json5");
    const defaultsRaw = `${JSON.stringify(
      {
        workspace: "${DEFAULT_WORKSPACE}",
        heartbeat: { agentId: "${LEGACY_OWNER}" },
        systemAgent: { agentId: "${LEGACY_OWNER}" },
        authInheritance: { agentId: "${LEGACY_OWNER}" },
        sessionStore: { agentId: "${LEGACY_OWNER}" },
      },
      null,
      2,
    )}\n`;
    const talkRaw = `${JSON.stringify({ agentId: "${LEGACY_OWNER}" }, null, 2)}\n`;

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(defaultsPath, defaultsRaw, "utf-8");
      await fs.writeFile(talkPath, talkRaw, "utf-8");
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            agents: {
              entries: {
                ops: { workspace: "${OPS_WORKSPACE}" },
                research: {},
              },
              defaults: { $include: "./defaults.json5" },
            },
            session: { store: path.join(stateDir, "sessions.sqlite") },
            talk: { $include: "./talk.json5" },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const io = createConfigIO({
        observe: false,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
        env: {
          HOME: home,
          NODE_ENV: "test",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_FAST: "1",
          DEFAULT_WORKSPACE: "/srv/default",
          OPS_WORKSPACE: "/srv/ops",
          LEGACY_OWNER: "ops",
        } as NodeJS.ProcessEnv,
      });
      const snapshot = await io.readConfigFileSnapshot();

      await io.writeConfigFile(snapshot.config, {
        baseSnapshot: snapshot,
        explicitSetPaths: [["agents", "entries"]],
        allowIncludeAncestorExplicitSetPaths: true,
        skipRuntimeSnapshotRefresh: true,
      });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: { defaults?: Record<string, unknown>; ownership?: string };
        talk?: Record<string, unknown>;
      };
      expect(persisted.agents?.ownership).toBe("explicit");
      expect(persisted.agents?.defaults).toEqual({ $include: "./defaults.json5" });
      expect(persisted.talk).toEqual({ $include: "./talk.json5" });
      await expect(fs.readFile(defaultsPath, "utf-8")).resolves.toBe(defaultsRaw);
      await expect(fs.readFile(talkPath, "utf-8")).resolves.toBe(talkRaw);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
