// An executing plugin imports the supported SDK rather than a core session helper.
export {
  cleanupSessionLifecycleArtifacts,
  deleteSessionEntry,
  patchSessionEntry,
  updateSessionStore,
  updateSessionStoreEntry,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
