// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Device pairing and token-management protocol schemas.
 *
 * These payloads cross the gateway approval boundary, so request ids and device
 * ids stay explicit and feature handlers own the authorization checks.
 */
/** Lists pending and approved device pairing records. */
export const DevicePairListParamsSchema = closedObject({});

/** Approves a pending pairing request by request id. */
export const DevicePairApproveParamsSchema = closedObject({ requestId: NonEmptyString });

/** Rejects a pending pairing request by request id. */
export const DevicePairRejectParamsSchema = closedObject({ requestId: NonEmptyString });

/** Removes an approved or remembered device by device id. */
export const DevicePairRemoveParamsSchema = closedObject({ deviceId: NonEmptyString });

/** Operator-assigned label for a paired device (max 64 chars after protocol bound). */
const DevicePairLabelString = Type.String({ minLength: 1, maxLength: 64 });

/** Renames a paired device while preserving its stable device id. */
export const DevicePairRenameParamsSchema = closedObject({
  deviceId: NonEmptyString,
  label: DevicePairLabelString,
});

/** Rotates or issues a device token for a specific role/scope grant. */
export const DeviceTokenRotateParamsSchema = closedObject({
  deviceId: NonEmptyString,
  role: NonEmptyString,
  scopes: Type.Optional(Type.Array(NonEmptyString)),
});

/** Revokes one role-bound device token grant. */
export const DeviceTokenRevokeParamsSchema = closedObject({
  deviceId: NonEmptyString,
  role: NonEmptyString,
});

/** Event emitted when a client opens or refreshes a pairing request. */
export const DevicePairRequestedEventSchema = closedObject({
  requestId: NonEmptyString,
  deviceId: NonEmptyString,
  publicKey: NonEmptyString,
  displayName: Type.Optional(NonEmptyString),
  platform: Type.Optional(NonEmptyString),
  deviceFamily: Type.Optional(NonEmptyString),
  clientId: Type.Optional(NonEmptyString),
  clientMode: Type.Optional(NonEmptyString),
  browserOrigin: Type.Optional(NonEmptyString),
  role: Type.Optional(NonEmptyString),
  roles: Type.Optional(Type.Array(NonEmptyString)),
  scopes: Type.Optional(Type.Array(NonEmptyString)),
  remoteIp: Type.Optional(NonEmptyString),
  silent: Type.Optional(Type.Boolean()),
  isRepair: Type.Optional(Type.Boolean()),
  ts: Type.Integer({ minimum: 0 }),
});

/** Event emitted after a pairing request is approved, rejected, or otherwise resolved. */
export const DevicePairResolvedEventSchema = closedObject({
  requestId: NonEmptyString,
  deviceId: NonEmptyString,
  decision: NonEmptyString,
  ts: Type.Integer({ minimum: 0 }),
});

const SetupCodeQrDataUrlSchema = Type.String({
  maxLength: 16_384,
  pattern: "^data:image/png;base64,",
});

const PairingConnectivityUrlSchema = Type.String({ minLength: 1, maxLength: 2048 });
const PairingConnectivityUrlsSchema = Type.Array(PairingConnectivityUrlSchema, {
  minItems: 1,
  maxItems: 8,
  uniqueItems: true,
});
const PairingConnectivityAuthSchema = Type.Union([
  Type.Literal("token"),
  Type.Literal("password"),
  Type.Literal("missing"),
  Type.Literal("invalid"),
]);
const PairingConnectivityBlockerSchema = Type.Union([
  Type.Literal("gateway-auth-required"),
  Type.Literal("gateway-auth-invalid"),
  Type.Literal("route-unavailable"),
  Type.Literal("route-insecure"),
  Type.Literal("lan-unavailable"),
  Type.Literal("tailscale-unavailable"),
  Type.Literal("tailscale-login-required"),
  Type.Literal("tailscale-not-running"),
  Type.Literal("tailscale-starting"),
  Type.Literal("tailscale-status-error"),
  Type.Literal("tailscale-serve-required"),
  Type.Literal("public-url-required"),
  Type.Literal("public-url-invalid"),
  Type.Literal("public-url-insecure"),
]);
const PairingConnectivityModeSchema = Type.Union([
  Type.Literal("lan"),
  Type.Literal("tailscale"),
  Type.Literal("public"),
]);
const PairingConnectivityAccessSchema = Type.Union([
  Type.Literal("full"),
  Type.Literal("limited"),
  Type.Literal("node"),
]);
const PairingConnectivityExposureSchema = Type.Union([
  Type.Literal("same-host"),
  Type.Literal("local-network"),
  Type.Literal("tailnet"),
  Type.Literal("public-internet"),
]);
const PairingConnectivityChangesSchema = Type.Array(
  Type.Union([
    Type.Literal("expose-gateway-on-local-network"),
    Type.Literal("enable-tailscale-serve"),
  ]),
  { maxItems: 2, uniqueItems: true },
);
const PairingConnectivityConfigHashSchema = Type.String({ minLength: 1, maxLength: 128 });

const TailscalePublishedRouteSchema = Type.Union([
  closedObject({ status: Type.Literal("ready"), urls: PairingConnectivityUrlsSchema }),
  closedObject({
    status: Type.Union([Type.Literal("not-configured"), Type.Literal("error")]),
  }),
]);

const TailscaleConnectivityInspectionSchema = Type.Union([
  closedObject({ status: Type.Literal("unavailable") }),
  closedObject({ status: Type.Literal("error") }),
  closedObject({
    status: Type.Literal("login-required"),
    backendState: Type.Union([Type.Literal("NeedsLogin"), Type.Literal("NeedsMachineAuth")]),
  }),
  closedObject({
    status: Type.Literal("stopped"),
    backendState: Type.Union([Type.Literal("NoState"), Type.Literal("Stopped")]),
  }),
  closedObject({ status: Type.Literal("starting"), backendState: Type.Literal("Starting") }),
  closedObject({
    status: Type.Literal("running"),
    backendState: Type.Literal("Running"),
    host: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
    serve: TailscalePublishedRouteSchema,
    funnel: TailscalePublishedRouteSchema,
  }),
]);

/** Read-only, non-secret connectivity inspection before setup-code issuance. */
export const DevicePairConnectivityInspectParamsSchema = closedObject({});
export const DevicePairConnectivityInspectResultSchema = closedObject({
  configHash: Type.Optional(PairingConnectivityConfigHashSchema),
  auth: PairingConnectivityAuthSchema,
  current: Type.Union([
    closedObject({
      status: Type.Literal("ready"),
      urls: PairingConnectivityUrlsSchema,
      source: Type.Union([
        Type.Literal("manual"),
        Type.Literal("remote"),
        Type.Literal("tailscale-serve"),
        Type.Literal("tailscale-funnel"),
        Type.Literal("lan"),
        Type.Literal("tailnet"),
        Type.Literal("custom"),
      ]),
      exposure: PairingConnectivityExposureSchema,
      access: PairingConnectivityAccessSchema,
      accessDowngraded: Type.Boolean(),
    }),
    closedObject({ status: Type.Literal("blocked"), blocker: PairingConnectivityBlockerSchema }),
  ]),
  lan: Type.Union([
    closedObject({
      status: Type.Literal("available"),
      url: PairingConnectivityUrlSchema,
      requiresGatewayChange: Type.Boolean(),
    }),
    closedObject({ status: Type.Literal("unavailable") }),
  ]),
  tailscale: TailscaleConnectivityInspectionSchema,
  publicUrl: Type.Union([
    closedObject({ status: Type.Literal("ready"), url: PairingConnectivityUrlSchema }),
    closedObject({ status: Type.Literal("not-configured") }),
    closedObject({ status: Type.Literal("invalid") }),
  ]),
});

/** Selects one connectivity mode for immutable operator confirmation. */
export const DevicePairConnectivityPlanParamsSchema = closedObject({
  mode: PairingConnectivityModeSchema,
  publicUrl: Type.Optional(PairingConnectivityUrlSchema),
});
export const DevicePairConnectivityPlanResultSchema = Type.Union([
  closedObject({
    status: Type.Literal("blocked"),
    mode: PairingConnectivityModeSchema,
    configHash: Type.Optional(PairingConnectivityConfigHashSchema),
    auth: PairingConnectivityAuthSchema,
    blocker: PairingConnectivityBlockerSchema,
    changes: PairingConnectivityChangesSchema,
  }),
  closedObject({
    status: Type.Literal("confirmation-required"),
    mode: PairingConnectivityModeSchema,
    configHash: Type.Optional(PairingConnectivityConfigHashSchema),
    urls: PairingConnectivityUrlsSchema,
    exposure: PairingConnectivityExposureSchema,
    auth: Type.Union([Type.Literal("token"), Type.Literal("password")]),
    access: PairingConnectivityAccessSchema,
    accessDowngraded: Type.Boolean(),
    changes: PairingConnectivityChangesSchema,
    restartRequired: Type.Boolean(),
    preservesCurrentRoute: Type.Boolean(),
  }),
]);

/**
 * Generates a device-pairing setup code (and optional QR) so a mobile/companion
 * client can scan it and connect to this gateway. The embedded setup code mints
 * a short-lived bootstrap token that defaults to full native-mobile operator
 * access, so this method requires operator.admin
 * (enforced by the core method descriptor's method-scope policy, not the handler)
 * and is not advertised. `bootstrapProfile: "limited"` omits operator.admin;
 * `bootstrapProfile: "node"` narrows the handoff to a node role with no operator
 * scopes for companion devices such as watchOS.
 */
export const DevicePairSetupCodeParamsSchema = closedObject({
  publicUrl: Type.Optional(NonEmptyString),
  preferRemoteUrl: Type.Optional(Type.Boolean()),
  includeQr: Type.Optional(Type.Boolean()),
  bootstrapProfile: Type.Optional(Type.String({ enum: ["limited", "node"] })),
});

/**
 * Setup code plus non-secret connection metadata. `auth` is a label only
 * ("token" | "password"); the gateway credential itself is never returned.
 * `accessDowngraded` reports the plaintext-LAN safety fallback from full to
 * limited access so the presenting client can explain how to upgrade.
 */
export const DevicePairSetupCodeResultSchema = closedObject({
  setupCode: NonEmptyString,
  qrDataUrl: Type.Optional(SetupCodeQrDataUrlSchema),
  gatewayUrl: NonEmptyString,
  gatewayUrls: Type.Optional(
    Type.Array(NonEmptyString, { minItems: 2, maxItems: 8, uniqueItems: true }),
  ),
  auth: Type.Union([Type.Literal("token"), Type.Literal("password")]),
  urlSource: NonEmptyString,
  access: Type.Optional(
    Type.Union([Type.Literal("full"), Type.Literal("limited"), Type.Literal("node")]),
  ),
  accessDowngraded: Type.Optional(Type.Boolean()),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type DevicePairListParams = Static<typeof DevicePairListParamsSchema>;
export type DevicePairApproveParams = Static<typeof DevicePairApproveParamsSchema>;
export type DevicePairRejectParams = Static<typeof DevicePairRejectParamsSchema>;
export type DevicePairRemoveParams = Static<typeof DevicePairRemoveParamsSchema>;
export type DevicePairSetupCodeParams = Static<typeof DevicePairSetupCodeParamsSchema>;
export type DevicePairSetupCodeResult = Static<typeof DevicePairSetupCodeResultSchema>;
export type DevicePairConnectivityInspectParams = Static<
  typeof DevicePairConnectivityInspectParamsSchema
>;
export type DevicePairConnectivityInspectResult = Static<
  typeof DevicePairConnectivityInspectResultSchema
>;
export type DevicePairConnectivityPlanParams = Static<
  typeof DevicePairConnectivityPlanParamsSchema
>;
export type DevicePairConnectivityPlanResult = Static<
  typeof DevicePairConnectivityPlanResultSchema
>;
export type DevicePairRenameParams = Static<typeof DevicePairRenameParamsSchema>;
export type DeviceTokenRotateParams = Static<typeof DeviceTokenRotateParamsSchema>;
export type DeviceTokenRevokeParams = Static<typeof DeviceTokenRevokeParamsSchema>;
