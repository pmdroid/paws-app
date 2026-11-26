import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { git } from "../acp";
import { jsonIn, replyOf } from "./agent";
import type { AgentTurn, Candidate, ProposedEntry, Source } from "./types";

export function probePath(id: string): string {
  return `.agents/probes/${id}.ts`;
}

const entrySchema = z.object({
  exec: z.array(z.string().min(1).max(4096)).min(1).max(32).optional(),
  paths: z.array(z.string().min(1).max(256)).min(1).max(100).optional(),
  failOn: z.enum(["P0", "P1", "P2", "P3"]),
  onFail: z.enum(["fix", "approve"]).optional(),
});

export function writePrompt(input: {
  repository: string;
  candidate: Candidate;
  sources: readonly Source[];
}): string {
  const { candidate } = input;
  const cited = new Set(candidate.sources.map((link) => link.source));
  const material = input.sources
    .filter((source) => cited.has(source.id))
    .map((source) => `## ${source.id} · ${source.title}\n${source.url}\n\n${source.text}`);
  return [
    `Write a Closeout probe for the rule \`${candidate.id}\` in ${input.repository}: ${candidate.summary}`,
    `This worktree is ${input.repository} at origin/main. Write exactly one file, \`${probePath(candidate.id)}\`. Do not change any other file, do not commit, and do not install packages.`,
    [
      "The probe contract:",
      "- It runs as `bun <probe> --base <sha> --head <sha> --repo <checkout>` from a scratch directory outside the checkout, with no network and no secrets. `--repo` is a clean checkout at `--head`.",
      "- It reads the change with git (`git -C <repo> diff --name-only <base> <head>`, `git -C <repo> show <head>:<path>`) and Bun or Node built-ins only.",
      "- It exits 0 when the change keeps the rule and 1 when it breaks it, and prints each place it found on its own line.",
      "- It must not write to the checkout or move HEAD.",
      "- When base and head are the same commit it judges that commit's tree as a whole, so a rule already broken on main is reported.",
    ].join("\n"),
    "When you are done, reply with only the rule's `rules:` entry fields as one JSON object in a ```json block:",
    '{"paths":["src/db/**"],"failOn":"P1","onFail":"fix"}',
    '`paths` lists the globs whose change should run the probe; leave it out to run on every change. `failOn` is the severity of a break (P0 highest). `onFail` is `approve` only for a rule the team sometimes means to break on purpose. Add `exec` only when the probe needs something other than `["bun"]`.',
    "The sources the rule came from:",
    ...material,
  ].join("\n\n");
}

/**
 * One agent session in `worktree` writes the candidate's probe and proposes its `rules:`
 * entry. Returns null with a reason when it wrote no probe. The worktree is reset afterwards.
 */
export async function writeProbe(input: {
  turn: AgentTurn;
  repository: string;
  candidate: Candidate;
  sources: readonly Source[];
  worktree: string;
  /** The origin/main commit the worktree is reset to afterwards. */
  commit: string;
  pawsRoot: string;
  runId: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; bytes: Uint8Array; entry: ProposedEntry } | { ok: false; reason: string }> {
  const path = probePath(input.candidate.id);
  try {
    const { text } = await replyOf(input.turn, {
      role: "implementer",
      repository: input.repository,
      itemId: "probes",
      runId: input.runId,
      prompt: writePrompt(input),
      worktreePath: input.worktree,
      pawsRoot: input.pawsRoot,
      checkpoint: false,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const bytes = await readFile(join(input.worktree, path)).catch(() => null);
    if (!bytes || bytes.length === 0) return { ok: false, reason: `the session wrote no ${path}` };
    const entry = entrySchema.safeParse(jsonIn(text));
    if (!entry.success) return { ok: false, reason: "the session did not propose a rules entry" };
    return { ok: true, bytes: new Uint8Array(bytes), entry: entry.data };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await resetWorktree(input.worktree, input.commit);
  }
}

/** Put the worktree back at `commit` with nothing else in it, so a probe runs on a clean checkout. */
export async function resetWorktree(worktree: string, commit: string): Promise<void> {
  await git(["-C", worktree, "checkout", "-q", "--detach", "--force", commit]);
  await git(["-C", worktree, "reset", "--hard", "-q", commit]);
  await git(["-C", worktree, "clean", "-fdq"]);
}
