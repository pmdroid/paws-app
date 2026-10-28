export type ProvisioningOperation =
  | "createVm"
  | "deleteVm"
  | "execVm"
  | "getVm"
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

export type ExeDev = {
  createVm(name: string, size?: ExeDevVmSize): Promise<ExeDevCreatedVm>;
  /** `pool list`. */
  listPools(): Promise<ExeDevPool[]>;
  /** `pool adopt --vm=<vm> --pool=<pool>`: admins only, and the move can take minutes. */
  adoptVm(name: string, pool: string): Promise<void>;
  deleteVm(name: string): Promise<ExeDevDeleteResult>;
  execVm(name: string, command: string, options?: ExeDevExecOptions): Promise<ExeDevExecResult>;
  getVm(name: string): Promise<ExeDevVm>;
};
