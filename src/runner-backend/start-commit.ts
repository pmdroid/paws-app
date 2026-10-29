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
  /**
   * Saves the fallback before the worktree moves, so a stop between the reset and the dispatch
   * still finds the handoff for the lost commits.
   */
  persistFallback: (fallback: { head: string; start: string; lost: string[] }) => void;
  signal: AbortSignal;
}): Promise<StartCommit> {
  const run = (args: string[]) =>
    git(["-C", input.worktree, ...args], { signal: input.signal }).then((out) => out.trim());
  await run(["check-ref-format", `refs/heads/${input.branch}`]);
  if (!input.remoteUrl) throw new Error("Runner start requires a repository URL.");
  const head = await run(["rev-parse", "HEAD"]);
  const unchanged = async () => {
    if (
      (await run(["rev-parse", "HEAD"])) !== head ||
      (await run(["status", "--porcelain", "--untracked-files=no"]))
    )
      throw new RemoteStartUnverified(head, "the worktree changed during remote verification");
  };
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
    let pushError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
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
        // Pascal's product decision: persistent permission refusals also allow fallback.
        // A fresh authenticated attempt distinguishes them from token-refresh failures.
        if (permissionRefusal(pushError)) {
          if (attempt === 0) continue;
          break;
        }
        if (/\[rejected\].*\((?:non-fast-forward|fetch first)\)/i.test(pushError)) break;
        throw new RemoteStartUnverified(head, pushError);
      }
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
    const lost = (await run(["log", "--format=%s", head, "--not", start, ...fetched.values()]))
      .split("\n")
      .filter(Boolean);
    await unchanged();
    // Retain the original commits even after HEAD moves to the remote fallback.
    await run(["update-ref", `refs/paws/unpublished/${head}`, head]);
    input.persistFallback({ head, start, lost });
    await unchanged();
    // --keep refuses to overwrite tracked edits introduced after the last check.
    await run(["reset", "--keep", start]);
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

function permissionRefusal(error: string): boolean {
  if (/rate.limit|secondary.limit|abuse|retry.after|expired|bad credentials|token/i.test(error))
    return false;
  return /(?:returned error: 403|Permission denied|write access.*not granted|Permission to .* denied|\(403\))/i.test(
    error,
  );
}
