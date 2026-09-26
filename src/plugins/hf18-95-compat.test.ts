// The HF-18 plugin must register on the patched stock-version host, never silently on vanilla stock.
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { loadOpenClawPlugins } from "./loader.js";
import { resetPluginLoaderTestStateForTest, useNoBundledPlugins } from "./loader.test-fixtures.js";

const pluginDir = fileURLToPath(
  new URL("../../local-hotfixes/hf18-slack-thread-guard/", import.meta.url),
);
const pluginId = "slack-thread-guard";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
});

it("loads and dispatches the HF-18 route hook from a 2026.9.5 bundle", async () => {
  useNoBundledPlugins();
  vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "2026.9.5");
  const registry = loadOpenClawPlugins({
    config: {
      plugins: {
        allow: [pluginId],
        entries: { [pluginId]: { enabled: true } },
        load: { paths: [`${pluginDir}index.js`] },
        slots: { memory: "none" },
      },
    },
    onlyPluginIds: [pluginId],
    activate: false,
    cache: false,
  });
  expect(registry.plugins.find((plugin) => plugin.id === pluginId)?.status).toBe("loaded");
  expect(registry.typedHooks.some((hook) => hook.hookName === "outbound_route_decision")).toBe(
    true,
  );
  // The handler executes in the actual host hook runner, not just a mock callback.
  const runner = createHookRunner(registry, { logger: { debug() {}, warn() {}, error() {} } });
  expect(runner?.hasHooks("outbound_route_decision")).toBe(true);
  expect(
    await runner?.runOutboundRouteDecision(
      { sessionKey: "agent:main:main", original: { channel: "webchat", to: "web-user" } },
      { channelId: "webchat" },
      undefined,
      undefined,
    ),
  ).toBeUndefined();
});
