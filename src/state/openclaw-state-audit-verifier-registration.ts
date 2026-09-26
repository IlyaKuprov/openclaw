import path from "node:path";

const activeBackgroundVerifiers = new Map<string, number>();

/** Only a verifier targeting this state file may defer its audit index proof. */
export function registerOpenClawStateAuditIntegrityVerifier(pathname: string): () => void {
  const target = path.resolve(pathname);
  activeBackgroundVerifiers.set(target, (activeBackgroundVerifiers.get(target) ?? 0) + 1);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      const remaining = (activeBackgroundVerifiers.get(target) ?? 1) - 1;
      if (remaining > 0) {
        activeBackgroundVerifiers.set(target, remaining);
      } else {
        activeBackgroundVerifiers.delete(target);
      }
    }
  };
}

export function isOpenClawStateAuditIntegrityVerifierRegistered(pathname: string): boolean {
  return activeBackgroundVerifiers.has(path.resolve(pathname));
}
