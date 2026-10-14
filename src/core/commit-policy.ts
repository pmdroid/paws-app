import {
  appBotCommitIdentity,
  commitIdentityEnv,
  type AppBotIdentity,
  type GitCommitIdentity,
} from "./commit-identity";

export type VerifiedGitHubCoauthor = GitCommitIdentity & { id: number; login: string };
export type GitCommitPolicy = {
  bot: AppBotIdentity;
  projectLead: VerifiedGitHubCoauthor;
  taskSteerer: VerifiedGitHubCoauthor;
};

export function policyCoauthors(policy: GitCommitPolicy): VerifiedGitHubCoauthor[] {
  appBotCommitIdentity(policy.bot);
  const result: VerifiedGitHubCoauthor[] = [];
  for (const human of [policy.projectLead, policy.taskSteerer]) {
    if (
      !human ||
      !Number.isSafeInteger(human.id) ||
      human.id <= 0 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(human.login)
    )
      throw new Error(
        "Link consenting verified GitHub identities for both project lead and task steerer before running App work.",
      );
    commitIdentityEnv(human);
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(human.email))
      throw new Error("Invalid verified GitHub coauthor email");
    const existing = result.find((entry) => entry.id === human.id);
    if (
      existing &&
      (existing.login !== human.login ||
        existing.name !== human.name ||
        existing.email !== human.email)
    )
      throw new Error("Conflicting verified GitHub identity for project lead and task steerer");
    if (!existing) result.push(human);
  }
  return result;
}

export function commitPolicyMessage(message: string, policy: GitCommitPolicy): string {
  const trailers = policyCoauthors(policy).map(
    (human) => `Co-authored-by: ${human.name} <${human.email}>`,
  );
  return `${message.trim()}\n\n${trailers.join("\n")}\n`;
}

export function validateCommitAttribution(
  policy: GitCommitPolicy,
  metadata: readonly string[],
  trailers: readonly string[],
): void {
  const identity = appBotCommitIdentity(policy.bot);
  if (
    metadata.join("\n") !==
    [identity.name, identity.email, identity.name, identity.email].join("\n")
  )
    throw new Error(
      "Candidate attribution rejected: every new commit must use the authorized App bot as author and committer. Repair metadata before verification; no candidate was rewritten.",
    );
  const expected = policyCoauthors(policy)
    .map((human) => `${human.name} <${human.email}>`)
    .sort();
  if (JSON.stringify([...trailers].sort()) !== JSON.stringify(expected))
    throw new Error(
      "Candidate attribution rejected: add exactly the verified project lead and task steerer Co-authored-by trailers before verification. No candidate was rewritten.",
    );
}

export function policyPullRequestCredit(policy: GitCommitPolicy): string {
  policyCoauthors(policy);
  return `Project lead: [@${policy.projectLead.login}](https://github.com/${policy.projectLead.login})\nTask steerer: [@${policy.taskSteerer.login}](https://github.com/${policy.taskSteerer.login})`;
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
