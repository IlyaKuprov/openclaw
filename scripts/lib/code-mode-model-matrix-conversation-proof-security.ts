import fs from "node:fs/promises";
import path from "node:path";
import type { QaGatewayChildConfigPreparationContext } from "../../extensions/qa-lab/src/gateway-child.js";
import {
  resolveQaAgentAuthDir,
  writeQaAuthProfiles,
} from "../../extensions/qa-lab/src/providers/shared/auth-store.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const SAFE_CHILD_ENV_KEYS = Object.freeze([
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "WINDIR",
]);

export const CODE_MODE_CONVERSATION_PROOF_TOOLS = Object.freeze([
  "conversations_list",
  "conversations_send",
]);

export const CODE_MODE_CONVERSATION_PROOF_ENV_OMIT_PATTERNS = Object.freeze([
  /^(?:ALL|HTTP|HTTPS|NO)_PROXY$/iu,
  /^(?:ANTHROPIC|AWS|AZURE_OPENAI|CODEX|GEMINI|GOOGLE|MISTRAL|OPENAI|VOYAGE)(?:_|$)/iu,
  /^CODEX_HOME$/iu,
  /^OPENCLAW_LIVE_[A-Z0-9_]+$/iu,
]);

export function buildCodeModeConversationProofChildEnv(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      childEnv[key] = value;
    }
  }
  return childEnv;
}

export function hasCodeModeConversationProofProviderEnv(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some((key) =>
    CODE_MODE_CONVERSATION_PROOF_ENV_OMIT_PATTERNS.some((pattern) => pattern.test(key)),
  );
}

export function createCodeModeConversationProofConfigPreparation(params: {
  agentId: string;
  authProfileId: string;
  credential: string;
  model: string;
}) {
  return async ({
    config,
    stateDir,
  }: QaGatewayChildConfigPreparationContext): Promise<OpenClawConfig> => {
    const agentDir = resolveQaAgentAuthDir({ stateDir, agentId: params.agentId });
    await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
    await fs.chmod(agentDir, 0o700);
    await writeQaAuthProfiles({
      agentDir,
      profiles: {
        [params.authProfileId]: {
          type: "api_key",
          provider: "openai",
          key: params.credential,
          displayName: "Frozen Code Mode proof credential",
        },
      },
      replace: true,
    });
    const mode = (await fs.stat(agentDir)).mode & 0o777;
    if (mode !== 0o700) {
      throw new Error(`conversation proof auth store must be mode 0700, got 0${mode.toString(8)}`);
    }

    const pinnedModel = `${params.model}@${params.authProfileId}`;
    const exactTools = {
      allow: [...CODE_MODE_CONVERSATION_PROOF_TOOLS],
      codeMode: { enabled: true },
    };
    return {
      ...config,
      auth: {
        ...config.auth,
        profiles: {
          [params.authProfileId]: {
            provider: "openai",
            mode: "api_key",
          },
        },
      },
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          model: {
            primary: pinnedModel,
            fallbacks: [],
          },
          models: {
            [params.model]: config.agents?.defaults?.models?.[params.model] ?? {},
          },
        },
        entries: {
          [params.agentId]: {
            ...config.agents?.entries?.[params.agentId],
            model: pinnedModel,
            tools: exactTools,
          },
        },
      },
      tools: {
        ...exactTools,
        toolSearch: { enabled: false },
      },
    };
  };
}

export const codeModeConversationProofSecurityTesting = {
  safeChildEnvKeys: SAFE_CHILD_ENV_KEYS,
  resolveAgentAuthDir: resolveQaAgentAuthDir,
  configPathForAgent: (stateDir: string, agentId: string) =>
    path.join(stateDir, "agents", agentId, "agent"),
};
