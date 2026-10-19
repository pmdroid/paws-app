export type Vm = {
  name: string;
  sshDestination?: string;
  sshHost?: string;
  sshUser?: string;
  httpsUrl?: string;
  status?: string;
};

export type CreateVm = {
  name: string;
  cpu: number;
  memoryGB: number;
  pool?: string;
  image?: string;
};

export type ExecVm = { vmName: string; command: string };
export type ExecResult = { stdout: string; stderr: string; exitCode: number };

export interface ExeDev {
  listVms(): Promise<Vm[]>;
  createVm(input: CreateVm): Promise<Vm>;
  execVm(input: ExecVm): Promise<ExecResult>;
}

export type ProviderOperation = "list" | "create" | "exec";
export type ProviderErrorCode =
  | "invalid_input"
  | "credentials"
  | "http"
  | "transport"
  | "timeout"
  | "invalid_response"
  | "output_limit"
  | "incomplete_exec";
export type ProviderOutcome = "not_sent" | "rejected" | "unknown";

export class ProvisioningError extends Error {
  override name = "ProvisioningError";

  constructor(
    readonly operation: ProviderOperation,
    readonly code: ProviderErrorCode,
    readonly outcome: ProviderOutcome,
    readonly status?: number,
  ) {
    super(`exe.dev ${operation}: ${code} (${outcome})`);
  }
}
