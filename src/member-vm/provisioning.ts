import {
  createExeDev,
  createExeDevBootstrap,
  isTailnetUrl,
  PINNED_MISE,
  PINNED_TAILSCALE,
  type ExeDev,
  type ExeDevBootstrap,
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
  latestRelease: () => Promise<string | null>;
  /** Reads `~/.paws/secrets/tailscale-authkey`. Absent or null: the VM joins no tailnet. */
  tailscaleAuthKey?: () => string | null;
  exeDev?: ExeDev;
  /** Replaces the bootstrap built from the release and installer. Tests pass the fake. */
  bootstrap?: ExeDevBootstrap;
};

export function createMemberVmProvisioning(
  source: MemberVmProvisioningSource,
): () => Promise<MemberVmProvisioning> {
  const exeDev = source.exeDev ?? createExeDev({ readToken: source.readToken });
  return async () => {
    if (source.publicUrl === null)
      throw new Error("Create VM needs PAWS_PUBLIC_URL so the VM can reach this Paws.");
    const authKey = source.tailscaleAuthKey ?? (() => null);
    if (isTailnetUrl(source.publicUrl) && authKey() === null)
      throw new Error(
        "Create VM needs a Tailscale auth key in ~/.paws/secrets/tailscale-authkey: PAWS_PUBLIC_URL is on a tailnet (.ts.net), so the VM must join it to reach this Paws.",
      );
    const control = await source.runnerControl();
    if (!control) throw new Error("Create VM needs runner control to be configured.");
    if (source.bootstrap)
      return { exeDev, bootstrap: source.bootstrap, mintEnrollment: control.mintEnrollment };
    const runnerVersion = control.serverVersion ?? (await source.latestRelease());
    if (runnerVersion === null)
      throw new Error(
        "Create VM could not find the latest runner release on GitHub to install on the VM.",
      );
    const installer = source.installer();
    if (installer === null)
      throw new Error("Create VM needs deploy/linux/install-runner.sh next to Paws.");
    const runnerApi = new URL(source.publicUrl);
    runnerApi.port = String(control.port);
    const bootstrap = createExeDevBootstrap({
      exeDev,
      runnerVersion,
      installer,
      mise: PINNED_MISE["linux-x64"],
      runnerApiUrl: runnerApi.origin,
      controlPlaneUrl: new URL(source.publicUrl).origin,
      serverCa: source.serverCa ?? null,
      allowedRepositories: source.repositories().slice(0, 256),
      tailnet: { authKey, release: PINNED_TAILSCALE.amd64 },
    });
    return { exeDev, bootstrap, mintEnrollment: control.mintEnrollment };
  };
}
