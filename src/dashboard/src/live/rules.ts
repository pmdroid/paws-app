import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  listCloseoutBypassChecks,
  listLinkAsks,
  type CloseoutProgressRecord,
  type CloseoutStepRecord,
} from "../../../db";
import type {
  StatusCheck,
  StatusCloseoutAttempt,
  StatusRuleApproval,
  StatusVerdict,
} from "../contract";

/** The evidence record of a rule result is a few kilobytes; anything larger is not one. */
const RECORD_LIMIT_BYTES = 256 * 1024;

/**
 * Closeout records a rule's probe as a command step whose argv is `probeArgv`: the probe, then
 * `--base`, `--head` and `--repo .` at the candidate. No policy command ends that way.
 */
export function isRuleStep(
  step: Pick<CloseoutStepRecord, "kind" | "command">,
  row: Pick<CloseoutProgressRecord, "base" | "head">,
): boolean {
  if (step.kind !== "command" || row.base.length === 0 || row.head.length === 0) return false;
  return step.command.endsWith(` --base ${row.base} --head ${row.head} --repo .`);
}

/** Rules of a Closeout run whose paths matched none of the change, by id. */
export function skippedRules(row: CloseoutProgressRecord): string[] {
  return row.steps
    .filter(
      (step) =>
        step.state === "skipped" &&
        step.detail === "no changed path matches" &&
        isRuleStep(step, row),
    )
    .map((step) => step.id);
}

/**
 * The item detail's rule rows with the probe hash from each result's evidence record, and the
 * bypass a person made or is asked to make for each failed rule on that head.
 */
export function withRuleDetail(
  db: Database,
  itemId: string,
  verdict: StatusVerdict,
  progress: readonly CloseoutProgressRecord[],
  evidenceRoot: string | null,
): StatusVerdict {
  const all = [verdict.checks, ...(verdict.attempts ?? []).map((attempt) => attempt.checks)];
  if (!all.some((checks) => checks.some((check) => check.kind === "rule"))) return verdict;
  const decisions = ruleDecisions(db, itemId);
  const mine = progress.filter((row) => row.itemId === itemId);
  const enrich = (
    checks: readonly StatusCheck[],
    head: string | null,
    policy: string | null | undefined,
  ): StatusCheck[] =>
    checks.map((check) => {
      if (check.kind !== "rule") return check;
      const row = mine.find(
        (entry) =>
          entry.head === head &&
          (policy === null || policy === undefined || entry.policyDigest === policy) &&
          entry.steps.some((step) => step.id === check.id),
      );
      const approval =
        check.state === "failed" || check.state === "exhausted"
          ? decisions.find((entry) => entry.checkId === check.id && entry.head === head)?.approval
          : undefined;
      return {
        ...check,
        probeSha256: row === undefined ? null : probeHash(row, check, evidenceRoot),
        ...(approval === undefined ? {} : { approval }),
      };
    });
  return {
    ...verdict,
    checks: enrich(verdict.checks, verdict.headSha, verdict.policyDigest),
    ...(verdict.attempts
      ? {
          attempts: verdict.attempts.map((attempt): StatusCloseoutAttempt => ({
            ...attempt,
            checks: enrich(attempt.checks, attempt.headSha, attempt.policyDigest),
          })),
        }
      : {}),
  };
}

type RuleDecision = { checkId: string; head: string; approval: StatusRuleApproval };

/**
 * Each check a bypass ask of the item offered: bypassed with who and why, or waiting while the
 * ask is open. The latest ask for a check and head wins.
 */
function ruleDecisions(db: Database, itemId: string): RuleDecision[] {
  const decisions: RuleDecision[] = [];
  for (const ask of listLinkAsks(db, itemId).reverse()) {
    if (ask.kind !== "bypass") continue;
    for (const check of listCloseoutBypassChecks(db, ask.questionId)) {
      if (
        decisions.some((entry) => entry.checkId === check.checkId && entry.head === ask.headCommit)
      )
        continue;
      if (check.approvedAt !== null) {
        decisions.push({
          checkId: check.checkId,
          head: ask.headCommit,
          approval: {
            state: "bypassed",
            questionId: null,
            head: ask.headCommit,
            by: check.approvedByName ?? check.approvedBy,
            reason: check.reason,
            at: new Date(check.approvedAt).toISOString(),
          },
        });
      } else if (ask.closedAt === null) {
        decisions.push({
          checkId: check.checkId,
          head: ask.headCommit,
          approval: {
            state: "waiting",
            questionId: ask.questionId,
            head: ask.headCommit,
            by: null,
            reason: null,
            at: null,
          },
        });
      }
    }
  }
  return decisions;
}

/** The probe hash a rule result's evidence record lists for the probe it ran. */
function probeHash(
  row: CloseoutProgressRecord,
  check: StatusCheck,
  evidenceRoot: string | null,
): string | null {
  const step = row.steps.find((entry) => entry.id === check.id);
  const portable = step?.evidencePath;
  if (evidenceRoot === null || !portable) return null;
  const parts = portable.split("/");
  if (parts[0] !== "evidence" || parts.some((part) => !part || part === "." || part === ".."))
    return null;
  const task = row.taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  if (!task || task === "." || task === "..") return null;
  const file = join(evidenceRoot, task, ...parts);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > RECORD_LIMIT_BYTES) return null;
    const record: unknown = JSON.parse(readFileSync(file, "utf8"));
    const artifacts =
      typeof record === "object" && record !== null && "artifacts" in record
        ? record.artifacts
        : null;
    if (!Array.isArray(artifacts)) return null;
    for (const artifact of artifacts) {
      const path: unknown = artifact?.path;
      const sha256: unknown = artifact?.sha256;
      if (typeof path === "string" && path.startsWith("probes/") && typeof sha256 === "string")
        return sha256;
    }
    return null;
  } catch (caughtError1) {
    journalCaught(caughtError1, "rules.probeHash.read", check.id);
    return null;
  }
}
