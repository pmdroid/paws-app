import { randomUUID } from "node:crypto";
import { git } from "../acp";

export type StartCommit =
  /** GitHub's item branch or default branch already holds the head. */
  | { status: "remote"; head: string }
  /** Paws pushed the head to the item branch. */
  | { status: "pushed"; head: string }
  /** The push failed, so the worktree went back to the last commit GitHub holds. */
  | { status: "fallback"; head: string; start: string; lost: string[]; error: string };

/**
 * Paws could neither confirm, push nor fall back to a commit GitHub holds. No runner gets the
 * work: its mirror would fail on the same commit. It is temporary, so the item retries.
 */
export class RemoteStartUnverified extends Error {
  override readonly name = "RemoteStartUnverified";
  constructor(head: string, reason: string) {
    super(`Paws could not confirm that GitHub has a commit to start from at ${head}: ${reason}`);
  }
}

/**
 * A runner's mirror fetches its start commit from GitHub, so a head that only Paws holds fails
 * every run there. Paws pushes it first; when that fails too, the worktree goes back to the PR
 * branch head, else `wipCommit`, else the base, and the caller tells the agent what was lost.
 * A start Paws cannot establish on GitHub throws {@link RemoteStartUnverified}.
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
  const fetched = new Map<"branch" | "default", string>();
  const errors: string[] = [];
  try {
    // The remote's HEAD is its default branch, whatever it is called.
    for (const [name, ref] of [
      ["branch", `refs/heads/${input.branch}`],
      ["default", "HEAD"],
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
        // A branch that was never pushed is absent; the other ref may still answer.
        errors.push(message(error));
      }
    }
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
    if (!fetched.size) throw new RemoteStartUnverified(head, [...errors, pushError].join("; "));
    const branchHead = fetched.get("branch");
    const defaultHead = fetched.get("default");
    const mergeBase = defaultHead
      ? await run(["merge-base", head, defaultHead]).catch(() => undefined)
      : undefined;
    let start: string | undefined;
    for (const candidate of [branchHead, input.wipCommit, input.baseSha, mergeBase])
      if (candidate && (candidate === branchHead || (await onRemote(candidate)))) {
        start = candidate;
        break;
      }
    if (!start)
      throw new RemoteStartUnverified(head, `no earlier commit is on GitHub; ${pushError}`);
    const lost = (await run(["log", "--format=%s", `${start}..${head}`]))
      .split("\n")
      .filter(Boolean);
    await run(["reset", "--hard", start]);
    return { status: "fallback", head, start, lost, error: pushError };
  } finally {
    for (const name of ["branch", "default"])
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
