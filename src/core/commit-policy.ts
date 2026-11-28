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

export const COAUTHOR_REJECTION =
  "Candidate attribution rejected: Co-authored-by trailers must match the consenting identities in the run policy.";

export const IDENTITY_REJECTION =
  "Candidate attribution rejected: every new commit must use the authorized App bot as author and committer.";

type CommitIdentityViolation = {
  commit: string;
  author: string;
  committer: string;
  failed: ("author" | "committer")[];
};

function commitIdentityViolation(
  policy: GitCommitPolicy,
  metadata: readonly (string | undefined)[],
  commit = "",
): CommitIdentityViolation | null {
  const identity = appBotCommitIdentity(policy.bot);
  const names = [identity.name, policy.bot.login];
  const [author = "", authorEmail = "", committer = "", committerEmail = ""] = metadata;
  const bot = (name: string, email: string) =>
    metadata.length === 4 && names.includes(name) && email === identity.email;
  const failed = [
    ...(bot(author, authorEmail) ? [] : ["author" as const]),
    ...(bot(committer, committerEmail) ? [] : ["committer" as const]),
  ];
  if (failed.length === 0) return null;
  return {
    commit: commit.slice(0, 12),
    author: `${author} <${authorEmail}>`,
    committer: `${committer} <${committerEmail}>`,
    failed,
  };
}

function commitIdentityRejection(violations: readonly CommitIdentityViolation[]): string {
  const named = violations
    .slice(0, 5)
    .map(
      (v) =>
        `commit=${v.commit || "unknown"} author=${v.author} committer=${v.committer} failed=${v.failed.join(",")}`,
    );
  const more = violations.length - named.length;
  return `${IDENTITY_REJECTION} Rejected ${named.join("; ")}${more > 0 ? `; and ${more} more` : ""}. Repair metadata before verification; no candidate was rewritten.`;
}

function commitTrailerRejection(
  policy: GitCommitPolicy,
  trailers: readonly string[],
  commit?: string,
): string | null {
  const expected = policyCoauthors(policy)
    .map((human) => `${human.name} <${human.email}>`)
    .sort();
  const found = [...new Set(trailers)].sort();
  if (JSON.stringify(found) === JSON.stringify(expected)) return null;
  const extra = found.filter((trailer) => !expected.includes(trailer));
  const missing = expected.filter((trailer) => !found.includes(trailer));
  const problems = [
    extra.length ? `has unexpected Co-authored-by: ${extra.join(", ")}` : "",
    missing.length ? `is missing Co-authored-by: ${missing.join(", ")}` : "",
  ].filter(Boolean);
  return `${COAUTHOR_REJECTION} ${commit ? `Commit ${commit.slice(0, 12)}` : "A commit"} ${problems.join(" and ")}; expected ${expected.length ? expected.join(", ") : "no Co-authored-by trailers"}. No candidate was rewritten.`;
}

export function commitAttributionCheck(policy: GitCommitPolicy) {
  const identities: CommitIdentityViolation[] = [];
  let trailer: string | null = null;
  return {
    add(metadata: readonly (string | undefined)[], trailers: readonly string[], commit?: string) {
      const identity = commitIdentityViolation(policy, metadata, commit);
      if (identity) identities.push(identity);
      else trailer ??= commitTrailerRejection(policy, trailers, commit);
    },
    assert() {
      if (identities.length > 0) throw new Error(commitIdentityRejection(identities));
      if (trailer !== null) throw new Error(trailer);
    },
  };
}

export function validateCommitAttribution(
  policy: GitCommitPolicy,
  metadata: readonly (string | undefined)[],
  trailers: readonly string[],
  commit?: string,
): void {
  const check = commitAttributionCheck(policy);
  check.add(metadata, trailers, commit);
  check.assert();
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

export function checkpointRef(branch: string): string {
  return `refs/paws/checkpoints/${branch}`;
}

export async function checkpointStart(
  invoke: (args: string[]) => Promise<string>,
  checkpoint: string,
  bases: readonly string[],
): Promise<string> {
  const subject = (await invoke(["log", "-1", "--format=%s", checkpoint])).trim();
  const start =
    subject === CHECKPOINT_COMMIT_MESSAGE
      ? (await invoke(["rev-parse", "--verify", `${checkpoint}^1^{commit}`])).trim()
      : checkpoint;
  await assertDescendsFromAny(invoke, bases, start);
  return start;
}

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
