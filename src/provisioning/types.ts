export type ProvisioningOperation =
  | "createVm"
  | "deleteVm"
  | "execVm"
  | "getVm"
  | "listVms"
  | "listPools"
  | "adoptVm";

export type ProvisioningErrorCode =
  | "invalid_name"
  | "invalid_command"
  | "no_token"
  | "timeout"
  | "invalid_response"
  | "unauthorized"
  | "conflict"
  /** exe.dev keeps the VM name for someone else, so another name may still work. */
  | "name_unavailable"
  | "missing"
  | "rate_limited"
  | "unknown";

export class ProvisioningError extends Error {
  readonly operation: ProvisioningOperation;
  readonly code: ProvisioningErrorCode;
  readonly status: number | null;
  /** exe.dev's own `error` text. Kept out of `message`, which may be logged or shown. */
  readonly detail: string | null;

  constructor(
    operation: ProvisioningOperation,
    code: ProvisioningErrorCode,
    message: string,
    status: number | null = null,
    detail: string | null = null,
  ) {
    super(message);
    this.name = "ProvisioningError";
    this.operation = operation;
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function isProvisioningError(value: unknown): value is ProvisioningError {
  return value instanceof ProvisioningError;
}

export type ExeDevCreatedVm = {
  name: string;
  sshDest: string;
  httpsUrl: string;
};

export type ExeDevVm = ExeDevCreatedVm & {
  status: string;
  region: string | null;
};

export type ExeDevExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ExeDevExecOptions = {
  timeoutMs?: number;
};

export type ExeDevDeleteResult = "deleted" | "missing";

/**
 * Size and placement flags for `new`, as `ssh exe.dev help new` names them: `--cpu`,
 * `--memory`, `--disk`, `--image` and `--pool`. A missing field sends no flag, so exe.dev uses
 * its default size and the team's VM placement.
 */
export type ExeDevVmSize = {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  image?: string;
  pool?: string;
};

/** One row of `pool list`: vCPU and memory reserved in one region. */
export type ExeDevPool = {
  name: string;
  region: string | null;
  /** For example `active`, or `pending` until exe.dev support activates it. */
  status: string | null;
};

export type VmProviderId = "exe-dev" | "boat" | "instabox";

export type VmState = "running" | "starting" | "stopped" | "stopping" | "error" | "unknown";

export type VmCreateRequest = { key: string };

export type CreatedVm = ExeDevCreatedVm & { id: string };

export type ProviderVm = ExeDevVm & { state: VmState };

export type VmProvider = {
  id: VmProviderId;
  createVm(name: string, size?: ExeDevVmSize, request?: VmCreateRequest): Promise<CreatedVm>;
  deleteVm(name: string): Promise<ExeDevDeleteResult>;
  execVm(name: string, command: string, options?: ExeDevExecOptions): Promise<ExeDevExecResult>;
  getVm(name: string): Promise<ProviderVm>;
};

export type ExeDev = VmProvider & {
  /** `ls`: every VM the token's team can see. */
  listVms(): Promise<ExeDevVm[]>;
  /** `pool list`. */
  listPools(): Promise<ExeDevPool[]>;
  /** `pool adopt --vm=<vm> --pool=<pool>`: admins only, and the move can take minutes. */
  adoptVm(name: string, pool: string): Promise<void>;
};

export function exeDevVmState(status: string): VmState {
  if (status === "running") return "running";
  if (status === "paused" || status === "stopped") return "stopped";
  return "unknown";
}
