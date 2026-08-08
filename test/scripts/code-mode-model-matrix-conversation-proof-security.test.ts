import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readQaAuthProfiles } from "../../extensions/qa-lab/src/providers/shared/auth-store.js";
import {
  buildCodeModeConversationProofChildEnv,
  CODE_MODE_CONVERSATION_PROOF_ENV_OMIT_PATTERNS,
  CODE_MODE_CONVERSATION_PROOF_TOOLS,
  createCodeModeConversationProofConfigPreparation,
  hasCodeModeConversationProofProviderEnv,
} from "../../scripts/lib/code-mode-model-matrix-conversation-proof-security.js";
import { createOpenClawCodingTools } from "../../src/agents/agent-tools.js";
import { isCodeModeControlTool } from "../../src/agents/code-mode-control-tools.js";
import { createAgentHarnessToolSurfaceRuntime } from "../../src/agents/harness/tool-surface-bridge.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const tempDirs: string[] = [];

async function createTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-proof-security-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Code Mode conversation proof security", () => {
  it("builds a positive-safe child env without provider, proxy, config, or auth-home inputs", () => {
    const childEnv = buildCodeModeConversationProofChildEnv({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      HOME: "/host/home",
      HTTPS_PROXY: "http://proxy.invalid",
      OPENCLAW_CONFIG_PATH: "/host/openclaw.json",
      OPENAI_API_KEY: "openai-secret",
      OPENAI_API_KEY_1: "openai-secret-1",
      OpenAi_Api_Keys: "mixed-case-secret",
      CODEX_API_KEY: "codex-secret",
      CODEX_HOME: "/host/codex",
      OPENCLAW_LIVE_OPENAI_KEY: "live-secret",
    });

    expect(childEnv).toEqual({
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
    });
    expect(hasCodeModeConversationProofProviderEnv(childEnv)).toBe(false);
  });

  it("matches provider aliases defensively after Gateway aliases and patches", () => {
    for (const key of [
      "OPENAI_API_KEY",
      "OPENAI_API_KEYS",
      "OPENAI_API_KEY_1",
      "OpenAi_Api_Key_99",
      "CODEX_API_KEY",
      "OPENCLAW_LIVE_OPENAI_KEY",
      "openclaw_live_codex_api_key",
      "HTTPS_PROXY",
      "CODEX_HOME",
    ]) {
      expect(
        CODE_MODE_CONVERSATION_PROOF_ENV_OMIT_PATTERNS.some((pattern) => pattern.test(key)),
      ).toBe(true);
    }
  });

  it("writes one inline pinned profile in a 0700 store and returns an exact tool policy", async () => {
    const tempRoot = await createTempDir();
    const stateDir = path.join(tempRoot, "state");
    const credential = "qa-proof-inline-credential";
    const prepare = createCodeModeConversationProofConfigPreparation({
      agentId: "proof",
      authProfileId: "openai:proof",
      credential,
      model: "openai/gpt-proof",
    });

    const config = await prepare({
      config: {
        auth: {
          profiles: {
            stale: { provider: "openai", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/stale",
              fallbacks: ["openai/fallback"],
            },
          },
          entries: {
            stale: {
              model: "openai/stale",
              tools: { profile: "coding", alsoAllow: ["exec"] },
            },
          },
        },
        tools: {
          profile: "coding",
          alsoAllow: ["exec"],
        },
      } satisfies OpenClawConfig,
      stateDir,
      tempRoot,
    });

    const agentDir = path.join(stateDir, "agents", "proof", "agent");
    expect((await fs.stat(agentDir)).mode & 0o777).toBe(0o700);
    expect(readQaAuthProfiles(agentDir)).toEqual({
      version: 1,
      profiles: {
        "openai:proof": {
          type: "api_key",
          provider: "openai",
          key: credential,
          displayName: "Frozen Code Mode proof credential",
        },
      },
    });
    expect(config.auth?.profiles).toEqual({
      "openai:proof": { provider: "openai", mode: "api_key" },
    });
    expect(config.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-proof@openai:proof",
      fallbacks: [],
    });
    expect(config.agents?.entries).toEqual({
      proof: {
        model: "openai/gpt-proof@openai:proof",
        tools: {
          allow: CODE_MODE_CONVERSATION_PROOF_TOOLS,
          codeMode: { enabled: true },
        },
      },
    });
    expect(config.tools).toEqual({
      allow: CODE_MODE_CONVERSATION_PROOF_TOOLS,
      codeMode: { enabled: true },
      toolSearch: { enabled: false },
    });
    expect(JSON.stringify(config)).not.toContain(credential);

    const sessionKey = "agent:proof:main";
    const directTools = createOpenClawCodingTools({
      agentDir,
      agentId: "proof",
      config,
      messageProvider: "webchat",
      senderIsOwner: true,
      sessionKey,
      workspaceDir: path.join(tempRoot, "workspace"),
    });
    expect(directTools.map((tool) => tool.name)).toEqual(CODE_MODE_CONVERSATION_PROOF_TOOLS);

    const runtime = createAgentHarnessToolSurfaceRuntime({
      agentId: "proof",
      config,
      executeTool: async () => ({ content: [], details: {} }),
      modelToolsEnabled: true,
      runtimeToolAllowlist: CODE_MODE_CONVERSATION_PROOF_TOOLS,
      sessionKey,
      toolsAllow: CODE_MODE_CONVERSATION_PROOF_TOOLS,
    });
    try {
      const visibleTools = runtime.compactTools(directTools).tools;
      expect(runtime.codeModeControlsEnabled).toBe(true);
      expect(runtime.toolSearchControlsEnabled).toBe(false);
      expect(visibleTools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
      expect(visibleTools.every((tool) => isCodeModeControlTool(tool))).toBe(true);
      expect(runtime.toolSearchCatalogRef?.current?.entries.map((entry) => entry.name)).toEqual(
        CODE_MODE_CONVERSATION_PROOF_TOOLS,
      );
      expect(runtime.toolSearchCatalogRef?.current?.entries.map((entry) => entry.id)).not.toContain(
        "openclaw:core:exec",
      );
    } finally {
      runtime.cleanup();
    }
  });
});
