import type { DraftCloudProfile, DraftEnvironment, DraftNode } from "./discovery.ts";

export function resolvePlacePickerSections(params: {
  environments: readonly DraftEnvironment[] | null;
  execNodes: readonly DraftNode[];
  cloudProfiles: readonly DraftCloudProfile[];
}): { deviceNodes: DraftNode[]; cloudProfiles: DraftCloudProfile[] } {
  const environmentById = params.environments
    ? new Map(params.environments.map((environment) => [environment.id, environment]))
    : null;
  return {
    deviceNodes: params.execNodes.filter((node) => {
      if (environmentById === null) {
        // No catalog snapshot: intersect the legacy fallback with current node presence only.
        return node.connected && node.canExec;
      }
      const environment = environmentById.get(`node:${node.nodeId}`);
      const legacyDevice =
        environment !== undefined &&
        environment.trust === undefined &&
        environment.sessionHost === undefined;
      const modernDevice = environment?.trust === "persistent" && environment.sessionHost === false;
      // Only the complete legacy absence is compatible; partial hints are ambiguous and fail closed.
      return (
        node.connected &&
        node.canExec &&
        environment?.type === "node" &&
        (legacyDevice || modernDevice)
      );
    }),
    // Legacy Gateways omit both hints; profiles were historically cloud session hosts.
    cloudProfiles: params.cloudProfiles.filter(
      (profile) => profile.trust !== "persistent" && profile.sessionHost !== false,
    ),
  };
}
