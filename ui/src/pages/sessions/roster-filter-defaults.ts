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

export function hasActiveRosterFilters(filters: {
  activeMinutes: string;
  searchQuery: string;
  includeGlobal: boolean;
  statusFilter: SessionArchivedFilter;
}): boolean {
  // An unparsable window is ignored by the query, so it is not a filter; a
  // parsable one counts only when it differs from the status-specific default.
  const activeMinutes = parseStrictPositiveInteger(filters.activeMinutes);
  return (
    normalizeLowercaseStringOrEmpty(filters.searchQuery).length > 0 ||
    (activeMinutes !== undefined &&
      String(activeMinutes) !== rosterFilterDefaults(filters.statusFilter).activeMinutes) ||
    !filters.includeGlobal
  );
}
