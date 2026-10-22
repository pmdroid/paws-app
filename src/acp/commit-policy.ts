import {
  commitCoauthorTrailers,
  policyCoauthors,
  validateCommitAttribution,
  type GitCommitPolicy,
} from "../core";
import { git } from "./git";

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
  const commits = (await invoke(["rev-list", head, ...bases.map((sha) => `^${sha}`)]))
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

export async function assertDescendsFromAny(
  invoke: (args: string[]) => Promise<string>,
  bases: readonly string[],
  head: string,
): Promise<void> {
  let failure: unknown;
  for (const base of bases) {
    try {
      await invoke(["merge-base", "--is-ancestor", base, head]);
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
