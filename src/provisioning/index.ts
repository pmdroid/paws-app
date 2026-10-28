import { readExeDevToken, readTailscaleAuthKey } from "../config";
export { isTailnetUrl } from "../config";
import type { ExeDevTokenReader } from "./client";

export {
  BOOTSTRAP_AUTHKEY_FILE,
  BOOTSTRAP_EXEC_TIMEOUT_MS,
  BOOTSTRAP_LOG_DIR,
  BOOTSTRAP_MISE_PATH,
  BOOTSTRAP_STAGE_DIR,
  BOOTSTRAP_TAILNET_KEY,
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
  BootstrapClock,
  BootstrapStep,
  EnrolledRunner,
  ExeDevBootstrap,
  ExeDevBootstrapOptions,
  ExeDevBootstrapTailnet,
  InstallStatus,
  JoinTailnetResult,
  MisePlatform,
  MiseRelease,
  StartInstallResult,
  TailscalePlatform,
  TailscaleRelease,
} from "./bootstrap";
export {
  createExeDev,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  EXE_DEV_ENDPOINT,
  EXE_DEV_EXEC_LIMIT_MS,
} from "./client";
export type { ExeDevFetch, ExeDevOptions, ExeDevTokenReader } from "./client";
export { createFakeExeDev, FAKE_UNSCRIPTED_EXIT } from "./fake";
export { createFakeBootstrap } from "./fake-bootstrap";
export { PINNED_MISE, PINNED_MISE_VERSION } from "./mise";
export { PINNED_TAILSCALE, PINNED_TAILSCALE_VERSION } from "./tailscale";
export { LATEST_RUNNER_RELEASE_URL, latestRunnerRelease } from "./release";
export type { FakeBootstrap, FakeBootstrapCall, FakeBootstrapOptions } from "./fake-bootstrap";
export type { FakeExecScript, FakeExeDev, FakeExeDevCall, FakeFailure } from "./fake";
export { isExeDevPoolName, isExeDevVmName, MAX_EXEC_COMMAND_BYTES } from "./names";
export { isProvisioningError, ProvisioningError } from "./types";
export type {
  ExeDev,
  ExeDevCreatedVm,
  ExeDevDeleteResult,
  ExeDevExecOptions,
  ExeDevExecResult,
  ExeDevPool,
  ExeDevVm,
  ExeDevVmSize,
  ProvisioningErrorCode,
  ProvisioningOperation,
} from "./types";

export function exeDevTokenReader(home: string): ExeDevTokenReader {
  return () => readExeDevToken(home);
}

/** Reads `~/.paws/secrets/tailscale-authkey` each time, so a key saved later is picked up. */
export function tailscaleAuthKeyReader(home: string): () => string | null {
  return () => readTailscaleAuthKey(home);
}
