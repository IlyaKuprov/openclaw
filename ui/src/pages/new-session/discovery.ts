import { normalizeOptionalString } from "../../lib/string-coerce.ts";

export type DraftBranches = {
  repoRoot: string;
  branches: Array<{ name: string; kind: "local" | "remote" }>;
  defaultBranch?: string;
  headBranch?: string;
};

export type DraftRepositoryState =
  | { kind: "idle" }
  | { kind: "checking"; repoRoot: string }
  | ({ kind: "git" } & DraftBranches)
  | { kind: "direct"; repoRoot: string }
  | { kind: "unavailable"; repoRoot: string };

export type DraftNode = {
  nodeId: string;
  displayName: string;
  platform?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  connected: boolean;
  canExec: boolean;
  canBrowse: boolean;
};

export type DraftCloudProfile = {
  id: string;
  providerId: string;
  trust?: "persistent" | "disposable";
  sessionHost?: boolean;
};

export type DraftEnvironment = {
  id: string;
  type: string;
  trust?: "persistent" | "disposable";
  sessionHost?: boolean;
  platform?: string;
};

export type BrowserTarget = { nodeId: string; label: string };

export function readDraftNodes(value: unknown): DraftNode[] {
  const rawNodes = Array.isArray(value) ? value : [];
  return rawNodes
    .flatMap((raw) => {
      const node = raw as {
        nodeId?: unknown;
        displayName?: unknown;
        platform?: unknown;
        deviceFamily?: unknown;
        modelIdentifier?: unknown;
        remoteIp?: unknown;
        connected?: unknown;
        commands?: unknown;
      };
      const nodeId = normalizeOptionalString(node.nodeId);
      const commands = Array.isArray(node.commands)
        ? node.commands.filter((command): command is string => typeof command === "string")
        : [];
      if (!nodeId) {
        return [];
      }
      const connected = node.connected === true;
      const canExec = connected && commands.includes("system.run");
      return [
        {
          nodeId,
          displayName: normalizeOptionalString(node.displayName) ?? nodeId,
          platform: normalizeOptionalString(node.platform),
          deviceFamily: normalizeOptionalString(node.deviceFamily),
          modelIdentifier: normalizeOptionalString(node.modelIdentifier),
          remoteIp: normalizeOptionalString(node.remoteIp),
          connected,
          canExec,
          canBrowse: canExec && commands.includes("fs.listDir"),
        },
      ];
    })
    .toSorted(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.nodeId.localeCompare(right.nodeId),
    );
}

export function readDraftCloudProfiles(value: unknown): DraftCloudProfile[] {
  return (Array.isArray(value) ? value : [])
    .flatMap<DraftCloudProfile>((raw) => {
      if (!raw || typeof raw !== "object") {
        return [];
      }
      const profile = raw as {
        id?: unknown;
        providerId?: unknown;
        trust?: unknown;
        sessionHost?: unknown;
      };
      const id = normalizeOptionalString(profile.id);
      const providerId = normalizeOptionalString(profile.providerId);
      const trust = profile.trust;
      if (
        !id ||
        !providerId ||
        (trust !== undefined && trust !== "persistent" && trust !== "disposable") ||
        (profile.sessionHost !== undefined && typeof profile.sessionHost !== "boolean")
      ) {
        return [];
      }
      return [
        {
          id,
          providerId,
          ...(trust ? { trust } : {}),
          ...(typeof profile.sessionHost === "boolean" ? { sessionHost: profile.sessionHost } : {}),
        },
      ];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

export function readDraftEnvironments(value: unknown): DraftEnvironment[] {
  return (Array.isArray(value) ? value : [])
    .flatMap<DraftEnvironment>((raw) => {
      if (!raw || typeof raw !== "object") {
        return [];
      }
      const environment = raw as {
        id?: unknown;
        type?: unknown;
        trust?: unknown;
        sessionHost?: unknown;
        platform?: unknown;
      };
      const id = normalizeOptionalString(environment.id);
      const type = normalizeOptionalString(environment.type);
      const trust = environment.trust;
      const platform = normalizeOptionalString(environment.platform);
      if (
        !id ||
        !type ||
        (trust !== undefined && trust !== "persistent" && trust !== "disposable") ||
        (environment.sessionHost !== undefined && typeof environment.sessionHost !== "boolean")
      ) {
        return [];
      }
      return [
        {
          id,
          type,
          ...(trust ? { trust } : {}),
          ...(typeof environment.sessionHost === "boolean"
            ? { sessionHost: environment.sessionHost }
            : {}),
          ...(platform ? { platform } : {}),
        },
      ];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
