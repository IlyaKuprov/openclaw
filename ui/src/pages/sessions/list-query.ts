import type { ApplicationContext } from "../../app/context.ts";
import {
  SESSIONS_PAGE_DEFAULT_ACTIVE_MINUTES,
  SESSIONS_PAGE_DEFAULT_LIMIT,
  SESSIONS_PAGE_ROSTER_DEFAULT_LIMIT,
  type SessionArchivedFilter,
  type SessionListOptions,
} from "../../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

type SessionsPageListFilters = {
  activeMinutes?: number;
  limit?: number;
  includeGlobal: boolean;
  includeUnknown: boolean;
  statusFilter: SessionArchivedFilter;
  deepLinkSessionKey?: string | null;
  search?: string;
};

/** Initial filter field values: the active roster opens compactly, archived
 *  and all views open on the unbounded page default. */
export function rosterFilterDefaults(statusFilter: SessionArchivedFilter): {
  activeMinutes: string;
  limit: string;
} {
  return statusFilter === "active"
    ? {
        activeMinutes: String(SESSIONS_PAGE_DEFAULT_ACTIVE_MINUTES),
        limit: String(SESSIONS_PAGE_ROSTER_DEFAULT_LIMIT),
      }
    : { activeMinutes: "", limit: String(SESSIONS_PAGE_DEFAULT_LIMIT) };
}

export function buildSessionsListQuery(
  context: Pick<ApplicationContext, "agentSelection">,
  filters: SessionsPageListFilters,
): SessionListOptions {
  const deepLinkSessionKey = filters.deepLinkSessionKey?.trim() || null;
  const scopeAgentId =
    parseAgentSessionKey(deepLinkSessionKey)?.agentId ??
    context.agentSelection.state.scopeId?.trim();
  // The activity window is a browsing default: an explicit search must find an
  // active session however old it is, so a nonblank search drops the window.
  const activeMinutes =
    !deepLinkSessionKey && filters.statusFilter === "active" && !filters.search?.trim()
      ? filters.activeMinutes
      : undefined;
  return {
    limit: deepLinkSessionKey ? SESSIONS_PAGE_DEFAULT_LIMIT : filters.limit,
    ...(activeMinutes ? { activeMinutes } : {}),
    ...(deepLinkSessionKey || filters.search?.trim()
      ? { search: deepLinkSessionKey ?? filters.search!.trim() }
      : {}),
    includeGlobal: deepLinkSessionKey ? true : filters.includeGlobal,
    includeUnknown: deepLinkSessionKey ? true : filters.includeUnknown,
    includeDerivedTitles: false,
    includeLastMessage: false,
    archivedFilter: filters.statusFilter,
    ...(scopeAgentId ? { agentId: scopeAgentId } : {}),
  };
}
