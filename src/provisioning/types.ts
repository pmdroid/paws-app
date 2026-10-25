export type ProvisioningOperation = "createVm" | "execVm" | "getVm";

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

  constructor(
    operation: ProvisioningOperation,
    code: ProvisioningErrorCode,
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = "ProvisioningError";
    this.operation = operation;
    this.code = code;
    this.status = status;
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

export type ExeDev = {
  createVm(name: string): Promise<ExeDevCreatedVm>;
  execVm(name: string, command: string, options?: ExeDevExecOptions): Promise<ExeDevExecResult>;
  getVm(name: string): Promise<ExeDevVm>;
};
