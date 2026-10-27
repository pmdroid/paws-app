import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchName,
  createWorktree,
  ensureBareMirror,
  git,
  removeWorktree,
  resolveStartRef,
} from "../acp";
import type { RepositoryBinding } from "../core";
import { readMergedPull, type GitHubClient, type GitHubTokenProvider } from "../github";
import { journalCaught } from "../journal";
import { replyOf } from "./agent";
import { checkProbe } from "./check";
import { distillPrompt, parseCandidates } from "./distill";
import {
  formatCandidate,
  probesDir,
  renderProposal,
  statusLabel,
  validateProposal,
} from "./output";
import { collectDocSources, collectPullSources, findingSources, numberSources } from "./sources";
import type { AgentTurn, Candidate, ProposedRule, SkippedCandidate, StoredFinding } from "./types";
import { probePath, resetWorktree, writeProbe } from "./write";

export type CollectOptions = {
  repository: RepositoryBinding;
  pawsRoot: string;
  since: Date;
  /** Stop after the candidates are printed: no probe session, no files. */
  dryRun: boolean;
  /** The YAML file to write. Probe scripts go in the directory next to it, see `probesDir`. */
  out: string;
  github: { client: GitHubClient; tokenProvider: GitHubTokenProvider };
  turn: AgentTurn;
  /** Clone and fetch with the repository token. Without it, plain `git`. */
  networkGit?: (args: string[]) => Promise<string>;
  findings: () => Promise<StoredFinding[]>;
  /** The decidable candidates a person keeps, by id. */
  keep: (candidates: readonly Candidate[]) => Promise<string[]>;
  print: (text: string) => void;
  signal?: AbortSignal;
  /** Names the worktree and agent runs. Defaults to the time. */
  runKey?: string;
};

export type CollectResult = {
  main: string;
  candidates: Candidate[];
  rules: ProposedRule[];
  skipped: SkippedCandidate[];
  /** The file written, or null for `--dry-run` or when no probe was written. */
  out: string | null;
};

/** `paws probes collect`: collect, distill, write, check, then write the proposal file. */
export async function collectProbes(options: CollectOptions): Promise<CollectResult> {
  const { owner, repo, remoteUrl } = options.repository;
  const repository = `${owner}/${repo}`;
  const key = options.runKey ?? `probes-${Date.now()}`;
  const mirror = await ensureBareMirror({
    remoteUrl,
    owner,
    repo,
    pawsRoot: options.pawsRoot,
    ...(options.networkGit ? { networkGit: options.networkGit } : {}),
  });
  const ref = await resolveStartRef(mirror.path, "origin/main");
  if (!ref) throw new Error(`${repository} has no origin/main to read.`);
  const main = (await git(["--git-dir", mirror.path, "rev-parse", `${ref}^{commit}`])).trim();

  const pulls = await collectPullSources({
    ...options.github,
    owner,
    repo,
    since: options.since,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const sources = numberSources([
    ...pulls.sources,
    ...findingSources(await options.findings()),
    ...(await collectDocSources({ gitDir: mirror.path, commit: main, owner, repo })),
  ]);
  options.print(
    `Collected ${sources.length} sources from ${repository}: ${pulls.pulls.length} merged pull requests since ${options.since.toISOString().slice(0, 10)}, Closeout findings, and docs at ${main.slice(0, 12)}.`,
  );
  if (sources.length === 0) {
    options.print("Nothing to distill.");
    return { main, candidates: [], rules: [], skipped: [], out: null };
  }

  const scratch = await mkdtemp(join(tmpdir(), "paws-probes-distill-"));
  let candidates: Candidate[];
  try {
    const { text } = await replyOf(options.turn, {
      role: "reviewer",
      repository,
      itemId: "probes",
      runId: `${key}-distill`,
      prompt: distillPrompt(repository, sources),
      worktreePath: scratch,
      pawsRoot: options.pawsRoot,
      checkpoint: false,
      readOnly: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    candidates = parseCandidates(text, sources);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  options.print(candidates.length ? candidates.map(formatCandidate).join("\n") : "No candidates.");

  const skipped: SkippedCandidate[] = candidates
    .filter((candidate) => !candidate.decidable)
    .map((candidate) => ({ candidate, reason: candidate.reason ?? "a script cannot decide it" }));
  if (options.dryRun) return { main, candidates, rules: [], skipped, out: null };

  const decidable = candidates.filter((candidate) => candidate.decidable);
  const kept = new Set(decidable.length ? await options.keep(decidable) : []);
  for (const candidate of decidable)
    if (!kept.has(candidate.id)) skipped.push({ candidate, reason: "not kept" });
  const chosen = decidable.filter((candidate) => kept.has(candidate.id));
  const rules: ProposedRule[] = [];
  if (chosen.length) {
    const worktree = await createWorktree({ owner, repo, itemId: key, pawsRoot: options.pawsRoot });
    try {
      await resetWorktree(worktree.path, main);
      const lookup = new Map(pulls.pulls.map((pull) => [pull.number, pull]));
      for (const candidate of chosen) {
        options.print(`Writing ${probePath(candidate.id)}…`);
        const written = await writeProbe({
          turn: options.turn,
          repository,
          candidate,
          sources,
          worktree: worktree.path,
          commit: main,
          pawsRoot: options.pawsRoot,
          runId: `${key}-${candidate.id}`,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!written.ok) {
          skipped.push({ candidate, reason: written.reason });
          options.print(`  not written: ${written.reason}`);
          continue;
        }
        const check = await checkProbe({
          probe: probePath(candidate.id),
          bytes: written.bytes,
          exec: written.entry.exec ?? ["bun"],
          checkout: worktree.path,
          main,
          breaks: candidate.breaks,
          pull: async (number) =>
            lookup.get(number) ?? readMergedPull({ ...options.github, owner, repo, number }),
        });
        const rule: ProposedRule = {
          candidate,
          entry: written.entry,
          probe: probePath(candidate.id),
          bytes: written.bytes,
          check,
        };
        rules.push(rule);
        options.print(`  ${statusLabel(rule)}`);
      }
    } finally {
      await removeWorktree({ owner, repo, itemId: key, pawsRoot: options.pawsRoot }).catch(
        (error) => journalCaught(error, "probe-collector.removeWorktree", null),
      );
      await git(["--git-dir", mirror.path, "branch", "-D", branchName(key)]).catch((error) =>
        journalCaught(error, "probe-collector.deleteBranch", null),
      );
    }
  }
  if (rules.length === 0) {
    options.print("No probe was written, so there is no proposal file.");
    return { main, candidates, rules, skipped, out: null };
  }

  const scripts = probesDir(options.out);
  const yaml = renderProposal({ repository, main, scriptsDir: scripts, rules, skipped });
  const invalid = validateProposal(yaml, rules);
  if (invalid)
    throw new Error(`The proposed rules do not validate as a Closeout policy: ${invalid}`);
  await mkdir(scripts, { recursive: true });
  for (const rule of rules) await writeFile(join(scripts, `${rule.candidate.id}.ts`), rule.bytes);
  await writeFile(options.out, yaml);
  options.print(
    `Wrote ${rules.length} proposed rules to ${options.out} and their probes to ${scripts}/.`,
  );
  return { main, candidates, rules, skipped, out: options.out };
}
