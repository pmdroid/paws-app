import { randomUUID } from "node:crypto";
import { git } from "../acp";

export type StartCommit =
  /** GitHub's item branch or main already holds the head. */
  | { status: "remote"; head: string }
  /** Paws pushed the head to the item branch. */
  | { status: "pushed"; head: string }
  /** The push failed, so the worktree went back to the last commit GitHub holds. */
  | { status: "fallback"; head: string; start: string; lost: string[]; error: string }
  /** Paws could not read GitHub, or found nothing to fall back to: the run starts as before. */
  | { status: "unknown"; head: string; error: string };

/**
 * A runner's mirror fetches its start commit from GitHub, so a head that only Paws holds fails
 * every run there. Paws pushes it first; when that fails too, the worktree goes back to the PR
 * branch head, else `wipCommit`, else the base, and the caller tells the agent what was lost.
 */
export async function ensureStartOnRemote(input: {
  worktree: string;
  branch: string;
  remoteUrl: string;
  networkGit: (args: string[]) => Promise<string>;
  wipCommit?: string;
  baseSha?: string;
  signal: AbortSignal;
}): Promise<StartCommit> {
  const run = (args: string[]) =>
    git(["-C", input.worktree, ...args], { signal: input.signal }).then((out) => out.trim());
  const head = await run(["rev-parse", "HEAD"]);
  const prefix = `refs/paws/remote-start/${randomUUID()}`;
  const fetched = new Map<"branch" | "main", string>();
  const errors: string[] = [];
  try {
    for (const [name, ref] of [
      ["branch", `refs/heads/${input.branch}`],
      ["main", "refs/heads/main"],
    ] as const) {
      try {
        await input.networkGit([
          "-C",
          input.worktree,
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--",
          input.remoteUrl,
          `+${ref}:${prefix}/${name}`,
        ]);
        fetched.set(name, await run(["rev-parse", "--verify", `${prefix}/${name}^{commit}`]));
      } catch (error) {
        input.signal.throwIfAborted();
        // A branch that was never pushed is absent, which is not a failure.
        errors.push(message(error));
      }
    }
    if (!fetched.size) return { status: "unknown", head, error: errors.join("; ") };
    const onRemote = async (sha: string) => {
      for (const tip of fetched.values())
        if (
          await run(["merge-base", "--is-ancestor", sha, tip]).then(
            () => true,
            () => false,
          )
        )
          return true;
      input.signal.throwIfAborted();
      return false;
    };
    if (await onRemote(head)) return { status: "remote", head };
    let pushError: string;
    try {
      // A fast-forward only: a branch that moved on GitHub keeps its commits.
      await input.networkGit([
        "-C",
        input.worktree,
        "push",
        "--",
        input.remoteUrl,
        `${head}:refs/heads/${input.branch}`,
      ]);
      return { status: "pushed", head };
    } catch (error) {
      input.signal.throwIfAborted();
      pushError = message(error);
    }
    const branchHead = fetched.get("branch");
    const mainHead = fetched.get("main");
    const mergeBase = mainHead
      ? await run(["merge-base", head, mainHead]).catch(() => undefined)
      : undefined;
    let start: string | undefined;
    for (const candidate of [branchHead, input.wipCommit, input.baseSha, mergeBase])
      if (candidate && (candidate === branchHead || (await onRemote(candidate)))) {
        start = candidate;
        break;
      }
    if (!start) return { status: "unknown", head, error: pushError };
    const lost = (await run(["log", "--format=%s", `${start}..${head}`]))
      .split("\n")
      .filter(Boolean);
    await run(["reset", "--hard", start]);
    return { status: "fallback", head, start, lost, error: pushError };
  } finally {
    for (const name of ["branch", "main"])
      await git(["-C", input.worktree, "update-ref", "-d", `${prefix}/${name}`], {
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined); // an absent ref has nothing to delete
  }
}

/** The handoff line that tells the agent which commits it has to redo. */
export function lostCommitsNote(start: string, lost: readonly string[]): string {
  return `Your commits after ${start.slice(0, 8)} didn't reach GitHub${
    lost.length ? `: ${lost.join("; ")}` : ""
  }. Redo them.`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
