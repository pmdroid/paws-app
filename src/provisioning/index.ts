import { readExeDevToken } from "../config";
import type { ExeDevTokenReader } from "./client";

export {
  BOOTSTRAP_MISE_PATH,
  BOOTSTRAP_STAGE_DIR,
  BOOTSTRAP_TOKEN_FILE,
  BOOTSTRAP_TOKEN_KEY,
  BOOTSTRAP_UNIT,
  BootstrapError,
  createExeDevBootstrap,
  isBootstrapError,
  RUNNER_CONFIG_PATH,
  RUNNER_STATE_DIR,
} from "./bootstrap";
export type {
  BootstrapStep,
  EnrolledRunner,
  ExeDevBootstrap,
  ExeDevBootstrapOptions,
  InstallStatus,
  MisePlatform,
  MiseRelease,
  StartInstallResult,
} from "./bootstrap";
export {
  createExeDev,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  EXE_DEV_ENDPOINT,
} from "./client";
export type { ExeDevFetch, ExeDevOptions, ExeDevTokenReader } from "./client";
export { createFakeExeDev, FAKE_UNSCRIPTED_EXIT } from "./fake";
export { createFakeBootstrap } from "./fake-bootstrap";
export { PINNED_MISE, PINNED_MISE_VERSION } from "./mise";
export { LATEST_RUNNER_RELEASE_URL, latestRunnerRelease } from "./release";
export type { FakeBootstrap, FakeBootstrapCall, FakeBootstrapOptions } from "./fake-bootstrap";
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
