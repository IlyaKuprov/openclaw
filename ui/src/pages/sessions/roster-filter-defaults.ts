import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SessionArchivedFilter } from "../../lib/sessions/index.ts";
import {
  SESSIONS_PAGE_DEFAULT_ACTIVE_MINUTES,
  SESSIONS_PAGE_DEFAULT_LIMIT,
  SESSIONS_PAGE_ROSTER_DEFAULT_LIMIT,
} from "../../lib/sessions/session-requests.ts";

/** The routed active roster opens compactly; archived and all views do not. */
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

export function routeRosterFilters(statusFilter: SessionArchivedFilter, deepLink = false) {
  const defaults = rosterFilterDefaults(statusFilter);
  return {
    activeMinutes: deepLink ? "" : defaults.activeMinutes,
    limit: deepLink ? String(SESSIONS_PAGE_DEFAULT_LIMIT) : defaults.limit,
    includeGlobal: true,
    includeUnknown: deepLink,
  };
}

export function hasActiveRosterFilters(filters: {
  activeMinutes: string;
  searchQuery: string;
  includeGlobal: boolean;
  statusFilter: SessionArchivedFilter;
}): boolean {
  // The default active window can hide every older session; offer Show all
  // even when the user did not edit it. Archived/all queries ignore recency.
  const activeMinutes = parseStrictPositiveInteger(filters.activeMinutes);
  return (
    normalizeLowercaseStringOrEmpty(filters.searchQuery).length > 0 ||
    (filters.statusFilter === "active" && activeMinutes !== undefined) ||
    !filters.includeGlobal
  );
}
