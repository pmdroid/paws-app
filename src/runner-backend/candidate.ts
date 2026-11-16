import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { assertDescendsFromAny, git } from "../acp";

const CANDIDATE_REF = /^refs\/paws\/candidates\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export class CandidateMismatch extends Error {
  override readonly name = "CandidateMismatch";
  constructor(readonly tip: string) {
    super("Fetched runner candidate does not match.");
  }
}

export async function restartCandidateFrom(input: {
  mirror: string;
  ref: string;
  branch: string;
  remoteUrl: string;
  from: { tip: string } | "main";
  base?: string;
  networkGit: (args: string[]) => Promise<string>;
  signal: AbortSignal;
}): Promise<{ start: string; base: string }> {
  input.signal.throwIfAborted();
  if (!isAbsolute(input.mirror) || !CANDIDATE_REF.test(input.ref))
    throw new Error("Runner candidate restart is invalid.");
  const scratch = `refs/paws/imports/${randomUUID()}`;
  const run = (args: string[]) =>
    git(["--git-dir", input.mirror, ...args], { signal: input.signal }).then((out) => out.trim());
  await run(["check-ref-format", `refs/heads/${input.branch}`]);
  const net = (flags: string[], refspec: string) =>
    input.networkGit(["-C", input.mirror, ...flags, "--", input.remoteUrl, refspec]);
  try {
    await net(
      ["fetch", "--no-tags", "--no-write-fetch-head"],
      `refs/heads/${input.branch}:${scratch}`,
    );
    const tip = await run(["rev-parse", "--verify", `${scratch}^{commit}`]);
    const main = await run(["rev-parse", "--verify", "refs/paws/upstream-main^{commit}"]);
    if (input.from !== "main") {
      if (tip !== input.from.tip) throw new CandidateMismatch(tip);
      const base = await assertDescendsFromAny(run, input.base ? [input.base] : [], tip).then(
        () => input.base!,
        () => run(["merge-base", tip, main]),
      );
      await run(["update-ref", input.ref, tip]);
      return { start: tip, base };
    }
    if (tip !== main)
      await net(
        ["push", `--force-with-lease=refs/heads/${input.branch}:${tip}`],
        `${main}:refs/heads/${input.branch}`,
      ).catch((error: unknown) => {
        throw /stale info|rejected/.test(String(error)) ? new CandidateMismatch(tip) : error;
      });
    await run(["update-ref", input.ref, main]);
    return { start: main, base: main };
  } finally {
    await git(["--git-dir", input.mirror, "update-ref", "-d", scratch], {
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }
}

/**
 * Imports a runner's candidate into the bare mirror: fetches the branch under a scratch ref,
 * checks that it is `candidateSha` and descends from the base or main, then moves the item's
 * candidate ref from `baseSha` to it. A ref that moved meanwhile refuses the import.
 */
export async function fetchRunnerCandidate(input: {
  mirror: string;
  ref: string;
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
    !isAbsolute(input.mirror) ||
    !CANDIDATE_REF.test(input.ref) ||
    !/^[a-f0-9]{40}$/.test(input.baseSha) ||
    (input.mainSha !== undefined && !/^[a-f0-9]{40}$/.test(input.mainSha)) ||
    !/^[a-f0-9]{40}$/.test(input.candidateSha) ||
    typeof input.networkGit !== "function"
  )
    throw new Error("Runner candidate import is invalid.");
  const scratch = `refs/paws/imports/${randomUUID()}`;
  const run = (args: string[]) =>
    git(["--git-dir", input.mirror, ...args], { signal: input.signal });
  const unchanged = async () => {
    if ((await run(["rev-parse", "--verify", `${input.ref}^{commit}`])).trim() !== input.baseSha)
      throw new Error("Runner candidate base changed.");
  };
  await run(["check-ref-format", `refs/heads/${input.branch}`]);
  await unchanged();
  if (input.candidateSha === input.baseSha) return;
  try {
    await input.networkGit([
      "-C",
      input.mirror,
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--",
      input.remoteUrl,
      `refs/heads/${input.branch}:${scratch}`,
    ]);
    input.signal.throwIfAborted();
    const tip = (await run(["rev-parse", "--verify", `${scratch}^{commit}`])).trim();
    if (tip !== input.candidateSha) throw new CandidateMismatch(tip);
    await assertDescendsFromAny(
      run,
      input.mainSha ? [input.baseSha, input.mainSha] : [input.baseSha],
      input.candidateSha,
    );
    await unchanged();
    input.signal.throwIfAborted();
    await run(["update-ref", input.ref, input.candidateSha, input.baseSha]);
  } finally {
    await git(["--git-dir", input.mirror, "update-ref", "-d", scratch], {
      signal: AbortSignal.timeout(5_000),
    });
  }
}

/** Moves the item's candidate ref in the mirror to a branch tip that carries its work. */
export async function fastForwardToBranchTip(input: {
  mirror: string;
  ref: string;
  branch: string;
  remoteUrl: string;
  networkGit: (args: string[]) => Promise<string>;
  signal: AbortSignal;
}): Promise<string | null> {
  input.signal.throwIfAborted();
  if (!isAbsolute(input.mirror) || !CANDIDATE_REF.test(input.ref))
    throw new Error("Runner branch tip import is invalid.");
  const ref = `refs/paws/branch-tips/${randomUUID()}`;
  const run = (args: string[]) =>
    git(["--git-dir", input.mirror, ...args], { signal: input.signal });
  await run(["check-ref-format", `refs/heads/${input.branch}`]);
  const head = (await run(["rev-parse", "--verify", `${input.ref}^{commit}`])).trim();
  try {
    const fetched = await input
      .networkGit([
        "-C",
        input.mirror,
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
    input.signal.throwIfAborted();
    // The old value refuses a ref that moved since it was read.
    const moved = await run(["update-ref", input.ref, tip, head]).then(
      () => false,
      () => true,
    );
    return moved ? null : tip;
  } finally {
    await git(["--git-dir", input.mirror, "update-ref", "-d", ref], {
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
