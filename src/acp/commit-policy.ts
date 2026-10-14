import {
  commitCoauthorTrailers,
  policyCoauthors,
  validateCommitAttribution,
  type GitCommitPolicy,
} from "../core";
import { git } from "./git";

export async function validateCandidateAttribution(
  tree: string,
  base: string,
  head: string,
  policy: GitCommitPolicy,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  policyCoauthors(policy);
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head))
    throw new Error("Invalid attribution candidate range");
  const invoke = (args: string[]) =>
    git(["-C", tree, "--no-replace-objects", ...args], { env, signal });
  await invoke(["merge-base", "--is-ancestor", base, head]);
  const commits = (await invoke(["rev-list", `${base}..${head}`]))
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
