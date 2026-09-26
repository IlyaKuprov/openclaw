import type { GatewayBindMode } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  findVerifiedGatewayListenerPidsOnPortSync,
  formatGatewayPidList,
} from "../../infra/gateway-processes.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import {
  isTerminalInteractive,
  NON_INTERACTIVE_GATEWAY_RUN_FORCE_MESSAGE,
} from "../terminal-interactivity.js";

export async function prepareGatewayRunForcedPort(params: {
  force: boolean;
  port: number;
  bindExplicitRaw: GatewayBindMode | undefined;
  cfg: OpenClawConfig;
  gatewayLog: ReturnType<typeof createSubsystemLogger>;
  toOptionString(value: unknown): string | undefined;
}): Promise<boolean> {
  if (params.force) {
    const interactive = isTerminalInteractive();
    const describeNonInteractiveGatewayOwner = () => {
      const gatewayPids = findVerifiedGatewayListenerPidsOnPortSync(params.port);
      if (gatewayPids.length === 0) {
        return undefined;
      }
      return `${NON_INTERACTIVE_GATEWAY_RUN_FORCE_MESSAGE} Existing gateway listener pid${gatewayPids.length === 1 ? "" : "s"}: ${formatGatewayPidList(gatewayPids)}.`;
    };
    if (!interactive) {
      const refusal = describeNonInteractiveGatewayOwner();
      if (refusal) {
        defaultRuntime.error(refusal);
        defaultRuntime.exit(1);
        return false;
      }
    }
    try {
      const { forceFreePortAndWait, waitForPortBindable } = await import("../ports.js");
      const { killed, waitedMs, escalatedToSigkill } = await forceFreePortAndWait(params.port, {
        timeoutMs: 2000,
        intervalMs: 100,
        sigtermTimeoutMs: 700,
        ...(interactive
          ? {}
          : {
              beforeSignal: () => {
                const refusal = describeNonInteractiveGatewayOwner();
                if (refusal) {
                  throw new Error(refusal);
                }
              },
            }),
      });
      if (killed.length === 0) {
        // Nothing was freed; keep the no-op out of normal startup output.
        params.gatewayLog.debug(`force: no listeners on port ${params.port}`);
      } else {
        for (const proc of killed) {
          params.gatewayLog.info(
            `force: killed pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""} on port ${params.port}`,
          );
        }
        if (escalatedToSigkill) {
          params.gatewayLog.info(`force: escalated to SIGKILL while freeing port ${params.port}`);
        }
        if (waitedMs > 0) {
          params.gatewayLog.info(`force: waited ${waitedMs}ms for port ${params.port} to free`);
        }
      }
      // After killing, verify the port is actually bindable (handles TIME_WAIT).
      const bindProbeHost =
        params.bindExplicitRaw === "loopback"
          ? "127.0.0.1"
          : params.bindExplicitRaw === "lan"
            ? "0.0.0.0"
            : params.bindExplicitRaw === "custom"
              ? params.toOptionString(params.cfg.gateway?.customBindHost)
              : undefined;
      const bindWaitMs = await waitForPortBindable(params.port, {
        timeoutMs: 3000,
        intervalMs: 150,
        host: bindProbeHost,
      });
      if (bindWaitMs > 0) {
        params.gatewayLog.info(
          `force: waited ${bindWaitMs}ms for port ${params.port} to become bindable`,
        );
      }
    } catch (err) {
      defaultRuntime.error(
        `Could not free port ${params.port}: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} to inspect the listener.`,
      );
      defaultRuntime.exit(1);
      return false;
    }
  }
  return true;
}
