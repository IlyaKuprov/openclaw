import type { WorkerEnvironmentService } from "./service.js";

type WorkerInferenceControl = Pick<
  WorkerEnvironmentService,
  | "beginInferenceSessionDrain"
  | "cancelInferenceForSession"
  | "hasInferenceForSession"
  | "resolveInferenceSessionForRunId"
>;

export function asWorkerInferenceControl(service: unknown): WorkerInferenceControl | undefined {
  return service as WorkerInferenceControl | undefined;
}
