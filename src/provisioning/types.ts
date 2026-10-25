export type ProvisioningOperation = "createVm" | "execVm" | "getVm";

export type ProvisioningErrorCode =
  /** The VM name failed validation; nothing was sent. */
  | "invalid_name"
  /** The command was empty, too long, or held a NUL byte; nothing was sent. */
  | "invalid_command"
  /** `~/.paws/secrets/exe-dev-token` is absent, empty, or unreadable; nothing was sent. */
  | "no_token"
  /** The request or the response body did not finish within the operation's timeout. */
  | "timeout"
  /** The response was malformed, cut off, or larger than the operation allows. */
  | "invalid_response"
  | "unauthorized"
  | "conflict"
  | "missing"
  | "rate_limited"
  | "unknown";

/**
 * Every failure of the exe.dev client. The message names the operation and the VM;
 * it never carries the response body or the token.
 */
export class ProvisioningError extends Error {
  readonly operation: ProvisioningOperation;
  readonly code: ProvisioningErrorCode;
  /** HTTP status when exe.dev answered, otherwise null. */
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

/** A VM as `new` reports it right after creation. */
export type ExeDevCreatedVm = {
  name: string;
  /** Ready-to-use `ssh` destination, possibly with a user prefix. */
  sshDest: string;
  httpsUrl: string;
};

/** A VM as `ls` reports it. */
export type ExeDevVm = ExeDevCreatedVm & {
  /** exe.dev's status word, such as `running` or `stopped`. */
  status: string;
  region: string | null;
};

export type ExeDevExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ExeDevExecOptions = {
  /** Overrides the client's exec timeout for this call, capped at the client's maximum. */
  timeoutMs?: number;
};

export type ExeDev = {
  createVm(name: string): Promise<ExeDevCreatedVm>;
  /** Runs `command` through the VM's shell and returns its exit code, stdout and stderr. */
  execVm(name: string, command: string, options?: ExeDevExecOptions): Promise<ExeDevExecResult>;
  /** Throws `missing` when exe.dev does not list the VM. */
  getVm(name: string): Promise<ExeDevVm>;
};
