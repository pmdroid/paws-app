import { git } from "../acp";
import { journalCaught } from "../journal";
import { PROBE_TIMEOUT_SECONDS, executeProbe } from "../closeout-spec";
import type { MergedPull } from "../github";
import type { BreakCheck, BreakRef, CheckStatus, ProbeCheck, ProbeRun } from "./types";

/** Most characters of probe output a report keeps. */
const MAX_OUTPUT_CHARS = 2_000;

export type PullLookup = (number: number) => Promise<MergedPull | null>;

/**
 * Run the probe on origin/main, base and head both `main`, then on every commit its sources say
 * broke the rule, base its first parent. `checkout` is a clean worktree; it is left at `main`.
 */
export async function checkProbe(input: {
  probe: string;
  bytes: Uint8Array;
  exec: string[];
  checkout: string;
  main: string;
  breaks: readonly BreakRef[];
  pull: PullLookup;
  env?: NodeJS.ProcessEnv;
}): Promise<ProbeCheck> {
  const run = async (base: string, head: string): Promise<ProbeRun> => {
    await git(["-C", input.checkout, "checkout", "-q", "--detach", head]);
    const result = await executeProbe({
      rule: { exec: input.exec, probe: input.probe },
      bytes: input.bytes,
      base,
      head,
      checkout: input.checkout,
      timeoutSeconds: PROBE_TIMEOUT_SECONDS,
      ...(input.env ? { env: input.env } : {}),
    });
    const notes = [
      result.timedOut ? `timed out after ${PROBE_TIMEOUT_SECONDS}s` : null,
      result.dirty ? "the probe changed the checkout" : null,
      result.headMoved ? "the probe moved HEAD" : null,
    ].filter((note) => note !== null);
    const passed = result.exitCode === 0 && notes.length === 0;
    const printed = `${result.stdout}\n${result.stderr}`.trim();
    return { passed, output: clip([...notes, printed].filter(Boolean).join("\n")) };
  };
  try {
    const main = await run(input.main, input.main);
    const breaks: BreakCheck[] = [];
    for (const ref of input.breaks) {
      const commit = await resolveBreak(input.checkout, ref, input.pull).catch(() => null);
      if (!commit) {
        breaks.push({
          ref,
          commit: null,
          run: null,
          note: `${refLabel(ref)} names no commit on origin/main`,
        });
        continue;
      }
      const parent = await revParse(input.checkout, `${commit}^`);
      if (!parent) {
        breaks.push({ ref, commit, run: null, note: `${commit.slice(0, 12)} has no parent` });
        continue;
      }
      breaks.push({ ref, commit, run: await run(parent, commit) });
    }
    return { main, breaks, status: checkStatus(main, breaks) };
  } finally {
    await git(["-C", input.checkout, "checkout", "-q", "--detach", input.main]);
  }
}

export function checkStatus(main: ProbeRun, breaks: readonly BreakCheck[]): CheckStatus {
  if (breaks.some((entry) => entry.run?.passed)) return "misses_bug";
  if (!main.passed) return "fails_on_main";
  // Checked only when every commit the sources name was run and the probe failed on it.
  return breaks.length > 0 && breaks.every((entry) => entry.run !== null)
    ? "checked"
    : "unverified";
}

export function refLabel(ref: BreakRef): string {
  return "pull" in ref ? `#${ref.pull}` : ref.commit.slice(0, 12);
}

async function resolveBreak(
  checkout: string,
  ref: BreakRef,
  pull: PullLookup,
): Promise<string | null> {
  if ("commit" in ref) return revParse(checkout, `${ref.commit}^{commit}`);
  const merged = await pull(ref.pull);
  if (!merged?.mergeCommitSha) return null;
  return revParse(checkout, `${merged.mergeCommitSha}^{commit}`);
}

async function revParse(checkout: string, rev: string): Promise<string | null> {
  try {
    return (await git(["-C", checkout, "rev-parse", "--verify", "--quiet", rev])).trim() || null;
  } catch (error) {
    journalCaught(error, "probe-collector.revParse", null, "a commit may be absent");
    return null;
  }
}

function clip(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS ? text : `${text.slice(0, MAX_OUTPUT_CHARS)}…`;
}
