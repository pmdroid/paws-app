import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { assertDescendsFromAny, git } from "../acp";

export async function fetchRunnerCandidate(input: {
  worktree: string;
  baseSha: string;
  mainSha?: string;
  candidateSha: string;
  branch: string;
  remoteUrl: string;
  networkGit: (args: string[]) => Promise<string>;
  signal: AbortSignal;
}): Promise<void> {
  input.signal.throwIfAborted();
  if (
    !isAbsolute(input.worktree) ||
    !/^[a-f0-9]{40}$/.test(input.baseSha) ||
    (input.mainSha !== undefined && !/^[a-f0-9]{40}$/.test(input.mainSha)) ||
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
    await assertDescendsFromAny(
      run,
      input.mainSha ? [input.baseSha, input.mainSha] : [input.baseSha],
      input.candidateSha,
    );
    await unchanged();
    input.signal.throwIfAborted();
    await run(["reset", "--hard", input.candidateSha]);
  } finally {
    await git(["-C", input.worktree, "update-ref", "-d", ref], {
      signal: AbortSignal.timeout(5_000),
    });
  }
}

export async function fastForwardToBranchTip(input: {
  worktree: string;
  branch: string;
  remoteUrl: string;
  networkGit: (args: string[]) => Promise<string>;
  signal: AbortSignal;
}): Promise<string | null> {
  input.signal.throwIfAborted();
  if (!isAbsolute(input.worktree)) throw new Error("Runner branch tip import is invalid.");
  const ref = `refs/paws/branch-tips/${randomUUID()}`;
  const run = (args: string[]) => git(["-C", input.worktree, ...args], { signal: input.signal });
  await run(["check-ref-format", `refs/heads/${input.branch}`]);
  const head = (await run(["rev-parse", "HEAD"])).trim();
  try {
    const fetched = await input
      .networkGit([
        "-C",
        input.worktree,
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--",
        input.remoteUrl,
        `refs/heads/${input.branch}:${ref}`,
      ])
      .then(
        () => true,
        () => false,
      );
    if (!fetched) return null;
    const tip = await run(["rev-parse", "--verify", `${ref}^{commit}`]).then(
      (out) => out.trim(),
      () => null,
    );
    if (tip === null || tip === head) return null;
    const descends = await run(["merge-base", "--is-ancestor", head, tip]).then(
      () => true,
      () => false,
    );
    if (!descends && !(await containedIn(run, tip, head))) return null;
    if ((await run(["rev-parse", "HEAD"])).trim() !== head) return null;
    input.signal.throwIfAborted();
    await run(["reset", "--hard", tip]);
    return tip;
  } finally {
    await git(["-C", input.worktree, "update-ref", "-d", ref], {
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }
}

async function containedIn(
  run: (args: string[]) => Promise<string>,
  tip: string,
  head: string,
): Promise<boolean> {
  const main = await run([
    "rev-parse",
    "--verify",
    "--quiet",
    "refs/paws/upstream-main^{commit}",
  ]).then(
    (out) => out.trim(),
    () => "",
  );
  const own = main
    ? await run(["merge-base", head, main]).then(
        (out) => out.trim(),
        () => "",
      )
    : "";
  const cherry = await run(["cherry", tip, head, ...(own ? [own] : [])]).then(
    (out) => out.trim(),
    () => null,
  );
  if (cherry === null) return false;
  const missing = cherry
    .split("\n")
    .filter((line) => line.startsWith("+ "))
    .map((line) => line.slice(2));
  if (missing.length === 0) return true;
  const tipBase = main
    ? await run(["merge-base", tip, main]).then(
        (out) => out.trim(),
        () => "",
      )
    : own;
  const onTip = await run(["log", "--format=%s", tip, ...(tipBase ? [`^${tipBase}`] : [])]).then(
    (out) => new Set(out.split("\n").filter(Boolean)),
    () => new Set<string>(),
  );
  for (const sha of missing) {
    const subject = await run(["log", "-1", "--format=%s", sha]).then(
      (out) => out.trim(),
      () => "",
    );
    if (!subject || !onTip.has(subject)) return false;
  }
  return true;
}
