import type { ApplicationContext } from "../../app/context.ts";
import {
  SESSIONS_PAGE_DEFAULT_LIMIT,
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
    !deepLinkSessionKey && !filters.search?.trim() && filters.statusFilter === "active"
      ? filters.activeMinutes
      : undefined;
  return {
    limit: deepLinkSessionKey ? SESSIONS_PAGE_DEFAULT_LIMIT : filters.limit,
    // The window means real activity (last run or user input), not the
    // updatedAt bookkeeping timestamp, while the pin-first ordering is kept.
    ...(activeMinutes ? { activeMinutes, activeMinutesBy: "activity" as const } : {}),
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
