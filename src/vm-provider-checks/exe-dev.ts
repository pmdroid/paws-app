import { isProvisioningError, type ExeDev } from "../provisioning";
import type { VmProviderCheckResult, VmProviderKeyCheck } from "./checks";

export function exeDevKeyCheck(exeDev: Pick<ExeDev, "listVms">): VmProviderKeyCheck {
  return async () => {
    try {
      const vms = await exeDev.listVms();
      const stopped = vms.filter((vm) => vm.status !== "running").length;
      return {
        state: "working",
        message: "exe.dev accepted the key.",
        facts: [
          { name: "key", text: "exe.dev accepted the key", level: "ok" },
          {
            name: "vms",
            text: `${vms.length} ${vms.length === 1 ? "VM" : "VMs"}, ${stopped} not running`,
            level: "ok",
          },
        ],
      };
    } catch (error) {
      return failedKeyCheck("exe.dev", error);
    }
  };
}

export function failedKeyCheck(provider: string, error: unknown): VmProviderCheckResult {
  const code = isProvisioningError(error) ? error.code : "unknown";
  const status = isProvisioningError(error) ? error.status : null;
  const http = status === null ? "" : ` (HTTP ${status})`;
  if (code === "unauthorized" || status === 401 || status === 403 || code === "no_token") {
    const message =
      code === "no_token"
        ? `The saved ${provider} key is not in a form ${provider} accepts.`
        : `${provider} refused the key${http}.`;
    return {
      state: "rejected",
      message,
      facts: [{ name: "key", text: message, level: "error" }],
    };
  }
  const message =
    code === "timeout"
      ? `${provider} did not answer in time${http}.`
      : `${provider} could not be reached${http}.`;
  return { state: "unreachable", message, facts: [{ name: "key", text: message, level: "error" }] };
}
