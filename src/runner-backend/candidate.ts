import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { git } from "../acp";

type CandidateImport = {
  worktree: string;
  baseSha: string;
  candidateSha: string;
  branch: string;
  remoteUrl: string;
  networkGit: (args: string[]) => Promise<string>;
  signal: AbortSignal;
};

/** Check out the runner's candidate. A failure names the commit and branch for Linear. */
export async function fetchRunnerCandidate(input: CandidateImport): Promise<void> {
  try {
    await importCandidate(input);
  } catch (error) {
    if (input.signal.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Paws could not import the runner's commit ${input.candidateSha.slice(0, 7)} from ${input.branch}: ${reason}`,
      { cause: error },
    );
  }
}

async function importCandidate(input: CandidateImport): Promise<void> {
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
  await run(["check-ref-format", `refs/heads/${input.branch}`]);
  await unchanged();
  // No new commit: the runner publishes nothing and the task already holds the candidate.
  if (input.candidateSha === input.baseSha) return;
  try {
    await input.networkGit([
      "-C",
      input.worktree,
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--",
      input.remoteUrl,
      `refs/heads/${input.branch}:${ref}`,
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
