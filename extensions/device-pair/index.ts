// Device Pair plugin entrypoint registers its OpenClaw integration.
import { rm } from "node:fs/promises";
import path from "node:path";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PairingSetupConnectivityResolution } from "./api.js";
import { buildDevicePairPairingQrChannelData } from "./pairing-qr-channel-data.js";
type NotifyModule = typeof import("./notify.js");

const loadDevicePairApiModule = createLazyRuntimeModule(() => import("./api.js"));

const loadNotifyModule = createLazyRuntimeModule(() => import("./notify.js"));

const loadPairCommandApproveModule = createLazyRuntimeModule(
  () => import("./pair-command-approve.js"),
);

const loadPairCommandAuthModule = createLazyRuntimeModule(() => import("./pair-command-auth.js"));

function formatDurationMinutes(expiresAtMs: number): string {
  const msRemaining = Math.max(0, expiresAtMs - Date.now());
  const minutes = Math.max(1, Math.ceil(msRemaining / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

type DevicePairPluginConfig = {
  publicUrl?: string;
};

type SetupPayload = {
  url: string;
  urls?: string[];
  bootstrapToken: string;
  expiresAtMs: number;
  access: "full" | "limited" | "node";
  accessDowngraded?: true;
};

type QrCommandContext = {
  channel: string;
  senderId?: string;
  from?: string;
  to?: string;
  accountId?: string;
  messageThreadId?: string | number;
};

type QrChannelSender = {
  createOpts: (params: {
    ctx: QrCommandContext;
    qrFilePath: string;
    mediaLocalRoots: string[];
    accountId?: string;
  }) => Record<string, unknown>;
};

const QR_CHANNEL_SENDERS: Record<string, QrChannelSender> = {
  telegram: {
    createOpts: ({ ctx, qrFilePath, mediaLocalRoots, accountId }) => ({
      mediaUrl: qrFilePath,
      mediaLocalRoots,
      ...(ctx.messageThreadId != null ? { threadId: ctx.messageThreadId } : {}),
      ...(accountId ? { accountId } : {}),
    }),
  },
  discord: {
    createOpts: ({ qrFilePath, mediaLocalRoots, accountId }) => ({
      mediaUrl: qrFilePath,
      mediaLocalRoots,
      ...(accountId ? { accountId } : {}),
    }),
  },
  slack: {
    createOpts: ({ ctx, qrFilePath, mediaLocalRoots, accountId }) => ({
      mediaUrl: qrFilePath,
      mediaLocalRoots,
      ...(ctx.messageThreadId != null ? { threadId: String(ctx.messageThreadId) } : {}),
      ...(accountId ? { accountId } : {}),
    }),
  },
  signal: {
    createOpts: ({ qrFilePath, mediaLocalRoots, accountId }) => ({
      mediaUrl: qrFilePath,
      mediaLocalRoots,
      ...(accountId ? { accountId } : {}),
    }),
  },
  imessage: {
    createOpts: ({ qrFilePath, mediaLocalRoots, accountId }) => ({
      mediaUrl: qrFilePath,
      mediaLocalRoots,
      ...(accountId ? { accountId } : {}),
    }),
  },
  whatsapp: {
    createOpts: ({ qrFilePath, mediaLocalRoots, accountId }) => ({
      verbose: false,
      mediaUrl: qrFilePath,
      mediaLocalRoots,
      ...(accountId ? { accountId } : {}),
    }),
  },
};

function encodeSetupCode(payload: SetupPayload): string {
  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json, "utf8").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function buildPairingFlowLines(stepTwo: string): string[] {
  return [
    "1) Open the iOS app → Settings → Gateway",
    `2) ${stepTwo}`,
    "3) Back here, run /pair approve",
    "4) If this code leaks or you are done, run /pair cleanup",
  ];
}

function buildSecurityNoticeLines(params: {
  kind: "setup code" | "QR code";
  expiresAtMs: number;
  markdown?: boolean;
}): string[] {
  const cleanupCommand = params.markdown ? "`/pair cleanup`" : "/pair cleanup";
  const securityPrefix = params.markdown ? "- " : "";
  const importantLine = params.markdown
    ? `**Important:** Run ${cleanupCommand} after pairing finishes.`
    : `IMPORTANT: After pairing finishes, run ${cleanupCommand}.`;
  return [
    `${securityPrefix}Security: single-use bootstrap token`,
    `${securityPrefix}Expires: ${formatDurationMinutes(params.expiresAtMs)}`,
    "",
    importantLine,
    `If this ${params.kind} leaks, run ${cleanupCommand} immediately.`,
  ];
}

function buildQrFollowUpLines(autoNotifyArmed: boolean): string[] {
  return autoNotifyArmed
    ? [
        "After scanning, wait here for the pairing request ping.",
        "I’ll auto-ping here when the pairing request arrives, then auto-disable.",
        "If the ping does not arrive, run `/pair approve latest` manually.",
      ]
    : ["After scanning, run `/pair approve` to complete pairing."];
}

function formatSetupReply(payload: SetupPayload, authLabel: string): string {
  const setupCode = encodeSetupCode(payload);
  return [
    "Pairing setup code generated.",
    "",
    ...buildPairingFlowLines("Paste the setup code below and tap Connect"),
    "",
    "Setup code:",
    setupCode,
    "",
    ...formatGatewayLines(payload),
    `Auth: ${authLabel}`,
    ...buildAccessLines(payload),
    ...buildSecurityNoticeLines({
      kind: "setup code",
      expiresAtMs: payload.expiresAtMs,
    }),
  ].join("\n");
}

function formatSetupInstructions(expiresAtMs: number): string {
  return [
    "Pairing setup code generated.",
    "",
    ...buildPairingFlowLines("Paste the setup code from my next message and tap Connect"),
    "",
    ...buildSecurityNoticeLines({
      kind: "setup code",
      expiresAtMs,
    }),
  ].join("\n");
}

function buildQrInfoLines(params: {
  payload: SetupPayload;
  authLabel: string;
  autoNotifyArmed: boolean;
  expiresAtMs: number;
}): string[] {
  return [
    ...formatGatewayLines(params.payload),
    `Auth: ${params.authLabel}`,
    ...buildAccessLines(params.payload),
    ...buildSecurityNoticeLines({
      kind: "QR code",
      expiresAtMs: params.expiresAtMs,
    }),
    "",
    ...buildQrFollowUpLines(params.autoNotifyArmed),
    "",
    "If your camera still won’t lock on, run `/pair` for a pasteable setup code.",
  ];
}

function formatQrInfoMarkdown(params: {
  payload: SetupPayload;
  authLabel: string;
  autoNotifyArmed: boolean;
  expiresAtMs: number;
}): string {
  return [
    ...formatGatewayLines(params.payload).map((line) => `- ${line}`),
    `- Auth: ${params.authLabel}`,
    ...buildAccessLines(params.payload, true),
    ...buildSecurityNoticeLines({
      kind: "QR code",
      expiresAtMs: params.expiresAtMs,
      markdown: true,
    }),
    "",
    ...buildQrFollowUpLines(params.autoNotifyArmed),
    "",
    "If your camera still won’t lock on, run `/pair` for a pasteable setup code.",
  ].join("\n");
}

function resolveQrChannelSender(channel: string): QrChannelSender | undefined {
  // Prototype names are not supported channel entries and must take the setup-code fallback.
  return Object.hasOwn(QR_CHANNEL_SENDERS, channel) ? QR_CHANNEL_SENDERS[channel] : undefined;
}

function resolveQrReplyTarget(ctx: QrCommandContext): string {
  if (ctx.channel === "discord") {
    const senderId = normalizeOptionalString(ctx.senderId) ?? "";
    if (senderId) {
      return senderId.startsWith("user:") || senderId.startsWith("channel:")
        ? senderId
        : `user:${senderId}`;
    }
  }
  return (
    normalizeOptionalString(ctx.senderId) ||
    normalizeOptionalString(ctx.from) ||
    normalizeOptionalString(ctx.to) ||
    ""
  );
}

function formatGatewayLines(payload: SetupPayload): string[] {
  return (payload.urls ?? [payload.url]).map((url, index) =>
    index === 0 ? `Gateway: ${url}` : `Fallback: ${url}`,
  );
}

function buildAccessLines(payload: SetupPayload, markdown = false): string[] {
  const prefix = markdown ? "- " : "";
  return [
    `${prefix}Access: ${payload.access}`,
    ...(payload.accessDowngraded
      ? [
          `${prefix}Plaintext ws:// was limited for safety. Use wss:// or Tailscale Serve, then generate a new code for full access.`,
        ]
      : []),
  ];
}

type ReadyPairingConnectivity = Extract<PairingSetupConnectivityResolution, { ok: true }>;

async function issueSetupPayload(resolved: ReadyPairingConnectivity): Promise<SetupPayload> {
  const { issueDeviceBootstrapToken } = await loadDevicePairApiModule();
  const issuedBootstrap = await issueDeviceBootstrapToken({
    profile: resolved.bootstrapProfile,
  });
  const [url] = resolved.urls;
  if (!url) {
    throw new Error("Gateway URL unavailable.");
  }
  return {
    url,
    ...(resolved.urls.length > 1 ? { urls: resolved.urls } : {}),
    bootstrapToken: issuedBootstrap.token,
    expiresAtMs: issuedBootstrap.expiresAtMs,
    access: resolved.access,
    ...(resolved.accessDowngraded ? { accessDowngraded: true } : {}),
  };
}

async function sendQrPngToSupportedChannel(params: {
  api: OpenClawPluginApi;
  ctx: QrCommandContext;
  sender: QrChannelSender;
  target: string;
  caption: string;
  qrFilePath: string;
}): Promise<boolean> {
  const mediaLocalRoots = [path.dirname(params.qrFilePath)];
  const accountId = normalizeOptionalString(params.ctx.accountId) || undefined;
  const adapter = await params.api.runtime.channel.outbound.loadAdapter(params.ctx.channel);
  const send = adapter?.sendMedia;
  if (!send) {
    return false;
  }
  await send({
    cfg: params.api.config,
    to: params.target,
    text: params.caption,
    ...params.sender.createOpts({
      ctx: params.ctx,
      qrFilePath: params.qrFilePath,
      mediaLocalRoots,
      accountId,
    }),
  });
  return true;
}

export default definePluginEntry({
  id: "device-pair",
  name: "Device Pair",
  description: "QR/bootstrap pairing helpers for OpenClaw devices",
  register(api: OpenClawPluginApi) {
    let notifierService: ReturnType<NotifyModule["createPairingNotifierService"]> | undefined;
    api.registerService({
      id: "device-pair-notifier",
      start: async (ctx) => {
        const { createPairingNotifierService } = await loadNotifyModule();
        notifierService = createPairingNotifierService(api);
        await notifierService.start(ctx);
      },
      stop: async (ctx) => {
        await notifierService?.stop?.(ctx);
        notifierService = undefined;
      },
    });

    api.registerCommand({
      name: "pair",
      description: "Generate setup codes and approve device pairing requests.",
      acceptsArgs: true,
      requiredScopes: ["operator.pairing"],
      handler: async (ctx) => {
        const args = normalizeOptionalString(ctx.args) ?? "";
        const tokens = args.split(/\s+/).filter(Boolean);
        const action = normalizeLowercaseStringOrEmpty(tokens[0]);
        const gatewayClientScopes = Array.isArray(ctx.gatewayClientScopes)
          ? ctx.gatewayClientScopes
          : undefined;
        const {
          buildMissingPairingScopeReply,
          buildMissingSetupHandoffScopeReply,
          resolvePairingCommandAuthState,
        } = await loadPairCommandAuthModule();
        const authState = resolvePairingCommandAuthState({
          channel: ctx.channel,
          gatewayClientScopes,
          senderIsOwner: ctx.senderIsOwner,
        });
        api.logger.info?.(
          `device-pair: /pair invoked channel=${ctx.channel} sender=${ctx.senderId ?? "unknown"} action=${
            action || "new"
          }`,
        );

        if (authState.isMissingPairingPrivilege) {
          return buildMissingPairingScopeReply();
        }

        if (action === "status" || action === "pending") {
          const [{ listDevicePairing }, { formatPendingRequests }] = await Promise.all([
            loadDevicePairApiModule(),
            loadNotifyModule(),
          ]);
          const list = await listDevicePairing();
          return { text: formatPendingRequests(list.pending) };
        }

        if (action === "notify") {
          const notifyAction = normalizeLowercaseStringOrEmpty(tokens[1]) || "status";
          const { handleNotifyCommand } = await loadNotifyModule();
          return await handleNotifyCommand({
            api,
            ctx,
            action: notifyAction,
          });
        }

        if (action === "approve") {
          const [
            { listDevicePairing },
            { approvePendingPairingRequest, selectPendingApprovalRequest },
          ] = await Promise.all([loadDevicePairApiModule(), loadPairCommandApproveModule()]);
          const list = await listDevicePairing();
          const selected = selectPendingApprovalRequest({
            pending: list.pending,
            requested: normalizeOptionalString(tokens[1]),
          });
          if (selected.reply) {
            return selected.reply;
          }
          const pending = selected.pending;
          if (!pending) {
            return { text: "Pairing request not found." };
          }
          return await approvePendingPairingRequest({
            requestId: pending.requestId,
            callerScopes: authState.approvalCallerScopes,
          });
        }

        if (action === "cleanup" || action === "clear" || action === "revoke") {
          const { clearDeviceBootstrapTokens } = await loadDevicePairApiModule();
          const cleared = await clearDeviceBootstrapTokens();
          return {
            text:
              cleared.removed > 0
                ? `Invalidated ${cleared.removed} unused setup code${cleared.removed === 1 ? "" : "s"}.`
                : "No unused setup codes were active.",
          };
        }

        if (authState.isMissingSetupHandoffPrivilege) {
          return buildMissingSetupHandoffScopeReply();
        }

        const {
          PAIRING_SETUP_BOOTSTRAP_PROFILE,
          resolvePairingSetupConnectivityFromConfig,
          runPluginCommandWithTimeout,
        } = await loadDevicePairApiModule();
        const pluginConfig = (api.pluginConfig ?? {}) as DevicePairPluginConfig;
        const connectivity = await resolvePairingSetupConnectivityFromConfig(api.config, {
          publicUrl: pluginConfig.publicUrl,
          ...(authState.canIssueFullAccessSetup
            ? {}
            : { bootstrapProfile: PAIRING_SETUP_BOOTSTRAP_PROFILE }),
          runCommandWithTimeout: async (argv, opts) =>
            await runPluginCommandWithTimeout({
              argv,
              timeoutMs: opts.timeoutMs,
              env: opts.env,
            }),
        });
        if (!connectivity.ok) {
          return { text: `Error: ${connectivity.error}` };
        }
        const authLabel = connectivity.authLabel;

        if (action === "qr") {
          const channel = ctx.channel;
          const qrChannelSender = resolveQrChannelSender(channel);
          const target = resolveQrReplyTarget(ctx);
          let autoNotifyArmed = false;

          if (channel === "telegram" && target) {
            try {
              const { armPairNotifyOnce } = await loadNotifyModule();
              autoNotifyArmed = await armPairNotifyOnce({ api, ctx });
            } catch (err) {
              api.logger.warn?.(
                `device-pair: failed to arm one-shot pairing notify (${(err as Error)?.message ?? err})`,
              );
            }
          }

          let payload = await issueSetupPayload(connectivity);
          let setupCode = encodeSetupCode(payload);

          const infoLines = buildQrInfoLines({
            payload,
            authLabel,
            autoNotifyArmed,
            expiresAtMs: payload.expiresAtMs,
          });

          if (target && qrChannelSender) {
            let qrFilePath: string | undefined;
            try {
              const { resolvePreferredOpenClawTmpDir, writeQrPngTempFile } =
                await loadDevicePairApiModule();
              qrFilePath = (
                await writeQrPngTempFile(setupCode, {
                  tmpRoot: resolvePreferredOpenClawTmpDir(),
                  dirPrefix: "device-pair-qr-",
                  fileName: "pair-qr.png",
                })
              ).filePath;
              const sent = await sendQrPngToSupportedChannel({
                api,
                ctx,
                sender: qrChannelSender,
                target,
                caption: ["Scan this QR code with the OpenClaw iOS app:", "", ...infoLines].join(
                  "\n",
                ),
                qrFilePath,
              });
              if (sent) {
                return {
                  text:
                    `QR code sent above.\n` +
                    `Expires: ${formatDurationMinutes(payload.expiresAtMs)}\n` +
                    "IMPORTANT: Run /pair cleanup after pairing finishes.",
                };
              }
            } catch (err) {
              const { revokeDeviceBootstrapToken } = await loadDevicePairApiModule();
              api.logger.warn?.(
                `device-pair: QR image send failed channel=${channel}, falling back (${(err as Error)?.message ?? err})`,
              );
              await revokeDeviceBootstrapToken({ token: payload.bootstrapToken }).catch(() => {});
              payload = await issueSetupPayload(connectivity);
              setupCode = encodeSetupCode(payload);
            } finally {
              if (qrFilePath) {
                await rm(path.dirname(qrFilePath), { recursive: true, force: true }).catch(
                  () => {},
                );
              }
            }
          }

          api.logger.info?.(`device-pair: QR fallback channel=${channel} target=${target}`);
          if (channel === "webchat") {
            try {
              const { renderQrPngDataUrl } = await loadDevicePairApiModule();
              await renderQrPngDataUrl(setupCode);
            } catch (err) {
              const { revokeDeviceBootstrapToken } = await loadDevicePairApiModule();
              api.logger.warn?.(
                `device-pair: webchat QR render failed, falling back (${(err as Error)?.message ?? err})`,
              );
              await revokeDeviceBootstrapToken({ token: payload.bootstrapToken }).catch(() => {});
              payload = await issueSetupPayload(connectivity);
              return {
                text:
                  "QR image delivery is not available on this channel right now, so I generated a pasteable setup code instead.\n\n" +
                  formatSetupReply(payload, authLabel),
              };
            }
            return {
              text: [
                "Scan this QR code with the OpenClaw iOS app:",
                "",
                formatQrInfoMarkdown({
                  payload,
                  authLabel,
                  autoNotifyArmed,
                  expiresAtMs: payload.expiresAtMs,
                }),
              ].join("\n"),
              channelData: buildDevicePairPairingQrChannelData({
                setupCode,
                expiresAtMs: payload.expiresAtMs,
              }),
              sensitiveMedia: true,
            };
          }

          return {
            text:
              "QR image delivery is not available on this channel, so I generated a pasteable setup code instead.\n\n" +
              formatSetupReply(payload, authLabel),
          };
        }
        const channel = ctx.channel;
        const target =
          normalizeOptionalString(ctx.senderId) ||
          normalizeOptionalString(ctx.from) ||
          normalizeOptionalString(ctx.to) ||
          "";
        const payload = await issueSetupPayload(connectivity);

        if (channel === "telegram" && target) {
          try {
            const runtimeKeys = Object.keys(api.runtime ?? {});
            const channelKeys = Object.keys(api.runtime?.channel ?? {});
            api.logger.debug?.(
              `device-pair: runtime keys=${runtimeKeys.join(",") || "none"} channel keys=${
                channelKeys.join(",") || "none"
              }`,
            );
            const adapter = await api.runtime.channel.outbound.loadAdapter("telegram");
            const send = adapter?.sendText;
            if (!send) {
              throw new Error(
                `telegram runtime unavailable (runtime keys: ${runtimeKeys.join(",")}; channel keys: ${channelKeys.join(
                  ",",
                )})`,
              );
            }
            await send({
              cfg: api.config,
              to: target,
              text: formatSetupInstructions(payload.expiresAtMs),
              ...(ctx.messageThreadId != null ? { threadId: ctx.messageThreadId } : {}),
              ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
            });
            api.logger.info?.(
              `device-pair: telegram split send ok target=${target} account=${ctx.accountId ?? "none"} thread=${
                ctx.messageThreadId ?? "none"
              }`,
            );
            return { text: encodeSetupCode(payload) };
          } catch (err) {
            api.logger.warn?.(
              `device-pair: telegram split send failed, falling back to single message (${(err as Error)?.message ?? err})`,
            );
          }
        }
        return {
          text: formatSetupReply(payload, authLabel),
        };
      },
    });
  },
});
