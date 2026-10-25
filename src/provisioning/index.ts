import { readExeDevToken } from "../config";
import type { ExeDevTokenReader } from "./client";

export {
  createExeDev,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  EXE_DEV_ENDPOINT,
} from "./client";
export type { ExeDevFetch, ExeDevOptions, ExeDevTokenReader } from "./client";
export { createFakeExeDev, FAKE_UNSCRIPTED_EXIT } from "./fake";
export type { FakeExecScript, FakeExeDev, FakeExeDevCall, FakeFailure } from "./fake";
export { isExeDevVmName, MAX_EXEC_COMMAND_BYTES } from "./names";
export { isProvisioningError, ProvisioningError } from "./types";
export type {
  ExeDev,
  ExeDevCreatedVm,
  ExeDevExecOptions,
  ExeDevExecResult,
  ExeDevVm,
  ProvisioningErrorCode,
  ProvisioningOperation,
} from "./types";

export function exeDevTokenReader(home: string): ExeDevTokenReader {
  return () => readExeDevToken(home);
}
