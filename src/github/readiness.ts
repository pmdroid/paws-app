import { journalCaught } from "../journal";
import { z } from "zod";
import {
  acquireOperationToken,
  type GitHubCredentialInput,
  type GitHubTokenProvider,
} from "./auth";
import { repoApiPath } from "./client";
import type { CiCheck, CiCheckState, GitHubClient } from "./types";

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });

type PageInfo = z.infer<typeof pageInfoSchema>;

const contextsSchema = z.object({
  pageInfo: pageInfoSchema,
  nodes: z.array(
    z
      .object({
        name: z.string().optional(),
        conclusion: z.string().nullable().optional(),
        detailsUrl: z.string().nullable().optional(),
        startedAt: z.string().nullable().optional(),
        completedAt: z.string().nullable().optional(),
        databaseId: z.number().nullable().optional(),
        summary: z.string().nullable().optional(),
        checkSuite: z
          .object({ app: z.object({ slug: z.string() }).nullable().optional() })
          .nullable()
          .optional(),
        context: z.string().optional(),
        state: z.string().optional(),
        targetUrl: z.string().nullable().optional(),
        createdAt: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
      })
      .nullable(),
  ),
});

const rollupSchema = z.object({ contexts: contextsSchema.optional() }).nullable();

const responseSchema = z.object({
  errors: z.array(z.unknown()).optional(),
  data: z.object({
    repository: z.object({
      object: z.object({
        oid: z.string(),
        statusCheckRollup: rollupSchema,
      }),
      pullRequest: z.object({
        headRefOid: z.string(),
        state: z.enum(["OPEN", "CLOSED", "MERGED"]),
        baseRefName: z.string(),
        baseRef: z
          .object({
            target: z.object({
              oid: z.string().optional(),
              statusCheckRollup: rollupSchema.optional(),
            }),
          })
          .nullable(),
        reviewThreads: z
          .object({
            nodes: z.array(z.object({ isResolved: z.boolean() })),
            pageInfo: pageInfoSchema,
          })
          .optional(),
      }),
    }),
  }),
});

const query = `query MergeReadiness($owner: String!, $repo: String!, $number: Int!, $head: GitObjectID!, $checksCursor: String, $baseChecksCursor: String, $threadsCursor: String, $readChecks: Boolean!, $readBaseChecks: Boolean!, $readThreads: Boolean!) {
  repository(owner: $owner, name: $repo) {
    object(oid: $head) {
      ... on Commit {
        oid
        statusCheckRollup {
          state
          contexts(first: 100, after: $checksCursor) @include(if: $readChecks) { ...Contexts }
        }
      }
    }
    pullRequest(number: $number) {
      headRefOid
      state
      baseRefName
      baseRef {
        target {
          ... on Commit {
            oid
            statusCheckRollup {
              state
              contexts(first: 100, after: $baseChecksCursor) @include(if: $readBaseChecks) { ...Contexts }
            }
          }
        }
      }
      reviewThreads(first: 100, after: $threadsCursor) @include(if: $readThreads) {
        nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}

fragment Contexts on StatusCheckRollupContextConnection {
  pageInfo { hasNextPage endCursor }
  nodes {
    ... on CheckRun { name conclusion detailsUrl startedAt completedAt databaseId summary checkSuite { app { slug } } }
    ... on StatusContext { context state targetUrl createdAt description }
  }
}`;

export type FailedCheck = {
  name: string;
  url: string | null;
  logTail?: string | null;
  /** The check with this name also failed on the base branch's head. */
  failsOnBase?: boolean;
};

export type Readiness = {
  outcome: "ready" | "pending" | "blocked" | "sha_moved" | "ci_failed";
  message: string;
  failedChecks?: FailedCheck[];
  waitingChecks?: { name: string; url: string | null }[];
  /** Every check on the head, set when CI failed. */
  checks?: CiCheck[];
  onlyCancelled?: true;
  /** Set when CI is green and only unresolved review threads hold the merge. */
  unresolvedThreads?: number;
  /** Every check on the head with its conclusion, set when CI is green. */
  passed?: PassedCheck[];
};

/** A check that reported green on the head. `conclusion` is GitHub's, such as `SUCCESS`. */
export type PassedCheck = { name: string; conclusion: string; url: string | null };

/** Conclusions and states that fail the pull request. Anything else that is not green waits. */
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"]);
const GREEN = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

type Check = {
  name: string;
  result: string | null;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The Actions job id, when GitHub Actions ran the check. */
  actionsJob: number | null;
  summary: string | null;
  /**
   * A plain commit status or a check run from an app other than GitHub Actions. It holds the
   * merge only when branch protection requires it. A check run whose app is hidden is not.
   */
  thirdParty: boolean;
};

/** Lines and characters of a failing check's log that Paws keeps and hands to the agent. */
export const LOG_TAIL_LINES = 60;
export const LOG_TAIL_CHARS = 6000;

type ReadinessInput = {
  client: GitHubClient;
  token: () => Promise<string>;
  owner: string;
  repo: string;
  prNumber: number;
  head: string;
  /** Paws publication time for the exact requested head, in milliseconds. */
  publishedAt?: (head: string) => number | null;
  sleep?: (ms: number) => Promise<void>;
  isCancelled?: () => boolean;
  onWait?: (message: string) => Promise<void>;
  releaseWhilePending?: boolean;
};

export async function waitForMergeReadiness(input: ReadinessInput): Promise<Readiness> {
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let previous = "";
  let failedReads = 0;
  for (let attempt = 0; attempt < 270; attempt++) {
    if (input.isCancelled?.()) return { outcome: "blocked", message: "merge cancelled" };
    const result = await readMergeReadiness(input);
    if (
      result.outcome === "blocked" &&
      result.message.startsWith("could not read") &&
      ++failedReads < 3
    ) {
      await sleep(10_000);
      continue;
    }
    if (result.outcome !== "pending") return result;
    if (result.message !== previous) {
      await input.onWait?.(result.message);
      previous = result.message;
    }
    if (input.releaseWhilePending) return result;
    if (attempt < 269) await sleep(10_000);
  }
  return { outcome: "blocked", message: `merge timed out waiting for GitHub: ${previous}` };
}

/**
 * Read the checks and review threads once. Green means every expected check
 * (required on the base branch, or reported on the base branch's head) has
 * reported on `head`, and every reported check finished with SUCCESS.
 */
export async function readMergeReadiness(input: ReadinessInput): Promise<Readiness> {
  try {
    const token = await input.token();
    const allChecks: Check[] = [];
    const baseChecks: Check[] = [];
    let baseBranch = "";
    let unresolved = 0;
    const cursors = {
      checks: null as string | null,
      base: null as string | null,
      threads: null as string | null,
    };
    const more = { checks: true, base: true, threads: true };
    const seen = new Set<string>();
    const advance = (key: keyof typeof more, info: PageInfo): boolean => {
      more[key] = info.hasNextPage;
      if (!info.hasNextPage) return true;
      if (!info.endCursor || seen.has(`${key}:${info.endCursor}`)) return false;
      seen.add(`${key}:${info.endCursor}`);
      cursors[key] = info.endCursor;
      return true;
    };
    while (more.checks || more.base || more.threads) {
      const response = await input.client.request({
        method: "POST",
        path: "/graphql",
        token,
        body: {
          query,
          variables: {
            owner: input.owner,
            repo: input.repo,
            number: input.prNumber,
            head: input.head,
            checksCursor: cursors.checks,
            baseChecksCursor: cursors.base,
            threadsCursor: cursors.threads,
            readChecks: more.checks,
            readBaseChecks: more.base,
            readThreads: more.threads,
          },
        },
      });
      const parsed = responseSchema.safeParse(response.body);
      const errors = parsed.success
        ? parsed.data.errors?.filter((error) => !appHiddenByAllowList(error))
        : [];
      if (response.status !== 200 || !parsed.success || errors?.length) {
        console.error(
          `GitHub readiness read failed: status ${response.status}${
            parsed.success && errors?.length
              ? `, ${JSON.stringify(errors).slice(0, 500)}`
              : parsed.success
                ? ""
                : ", unexpected response shape"
          }`,
        );
        return unreadable();
      }
      const { object: commit, pullRequest: pull } = parsed.data.data.repository;
      if (commit.oid !== input.head || pull.headRefOid !== input.head) {
        return { outcome: "sha_moved", message: "pull request head changed before merge" };
      }
      if (pull.state !== "OPEN") {
        return { outcome: "blocked", message: "pull request is no longer open" };
      }
      if (pull.baseRef === null) {
        return { outcome: "blocked", message: "pull request base branch no longer exists" };
      }
      baseBranch = pull.baseRefName;
      const rollups = {
        checks: commit.statusCheckRollup,
        base: pull.baseRef.target.statusCheckRollup ?? null,
      };
      for (const key of ["checks", "base"] as const) {
        if (!more[key]) continue;
        const rollup = rollups[key];
        if (rollup === null) {
          // A commit without a rollup has no checks yet.
          more[key] = false;
          continue;
        }
        if (!rollup.contexts) return unreadable();
        (key === "checks" ? allChecks : baseChecks).push(...toChecks(rollup.contexts.nodes));
        if (!advance(key, rollup.contexts.pageInfo)) return unreadable();
      }
      if (more.threads) {
        if (!pull.reviewThreads) return unreadable();
        unresolved += pull.reviewThreads.nodes.filter((thread) => !thread.isResolved).length;
        if (!advance("threads", pull.reviewThreads.pageInfo)) return unreadable();
      }
    }
    const required = await readRequiredChecks(input, token, baseBranch);
    if (required === null) return unreadable();
    const checks = latestPerName(allChecks, (check) => check);
    const ci = judgeChecks(
      checks,
      latestPerName(baseChecks, (check) => check),
      required,
      baseBranch,
      input.publishedAt?.(input.head) ?? null,
    );
    if (ci.outcome === "ci_failed") return await withLogTails(input, token, ci, checks);
    if (ci.outcome !== "ready") return ci;
    const passed = checks.map((check) => ({
      name: check.name,
      conclusion: check.result ?? "",
      url: check.url,
    }));
    return unresolved > 0
      ? {
          outcome: "pending",
          message: `Waiting for ${unresolved} unresolved review thread(s).`,
          unresolvedThreads: unresolved,
          passed,
        }
      : {
          outcome: "ready",
          message:
            checks.length === 0
              ? ci.message
              : `CI passed and all review threads are resolved.${skippedNote(checks)}${optionalNote(checks, required)}`,
          passed,
        };
  } catch (error) {
    journalCaught(error, "readiness.readMergeReadiness.token", null);
    if (error instanceof Error && LINEAR_WAIT.test(error.message))
      return {
        outcome: "pending",
        message: "Waiting for Linear's rate limit to reset before reading GitHub.",
      };

    return unreadable();
  }
}

const LINEAR_WAIT = /Linear GraphQL: RATELIMITED|Linear publication freshness is pending/;

function unreadable(): Readiness {
  return { outcome: "blocked", message: "could not read GitHub CI and review threads" };
}

function appHiddenByAllowList(error: unknown): boolean {
  const parsed = z
    .object({
      path: z.array(z.union([z.string(), z.number()])),
      extensions: z.object({ ip_allow_list_failure: z.literal(true) }),
    })
    .safeParse(error);
  return parsed.success && parsed.data.path.slice(-2).join(".") === "checkSuite.app";
}

function toChecks(nodes: z.infer<typeof contextsSchema>["nodes"]): Check[] {
  return nodes.flatMap((node) => {
    const name = node?.name ?? node?.context;
    if (!node || !name) return [];
    return [
      {
        name,
        result: node.conclusion ?? node.state ?? null,
        url: node.detailsUrl ?? node.targetUrl ?? null,
        startedAt: node.startedAt ?? node.createdAt ?? null,
        completedAt: node.completedAt ?? null,
        actionsJob:
          node.checkSuite?.app?.slug === "github-actions" && typeof node.databaseId === "number"
            ? node.databaseId
            : null,
        summary: node.summary ?? node.description ?? null,
        thirdParty:
          node.context !== undefined ||
          (typeof node.checkSuite?.app?.slug === "string" &&
            node.checkSuite.app.slug !== "github-actions"),
      },
    ];
  });
}

export function latestPerName<T extends { name: string }>(
  runs: T[],
  times: (run: T) => { startedAt: string | null; completedAt: string | null },
): T[] {
  const latest = new Map<string, T>();
  for (const run of runs) {
    const kept = latest.get(run.name);
    if (kept === undefined || !startedLater(times(kept), times(run))) latest.set(run.name, run);
  }
  return [...latest.values()];
}

function startedLater(
  a: { startedAt: string | null; completedAt: string | null },
  b: { startedAt: string | null; completedAt: string | null },
): boolean {
  for (const key of ["startedAt", "completedAt"] as const) {
    const [left, right] = [Date.parse(a[key] ?? ""), Date.parse(b[key] ?? "")];
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left > right;
  }
  return false;
}

function judgeChecks(
  all: Check[],
  baseChecks: Check[],
  required: Set<string>,
  baseBranch: string,
  pushedAt: number | null,
): Readiness {
  const checks = all.filter((check) => !optional(check, required, all));
  const failed = checks.filter((check) => FAILED.has(check.result ?? ""));
  if (failed.length > 0) {
    const reported = new Set(all.map((check) => check.name));
    const waitingChecks = [
      ...checks
        .filter((c) => !GREEN.has(c.result ?? "") && !FAILED.has(c.result ?? ""))
        .map(({ name, url }) => ({ name, url })),
      ...[...required].filter((name) => !reported.has(name)).map((name) => ({ name, url: null })),
    ];
    const failedOnBase = new Set(
      baseChecks.filter((check) => FAILED.has(check.result ?? "")).map((check) => check.name),
    );
    return {
      outcome: "ci_failed",
      message: waitingChecks.length
        ? `CI failed: ${failed.map((c) => c.name).join(", ")}; waiting for ${waitingChecks.map((c) => c.name).join(", ")} to finish (up to 20 min)`
        : "CI failed on the candidate commit",
      ...(waitingChecks.length ? { waitingChecks } : {}),
      failedChecks: failed.map((check) => ({
        name: check.name,
        url: check.url,
        failsOnBase: failedOnBase.has(check.name),
      })),
      ...(onlyCancelled(failed) ? { onlyCancelled: true as const } : {}),
    };
  }
  if (checks.length === 0 && required.size === 0) {
    const pushed = pushedAt ?? Number.NaN;
    if (
      all.length === 0 &&
      baseChecks.length === 0 &&
      Number.isFinite(pushed) &&
      Date.now() - pushed >= 5 * 60_000
    ) {
      return {
        outcome: "ready",
        message: `No CI on this repository: no checks on the candidate or on ${baseBranch}, and none required.`,
      };
    }
    return { outcome: "pending", message: "Waiting for CI on the candidate commit." };
  }
  const reported = new Set(all.map((check) => check.name));
  const waiting = new Set([...required].filter((name) => !reported.has(name)));
  for (const check of checks) if (!GREEN.has(check.result ?? "")) waiting.add(check.name);
  const notes = `${skippedNote(all)}${optionalNote(all, required)}`;
  if (waiting.size > 0) {
    return {
      outcome: "pending",
      message: `Waiting for checks: ${[...waiting].sort().join(", ")}.${notes}`,
    };
  }
  return { outcome: "ready", message: `CI passed.${notes}` };
}

/**
 * A third-party check that branch protection does not require. When nothing else is CI
 * (no Actions check and nothing required), every check keeps holding the merge.
 */
function optional(check: Check, required: Set<string>, checks: Check[]): boolean {
  if (!check.thirdParty || required.has(check.name)) return false;
  return required.size > 0 || checks.some((other) => !other.thirdParty);
}

/** Names the optional third-party checks that are not green, such as a preview deploy that hangs. */
function optionalNote(checks: Check[], required: Set<string>): string {
  const notGreen = checks.filter(
    (check) => optional(check, required, checks) && !GREEN.has(check.result ?? ""),
  );
  const failed = notGreen.filter((check) => FAILED.has(check.result ?? "")).map((c) => c.name);
  const running = notGreen.filter((check) => !FAILED.has(check.result ?? "")).map((c) => c.name);
  const list = (names: string[]) => names.sort().join(", ");
  return [
    failed.length > 0
      ? ` ${list(failed)} failed and ${failed.length === 1 ? "isn't" : "aren't"} required.`
      : "",
    running.length > 0
      ? ` ${list(running)} ${running.length === 1 ? "is" : "are"} still running and ${running.length === 1 ? "isn't" : "aren't"} required.`
      : "",
  ].join("");
}

const CANCELLED = new Set(["CANCELLED", "TIMED_OUT"]);

function onlyCancelled(failed: Check[]): boolean {
  const cancelled = failed.filter((check) => CANCELLED.has(check.result ?? ""));
  return (
    cancelled.length > 0 &&
    failed.every(
      (check) =>
        CANCELLED.has(check.result ?? "") ||
        cancelled.some((cause) => ranAfterInSameRun(check, cause)),
    )
  );
}

function ranAfterInSameRun(check: Check, cause: Check): boolean {
  const run = workflowRun(cause.url);
  return (
    run !== null &&
    run === workflowRun(check.url) &&
    Date.parse(check.startedAt ?? "") >= Date.parse(cause.completedAt ?? "")
  );
}

function workflowRun(url: string | null): string | null {
  return /\/actions\/runs\/(\d+)(?:\/|$)/.exec(url ?? "")?.[1] ?? null;
}

function skippedNote(checks: Check[]): string {
  const skipped = checks.filter((check) => check.result === "SKIPPED").length;
  if (skipped === 0) return "";
  return ` ${skipped} skipped ${skipped === 1 ? "check counts" : "checks count"} as passed.`;
}

function ciState(result: string | null): CiCheckState {
  if (result === "SUCCESS") return "passed";
  if (FAILED.has(result ?? "")) return "failed";
  if (result === "SKIPPED" || result === "NEUTRAL") return "skipped";
  return "running";
}

/** Every check on the head, with the log tail of each failing one. A log that can't be read is left out. */
async function withLogTails(
  input: ReadinessInput,
  token: string,
  ci: Readiness,
  checks: Check[],
): Promise<Readiness> {
  const read: CiCheck[] = [];
  for (const check of checks) {
    const state = ciState(check.result);
    const log = state === "failed" ? await readLogTail(input, token, check) : null;
    read.push({
      name: check.name,
      state,
      url: check.url,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
      logTail: log?.tail ?? null,
      logSource: log?.source ?? null,
    });
  }
  const tails = new Map(read.map((check) => [check.name, check.logTail]));
  return {
    ...ci,
    failedChecks: (ci.failedChecks ?? []).map((check) => ({
      ...check,
      logTail: tails.get(check.name) ?? null,
    })),
    checks: read,
  };
}

/** The job log for GitHub Actions, otherwise the check's summary text. */
async function readLogTail(
  input: ReadinessInput,
  token: string,
  check: Check,
): Promise<{ tail: string; source: "actions" | "summary" } | null> {
  if (check.actionsJob !== null) {
    try {
      const response = await input.client.request({
        method: "GET",
        path: repoApiPath(input.owner, input.repo, `/actions/jobs/${check.actionsJob}/logs`),
        token,
        accept: "text",
        signal: AbortSignal.timeout(30_000),
      });
      const tail =
        response.status === 200 && typeof response.body === "string" ? logTail(response.body) : "";
      if (tail !== "") return { tail, source: "actions" };
      console.error(`GitHub Actions log read for ${check.name} failed: status ${response.status}`);
    } catch (error) {
      journalCaught(error, "readiness.readLogTail.request", null);
    }
  }
  const summary = logTail(check.summary ?? "");
  return summary === "" ? null : { tail: summary, source: "summary" };
}

/**
 * The end of a log, up to the last `##[error]` line when there is one, so post-job cleanup
 * does not push the failure out. Timestamps, colour codes and group markers are removed.
 */
export function logTail(log: string): string {
  const lines = cleanLogLines(log);
  const lastError = lines.findLastIndex((line) => line.startsWith("##[error]"));
  const kept = (lastError === -1 ? lines : lines.slice(0, lastError + 1)).slice(-LOG_TAIL_LINES);
  const tail = kept
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
  return tail.length > LOG_TAIL_CHARS ? tail.slice(tail.length - LOG_TAIL_CHARS) : tail;
}

const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

function cleanLogLines(log: string): string[] {
  return log
    .replace(ANSI_COLOUR, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/, ""))
    .filter((line) => !/^##\[(?:end)?group\]/.test(line));
}

const protectionSchema = z.object({
  protection: z
    .object({
      required_status_checks: z
        .object({
          enforcement_level: z.string().optional(),
          contexts: z.array(z.string()).optional(),
          checks: z.array(z.object({ context: z.string() })).optional(),
        })
        .optional(),
    })
    .optional(),
});

const rulesSchema = z.array(
  z.object({
    type: z.string(),
    parameters: z
      .object({
        required_status_checks: z.array(z.object({ context: z.string() })).optional(),
      })
      .passthrough()
      .optional(),
  }),
);

/** Required checks on the base branch from branch protection and rulesets, or null if unreadable. */
async function readRequiredChecks(
  input: ReadinessInput,
  token: string,
  branch: string,
): Promise<Set<string> | null> {
  const encoded = branch.split("/").map(encodeURIComponent).join("/");
  const required = new Set<string>();
  const branchResponse = await input.client.request({
    method: "GET",
    path: repoApiPath(input.owner, input.repo, `/branches/${encoded}`),
    token,
  });
  const protection = protectionSchema.safeParse(branchResponse.body);
  if (branchResponse.status !== 200 || !protection.success) {
    console.error(`GitHub required checks read failed: branch status ${branchResponse.status}`);
    return null;
  }
  const status = protection.data.protection?.required_status_checks;
  if (status && status.enforcement_level !== "off") {
    for (const name of status.contexts ?? []) required.add(name);
    for (const check of status.checks ?? []) required.add(check.context);
  }
  for (let page = 1; ; page++) {
    const response = await input.client.request({
      method: "GET",
      path: repoApiPath(
        input.owner,
        input.repo,
        `/rules/branches/${encoded}?per_page=100&page=${page}`,
      ),
      token,
    });
    const rules = rulesSchema.safeParse(response.body);
    if (response.status !== 200 || !rules.success) {
      console.error(`GitHub required checks read failed: rules status ${response.status}`);
      return null;
    }
    for (const rule of rules.data) {
      if (rule.type !== "required_status_checks") continue;
      for (const check of rule.parameters?.required_status_checks ?? [])
        required.add(check.context);
    }
    if (rules.data.length < 100) return required;
  }
}

/** CI on the pull request's head, read once: review threads do not count. */
export type PullCi =
  | { state: "green"; checks: PassedCheck[] }
  | { state: "pending"; message: string }
  | { state: "failed"; failedChecks: FailedCheck[]; checks: CiCheck[] }
  /** The head is not the pull request's, the pull request is closed, or GitHub was unreadable. */
  | { state: "unknown"; message: string; moved?: true };

export async function readPullCi(input: {
  client: GitHubClient;
  owner: string;
  repo: string;
  prNumber: number;
  head: string;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
}): Promise<PullCi> {
  const read = await readMergeReadiness({
    client: input.client,
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    head: input.head,
    token: () => acquireOperationToken(input, "merge"),
  });
  if (read.passed !== undefined) return { state: "green", checks: read.passed };
  if (read.outcome === "ci_failed")
    return { state: "failed", failedChecks: read.failedChecks ?? [], checks: read.checks ?? [] };
  if (read.outcome === "pending") return { state: "pending", message: read.message };
  if (read.outcome === "sha_moved") return { state: "unknown", message: read.message, moved: true };
  return { state: "unknown", message: read.message };
}

export type HeadCheckRun = { name: string; app: string | null; status: string };

export type HeadChecks = { runs: HeadCheckRun[]; pushedAt: number | null };

const checkRunsSchema = z.object({
  total_count: z.number(),
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      app: z.object({ slug: z.string() }).nullable().optional(),
    }),
  ),
});

const checkSuitesSchema = z.object({
  check_suites: z.array(z.object({ created_at: z.string().nullable().optional() })),
});

export async function readHeadCheckRuns(
  input: {
    client: GitHubClient;
    owner: string;
    repo: string;
    head: string;
    signal?: AbortSignal;
  } & GitHubCredentialInput,
): Promise<HeadChecks | null> {
  try {
    const token = await acquireOperationToken(input, "merge");
    const get = (suffix: string) =>
      input.client.request({
        method: "GET",
        path: repoApiPath(input.owner, input.repo, `/commits/${input.head}/${suffix}`),
        token,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    const runs: HeadCheckRun[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await get(`check-runs?per_page=100&page=${page}`);
      const parsed = checkRunsSchema.safeParse(response.body);
      if (response.status !== 200 || !parsed.success) return null;
      for (const run of parsed.data.check_runs)
        runs.push({ name: run.name, app: run.app?.slug ?? null, status: run.status });
      if (parsed.data.check_runs.length < 100 || runs.length >= parsed.data.total_count) break;
    }
    const suites = await get("check-suites?per_page=100");
    const parsed = checkSuitesSchema.safeParse(suites.body);
    if (suites.status !== 200 || !parsed.success) return null;
    const created = parsed.data.check_suites
      .map((suite) => (suite.created_at ? Date.parse(suite.created_at) : Number.NaN))
      .filter((time) => Number.isFinite(time));
    return { runs, pushedAt: created.length > 0 ? Math.min(...created) : null };
  } catch (error) {
    journalCaught(error, "readiness.readHeadCheckRuns", null);
    return null;
  }
}
