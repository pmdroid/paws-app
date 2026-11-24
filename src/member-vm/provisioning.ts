import {
  createExeDev,
  createExeDevBootstrap,
  isTailnetUrl,
  PINNED_MISE,
  PINNED_TAILSCALE,
  type ExeDev,
  type ExeDevBootstrap,
  type ExeDevTokenReader,
  type ExeDevVmSize,
  type VmProvider,
  type VmProviderId,
} from "../provisioning";
import { providerFor, type MemberVmProvisioning, type MintEnrollment } from "./job";

export type MemberVmRunnerControl = {
  port: number;
  serverVersion: string | null;
  mintEnrollment: MintEnrollment;
};

export type MemberVmProvisioningSource = {
  readToken: ExeDevTokenReader;
  installer: () => string | null;
  publicUrl: string | null;
  runnerUrl?: string | null;
  serverCa?: string | null;
  runnerControl: () => Promise<MemberVmRunnerControl | null | undefined>;
  latestRelease: () => Promise<string | null>;
  /** Reads the `tailscale-authkey` key. Absent or null: the VM joins no tailnet. */
  tailscaleAuthKey?: () => string | null;
  /** Reads the VM size from Settings for each Create VM step. */
  size?: () => ExeDevVmSize;
  exeDev?: ExeDev;
  providers?: readonly VmProvider[];
  /** Replaces the bootstrap built from the release and installer. Tests pass the fake. */
  bootstrap?: ExeDevBootstrap;
};

export function createMemberVmProvisioning(
  source: MemberVmProvisioningSource,
): (provider: VmProviderId) => Promise<MemberVmProvisioning> {
  const exeDev = source.exeDev ?? createExeDev({ readToken: source.readToken });
  return async (id) => {
    const provider = providerFor([exeDev, ...(source.providers ?? [])], id);
    if (source.publicUrl === null)
      throw new Error("Create VM needs PAWS_PUBLIC_URL so the VM can reach this Paws.");
    const authKey = source.tailscaleAuthKey ?? (() => null);
    const tailnetUrl = isTailnetUrl(source.publicUrl)
      ? "PAWS_PUBLIC_URL"
      : isTailnetUrl(source.runnerUrl ?? null)
        ? "PAWS_RUNNER_URL"
        : null;
    if (tailnetUrl !== null && authKey() === null)
      throw new Error(
        `Create VM needs a Tailscale auth key: ${tailnetUrl} is on a tailnet (.ts.net), so the VM must join it to reach this Paws. Save the key on Settings › Runner VMs.`,
      );
    const control = await source.runnerControl();
    if (!control) throw new Error("Create VM needs runner control to be configured.");
    const size = source.size?.() ?? {};
    if (source.bootstrap)
      return {
        provider,
        bootstrap: source.bootstrap,
        mintEnrollment: control.mintEnrollment,
        size,
      };
    const runnerVersion = control.serverVersion ?? (await source.latestRelease());
    if (runnerVersion === null)
      throw new Error(
        "Create VM could not find the latest runner release on GitHub to install on the VM.",
      );
    const installer = source.installer();
    if (installer === null)
      throw new Error("Create VM needs deploy/linux/install.sh next to Paws.");
    const runnerApi = new URL(source.runnerUrl ?? source.publicUrl);
    if (!source.runnerUrl) runnerApi.port = String(control.port);
    const bootstrap = createExeDevBootstrap({
      exeDev: provider,
      runnerVersion,
      installer,
      mise: PINNED_MISE["linux-x64"],
      runnerApiUrl: runnerApi.origin,
      controlPlaneUrl: new URL(source.publicUrl).origin,
      serverCa: source.serverCa ?? null,
      tailnet: { authKey, release: PINNED_TAILSCALE.amd64 },
    });
    return { provider, bootstrap, mintEnrollment: control.mintEnrollment, size };
  };
}
