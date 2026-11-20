import {
  assertDescendsFromAny,
  commitCoauthorTrailers,
  policyCoauthors,
  validateCommitAttribution,
  type GitCommitPolicy,
} from "../core";
import { git } from "./git";

const UPSTREAM_MAIN = "refs/paws/upstream-main";

export async function validateCandidateAttribution(
  tree: string,
  base: string | readonly string[],
  head: string,
  policy: GitCommitPolicy,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  adoptedPatchIds: readonly string[] = [],
): Promise<void> {
  policyCoauthors(policy);
  const bases = typeof base === "string" ? [base] : base;
  if (
    bases.length === 0 ||
    !bases.every((sha) => /^[a-f0-9]{40}$/.test(sha)) ||
    !/^[a-f0-9]{40}$/.test(head)
  )
    throw new Error("Invalid attribution candidate range");
  const invoke = (args: string[]) =>
    git(["-C", tree, "--no-replace-objects", ...args], { env, signal });
  await assertDescendsFromAny(invoke, bases, head);
  const main = await invoke(["rev-parse", "--verify", "--quiet", `${UPSTREAM_MAIN}^{commit}`]).then(
    (out) => out.trim(),
    () => "",
  );
  const excluded = [...bases, ...(/^[a-f0-9]{40}$/.test(main) ? [main] : [])];
  const commits = (await invoke(["rev-list", head, ...excluded.map((sha) => `^${sha}`)]))
    .trim()
    .split("\n")
    .filter(Boolean);
  const adopted = new Set(adoptedPatchIds);
  for (const sha of commits) {
    if (adopted.size > 0 && adopted.has((await commitPatchId(tree, sha, env, signal)) ?? ""))
      continue;
    const metadata = (await invoke(["show", "-s", "--format=%an%n%ae%n%cn%n%ce", sha]))
      .trimEnd()
      .split("\n");
    const message = await invoke(["show", "-s", "--format=%B", sha]);
    validateCommitAttribution(policy, metadata, commitCoauthorTrailers(message));
  }
}

export async function commitPatchIds(
  tree: string,
  shas: readonly string[],
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string[]> {
  const ids: string[] = [];
  for (const sha of shas) {
    const id = await commitPatchId(tree, sha, env, signal);
    if (id) ids.push(id);
  }
  return ids;
}

async function commitPatchId(
  tree: string,
  sha: string,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string | null> {
  const invoke = (args: string[], input?: string) =>
    git(["-C", tree, "--no-replace-objects", ...args], { env, signal, input });
  const diff = await invoke([
    "diff-tree",
    "-p",
    "--no-commit-id",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    sha,
  ]);
  if (diff.trim() === "") return null;
  const id = (await invoke(["patch-id", "--stable"], diff)).split(" ")[0] ?? "";
  return /^[a-f0-9]{40}$/.test(id) ? id : null;
}
