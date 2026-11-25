import type { Db, VmProviderCheckRow } from "../db";
import type { TailnetJoinOutcome } from "../provisioning";
import { saveVmProviderCheck, type VmProviderCheckResult } from "./checks";

export type TailnetJoin = { vm: string; outcome: TailnetJoinOutcome; at: number };

export function recordTailnetJoin(db: Db, join: TailnetJoin): Promise<VmProviderCheckRow> {
  return saveVmProviderCheck(db, "tailscale", tailnetJoinResult(join), join.at);
}

function tailnetJoinResult({ vm, outcome, at }: TailnetJoin): VmProviderCheckResult {
  const when = `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  switch (outcome) {
    case "joined":
      return {
        state: "working",
        message: "A new VM joined the tailnet with the key.",
        facts: [{ name: "join", text: `${vm} joined at ${when}`, level: "ok" }],
      };
    case "unapproved":
      return {
        state: "limited",
        message:
          "The key works, but new machines wait for approval in the Tailscale admin console.",
        facts: [{ name: "join", text: `${vm} waited for approval at ${when}`, level: "warn" }],
      };
    case "rejected":
      return {
        state: "rejected",
        message: "Tailscale refused the key: it is expired or revoked.",
        facts: [{ name: "join", text: `${vm} was refused at ${when}`, level: "error" }],
      };
    case "failed":
      return {
        state: "unreachable",
        message: "The last tailnet join failed for a reason other than the key.",
        facts: [{ name: "join", text: `${vm} could not join at ${when}`, level: "error" }],
      };
  }
}
