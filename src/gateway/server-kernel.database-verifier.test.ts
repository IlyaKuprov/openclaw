import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel } from "./server-kernel.js";
import { startGatewayServerCore } from "./server-start.js";

it("defers audit integrity on the direct Gateway first state open and restores full local checks on failed bootstrap", async () => {
  const state = await createOpenClawTestState({
    label: "gateway-direct-first-state-open",
    layout: "home",
    env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: "1" },
  });
  state.applyEnv();
  const bootstrapModule = await import("./server-startup-bootstrap.js");
  const checks: string[] = [];
  // oxlint-disable-next-line typescript/unbound-method -- Forward the native method with its database receiver.
  const prepare = DatabaseSync.prototype.prepare;
  const sqlSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (sql.startsWith("PRAGMA integrity_check") || sql.startsWith("PRAGMA quick_check")) {
      checks.push(sql);
    }
    return prepare.call(this, sql);
  });
  try {
    openOpenClawStateDatabase({ env: process.env });
    closeOpenClawStateDatabaseForTest();
    checks.length = 0;
    const failure = new Error("synthetic bootstrap interruption");
    const bootstrap = vi
      .spyOn(bootstrapModule, "prepareGatewayServerBootstrap")
      .mockImplementation(async () => {
        // Exercise the real first writable open inside the Gateway entrypoint.
        openOpenClawStateDatabase({ env: process.env });
        throw failure;
      });
    try {
      await expect(createGatewayKernel()).rejects.toThrow(failure);
      expect(checks).toContain("PRAGMA quick_check;");
      expect(checks).not.toContain("PRAGMA integrity_check;");
      closeOpenClawStateDatabaseForTest();
      checks.length = 0;
      openOpenClawStateDatabase({ env: process.env });
      expect(checks).toContain("PRAGMA integrity_check;");
    } finally {
      bootstrap.mockRestore();
    }
  } finally {
    sqlSpy.mockRestore();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it("adopts the CLI verifier once and joins it on normal Gateway close", async () => {
  const state = await createOpenClawTestState({
    label: "gateway-adopt-boot-verifier",
    layout: "home",
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      VITEST: "1",
    },
  });
  const token = "synthetic-verifier-lifetime-token";
  await state.writeConfig({ gateway: { auth: { mode: "token", token } }, plugins: {} });
  state.applyEnv();
  const verifier = { stop: vi.fn(async () => {}) };
  let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
  try {
    server = await startGatewayServerCore(await getFreePort(), {
      auth: { mode: "token", token },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
      databaseIntegrityVerifier: verifier,
    });
    await server.startupSettled;
    expect(verifier.stop).not.toHaveBeenCalled();
    await server.close();
    expect(verifier.stop).toHaveBeenCalledOnce();
  } finally {
    await server?.close();
    await state.cleanup();
  }
});
