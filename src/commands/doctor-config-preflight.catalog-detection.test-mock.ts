import { vi } from "vitest";

const detectLegacyPluginModelCatalogs = vi.hoisted(() =>
  vi.fn(async () => ({ detected: [], migrations: [], warnings: [] })),
);

vi.mock("./doctor-plugin-model-catalog-detection.js", () => ({
  detectLegacyPluginModelCatalogs,
  formatLegacyPluginModelCatalogStartupRefusal: vi.fn(),
}));
