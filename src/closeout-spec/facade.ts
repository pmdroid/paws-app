/**
 * In-process Closeout draft 0.1 operations.
 *
 * `validate`, `decision`, `run`, and `addReview` read the policy from
 * `origin/main` (then `~/.agents/closeout.yaml`) through {@link loadPolicy}.
 * `digest` hashes the policy files in the repository directory. The
 * conformance digest fixture appends a newline to a referenced file and
 * requires that hash to change without another commit.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { evaluate, type EvaluateRequest } from "./evaluate/evaluate";
import { PAWS_CLOSEOUT_NAME, PAWS_CLOSEOUT_VERSION, type EvaluateTrust } from "./evaluate/trust";
import { createEvidenceStore } from "./evidence/store";
import { evidenceAttemptKey } from "./retry";
import { approvalsAtHead, publishedAtHead } from "./published";
import {
  loadOriginMainRootFiles,
  loadPolicy,
  loadPolicyFiles,
  treeFiles,
  type PolicyFilesLoad,
  type RootFilesLoad,
} from "./policy/load";
import type { GitBlob, GitReader } from "./policy/git";
import { loadHomePolicy, type TreePolicy } from "./policy/resolve";
import type { RecordedReview, ReviewRunResult } from "./review/reviewer";
import { scrubCommandEnv } from "./run/env";
import {
  changedLines,
  changedPaths as diffPaths,
  resolveCommit,
  type PawsCommandRunner,
} from "./run/exec";
import { withRetryLock } from "./run/lock";
import type { CloseoutProgress } from "./run/progress";
import { runCloseoutCommands } from "./run/run";
import {
  SPEC_VERSION,
  type CandidateIdentity,
  type DecisionDocument,
  type DecisionWarning,
  type Gate,
  type Independence,
  type EvidenceApproval,
  type PublishedEvidence,
  type ResolvedPolicy,
  type ResolvedEvidence,
  type ResolvedPolicyAbsent,
  type ResolvedReview,
  type ReviewRecord,
  type ReviewRequest,
  type ReviewResult,
  type Reviewer,
} from "./types";

const FETCH_TIMEOUT_MS = 120_000;
const REMOTE_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 30_000;

const ABSENT: ResolvedPolicyAbsent = {
  source: "none",
  digest: null,
  entryPath: null,
  setup: [],
  items: [],
  files: [],
};

export type ValidateResult =
  | {
      ok: true;
      specVersion: typeof SPEC_VERSION;
      absent: boolean;
      path: string | null;
      digest: string | null;
      items: string[];
      warnings: DecisionWarning[];
    }
  | { ok: false; message: string };

export type DigestResult = { ok: true; digest: string | null } | { ok: false; message: string };

export type DecisionInput = {
  checkoutExclusions?: readonly string[];
  repo: string;
  base: string;
  head: string;
  gate: Gate;
  task?: string;
  candidate?: CandidateIdentity;
  /** Defaults to `<repo>/.closeout`. */
  evidenceDir?: string;
  /** Home directory for `~/.agents/closeout.yaml` when origin has no entry. */
  home?: string;
  policyRoot?: string;
  retryBaseline?: readonly string[];
  trust?: EvaluateTrust;
  env?: NodeJS.ProcessEnv;
  /** The task's videos and screenshots, for `evidence` requirements. */
  published?: readonly PublishedEvidence[];
  /** Visual reviews of those files, for `approval: human` requirements. */
  approvals?: readonly EvidenceApproval[];
};

export type RunRequest = {
  checkoutExclusions?: readonly string[];
  repo: string;
  base: string;
  head: string;
  gate: Gate;
  task?: string;
  candidate: CandidateIdentity;
  evidenceDir?: string;
  home?: string;
  policyRoot?: string;
  /** `~/.paws` override for the detached worktree. */
  pawsHome?: string;
  retryBaseline?: readonly string[];
  trust?: EvaluateTrust;
  env?: NodeJS.ProcessEnv;
  progress?: CloseoutProgress;
  commandRunner?: Pick<PawsCommandRunner, "runLogged">;
  published?: readonly PublishedEvidence[];
  approvals?: readonly EvidenceApproval[];
};

export type ReviewIntake =
  | Reviewer
  | {
      review(request: ReviewRequest): Promise<ReviewResult | ReviewRunResult>;
    };

export type AddReviewInput = {
  checkoutExclusions?: readonly string[];
  repo: string;
  base: string;
  head: string;
  gate: Gate;
  task?: string;
  /** Qualified id of the review requirement. */
  itemId: string;
  candidate: CandidateIdentity;
  reviewer: ReviewIntake;
  evidenceDir?: string;
  home?: string;
  policyRoot?: string;
  retryBaseline?: readonly string[];
  trust?: EvaluateTrust;
  env?: NodeJS.ProcessEnv;
};

export type AddReviewResult = { ok: true; record: ReviewRecord } | { ok: false; message: string };

const gitReader: GitReader = {
  fetchOriginMain(repo) {
    const fetched = gitSync(
      repo,
      ["fetch", "--no-tags", "origin", "refs/heads/main"],
      FETCH_TIMEOUT_MS,
    );
    if (!fetched.ok) return { ok: false, stderr: fetched.stderr };
    const head = gitSync(
      repo,
      ["rev-parse", "--verify", "--end-of-options", "FETCH_HEAD^{commit}"],
      GIT_TIMEOUT_MS,
    );
    if (!head.ok) return { ok: false, stderr: head.stderr };
    const commit = head.stdout.toString("utf8").trim().toLowerCase();
    return { ok: true, commit };
  },
  lsRemoteOriginMain(repo) {
    const listed = gitSync(
      repo,
      ["ls-remote", "--exit-code", "origin", "refs/heads/main"],
      REMOTE_TIMEOUT_MS,
    );
    if (!listed.ok) return { ok: false, stderr: listed.stderr };
    return { ok: true, stdout: listed.stdout.toString("utf8") };
  },
  listBlobs(repo, commit, prefix) {
    const listed = gitSync(
      repo,
      ["-c", "core.quotepath=false", "ls-tree", "-r", "-z", commit, "--", prefix],
      GIT_TIMEOUT_MS,
    );
    if (!listed.ok) return { ok: false, stderr: listed.stderr };
    const blobs = parseLsTree(listed.stdout);
    if (blobs === undefined) return { ok: false, stderr: "could not read the policy file" };
    return { ok: true, blobs };
  },
  readBlob(repo, object) {
    const read = gitSync(repo, ["cat-file", "blob", object], GIT_TIMEOUT_MS);
    if (!read.ok) return { ok: false, stderr: read.stderr };
    return { ok: true, bytes: new Uint8Array(read.stdout) };
  },
};

export function trustedPolicyFiles(
  repo: string,
  home?: string,
  policyRoot?: string,
): PolicyFilesLoad {
  return loadPolicyFiles({
    repo,
    git: gitReader,
    ...(home !== undefined ? { home } : {}),
    ...(policyRoot !== undefined ? { policyRoot } : {}),
  });
}

/**
 * Read the named repository-root files from `origin/main` on the trusted path
 * that serves `.agents/closeout.yaml`. The work tree is never read.
 */
export function trustedRootFiles(repo: string, names: readonly string[]): RootFilesLoad {
  return loadOriginMainRootFiles({ repo, git: gitReader }, names);
}

export function workspacePolicyFiles(root: string): PolicyFilesLoad {
  return treeFiles(root);
}

/** Load `.agents/closeout.yaml` from `origin/main`, or the home file when that commit has none. */
export function validate(repo: string, home?: string, policyRoot?: string): ValidateResult {
  const loaded = loadOrigin(repo, home, policyRoot);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  return presentValidate(loaded.policy, loaded.warnings);
}

export function reviewRequirements(
  repo: string,
  home?: string,
  policyRoot?: string,
):
  | {
      ok: true;
      items: Array<{ id: string; gate: Gate; independence: Independence; parallel: boolean }>;
    }
  | { ok: false; message: string } {
  const loaded = loadOrigin(repo, home, policyRoot);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  return {
    ok: true,
    items: loaded.policy.items
      .filter((item): item is ResolvedReview => item.kind === "review")
      .map(({ id, gate, independence, parallel }) => ({
        id,
        gate,
        independence,
        parallel: parallel === true,
      })),
  };
}

/** Evidence requirements with `approval: human`, from the same trusted policy as Closeout. */
export function visualReviewRequirements(
  repo: string,
  home?: string,
  policyRoot?: string,
): { ok: true; items: ResolvedEvidence[] } | { ok: false; message: string } {
  const loaded = loadOrigin(repo, home, policyRoot);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  return {
    ok: true,
    items: loaded.policy.items.filter(
      (item): item is ResolvedEvidence =>
        item.kind === "evidence" && (item as ResolvedEvidence).approval === "human",
    ),
  };
}

export function policyFixBudget(repo: string, home?: string, policyRoot?: string): number | null {
  const loaded = loadOrigin(repo, home, policyRoot);
  if (!loaded.ok) return null;
  const policy = loaded.policy;
  if (policy.source === "none" || policy.retry === undefined) return null;
  const retry = policy.retry;
  const failedBudget =
    policy.setup.length * retry.maxFailedAttemptsPerItem +
    policy.items.reduce(
      (total, item) =>
        total +
        (item.kind === "review"
          ? (retry.maxFailedReviewAttempts ?? retry.maxFailedAttemptsPerItem)
          : retry.maxFailedAttemptsPerItem),
      0,
    );
  return Math.max(retry.maxFailedAttemptsPerItem, failedBudget) - 1;
}

export async function retryBaseline(evidenceDir: string): Promise<string[]> {
  const snapshot = await createEvidenceStore({ root: evidenceDir }).load();
  if (snapshot.invalid) throw new Error(snapshot.invalid.message);
  return snapshot.records.map(evidenceAttemptKey);
}

/**
 * SHA-256 identity of the policy files currently in the repository directory.
 * A newline added to a referenced skill file changes this digest.
 */
export function digest(repo: string): DigestResult {
  const loaded = loadTree(repo);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  return { ok: true, digest: loaded.policy.digest };
}

/** Judge the evidence already stored for this candidate. Does not run commands. */
export async function decision(input: DecisionInput): Promise<DecisionDocument> {
  const loaded = loadOrigin(input.repo, input.home, input.policyRoot, input.checkoutExclusions);
  const candidate = input.candidate ?? blankCandidate();
  if (!loaded.ok) {
    return evaluate(
      ABSENT,
      [],
      requestOf(input, candidate, { policyLoadError: loaded.message }),
      input.trust,
    );
  }
  return judge(input, loaded.policy, candidate);
}

/**
 * Load the origin policy, run in-scope setup steps and commands, then evaluate.
 * Review requirements stay missing until {@link addReview}.
 */
export async function run(input: RunRequest): Promise<DecisionDocument> {
  const loaded = loadOrigin(input.repo, input.home, input.policyRoot, input.checkoutExclusions);
  const candidate = withTask(input.candidate, input.task);
  if (!loaded.ok) {
    return evaluate(
      ABSENT,
      [],
      requestOf(input, candidate, { policyLoadError: loaded.message }),
      input.trust,
    );
  }
  const env = scrubCommandEnv(input.env);
  const resolved = await resolvePair(input.repo, input.base, input.head, env);
  if (!resolved.ok) {
    return evaluate(
      loaded.policy,
      [],
      requestOf(input, candidate, {
        base: resolved.base,
        head: resolved.head,
        evidenceError: resolved.message,
      }),
      input.trust,
    );
  }
  const evidenceDir = input.evidenceDir ?? join(input.repo, ".closeout");
  const evidence = createEvidenceStore({ root: evidenceDir });
  const ran = await runCloseoutCommands({
    checkoutExclusions: input.checkoutExclusions,
    repo: input.repo,
    policy: loaded.policy,
    base: resolved.base,
    head: resolved.head,
    candidate,
    evidence,
    evidenceDir,
    gate: input.gate,
    ...(input.pawsHome !== undefined ? { home: input.pawsHome } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.progress !== undefined ? { progress: input.progress } : {}),
    ...(input.commandRunner ? { commandRunner: input.commandRunner } : {}),
    ...(input.retryBaseline !== undefined ? { retryBaseline: input.retryBaseline } : {}),
  });
  if (ran.blocked !== undefined) {
    return evaluate(
      loaded.policy,
      [],
      requestOf(input, candidate, {
        base: resolved.base,
        head: resolved.head,
        evidenceError: ran.blocked,
      }),
      input.trust,
    );
  }
  return finish(input, loaded.policy, candidate, resolved.base, resolved.head, evidenceDir);
}

/** Run the reviewer and store the next review record. Does not decide acceptance. */
export async function addReview(input: AddReviewInput): Promise<AddReviewResult> {
  const loaded = loadOrigin(input.repo, input.home, input.policyRoot, input.checkoutExclusions);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  if (loaded.policy.source === "none" || loaded.policy.digest === null) {
    return { ok: false, message: "no closeout policy" };
  }
  const policy = loaded.policy;
  const item = policy.items.find((entry) => isReview(entry, input.itemId, input.gate));
  if (item === undefined) {
    return { ok: false, message: `no review requirement ${input.itemId} at ${input.gate}` };
  }
  const candidate = withTask(input.candidate, input.task);
  const env = scrubCommandEnv(input.env);
  const resolved = await resolvePair(input.repo, input.base, input.head, env);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  const evidenceDir = input.evidenceDir ?? join(input.repo, ".closeout");
  const preflight = await finish(
    input,
    policy,
    candidate,
    resolved.base,
    resolved.head,
    evidenceDir,
  );
  const blocked = preflight.items.find((entry) => entry.id === input.itemId);
  if (blocked?.state === "exhausted" || blocked?.state === "invalid" || preflight.message) {
    return { ok: false, message: blocked?.message ?? preflight.message ?? "review is blocked" };
  }
  const reviewed = await input.reviewer.review({
    checkoutExclusions: input.checkoutExclusions,
    item,
    candidate,
    base: resolved.base,
    head: resolved.head,
    policyDigest: policy.digest,
    skillFiles: policy.skillFiles,
    worktree: input.repo,
  });
  if (isInvalid(reviewed)) return { ok: false, message: reviewed.reason };

  return withRetryLock(evidenceDir, policy.retry !== undefined, async () => {
    const current = await finish(
      input,
      policy,
      candidate,
      resolved.base,
      resolved.head,
      evidenceDir,
    );
    const row = current.items.find((entry) => entry.id === input.itemId);
    if (row?.state === "exhausted" || row?.state === "invalid" || current.message) {
      return { ok: false, message: row?.message ?? current.message ?? "review is blocked" };
    }
    const evidence = createEvidenceStore({ root: evidenceDir });
    const attempt = await evidence.nextAttempt({
      policyDigest: policy.digest,
      head: resolved.head,
      itemId: input.itemId,
    });
    const record = toReviewRecord(
      input,
      item.id,
      resolved.base,
      resolved.head,
      policy.digest,
      attempt,
      reviewed,
    );
    try {
      await evidence.add(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message };
    }
    const stored = await evidence.load();
    const written = stored.records.find(
      (entry) =>
        entry.recordType === "review" &&
        entry.itemId === record.itemId &&
        entry.attempt === attempt &&
        entry.head === record.head,
    );
    if (written === undefined || written.recordType !== "review") {
      return {
        ok: false,
        message: stored.invalid?.message ?? "could not read the evidence directory",
      };
    }
    return { ok: true, record: written };
  });
}

function presentValidate(policy: ResolvedPolicy, warnings: DecisionWarning[]): ValidateResult {
  return {
    ok: true,
    specVersion: SPEC_VERSION,
    absent: policy.source === "none",
    path: policy.entryPath,
    digest: policy.digest,
    items: policy.items.map((item) => item.id),
    warnings,
  };
}

async function judge(
  input: DecisionInput,
  policy: ResolvedPolicy,
  candidate: CandidateIdentity,
): Promise<DecisionDocument> {
  const env = scrubCommandEnv(input.env);
  const resolved = await resolvePair(input.repo, input.base, input.head, env);
  if (!resolved.ok) {
    return evaluate(
      policy,
      [],
      requestOf(input, candidate, {
        base: resolved.base,
        head: resolved.head,
        evidenceError: resolved.message,
      }),
      input.trust,
    );
  }
  return finish(
    input,
    policy,
    candidate,
    resolved.base,
    resolved.head,
    input.evidenceDir ?? join(input.repo, ".closeout"),
  );
}

async function finish(
  input: DecisionInput,
  policy: ResolvedPolicy,
  candidate: CandidateIdentity,
  base: string,
  head: string,
  evidenceDir: string,
): Promise<DecisionDocument> {
  const evidence = createEvidenceStore({ root: evidenceDir });
  const snapshot = await evidence.load();
  if (snapshot.invalid !== undefined) {
    return evaluate(
      policy,
      [],
      requestOf(input, candidate, { base, head, evidenceError: snapshot.invalid.message }),
      input.trust,
    );
  }
  const paths = await readChangedPaths(input.repo, policy, input.gate, base, head, input.env);
  if (!paths.ok) {
    return evaluate(
      policy,
      [],
      requestOf(input, candidate, { base, head, evidenceError: paths.message }),
      input.trust,
    );
  }
  const lines = policy.items.some((item) => item.gate === input.gate && "minChangedLines" in item)
    ? await changedLines(input.repo, base, head, scrubCommandEnv(input.env))
    : undefined;
  const published =
    input.published === undefined
      ? undefined
      : await publishedAtHead(
          input.repo,
          head,
          input.published,
          policy.items,
          scrubCommandEnv(input.env),
          base,
        );
  const approvals =
    input.approvals === undefined
      ? undefined
      : await approvalsAtHead(
          input.repo,
          head,
          input.approvals,
          policy.items,
          scrubCommandEnv(input.env),
          base,
        );
  return evaluate(
    policy,
    snapshot.records,
    requestOf(input, candidate, {
      base,
      head,
      ...(paths.paths !== undefined ? { changedPaths: paths.paths } : {}),
      ...(lines !== undefined ? { changedLines: lines } : {}),
      ...(published !== undefined ? { published } : {}),
      ...(approvals !== undefined ? { approvals } : {}),
    }),
    input.trust,
  );
}

function requestOf(
  input: {
    base: string;
    head: string;
    gate: Gate;
    task?: string;
    retryBaseline?: readonly string[];
  },
  candidate: CandidateIdentity,
  extra: Partial<EvaluateRequest> & { base?: string; head?: string },
): EvaluateRequest {
  const request: EvaluateRequest = {
    base: extra.base ?? input.base,
    head: extra.head ?? input.head,
    gate: input.gate,
    candidate,
  };
  if (input.task !== undefined) request.task = input.task;
  if (input.retryBaseline !== undefined) request.retryBaseline = input.retryBaseline;
  if (extra.changedPaths !== undefined) request.changedPaths = extra.changedPaths;
  if (extra.changedLines !== undefined) request.changedLines = extra.changedLines;
  if (extra.evidenceError !== undefined) request.evidenceError = extra.evidenceError;
  if (extra.policyLoadError !== undefined) request.policyLoadError = extra.policyLoadError;
  if (extra.published !== undefined) request.published = extra.published;
  if (extra.approvals !== undefined) request.approvals = extra.approvals;
  return request;
}

async function readChangedPaths(
  repo: string,
  policy: ResolvedPolicy,
  gate: Gate,
  base: string,
  head: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ ok: true; paths?: string[] } | { ok: false; message: string }> {
  if (!needsPaths(policy, gate)) return { ok: true };
  const diff = await diffPaths(repo, base, head, scrubCommandEnv(env));
  if (!diff.ok) return diff;
  return { ok: true, paths: diff.paths };
}

function needsPaths(policy: ResolvedPolicy, gate: Gate): boolean {
  const has = (paths: string[] | undefined) => paths !== undefined && paths.length > 0;
  return (
    policy.setup.some((step) => step.gate === gate && has(step.paths)) ||
    policy.items.some((item) => item.gate === gate && has(item.paths))
  );
}

async function resolvePair(
  repo: string,
  baseRev: string,
  headRev: string,
  env: Record<string, string>,
): Promise<
  | { ok: true; base: string; head: string }
  | { ok: false; base: string; head: string; message: string }
> {
  const base = await resolveCommit(repo, baseRev, env);
  const head = await resolveCommit(repo, headRev, env);
  if (base === null || head === null) {
    return {
      ok: false,
      base: base ?? "",
      head: head ?? "",
      message: "base or head does not resolve to a commit",
    };
  }
  return { ok: true, base, head };
}

function loadOrigin(
  repo: string,
  home: string | undefined,
  policyRoot?: string,
  checkoutExclusions: readonly string[] = [],
): ReturnType<typeof loadPolicy> {
  const loaded = loadPolicy({
    repo,
    git: gitReader,
    ...(home !== undefined ? { home } : {}),
    ...(policyRoot !== undefined ? { policyRoot } : {}),
  });
  if (loaded.ok && loaded.policy.source !== "none" && checkoutExclusions.length) {
    loaded.policy = {
      ...loaded.policy,
      digest: `sha256:${createHash("sha256")
        .update(
          JSON.stringify({
            policy: loaded.policy.digest,
            checkoutExclusions: [...new Set(checkoutExclusions)].sort(),
          }),
        )
        .digest("hex")}`,
    };
  }
  return loaded;
}

function loadTree(repo: string): ReturnType<typeof loadPolicy> {
  if (!isDirectory(repo))
    return { ok: false, source: "repo", message: "policy root is not a directory" };
  const loaded = loadHomePolicy(repo);
  if (!loaded.ok) return { ok: false, source: "repo", message: loaded.message };
  if (loaded.absent) return { ok: true, policy: ABSENT, warnings: [] };
  return { ok: true, policy: treePresent(loaded.policy), warnings: [] };
}

function treePresent(policy: TreePolicy): ResolvedPolicy {
  const resolved: ResolvedPolicy = {
    source: "repo",
    digest: policy.digest,
    entryPath: policy.entryPath,
    setup: policy.setup,
    items: policy.items,
    files: policy.files,
  };
  if (policy.retry !== undefined) resolved.retry = policy.retry;
  return resolved;
}

function toReviewRecord(
  input: AddReviewInput,
  itemId: string,
  base: string,
  head: string,
  policyDigest: string,
  attempt: number,
  reviewed: ReviewResult | RecordedReview,
): ReviewRecord {
  const recorded = isRecorded(reviewed) ? reviewed : undefined;
  const task = input.task ?? input.candidate.task;
  return {
    specVersion: SPEC_VERSION,
    recordType: "review",
    ...(task !== undefined && task.length > 0 ? { task } : {}),
    itemId,
    base,
    head,
    policyDigest,
    attempt,
    evaluator: recorded?.record.evaluator ?? {
      name: PAWS_CLOSEOUT_NAME,
      version: PAWS_CLOSEOUT_VERSION,
    },
    producer: reviewed.producer,
    findings: reviewed.findings,
    artifacts: reviewed.artifacts,
  };
}

function isReview(
  item: ResolvedPolicy["items"][number],
  id: string,
  gate: Gate,
): item is ResolvedReview {
  return item.id === id && item.gate === gate && item.kind === "review" && !("supported" in item);
}

function isRecorded(result: ReviewResult | ReviewRunResult): result is RecordedReview {
  return "status" in result && result.status === "recorded";
}

function isInvalid(
  result: ReviewResult | ReviewRunResult,
): result is Extract<ReviewRunResult, { status: "invalid" }> {
  return "status" in result && result.status === "invalid";
}

function withTask(candidate: CandidateIdentity, task: string | undefined): CandidateIdentity {
  if (task === undefined) return candidate;
  return { ...candidate, task };
}

function blankCandidate(): CandidateIdentity {
  return { session: "", model: "", provider: "" };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory() && !lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function gitSync(
  repo: string,
  args: string[],
  timeout: number,
): { ok: true; stdout: Buffer } | { ok: false; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: repo,
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) {
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    return { ok: false, stderr: message };
  }
  const stderr = result.stderr?.toString("utf8") ?? "";
  if (result.status !== 0) return { ok: false, stderr };
  return { ok: true, stdout: result.stdout ?? Buffer.alloc(0) };
}

function parseLsTree(bytes: Buffer): GitBlob[] | undefined {
  const blobs: GitBlob[] = [];
  for (const record of splitNul(bytes)) {
    const tab = record.indexOf(0x09);
    if (tab < 0) return undefined;
    const meta = utf8(record.subarray(0, tab));
    const path = utf8(record.subarray(tab + 1));
    if (meta === undefined || path === undefined || path.length === 0) return undefined;
    const [mode, kind, object] = meta.split(" ");
    if (kind !== "blob" || mode === undefined || object === undefined || !isBlobSha(object)) {
      return undefined;
    }
    blobs.push({ mode, object: object.toLowerCase(), path });
  }
  return blobs;
}

function splitNul(bytes: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index > start) parts.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start < bytes.length) parts.push(bytes.subarray(start));
  return parts;
}

function utf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function isBlobSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}
