export type ProvisioningOperation = "createVm" | "deleteVm" | "execVm" | "getVm";

export type ProvisioningErrorCode =
  | "invalid_name"
  | "invalid_command"
  | "no_token"
  | "timeout"
  | "invalid_response"
  | "unauthorized"
  | "conflict"
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
 * Size flags for `new`, as `ssh exe.dev help new` names them: `--cpu`, `--memory`, `--disk`
 * and `--image`. A missing field sends no flag, so exe.dev uses its default.
 */
export type ExeDevVmSize = {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  image?: string;
};

export type ExeDev = {
  createVm(name: string, size?: ExeDevVmSize): Promise<ExeDevCreatedVm>;
  deleteVm(name: string): Promise<ExeDevDeleteResult>;
  execVm(name: string, command: string, options?: ExeDevExecOptions): Promise<ExeDevExecResult>;
  getVm(name: string): Promise<ExeDevVm>;
};
