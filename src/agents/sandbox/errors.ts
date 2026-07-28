/** A sandbox failed before provider execution could begin. */
export class SandboxProvisioningError extends Error {
  readonly code = "sandbox_provisioning_failed";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandboxProvisioningError";
  }
}

export function toSandboxProvisioningError(error: unknown): SandboxProvisioningError {
  if (error instanceof SandboxProvisioningError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new SandboxProvisioningError(message, { cause: error });
}
