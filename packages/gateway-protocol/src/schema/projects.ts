import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const PROJECTS_LIST_DEFAULT_LIMIT = 50;
export const PROJECTS_LIST_MAX_LIMIT = 200;

/** One gateway-visible checkout for a derived repository project. */
export const ProjectCheckoutSchema = closedObject({
  runnerId: NonEmptyString,
  path: NonEmptyString,
});

/** Repository identity derived from observed checkout and session state. */
export const ProjectSummarySchema = closedObject({
  name: NonEmptyString,
  originUrl: Type.Optional(NonEmptyString),
  checkouts: Type.Array(ProjectCheckoutSchema, { minItems: 1 }),
  lastUsedAt: Type.Number({ minimum: 0 }),
});

/** Bounded request for derived projects, newest first. */
export const ProjectsListParamsSchema = closedObject({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: PROJECTS_LIST_MAX_LIMIT })),
});

export const ProjectsListResultSchema = closedObject({
  projects: Type.Array(ProjectSummarySchema, { maxItems: PROJECTS_LIST_MAX_LIMIT }),
});

export type ProjectCheckout = Static<typeof ProjectCheckoutSchema>;
export type ProjectSummary = Static<typeof ProjectSummarySchema>;
export type ProjectsListParams = Static<typeof ProjectsListParamsSchema>;
export type ProjectsListResult = Static<typeof ProjectsListResultSchema>;
