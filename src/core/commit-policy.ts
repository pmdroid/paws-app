import { journalCaught } from "./journal";
import {
  appBotCommitIdentity,
  commitIdentityEnv,
  type AppBotIdentity,
  type GitCommitIdentity,
} from "./commit-identity";

export type VerifiedGitHubCoauthor = GitCommitIdentity & { id: number; login: string };
/** The App bot authors every commit; `credit` is the delegating member's linked GitHub identity. */
export type GitCommitPolicy = {
  bot: AppBotIdentity;
  credit: VerifiedGitHubCoauthor | null;
};

export function policyCoauthors(policy: GitCommitPolicy): VerifiedGitHubCoauthor[] {
  appBotCommitIdentity(policy.bot);
  const human = policy.credit;
  if (human === null) return [];
  if (
    !human ||
    !Number.isSafeInteger(human.id) ||
    human.id <= 0 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(human.login)
  )
    throw new Error("Invalid verified GitHub coauthor identity.");
  commitIdentityEnv(human);
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(human.email))
    throw new Error("Invalid verified GitHub coauthor email");
  return [human];
}

export function commitPolicyMessage(message: string, policy: GitCommitPolicy): string {
  const trailers = policyCoauthors(policy).map(
    (human) => `Co-authored-by: ${human.name} <${human.email}>`,
  );
  return `${message.trim()}${trailers.length ? `\n\n${trailers.join("\n")}` : ""}\n`;
}

export function validateCommitAttribution(
  policy: GitCommitPolicy,
  metadata: readonly string[],
  trailers: readonly string[],
): void {
  const identity = appBotCommitIdentity(policy.bot);
  const names = [identity.name, policy.bot.login];
  const [author, authorEmail, committer, committerEmail] = metadata;
  if (
    metadata.length !== 4 ||
    !names.includes(author!) ||
    !names.includes(committer!) ||
    authorEmail !== identity.email ||
    committerEmail !== identity.email
  )
    throw new Error(
      "Candidate attribution rejected: every new commit must use the authorized App bot as author and committer. Repair metadata before verification; no candidate was rewritten.",
    );
  const expected = policyCoauthors(policy)
    .map((human) => `${human.name} <${human.email}>`)
    .sort();
  if (JSON.stringify([...trailers].sort()) !== JSON.stringify(expected))
    throw new Error(
      "Candidate attribution rejected: Co-authored-by trailers must match the consenting identities in the run policy. No candidate was rewritten.",
    );
}

export function policyPullRequestCredit(policy: GitCommitPolicy): string {
  const [human] = policyCoauthors(policy);
  return human ? `Credit: [@${human.login}](https://github.com/${human.login})` : "";
}

export function commitCoauthorTrailers(message: string): string[] {
  const block = message
    .trimEnd()
    .split(/\n\s*\n/)
    .at(-1)!
    .split("\n");
  if (block.some((line) => !/^[A-Za-z0-9-]+:[ \t]+\S/.test(line))) return [];
  return block
    .filter((line) => /^Co-authored-by:/i.test(line))
    .map((line) => line.slice(line.indexOf(":") + 1).trim());
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
      journalCaught(error, "commit-policy.assertDescendsFromAny.invoke", null);
      failure = error;
    }
  }
  throw failure;
}

export const CHECKPOINT_COMMIT_MESSAGE = "Save work in progress so far";

export async function candidateBases(
  invoke: (args: string[]) => Promise<string>,
  base: string,
): Promise<string[]> {
  const subject = await invoke(["log", "-1", "--format=%s", base]).then(
    (out) => out.trim(),
    () => "",
  );
  if (subject !== CHECKPOINT_COMMIT_MESSAGE) return [base];
  const parent = await invoke(["rev-parse", "--verify", `${base}^`]).then(
    (out) => out.trim(),
    () => "",
  );
  return /^[a-f0-9]{40}$/.test(parent) ? [base, parent] : [base];
}
