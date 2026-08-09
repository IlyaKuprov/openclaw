export type BuiltPluginControlPlaneModule = {
  pluginId: string;
  kind: string;
  relativePath: string;
};

export type BuiltPluginControlPlaneModuleFailure = BuiltPluginControlPlaneModule & {
  error: string;
};

export function listBuiltPluginControlPlaneModules(params?: {
  rootDir?: string;
}): BuiltPluginControlPlaneModule[];

export function probeBuiltPluginControlPlaneModules(
  modules: BuiltPluginControlPlaneModule[],
  params?: { rootDir?: string; timeoutMs?: number },
): BuiltPluginControlPlaneModuleFailure[];

export type BuiltDoctorContractClosureViolation = BuiltPluginControlPlaneModule & {
  dependency: string;
  importerPath: string;
};

export function collectBuiltDoctorContractClosureViolations(
  modules: BuiltPluginControlPlaneModule[],
  params?: { rootDir?: string },
): BuiltDoctorContractClosureViolation[];

export function verifyBuiltPluginControlPlaneModules(params?: {
  rootDir?: string;
  timeoutMs?: number;
}): void;
