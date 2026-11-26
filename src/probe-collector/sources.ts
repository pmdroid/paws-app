import { git } from "../acp";
import {
  listMergedPullsSince,
  readPullComments,
  readReviewThreads,
  type GitHubClient,
  type GitHubTokenProvider,
  type MergedPull,
} from "../github";
import type { Source, StoredFinding } from "./types";

export const DEFAULT_SINCE_DAYS = 90;

/** Longest text one source carries into the distill prompt. */
const MAX_SOURCE_CHARS = 20_000;

export type PullReading = {
  client: GitHubClient;
  tokenProvider: GitHubTokenProvider;
  owner: string;
  repo: string;
  since: Date;
  signal?: AbortSignal;
};

/** Review threads, resolved or not, and top-level comments on pull requests merged since `since`. */
export async function collectPullSources(
  input: PullReading,
): Promise<{ pulls: MergedPull[]; sources: Omit<Source, "id">[] }> {
  const pulls = await listMergedPullsSince(input);
  const sources: Omit<Source, "id">[] = [];
  for (const pull of pulls) {
    const read = { ...input, number: pull.number };
    for (const comment of await readPullComments(read)) {
      if (!comment.body.trim()) continue;
      sources.push({
        kind: "pull_comment",
        url: comment.url,
        title: `#${pull.number} ${pull.title}: comment by ${comment.author ?? "unknown"}`,
        text: clip(comment.body),
        pull: pull.number,
      });
    }
    const threads = await readReviewThreads({
      client: input.client,
      tokenProvider: input.tokenProvider,
      owner: input.owner,
      repo: input.repo,
      prNumber: pull.number,
      includeResolved: true,
    });
    for (const thread of threads) {
      const comments = thread.comments.filter((comment) => comment.body.trim());
      const first = comments[0];
      if (!first) continue;
      const where = thread.path ? ` on ${thread.path}${thread.line ? `:${thread.line}` : ""}` : "";
      sources.push({
        kind: "review_thread",
        url: first.url ?? `${pull.url}#pullrequestreview-${first.reviewId ?? ""}`,
        title: `#${pull.number} ${pull.title}: review thread${where}, ${thread.resolved ? "resolved" : "unresolved"}`,
        text: clip(
          comments.map((comment) => `${comment.author ?? "unknown"}: ${comment.body}`).join("\n\n"),
        ),
        pull: pull.number,
      });
    }
  }
  return { pulls, sources };
}

/** The repository files a team writes its rules in. */
export function isRuleDoc(path: string): boolean {
  if (path === "AGENTS.md" || path === "CLAUDE.md") return true;
  if (path.startsWith("docs/") && path.endsWith(".md")) return true;
  return /^\.agents\/skills\/.+\/SKILL\.md$/.test(path);
}

/**
 * `AGENTS.md`, `CLAUDE.md`, `docs/**\/*.md` and `.agents/skills/**\/SKILL.md` at `commit` in
 * `gitDir`. Each line is numbered so the distill turn can cite it.
 */
export async function collectDocSources(input: {
  gitDir: string;
  commit: string;
  owner: string;
  repo: string;
}): Promise<Omit<Source, "id">[]> {
  const listed = await git([
    "--git-dir",
    input.gitDir,
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    input.commit,
  ]);
  const paths = listed.split("\0").filter(isRuleDoc).sort();
  const sources: Omit<Source, "id">[] = [];
  for (const path of paths) {
    const text = await git(["--git-dir", input.gitDir, "show", `${input.commit}:${path}`]);
    if (!text.trim()) continue;
    sources.push({
      kind: "doc",
      url: `https://github.com/${input.owner}/${input.repo}/blob/${input.commit}/${path}`,
      title: path,
      text: clip(
        text
          .split("\n")
          .map((line, index) => `${index + 1}: ${line}`)
          .join("\n"),
      ),
      path,
    });
  }
  return sources;
}

export function findingSources(findings: readonly StoredFinding[]): Omit<Source, "id">[] {
  const seen = new Set<string>();
  const sources: Omit<Source, "id">[] = [];
  for (const { task, check, head, finding } of findings) {
    const key = `${finding.location}\0${finding.explanation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      kind: "closeout_finding",
      url: `closeout:${task}/${check}@${head.slice(0, 12)}`,
      title: `Closeout ${check} finding (${finding.severity}) in ${task} at ${finding.location}`,
      text: clip(`${finding.explanation}\n\nEvidence: ${finding.evidence}`),
    });
  }
  return sources;
}

/** Number the sources `S1`, `S2`, … in the order given. */
export function numberSources(sources: readonly Omit<Source, "id">[]): Source[] {
  return sources.map((source, index) => ({ id: `S${index + 1}`, ...source }));
}

function clip(text: string): string {
  return text.length <= MAX_SOURCE_CHARS ? text : `${text.slice(0, MAX_SOURCE_CHARS)}\n[…]`;
}
