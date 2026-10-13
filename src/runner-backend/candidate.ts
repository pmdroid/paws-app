import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { git } from "../acp";

export async function fetchRunnerCandidate(input: {
  worktree: string;
  baseSha: string;
  candidateSha: string;
  remoteUrl: string;
  networkGit: (args: string[]) => Promise<string>;
  signal: AbortSignal;
}): Promise<void> {
  input.signal.throwIfAborted();
  if (
    !isAbsolute(input.worktree) ||
    !/^[a-f0-9]{40}$/.test(input.baseSha) ||
    !/^[a-f0-9]{40}$/.test(input.candidateSha) ||
    typeof input.networkGit !== "function"
  )
    throw new Error("Runner candidate import is invalid.");
  const ref = `refs/paws/candidates/${randomUUID()}`;
  const run = (args: string[]) => git(["-C", input.worktree, ...args], { signal: input.signal });
  const unchanged = async () => {
    if ((await run(["rev-parse", "HEAD"])).trim() !== input.baseSha)
      throw new Error("Runner candidate base changed.");
  };
  await unchanged();
  try {
    await input.networkGit([
      "-C",
      input.worktree,
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--",
      input.remoteUrl,
      `${input.candidateSha}:${ref}`,
    ]);
    input.signal.throwIfAborted();
    if ((await run(["rev-parse", "--verify", `${ref}^{commit}`])).trim() !== input.candidateSha)
      throw new Error("Fetched runner candidate does not match.");
    await run(["merge-base", "--is-ancestor", input.baseSha, input.candidateSha]);
    await unchanged();
    input.signal.throwIfAborted();
    await run(["reset", "--hard", input.candidateSha]);
  } finally {
    await git(["-C", input.worktree, "update-ref", "-d", ref], {
      signal: AbortSignal.timeout(5_000),
    });
  }
}
