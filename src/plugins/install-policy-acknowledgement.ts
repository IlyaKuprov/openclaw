import type {
  InstallPolicyAcknowledgementSequence,
  InstallSafetyOverrides,
} from "./install-security-scan.types.js";

const INSTALL_POLICY_ACKNOWLEDGEMENT_STAGE_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_INSTALL_POLICY_ACKNOWLEDGEMENT_STAGES = 32;

export function parseInstallPolicyAcknowledgementIds(value: string): string[] {
  const ids = value.split(",");
  return ids.length <= MAX_INSTALL_POLICY_ACKNOWLEDGEMENT_STAGES &&
    ids.every((id) => INSTALL_POLICY_ACKNOWLEDGEMENT_STAGE_PATTERN.test(id))
    ? ids
    : [];
}

export function formatInstallPolicyAcknowledgementIds(ids: readonly string[]): string {
  return ids.join(",");
}

export function resolveInstallPolicyAcknowledgementSequence(
  params: Pick<
    InstallSafetyOverrides,
    | "dangerouslyForceUnsafeInstall"
    | "installPolicyAcknowledgementId"
    | "installPolicyAcknowledgementSequence"
  >,
): InstallPolicyAcknowledgementSequence | undefined {
  return (
    params.installPolicyAcknowledgementSequence ??
    (params.dangerouslyForceUnsafeInstall && params.installPolicyAcknowledgementId
      ? {
          presentedId: params.installPolicyAcknowledgementId,
          pendingAcknowledgementIds: parseInstallPolicyAcknowledgementIds(
            params.installPolicyAcknowledgementId,
          ),
          previousAcknowledgementIds: [],
          matched: false,
        }
      : undefined)
  );
}

export function unresolvedInstallPolicyAcknowledgement(
  sequence: InstallPolicyAcknowledgementSequence | undefined,
): InstallPolicyAcknowledgementSequence["deferred"] | undefined {
  if (!sequence || sequence.matched) {
    return undefined;
  }
  if (sequence.deferred) {
    return sequence.deferred;
  }
  return sequence.pendingAcknowledgementIds?.length && sequence.matchedWarning
    ? {
        warning: sequence.matchedWarning,
        reason: "install policy acknowledgement includes an unknown later warning",
      }
    : undefined;
}

export type DeferredInstallPolicyMismatch<T> = {
  index: number;
  outcome: T;
};

/** Tracks one acknowledgement while a bulk operation visits multiple install targets. */
export function createInstallPolicyAcknowledgementTracker<T>(params: {
  acknowledgementId?: string;
  sequence?: InstallPolicyAcknowledgementSequence;
  deferUnmatched?: boolean;
}) {
  let matched = params.sequence?.matched ?? !params.acknowledgementId;
  let deferred: DeferredInstallPolicyMismatch<T> | undefined;
  return {
    sync(resultMatched?: boolean): void {
      matched ||= params.sequence?.matched === true || resultMatched === true;
    },
    shouldDefer(warningAcknowledgementId: string | undefined): boolean {
      return Boolean(
        params.acknowledgementId &&
        !matched &&
        warningAcknowledgementId &&
        warningAcknowledgementId !== params.acknowledgementId,
      );
    },
    defer(index: number, outcome: T): void {
      deferred ??= { index, outcome };
    },
    finish(outcomes: T[]): {
      matched: boolean;
      deferred?: DeferredInstallPolicyMismatch<T>;
    } {
      if (!matched && deferred && !params.deferUnmatched) {
        outcomes[deferred.index] = deferred.outcome;
      }
      return { matched, ...(!matched && deferred ? { deferred } : {}) };
    },
  };
}
