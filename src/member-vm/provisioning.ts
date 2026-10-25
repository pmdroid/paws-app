import {
  createExeDev,
  createExeDevBootstrap,
  PINNED_MISE,
  type ExeDev,
  type ExeDevTokenReader,
} from "../provisioning";
import type { MemberVmProvisioning, MintEnrollment } from "./job";

export type MemberVmRunnerControl = {
  port: number;
  serverVersion: string | null;
  mintEnrollment: MintEnrollment;
};

export type MemberVmProvisioningSource = {
  readToken: ExeDevTokenReader;
  installer: () => string | null;
  publicUrl: string | null;
  serverCa?: string | null;
  repositories: () => readonly string[];
  runnerControl: () => Promise<MemberVmRunnerControl | null | undefined>;
  exeDev?: ExeDev;
};

export function createMemberVmProvisioning(
  source: MemberVmProvisioningSource,
): () => Promise<MemberVmProvisioning> {
  const exeDev = source.exeDev ?? createExeDev({ readToken: source.readToken });
  return async () => {
    if (source.publicUrl === null)
      throw new Error("Create VM needs PAWS_PUBLIC_URL so the VM can reach this Paws.");
    const control = await source.runnerControl();
    if (!control) throw new Error("Create VM needs runner control to be configured.");
    if (control.serverVersion === null)
      throw new Error(
        "Create VM needs an installed Paws release; a source checkout has no runner version to install.",
      );
    const installer = source.installer();
    if (installer === null)
      throw new Error("Create VM needs deploy/linux/install-runner.sh next to Paws.");
    const runnerApi = new URL(source.publicUrl);
    runnerApi.port = String(control.port);
    const bootstrap = createExeDevBootstrap({
      exeDev,
      runnerVersion: control.serverVersion,
      installer,
      mise: PINNED_MISE["linux-x64"],
      runnerApiUrl: runnerApi.origin,
      controlPlaneUrl: new URL(source.publicUrl).origin,
      serverCa: source.serverCa ?? null,
      allowedRepositories: source.repositories().slice(0, 256),
    });
    return { exeDev, bootstrap, mintEnrollment: control.mintEnrollment };
  };
}
