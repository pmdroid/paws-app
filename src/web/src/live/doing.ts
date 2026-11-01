import type { ItemActivityFacts, ItemHold } from "../../../db";
import type { StatusDoing } from "../contract";

export const STALL_MS = 30 * 60_000;

const SHOWN = new Set([
  "planning",
  "queued",
  "running",
  "verifying",
  "recovering",
  "awaiting_input",
]);
const STALLABLE = new Set(["running", "verifying", "recovering"]);

export type DoingInput = {
  state: string;
  facts: ItemActivityFacts;
  hold: ItemHold | undefined;
  question: string | null;
  lastChange: number;
  now: number;
};

export function doingOf(input: DoingInput): StatusDoing | undefined {
  if (!SHOWN.has(input.state)) return undefined;
  const doing = baseDoing(input);
  const stalled =
    (doing.kind === "slot" || doing.kind === "idle") &&
    STALLABLE.has(input.state) &&
    input.now - input.lastChange >= STALL_MS;
  return stalled ? { ...doing, stalled: true } : doing;
}

function baseDoing({ state, facts, hold, question, lastChange }: DoingInput): StatusDoing {
  const changed = new Date(lastChange).toISOString();
  if (state === "awaiting_input")
    return { kind: "person", runners: [], since: changed, ...(question ? { question } : {}) };
  const pause = facts.usagePause;
  if (pause)
    return {
      kind: "paused",
      runners: [],
      since: new Date(pause.pausedAt).toISOString(),
      until: new Date(pause.resumeAt).toISOString(),
      agent: pause.agent,
    };
  if (facts.liveRunner !== null)
    return { kind: "running", runners: [facts.liveRunner], since: null };
  if (facts.slotWait)
    return {
      kind: "slot",
      runners: facts.slotWait.runners,
      since: new Date(facts.slotWait.since ?? lastChange).toISOString(),
    };
  if (hold?.reason === "slot")
    return {
      kind: "slot",
      runners: facts.pinnedRunner === null ? [] : [facts.pinnedRunner],
      since: new Date(facts.heldSince ?? lastChange).toISOString(),
    };
  if (facts.liveJob) return { kind: "running", runners: [], since: null };
  return { kind: "idle", runners: [], since: changed };
}
