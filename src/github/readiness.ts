import { z } from "zod";
import { readLogTail } from "./ci-logs";
import { repoApiPath } from "./client";
import type { CiCheck, CiCheckState, CiOutcome, GitHubClient } from "./types";

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
        databaseId: z.number().nullable().optional(),
        startedAt: z.string().nullable().optional(),
        completedAt: z.string().nullable().optional(),
        summary: z.string().nullable().optional(),
        text: z.string().nullable().optional(),
        checkSuite: z
          .object({ app: z.object({ slug: z.string() }).nullable().optional() })
          .nullable()
          .optional(),
        context: z.string().optional(),
        state: z.string().optional(),
        targetUrl: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        createdAt: z.string().nullable().optional(),
      })
      .nullable(),
  ),
});

const rollupSchema = z.object({ contexts: contextsSchema.optional() }).nullable();

const responseSchema = z.object({
  errors: z.array(z.unknown()).optional(),
  data: z.object({
    repository: z.object({
      object: z.object({ oid: z.string(), statusCheckRollup: rollupSchema }),
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
    ... on CheckRun { name conclusion detailsUrl databaseId startedAt completedAt summary text checkSuite { app { slug } } }
    ... on StatusContext { context state targetUrl description createdAt }
  }
}`;

export type FailedCheck = { name: string; url: string | null; logTail?: string | null };

export type Readiness = {
  outcome: "ready" | "pending" | "blocked" | "sha_moved" | "ci_failed";
  message: string;
  failedChecks?: FailedCheck[];
  /** Every check on the head, once the head's checks were read. */
  checks?: CiCheck[];
  /** CI alone, without review threads: a missing expected check keeps it running. */
  ciOutcome?: CiOutcome;
};

/** Conclusions and states that fail the pull request. Anything else that is not green waits. */
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"]);

type Check = {
  name: string;
  result: string | null;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The Actions job id when the check run comes from GitHub Actions. */
  actionsJob: number | null;
  summary: string | null;
};

type ReadinessInput = {
  client: GitHubClient;
  token: () => Promise<string>;
  owner: string;
  repo: string;
  prNumber: number;
  head: string;
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
    const checks: Check[] = [];
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
      if (response.status !== 200 || !parsed.success || parsed.data.errors?.length) {
        console.error(
          `GitHub readiness read failed: status ${response.status}${
            parsed.success && parsed.data.errors?.length
              ? `, ${JSON.stringify(parsed.data.errors).slice(0, 500)}`
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
        (key === "checks" ? checks : baseChecks).push(...toChecks(rollup.contexts.nodes));
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
    const judged = judgeChecks(checks, baseChecks, required);
    const read = await ciChecks(input, token, checks, judged.outcome);
    const ciOutcome: CiOutcome =
      judged.outcome === "ci_failed" ? "failed" : judged.outcome === "ready" ? "passed" : "running";
    const ci: Readiness = {
      ...judged,
      checks: read,
      ciOutcome,
      // Each failed check keeps its own log tail; names can repeat across workflows.
      ...(judged.failedChecks === undefined
        ? {}
        : {
            failedChecks: read
              .filter((check) => check.state === "failed")
              .map((check) => ({
                name: check.name,
                url: check.url,
                ...(check.logTail ? { logTail: check.logTail } : {}),
              })),
          }),
    };
    if (ci.outcome !== "ready") return ci;
    return unresolved > 0
      ? {
          outcome: "pending",
          message: `Waiting for ${unresolved} unresolved review thread(s).`,
          checks: read,
          ciOutcome,
        }
      : {
          outcome: "ready",
          message: "CI passed and all review threads are resolved",
          checks: read,
          ciOutcome,
        };
  } catch (error) {
    console.error(
      `GitHub readiness read failed: ${
        error instanceof Error
          ? error.message
              .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[redacted]")
              .slice(0, 300)
          : "unknown error"
      }`,
    );
    return unreadable();
  }
}

function unreadable(): Readiness {
  return { outcome: "blocked", message: "could not read GitHub CI and review threads" };
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
          node.checkSuite?.app?.slug === "github-actions" && node.databaseId != null
            ? node.databaseId
            : null,
        summary:
          [node.summary, node.text, node.description]
            .map((part) => part?.trim() ?? "")
            .filter(Boolean)
            .join("\n\n") || null,
      },
    ];
  });
}

/** The head's checks for the run page. A CI failure also reads each failed check's log tail. */
async function ciChecks(
  input: ReadinessInput,
  token: string,
  checks: readonly Check[],
  outcome: Readiness["outcome"],
): Promise<CiCheck[]> {
  return Promise.all(
    checks.map(async (check) => {
      const state = ciState(check.result);
      const tail =
        outcome === "ci_failed" && state === "failed"
          ? await readLogTail({ ...input, token, ...check })
          : { logTail: null, logSource: null };
      return {
        name: check.name,
        state,
        url: check.url,
        startedAt: check.startedAt,
        completedAt: check.completedAt,
        ...tail,
      };
    }),
  );
}

function ciState(result: string | null): CiCheckState {
  if (result === "SUCCESS") return "passed";
  if (FAILED.has(result ?? "")) return "failed";
  if (result === "SKIPPED") return "skipped";
  if (result === "NEUTRAL") return "neutral";
  return "running";
}

function judgeChecks(checks: Check[], baseChecks: Check[], required: Set<string>): Readiness {
  const failed = checks.filter((check) => FAILED.has(check.result ?? ""));
  if (failed.length > 0) {
    return {
      outcome: "ci_failed",
      message: "CI failed on the candidate commit",
      failedChecks: failed.map((check) => ({ name: check.name, url: check.url })),
    };
  }
  const skippedOnBase = new Set(
    baseChecks.filter((check) => check.result === "SKIPPED").map((check) => check.name),
  );
  const expected = new Set([...required, ...baseChecks.map((check) => check.name)]);
  if (checks.length === 0 && expected.size === 0) {
    return { outcome: "pending", message: "Waiting for CI on the candidate commit." };
  }
  const reported = new Set(checks.map((check) => check.name));
  const waiting = new Set([...expected].filter((name) => !reported.has(name)));
  for (const check of checks) {
    const green =
      check.result === "SUCCESS" || (check.result === "SKIPPED" && skippedOnBase.has(check.name));
    if (!green) waiting.add(check.name);
  }
  if (waiting.size > 0) {
    return {
      outcome: "pending",
      message: `Waiting for checks: ${[...waiting].sort().join(", ")}.`,
    };
  }
  return { outcome: "ready", message: "CI passed" };
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
