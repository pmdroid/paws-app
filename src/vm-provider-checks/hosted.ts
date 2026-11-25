import type { Boat, InstaBox } from "../provisioning";
import type { VmProviderKeyCheck } from "./checks";
import { failedKeyCheck } from "./exe-dev";

export function boatKeyCheck(boat: Pick<Boat, "listVms">): VmProviderKeyCheck {
  return async () => {
    try {
      const sandboxes = await boat.listVms();
      return {
        state: "working",
        message: "boat accepted the key.",
        facts: [
          { name: "key", text: "boat accepted the key", level: "ok" },
          vmsFact(sandboxes, "sandbox", "sandboxes"),
        ],
      };
    } catch (error) {
      return failedKeyCheck("boat", error);
    }
  };
}

export function instaBoxKeyCheck(
  instaBox: Pick<InstaBox, "listVms" | "listSizes">,
): VmProviderKeyCheck {
  return async () => {
    try {
      const machines = await instaBox.listVms();
      const sizes = (await instaBox.listSizes()).map(
        (spec) => `${spec.vcpus} vCPU / ${spec.memMiB} MiB`,
      );
      const key = { name: "key", text: "InstaBox accepted the key", level: "ok" } as const;
      const vms = vmsFact(machines, "machine", "machines");
      if (sizes.length <= 1) {
        const only = sizes[0];
        return {
          state: "limited",
          message: `InstaBox accepted the key, but its plan allows ${only === undefined ? "no size" : "only one size"}.`,
          facts: [
            key,
            {
              name: "sizes",
              text: only === undefined ? "No size allowed" : `Only ${only}`,
              level: "warn",
            },
            vms,
          ],
        };
      }
      return {
        state: "working",
        message: "InstaBox accepted the key.",
        facts: [key, { name: "sizes", text: sizes.join(", "), level: "ok" }, vms],
      };
    } catch (error) {
      return failedKeyCheck("InstaBox", error);
    }
  };
}

function vmsFact(vms: readonly { state: string }[], one: string, many: string) {
  const stopped = vms.filter((vm) => vm.state !== "running").length;
  return {
    name: "vms",
    text: `${vms.length} ${vms.length === 1 ? one : many}, ${stopped} not running`,
    level: "ok",
  } as const;
}
