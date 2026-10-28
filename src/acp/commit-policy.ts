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
  for (const sha of commits) {
    const metadata = (await invoke(["show", "-s", "--format=%an%n%ae%n%cn%n%ce", sha]))
      .trimEnd()
      .split("\n");
    const message = await invoke(["show", "-s", "--format=%B", sha]);
    validateCommitAttribution(policy, metadata, commitCoauthorTrailers(message));
  }
}
