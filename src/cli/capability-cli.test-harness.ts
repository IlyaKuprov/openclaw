// Shared mocked runtime and reset contract for the capability CLI command suites.
import { vi } from "vitest";
import type { inspectLocalAudioSelection } from "../media-understanding/local-audio.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";

type LocalAudioSelection = Awaited<ReturnType<typeof inspectLocalAudioSelection>>;

const closeEmbeddingProviderMock = vi.hoisted(() => vi.fn(async () => {}));
const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  },
  loadConfig: vi.fn(() => ({})),
  getRuntimeConfigSourceSnapshot: vi.fn(() => null),
  setRuntimeConfigSnapshot: vi.fn(),
  loadAuthProfileStoreForRuntime: vi.fn<
    typeof import("../agents/auth-profiles.js").loadAuthProfileStoreForRuntime
  >(() => ({ version: 1, profiles: {}, order: {} })),
  listProfilesForProvider: vi.fn<
    typeof import("../agents/auth-profiles.js").listProfilesForProvider
  >(() => []),
  resolveApiKeyForProviderCore: vi.fn(),
  // Alias resolution hands this snapshot to manifest-backed model-id normalization,
  // which needs the complete snapshot contract, not just the manifest registry.
  loadManifestMetadataSnapshot: vi.fn(() => createPluginMetadataSnapshotFixture()),
  planEffectiveModelCatalogRows: vi.fn<
    typeof import("../model-catalog/index.js").planEffectiveModelCatalogRows
  >(() => ({ rows: [], entries: [], conflicts: [] })),
  resolveAgentDir: vi.fn((_cfg: unknown, agentId: string) => `/tmp/agent-${agentId}`),
  updateAuthProfileStoreWithLock: vi.fn(
    async ({ updater }: { updater: (store: any) => boolean }) => {
      const store = {
        version: 1,
        profiles: {},
        order: {},
        lastGood: {},
        usageStats: {},
      };
      updater(store);
      return store;
    },
  ),
  resolveMemorySearchConfig: vi.fn<
    typeof import("../agents/memory-search.js").resolveMemorySearchConfig
  >(() => null),
  loadModelCatalog: vi.fn<
    typeof import("../agents/prepared-model-catalog.js").readPreparedModelCatalog
  >(async () => []),
  releaseSimpleCompletion: vi.fn(),
  acquireSimpleCompletionModelForAgent: vi.fn(async () => ({
    async [Symbol.asyncDispose]() {
      mocks.releaseSimpleCompletion();
    },
    selection: {
      provider: "openai",
      modelId: "gpt-5.4",
      agentDir: "/tmp/agent",
    },
    model: {
      provider: "openai",
      id: "gpt-5.4",
      maxTokens: 128,
    },
    auth: {
      apiKey: "sk-test",
      source: "env:TEST_API_KEY",
      mode: "api-key",
    },
  })),
  completeWithPreparedSimpleCompletionModel: vi.fn(async () => ({
    content: [{ type: "text", text: "local reply" }],
  })),
  callGateway: vi.fn(async ({ method }: { method: string }) => {
    if (method === "tts.status") {
      return { enabled: true, provider: "openai" };
    }
    if (method === "agent") {
      return {
        result: {
          payloads: [{ text: "gateway reply" }],
          meta: { agentMeta: { provider: "anthropic", model: "claude-sonnet-4-6" } },
        },
      };
    }
    return {};
  }),
  describeImageFile: vi.fn(async () => ({
    text: "friendly lobster",
    provider: "openai",
    model: "gpt-4.1-mini",
  })),
  prepareImageDescriptionInput: vi.fn(async () => ({
    buffer: Buffer.from("image"),
    fileName: "photo.jpg",
    mime: "image/jpeg",
  })),
  describePreparedImageWithModel: vi.fn(async () => ({
    text: "friendly lobster",
    model: "gpt-4.1-mini",
  })),
  describeImageFileWithModel: vi.fn(async () => ({
    text: "friendly lobster",
    model: "gpt-4.1-mini",
  })),
  generateImage: vi.fn(),
  listRuntimeImageGenerationProviders: vi.fn(() => []),
  generateVideo: vi.fn(),
  describeVideoFile: vi.fn(),
  listRuntimeVideoGenerationProviders: vi.fn(() => []),
  transcribeAudioFile: vi.fn(async () => ({ text: "meeting notes" })),
  textToSpeech: vi.fn(async () => ({
    success: true,
    audioPath: "/tmp/tts-source.mp3",
    provider: "openai",
    outputFormat: "mp3",
    voiceCompatible: false,
    attempts: [],
  })),
  setTtsProvider: vi.fn(),
  getTtsProvider: vi.fn(() => "openai"),
  listSpeechProviders: vi.fn(() => []),
  setTtsPersona: vi.fn(),
  resolveTtsConfig: vi.fn(() => ({})),
  resolveExplicitTtsOverrides: vi.fn(
    ({
      provider,
      modelId,
      voiceId,
    }: {
      provider?: string;
      modelId?: string;
      voiceId?: string;
    }) => ({
      ...(provider ? { provider } : {}),
      ...(modelId || voiceId
        ? {
            providerOverrides: {
              [provider ?? "openai"]: {
                ...(modelId ? { modelId } : {}),
                ...(voiceId ? { voiceId } : {}),
              },
            },
          }
        : {}),
    }),
  ),
  getProviderEnvVars: vi.fn((providerId: string) => [
    `${providerId.toUpperCase().replaceAll("-", "_")}_API_KEY`,
  ]),
  embedBatch: vi.fn(async (inputs: unknown[], options?: { inputType?: string }) =>
    inputs.map(() => (options?.inputType === "document" ? [0.1, 0.2] : [9, 9])),
  ),
  createEmbeddingProvider: vi.fn(async () => ({
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embed: async () => [0.1, 0.2],
      embedBatch: (...args: Parameters<typeof mocks.embedBatch>) => mocks.embedBatch(...args),
      close: closeEmbeddingProviderMock,
    },
  })),
  listMemoryEmbeddingProviders: vi.fn(() => [
    { id: "openai", defaultModel: "text-embedding-3-small", transport: "remote" },
  ]),
  listEmbeddingProviders: vi.fn(() => []),
  buildMediaUnderstandingRegistry: vi.fn(() => new Map()),
  inspectLocalAudioSelection: vi.fn<() => Promise<LocalAudioSelection>>(async () => ({
    candidates: [],
    entries: [],
  })),
  convertHeicToJpeg: vi.fn(async () => Buffer.from("jpeg-normalized")),
  listWebSearchProviders: vi.fn<typeof import("../web-search/runtime.js").listWebSearchProviders>(
    () => [],
  ),
  isWebSearchProviderConfigured: vi.fn<
    typeof import("../web-search/runtime.js").isWebSearchProviderConfigured
  >(() => false),
  isWebFetchProviderConfigured: vi.fn(() => false),
  getModelsCommandSecretTargetIds: vi.fn(() => new Set(["models.providers.*.apiKey"])),
  getMemoryEmbeddingCommandSecretTargetIds: vi.fn(() => new Set(["models.providers.*.apiKey"])),
  getTtsCommandSecretTargetIds: vi.fn(() => new Set(["models.providers.*.apiKey"])),
  getCapabilityWebSearchCommandSecretTargets: vi.fn(
    (
      config: { tools?: { web?: { search?: { provider?: string } } } },
      options?: { providerId?: string },
    ) => {
      const providerId = options?.providerId ?? config.tools?.web?.search?.provider ?? "tavily";
      const pathValue = `plugins.entries.${providerId}.config.webSearch.apiKey`;
      return {
        targetIds: new Set([pathValue]),
        ...(options?.providerId ? { forcedActivePaths: new Set([pathValue]) } : {}),
      };
    },
  ),
  getCapabilityWebFetchCommandSecretTargets: vi.fn(
    (
      _config: { tools?: { web?: { fetch?: { provider?: string } } } },
      options?: { providerId?: string },
    ) => {
      const pathLocal =
        options?.providerId === "firecrawl"
          ? "plugins.entries.firecrawl.config.webSearch.apiKey"
          : "plugins.entries.firecrawl.config.webFetch.apiKey";
      return {
        targetIds: new Set([pathLocal]),
        ...(options?.providerId ? { forcedActivePaths: new Set([pathLocal]) } : {}),
      };
    },
  ),
  resolveCommandConfigWithSecrets: vi.fn(
    async ({ config }: { config: Record<string, unknown> }) => ({
      resolvedConfig: config,
      effectiveConfig: config,
      diagnostics: [],
    }),
  ),
  modelsStatusCommand: vi.fn(
    async (_opts: unknown, runtime: { log: (...args: unknown[]) => void }) => {
      runtime.log(JSON.stringify({ ok: true, providers: [{ id: "openai" }] }));
    },
  ),
  modelsAuthLoginCommand: vi.fn(),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: { writeJson: (value: unknown) => void }, value: unknown) =>
    runtime.writeJson(value),
}));

vi.mock("../secrets/provider-env-vars.js", () => ({
  getProviderEnvVars: mocks.getProviderEnvVars,
  resolveProviderAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {},
    authEvidenceMap: {},
  }),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfigSourceSnapshot:
    mocks.getRuntimeConfigSourceSnapshot as typeof import("../config/config.js").getRuntimeConfigSourceSnapshot,
  getRuntimeConfig: mocks.loadConfig as typeof import("../config/config.js").getRuntimeConfig,
  loadConfig: mocks.loadConfig as typeof import("../config/config.js").loadConfig,
  setRuntimeConfigSnapshot:
    mocks.setRuntimeConfigSnapshot as typeof import("../config/config.js").setRuntimeConfigSnapshot,
}));

vi.mock("../model-catalog/index.js", () => ({
  planEffectiveModelCatalogRows: mocks.planEffectiveModelCatalogRows,
}));

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: mocks.loadManifestMetadataSnapshot,
}));

vi.mock("./command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommandConfigWithSecrets,
}));

vi.mock("./command-secret-targets.js", () => ({
  getCapabilityWebFetchCommandSecretTargets: mocks.getCapabilityWebFetchCommandSecretTargets,
  getCapabilityWebSearchCommandSecretTargets: mocks.getCapabilityWebSearchCommandSecretTargets,
  getMemoryEmbeddingCommandSecretTargetIds: mocks.getMemoryEmbeddingCommandSecretTargetIds,
  getModelsCommandSecretTargetIds: mocks.getModelsCommandSecretTargetIds,
  getTtsCommandSecretTargetIds: mocks.getTtsCommandSecretTargetIds,
}));

// Account-secret snapshot preparation is covered by dedicated
// model.account-secrets.* and local-runners.account-secrets tests; keep this
// command-wiring suite on the pre-existing mocked world instead of loading the
// real secrets runtime.
vi.mock("./capability-cli/local-account-secrets.js", () => ({
  prepareLocalCapabilityAccountSecrets: vi.fn(async () => {}),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentConfig: () => ({}),
  resolveAgentEffectiveModelPrimary: (
    cfg: {
      agents?: {
        defaults?: { model?: string };
        entries?: Record<string, { model?: string }>;
      };
    },
    agentId: string,
  ) => cfg.agents?.entries?.[agentId]?.model ?? cfg.agents?.defaults?.model,
  resolveAgentModelFallbacksOverride: () => [],
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog:
    mocks.loadModelCatalog as typeof import("../agents/prepared-model-catalog.js").readPreparedModelCatalog,
}));

vi.mock("../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent:
    mocks.acquireSimpleCompletionModelForAgent as unknown as typeof import("../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel:
    mocks.completeWithPreparedSimpleCompletionModel as unknown as typeof import("../agents/simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel,
}));

vi.mock("../agents/auth-profiles.js", () => ({
  loadAuthProfileStoreForRuntime:
    mocks.loadAuthProfileStoreForRuntime as unknown as typeof import("../agents/auth-profiles.js").loadAuthProfileStoreForRuntime,
  listProfilesForProvider:
    mocks.listProfilesForProvider as typeof import("../agents/auth-profiles.js").listProfilesForProvider,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProviderCore:
    mocks.resolveApiKeyForProviderCore as typeof import("../agents/model-auth.js").resolveApiKeyForProviderCore,
}));

vi.mock("../agents/auth-profiles/store-runtime.js", () => ({
  updateAuthProfileStoreWithLock:
    mocks.updateAuthProfileStoreWithLock as typeof import("../agents/auth-profiles/store-runtime.js").updateAuthProfileStoreWithLock,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig:
    mocks.resolveMemorySearchConfig as typeof import("../agents/memory-search.js").resolveMemorySearchConfig,
}));

vi.mock("../commands/models/auth.js", () => ({
  modelsAuthLoginCommand: mocks.modelsAuthLoginCommand,
}));

vi.mock("../commands/models/list.status-command.js", () => ({
  modelsStatusCommand:
    mocks.modelsStatusCommand as typeof import("../commands/models/list.status-command.js").modelsStatusCommand,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway as typeof import("../gateway/call.js").callGateway,
  randomIdempotencyKey: () => "run-1",
}));

vi.mock("../gateway/connection-details.js", () => ({
  buildGatewayConnectionDetailsWithResolvers: vi.fn(() => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    message: "Gateway target: ws://127.0.0.1:18789",
  })),
}));

vi.mock("../media-understanding/runtime.js", () => ({
  describeImageFile:
    mocks.describeImageFile as typeof import("../media-understanding/runtime.js").describeImageFile,
  prepareImageDescriptionInput:
    mocks.prepareImageDescriptionInput as typeof import("../media-understanding/runtime.js").prepareImageDescriptionInput,
  describePreparedImageWithModel:
    mocks.describePreparedImageWithModel as typeof import("../media-understanding/runtime.js").describePreparedImageWithModel,
  describeImageFileWithModel:
    mocks.describeImageFileWithModel as typeof import("../media-understanding/runtime.js").describeImageFileWithModel,
  describeVideoFile:
    mocks.describeVideoFile as typeof import("../media-understanding/runtime.js").describeVideoFile,
  transcribeAudioFile:
    mocks.transcribeAudioFile as typeof import("../media-understanding/runtime.js").transcribeAudioFile,
}));

vi.mock("../media-understanding/provider-registry.js", () => ({
  buildMediaUnderstandingRegistry:
    mocks.buildMediaUnderstandingRegistry as typeof import("../media-understanding/provider-registry.js").buildMediaUnderstandingRegistry,
}));

vi.mock("../media-understanding/local-audio.js", () => ({
  inspectLocalAudioSelection: mocks.inspectLocalAudioSelection,
}));

vi.mock("../media/media-services.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/media-services.js")>();
  return {
    ...actual,
    convertHeicToJpeg:
      mocks.convertHeicToJpeg as typeof import("../media/media-services.js").convertHeicToJpeg,
  };
});

vi.mock("../plugins/memory-embedding-provider-runtime.js", () => ({
  listRegisteredMemoryEmbeddingProviderAdapters:
    mocks.listMemoryEmbeddingProviders as unknown as typeof import("../plugins/memory-embedding-provider-runtime.js").listRegisteredMemoryEmbeddingProviderAdapters,
}));

vi.mock("../plugins/embedding-provider-runtime.js", () => ({
  listEmbeddingProviders:
    mocks.listEmbeddingProviders as unknown as typeof import("../plugins/embedding-provider-runtime.js").listEmbeddingProviders,
}));

vi.mock("../plugin-sdk/memory-core-bundled-runtime.js", () => ({
  createEmbeddingProvider:
    mocks.createEmbeddingProvider as unknown as typeof import("../plugin-sdk/memory-core-bundled-runtime.js").createEmbeddingProvider,
}));

vi.mock("../image-generation/runtime.js", () => ({
  generateImage: (...args: unknown[]) => mocks.generateImage(...args),
  listRuntimeImageGenerationProviders: mocks.listRuntimeImageGenerationProviders,
}));

vi.mock("../video-generation/runtime.js", () => ({
  generateVideo: mocks.generateVideo,
  listRuntimeVideoGenerationProviders: mocks.listRuntimeVideoGenerationProviders,
}));

vi.mock("../tts/tts.js", () => ({
  getTtsPersona: vi.fn(() => undefined),
  getTtsProvider: mocks.getTtsProvider,
  listTtsPersonas: vi.fn(() => []),
  listSpeechVoices: vi.fn(async () => []),
  resolveTtsConfig:
    mocks.resolveTtsConfig as unknown as typeof import("../tts/tts.js").resolveTtsConfig,
  resolveTtsPrefsPath: vi.fn(() => "/tmp/tts.json"),
  setTtsEnabled: vi.fn(),
  setTtsPersona: mocks.setTtsPersona as typeof import("../tts/tts.js").setTtsPersona,
  setTtsProvider: mocks.setTtsProvider as typeof import("../tts/tts.js").setTtsProvider,
  resolveExplicitTtsOverrides:
    mocks.resolveExplicitTtsOverrides as typeof import("../tts/tts.js").resolveExplicitTtsOverrides,
  textToSpeech: mocks.textToSpeech as typeof import("../tts/tts.js").textToSpeech,
}));

vi.mock("../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: vi.fn((provider: string) => provider),
  listSpeechProviders: mocks.listSpeechProviders,
  normalizeSpeechProviderId: vi.fn(
    (provider: string | undefined) => provider?.trim().toLowerCase() || undefined,
  ),
}));

vi.mock("../web-search/runtime.js", () => ({
  listWebSearchProviders: mocks.listWebSearchProviders,
  isWebSearchProviderConfigured:
    mocks.isWebSearchProviderConfigured as typeof import("../web-search/runtime.js").isWebSearchProviderConfigured,
  runWebSearch: vi.fn(),
}));

vi.mock("../web-fetch/runtime.js", () => ({
  listWebFetchProviders: vi.fn(() => []),
  isWebFetchProviderConfigured:
    mocks.isWebFetchProviderConfigured as typeof import("../web-fetch/runtime.js").isWebFetchProviderConfigured,
  resolveWebFetchDefinition: vi.fn(),
}));

vi.mock("../plugins/web-fetch-providers.runtime.js", () => ({
  resolvePluginWebFetchProviders: vi.fn((params: { config?: Record<string, unknown> }) => [
    {
      pluginId: "firecrawl",
      id: "firecrawl",
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      getConfiguredCredentialValue: (config?: {
        plugins?: {
          entries?: {
            firecrawl?: { config?: { webFetch?: { apiKey?: unknown } } };
          };
        };
      }) => config?.plugins?.entries?.firecrawl?.config?.webFetch?.apiKey,
      getConfiguredCredentialFallback: () => ({
        path: "plugins.entries.firecrawl.config.webSearch.apiKey",
        value: (
          params.config as {
            plugins?: {
              entries?: {
                firecrawl?: { config?: { webSearch?: { apiKey?: unknown } } };
              };
            };
          }
        )?.plugins?.entries?.firecrawl?.config?.webSearch?.apiKey,
      }),
      getCredentialValue: (): undefined => undefined,
    },
  ]),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: vi.fn(() => [
    {
      pluginId: "tavily",
      id: "tavily",
      credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
      getConfiguredCredentialValue: (config?: {
        plugins?: {
          entries?: {
            tavily?: { config?: { webSearch?: { apiKey?: unknown } } };
          };
        };
      }) => config?.plugins?.entries?.tavily?.config?.webSearch?.apiKey,
      getConfiguredCredentialFallback: (): undefined => undefined,
      getCredentialValue: (): undefined => undefined,
    },
    {
      pluginId: "firecrawl",
      id: "firecrawl",
      credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
      getConfiguredCredentialValue: (config?: {
        plugins?: {
          entries?: {
            firecrawl?: { config?: { webSearch?: { apiKey?: unknown } } };
          };
        };
      }) => config?.plugins?.entries?.firecrawl?.config?.webSearch?.apiKey,
      getConfiguredCredentialFallback: (): undefined => undefined,
      getCredentialValue: (): undefined => undefined,
    },
    {
      pluginId: "exa",
      id: "exa",
      credentialPath: "plugins.entries.exa.config.webSearch.apiKey",
      getConfiguredCredentialValue: (config?: {
        plugins?: {
          entries?: {
            exa?: { config?: { webSearch?: { apiKey?: unknown } } };
          };
        };
      }) => config?.plugins?.entries?.exa?.config?.webSearch?.apiKey,
      getConfiguredCredentialFallback: (): undefined => undefined,
      getCredentialValue: (): undefined => undefined,
    },
  ]),
}));

export function getCapabilityCliMocks() {
  return mocks;
}

export function getCloseEmbeddingProviderMock() {
  return closeEmbeddingProviderMock;
}

export function restoreCapabilityCliMocks(): void {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
}

export function resetCapabilityCliMocks(): void {
  vi.stubEnv("OPENAI_API_KEY", "");
  mocks.loadConfig.mockReset().mockReturnValue({});
  mocks.runtime.log.mockClear();
  mocks.runtime.error.mockClear();
  mocks.runtime.writeJson.mockClear();
  mocks.loadModelCatalog
    .mockReset()
    .mockResolvedValue([{ id: "gpt-5.4", provider: "openai", name: "GPT-5.4" }] as never);
  mocks.loadAuthProfileStoreForRuntime
    .mockReset()
    .mockReturnValue({ version: 1, profiles: {}, order: {} });
  mocks.listProfilesForProvider.mockReset().mockReturnValue([]);
  mocks.resolveApiKeyForProviderCore.mockReset().mockRejectedValue(new Error("no auth profile"));
  mocks.loadManifestMetadataSnapshot
    .mockReset()
    .mockReturnValue(createPluginMetadataSnapshotFixture());
  mocks.planEffectiveModelCatalogRows
    .mockReset()
    .mockReturnValue({ rows: [], entries: [], conflicts: [] });
  mocks.resolveAgentDir.mockClear();
  mocks.resolveTtsConfig.mockReset().mockReturnValue({});
  mocks.getRuntimeConfigSourceSnapshot.mockReset().mockReturnValue(null);
  mocks.setRuntimeConfigSnapshot.mockClear();
  mocks.updateAuthProfileStoreWithLock
    .mockReset()
    .mockImplementation(async ({ updater }: { updater: (store: any) => boolean }) => {
      const store = {
        version: 1,
        profiles: {},
        order: {},
        lastGood: {},
        usageStats: {},
      };
      updater(store);
      return store;
    });
  mocks.resolveMemorySearchConfig.mockReset().mockReturnValue(null);
  mocks.acquireSimpleCompletionModelForAgent.mockClear();
  mocks.releaseSimpleCompletion.mockClear();
  mocks.completeWithPreparedSimpleCompletionModel.mockClear();
  mocks.callGateway.mockReset().mockImplementation((async ({ method }: { method: string }) => {
    if (method === "tts.status") {
      return { enabled: true, provider: "openai" };
    }
    if (method === "tts.convert") {
      return {
        audioPath: "/tmp/gateway-tts.mp3",
        provider: "openai",
        outputFormat: "mp3",
        voiceCompatible: false,
      };
    }
    if (method === "agent") {
      return {
        result: {
          payloads: [{ text: "gateway reply" }],
          meta: { agentMeta: { provider: "anthropic", model: "claude-sonnet-4-6" } },
        },
      };
    }
    return {};
  }) as never);
  mocks.describeImageFile.mockClear();
  mocks.prepareImageDescriptionInput.mockClear();
  mocks.describePreparedImageWithModel.mockClear();
  mocks.describeImageFileWithModel.mockClear();
  mocks.generateImage.mockReset();
  mocks.listRuntimeImageGenerationProviders.mockReset().mockReturnValue([]);
  mocks.generateVideo.mockReset();
  mocks.describeVideoFile.mockReset().mockResolvedValue({
    text: "friendly lobster",
    provider: "openai",
    model: "gpt-4.1-mini",
  } as never);
  mocks.listRuntimeVideoGenerationProviders.mockReset().mockReturnValue([]);
  mocks.transcribeAudioFile.mockClear();
  mocks.textToSpeech.mockClear();
  mocks.setTtsProvider.mockClear();
  mocks.setTtsPersona.mockClear();
  mocks.getTtsProvider.mockReset().mockReturnValue("openai");
  mocks.listSpeechProviders.mockReset().mockReturnValue([]);
  mocks.resolveExplicitTtsOverrides.mockClear();
  mocks.getProviderEnvVars
    .mockReset()
    .mockImplementation((providerId: string) => [
      `${providerId.toUpperCase().replaceAll("-", "_")}_API_KEY`,
    ]);
  mocks.buildMediaUnderstandingRegistry.mockReset().mockReturnValue(new Map());
  mocks.inspectLocalAudioSelection.mockReset().mockResolvedValue({ candidates: [], entries: [] });
  mocks.convertHeicToJpeg.mockClear();
  mocks.createEmbeddingProvider.mockClear();
  closeEmbeddingProviderMock.mockClear();
  mocks.listMemoryEmbeddingProviders
    .mockReset()
    .mockReturnValue([
      { id: "openai", defaultModel: "text-embedding-3-small", transport: "remote" },
    ]);
  mocks.listEmbeddingProviders.mockReset().mockReturnValue([]);
  mocks.listWebSearchProviders.mockReset().mockReturnValue([]);
  mocks.isWebSearchProviderConfigured.mockReset().mockReturnValue(false);
  mocks.isWebFetchProviderConfigured.mockReset().mockReturnValue(false);
  mocks.getModelsCommandSecretTargetIds.mockClear();
  mocks.getMemoryEmbeddingCommandSecretTargetIds.mockClear();
  mocks.getTtsCommandSecretTargetIds.mockClear();
  mocks.getCapabilityWebSearchCommandSecretTargets.mockClear();
  mocks.getCapabilityWebFetchCommandSecretTargets.mockClear();
  mocks.resolveCommandConfigWithSecrets
    .mockReset()
    .mockImplementation(async ({ config }: { config: Record<string, unknown> }) => ({
      resolvedConfig: config,
      effectiveConfig: config,
      diagnostics: [],
    }));
  mocks.modelsStatusCommand.mockClear();
  mocks.modelsAuthLoginCommand.mockClear();
}
