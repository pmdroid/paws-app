import { journalCaught } from "../journal";
import type {
  StatusCheck,
  StatusCloseoutAttempt,
  StatusVerdict,
  StatusPullRequest,
  ItemState,
} from "../contract";
import { parseEngineUrl } from "./format";
import { ansiToHtml } from "./ansi";
import { durationLabel, esc } from "./format";

/**
 * What the reader changed on the Closeout checks. It lives outside the
 * snapshot so the five-second poll does not fold rows back up.
 */
export interface CloseoutView {
  /** Chosen attempt number per item. Missing means the latest attempt. */
  attempt: Record<string, number>;
  /** Rows the reader opened or closed, by `checkKey`. Missing means the default. */
  open: Record<string, boolean>;
  /** Rows whose output wraps long lines, by `checkKey`. */
  wrap: Record<string, boolean>;
  stream?: Record<string, "stdout" | "stderr">;
  /** Logs loaded for opened rows, by `checkKey`. A row without one shows the check's own output. */
  logs?: Record<string, CheckLogView>;
  /** Issues being filed from pre-existing findings, by `findingIssueKey`. */
  filing?: Record<string, FindingFiling>;
}

/** A click on File an issue: sending, the issue Linear filed, or Linear's error. */
export type FindingFiling =
  | { state: "sending" }
  | { state: "filed"; identifier: string; url: string | null }
  | { state: "failed"; error: string };

/** A check log the issue page fetched when its row opened. `checkState` is the state it was read in. */
export type CheckLogView =
  | { status: "loading"; checkState: string }
  | { status: "error"; checkState: string; error: string }
  | {
      status: "loaded";
      checkState: string;
      stdout: string;
      stderr: string;
      truncated: boolean;
      full: boolean;
    };

export function emptyCloseoutView(): CloseoutView {
  return { attempt: {}, open: {}, wrap: {} };
}

export function checkKey(itemId: string, attempt: number, checkId: string): string {
  return `${itemId}\n${attempt}\n${checkId}`;
}

/** Every attempt, oldest first. A verdict without recorded attempts is one attempt. */
export function attemptsOf(verdict: StatusVerdict): StatusCloseoutAttempt[] {
  if (verdict.attempts && verdict.attempts.length > 0) return verdict.attempts;
  return [
    {
      number: Math.max(verdict.attempt, 1),
      decision: verdict.decision,
      startedAt: "",
      baseSha: verdict.baseSha,
      headSha: verdict.headSha,
      policyDigest: verdict.policyDigest ?? null,
      checks: verdict.checks,
    },
  ];
}

export function shownAttempt(verdict: StatusVerdict, view: CloseoutView): StatusCloseoutAttempt {
  const attempts = attemptsOf(verdict);
  const chosen = view.attempt[verdict.itemId];
  return attempts.find((entry) => entry.number === chosen) ?? attempts.at(-1)!;
}

export function isOpen(
  view: CloseoutView,
  itemId: string,
  attempt: number,
  check: StatusCheck,
): boolean {
  return view.open[checkKey(itemId, attempt, check.id)] ?? startsOpen(check);
}

/** Failed and running checks start open so their output is in view, unless a person let them pass. */
function startsOpen(check: StatusCheck): boolean {
  if (check.approval?.state === "approved" || check.approval?.state === "bypassed") return false;
  return (
    check.state === "failed" ||
    check.state === "blocked" ||
    check.state === "exhausted" ||
    check.active === true
  );
}

/** The fragment a copied link carries: `#check=<attempt>/<check id>`. */
export function checkHash(attempt: number, checkId: string): string {
  return `#check=${attempt}/${encodeURIComponent(checkId)}`;
}

export function parseCheckHash(hash: string): { attempt: number; checkId: string } | null {
  const match = /^#check=(\d+)\/(.+)$/.exec(hash);
  if (!match) return null;
  try {
    return { attempt: Number(match[1]), checkId: decodeURIComponent(match[2]!) };
  } catch (caughtError1) {
    journalCaught(caughtError1, "closeout.parseCheckHash.Number", null);
    return null;
  }
}

export function checkAnchor(attempt: number, checkId: string, itemId = ""): string {
  const agent = itemId.startsWith("agent:") ? "agent-" : "";
  return `${agent}check-${attempt}-${checkId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function sectionToggle(key: string, open: boolean, title: string, detail: string): string {
  return `<button class="chk section-toggle${open ? " on" : ""}" type="button" data-action="section-toggle" data-item="${esc(key)}" data-attempt="1" data-open="${open}" aria-expanded="${open}">${title}<span class="muted">${esc(detail)}</span><span class="check-chevron" aria-hidden="true">${open ? "⌄" : "›"}</span></button>`;
}

export function sectionOpen(view: CloseoutView, key: string, fallback: boolean): boolean {
  return view.open[`section\n${key}`] ?? fallback;
}

export function checkListKey(itemId: string, attempt: number): string {
  return `checks:${itemId}:${attempt}`;
}

export interface CloseoutChecksOptions {
  heading?: string | null;
  result?: { title: string; description: string; icon: string };
  checkAttempts?: number | null;
}

export function renderCloseoutChecks(
  verdict: StatusVerdict,
  view: CloseoutView,
  engineUrl: string | null,
  pr: StatusPullRequest | null = null,
  itemState?: ItemState,
  options: CloseoutChecksOptions = {},
): string {
  const attempts = attemptsOf(verdict);
  const attempt = shownAttempt(verdict, view);
  const item = esc(verdict.itemId);
  const rounds = [...new Set(attempts.map((entry) => entry.round ?? 1))];
  const switcher = rounds
    .map((round) => {
      const label =
        rounds.length > 1
          ? `<span class="attempt-round">${round === 1 ? "Round 1" : `Round ${round} · rebased`}</span>`
          : "";
      const tabs = attempts
        .filter((entry) => (entry.round ?? 1) === round)
        .map((entry) => {
          const on = entry.number === attempt.number;
          return `<button type="button" class="btn sm${on ? " on" : ""}" data-action="closeout-attempt" data-item="${item}" data-attempt="${entry.number}" aria-pressed="${on}"><span class="attempt-dot ${esc(entry.decision)}" aria-hidden="true"></span>Attempt ${roundAttempt(attempts, entry)}<span class="sr-only"> · ${esc(attemptLabel(entry))}</span></button>`;
        })
        .join("");
      return `${label}<div class="attempt-tabs" role="group" aria-label="${rounds.length > 1 ? `Closeout round ${round} attempt` : "Closeout attempt"}">${tabs}</div>`;
    })
    .join("");
  const shown = roundAttempt(attempts, attempt);
  const inRound = rounds.length > 1 ? ` in round ${attempt.round ?? 1}` : "";
  // Repository rules have their own section; see `renderRuleResults`.
  const checks = attempt.checks.filter((check) => check.kind !== "rule");
  const allOpen =
    checks.length > 0 &&
    checks.every((check) => isOpen(view, verdict.itemId, attempt.number, check));
  const toggleAll = checks.length
    ? `<button type="button" class="btn sm ghost" data-action="closeout-expand-all" data-item="${item}" data-attempt="${attempt.number}" aria-pressed="${allOpen}">${allOpen ? "Collapse all" : "Expand all"}</button>`
    : "";
  const rows = checks.length
    ? checks.map((check) => checkRow(verdict, attempt, check, view, engineUrl, options)).join("")
    : '<div class="dim">No checks recorded for this attempt yet.</div>';
  const decision = attempt.decision;
  const accepted = decision === "accepted";
  const title = accepted
    ? `Accepted on attempt ${shown} of ${verdict.maxAttempts}${inRound}`
    : decision === "exhausted"
      ? `Exhausted after ${shown} of ${verdict.maxAttempts} attempts${inRound}`
      : `${attemptLabel(attempt)[0]!.toUpperCase()}${attemptLabel(attempt).slice(1)} on attempt ${shown} of ${verdict.maxAttempts}${inRound}`;
  const head = attempt.headSha ? ` on head ${esc(attempt.headSha.slice(0, 7))}` : "";
  const description = accepted
    ? `All ${checks.length} checks passed${head}.${pr && itemState === "merge_queue" ? ` Pull request <a href="${esc(pr.url)}">#${pr.number}</a> is waiting to merge.` : itemState === "merged" ? " This change has merged." : ""}`
    : `${esc(
        attempt.checks
          .filter(
            (check) =>
              ["failed", "blocked", "exhausted"].includes(check.state) &&
              check.approval?.state !== "approved" &&
              check.approval?.state !== "bypassed",
          )
          .map((check) => check.id)
          .join(", ") || "Checks",
      )} ${decision === "running" ? "are running" : "did not pass"}${head}.`;
  const waiting = decision === "running" ? attempt.checks.find(waitingForRunner) : undefined;
  const result =
    options.result ??
    (waiting
      ? { title: esc(`${waiting.id} is waiting`), description: esc(waiting.detail!), icon: "…" }
      : {
          title: esc(title),
          description,
          icon: accepted ? "✓" : decision === "running" ? "…" : "✕",
        });
  const heading =
    options.heading === undefined
      ? "<h2>Closeout</h2>"
      : options.heading === null
        ? "<span></span>"
        : `<h2>${esc(options.heading)}</h2>`;
  const listKey = checkListKey(verdict.itemId, attempt.number);
  const folds = accepted && checks.length > 0;
  const listOpen = sectionOpen(
    view,
    listKey,
    !folds || checks.some((check) => isOpen(view, verdict.itemId, attempt.number, check)),
  );
  const fold = folds
    ? sectionToggle(
        listKey,
        listOpen,
        `<b>${checks.length} checks</b>`,
        checks.map((check) => check.id).join(" · "),
      )
    : "";
  return `<div class="between closeout-toolbar">${heading}<div class="row">${switcher}${toggleAll}</div></div><div class="closeout-result ${esc(decision)}"><span class="result-icon" aria-hidden="true">${result.icon}</span><div><h3>${result.title}</h3><p>${result.description}</p></div></div>${fold}${listOpen ? `<div class="check-list">${rows}</div>` : ""}`;
}

/** The attempt's number within its retry-budget round. */
export function roundAttempt(
  attempts: readonly StatusCloseoutAttempt[],
  attempt: StatusCloseoutAttempt,
): number {
  const round = attempt.round ?? 1;
  return attempts.filter((entry) => (entry.round ?? 1) === round && entry.number <= attempt.number)
    .length;
}

function attemptLabel(attempt: StatusCloseoutAttempt): string {
  if (attempt.decision === "accepted") return "passed";
  if (attempt.decision === "running") return "running";
  if (attempt.decision === "blocked") return "blocked";
  if (attempt.decision === "exhausted") return "exhausted";
  return "failed";
}

function checkRow(
  verdict: StatusVerdict,
  attempt: StatusCloseoutAttempt,
  check: StatusCheck,
  view: CloseoutView,
  engineUrl: string | null,
  options: CloseoutChecksOptions,
): string {
  const open = isOpen(view, verdict.itemId, attempt.number, check);
  const anchor = checkAnchor(attempt.number, check.id, verdict.itemId);
  const meta = checkMeta(check, options.checkAttempts);
  const command = check.kind === "review" ? "closeout review --independent" : check.command;
  const head = `<button class="chk${open ? " on" : ""}" type="button" data-action="toggle-check" data-item="${esc(verdict.itemId)}" data-attempt="${attempt.number}" data-check="${esc(check.id)}" aria-expanded="${open}" aria-controls="${anchor}-out"><span class="ico ${esc(check.state)}" aria-label="${esc(check.state)}">${checkMark(check.state)}</span><span class="mono check-name">${esc(check.id)}</span><span class="mono muted check-command">${esc(command)}</span><span class="tag">${esc(check.kind)}</span><span class="check-meta">${meta}</span><span class="check-chevron" aria-hidden="true">${open ? "⌄" : "›"}</span></button>`;
  const body = open
    ? `<div class="check-detail" id="${anchor}-out">${checkBody(verdict, attempt, check, view, engineUrl, options)}</div>`
    : "";
  return `<div class="check-row" id="${anchor}">${head}${body}</div>`;
}

export function checkBody(
  verdict: StatusVerdict,
  attempt: StatusCloseoutAttempt,
  check: StatusCheck,
  view: CloseoutView,
  engineUrl: string | null,
  options: CloseoutChecksOptions,
): string {
  if (check.kind === "evidence") return `<p class="check-command">${esc(check.command)}</p>`;
  const key = checkKey(verdict.itemId, attempt.number, check.id);
  const shown =
    options.checkAttempts !== undefined && typeof check.attempt === "number"
      ? check.attempt
      : attempt.number;
  const wrap = view.wrap[key] === true;
  const data = `data-item="${esc(verdict.itemId)}" data-attempt="${attempt.number}" data-check="${esc(check.id)}"`;
  const finished = check.state !== "running" && check.state !== "pending";
  const fullLog =
    finished && check.logPath
      ? artifactLink(verdict, attempt, check, "log", "Full log", engineUrl)
      : "";
  const log = view.logs?.[key];
  const streams = logStreams(check, log);
  const download =
    fullLog ||
    (streams.stdout || streams.stderr
      ? `<button class="btn sm ghost" type="button" data-action="download-output" ${data}>Download output</button>`
      : "");
  const evidence =
    finished && check.evidencePath
      ? artifactLink(verdict, attempt, check, "evidence", "Evidence", engineUrl)
      : "";
  const tools = `<div class="row"><button class="btn sm" type="button" data-action="wrap-output" ${data} aria-pressed="${wrap}">Wrap lines</button><button class="btn sm ghost" type="button" data-action="copy-check-link" ${data}>Copy link</button>${download}${evidence}</div>`;
  const truncated = check.truncated
    ? `<p class="muted" role="note">Output was cut at the size limit. ${fullLog ? `${fullLog} has the complete output.` : "The full log is available once the check finishes."}</p>`
    : "";
  const tailOnly =
    log?.status === "loaded" && log.truncated && !log.full
      ? `<p class="muted" role="note">Showing the last 64 KB of each stream. <button class="btn sm ghost" type="button" data-action="check-log-full" ${data}>Load the full log</button></p>`
      : "";
  const failed =
    log?.status === "error"
      ? `<p class="muted" role="alert">Could not load the log: ${esc(log.error)}</p>`
      : "";
  const findings = check.findings
    ? `<div class="stream"><span>Findings</span><pre class="out ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}" tabindex="0" data-log="${logKey(verdict.itemId, attempt.number, check.id, "findings")}">${esc(check.findings)}</pre></div>`
    : "";
  const selectedStream = view.stream?.[key] ?? (streams.stdout ? "stdout" : "stderr");
  const tabs = (["stdout", "stderr"] as const)
    .map(
      (stream) =>
        `<button type="button" class="btn sm" data-action="check-stream" ${data} data-stream="${stream}" aria-pressed="${selectedStream === stream}">${stream}</button>`,
    )
    .join("");
  return `<div class="between"><span class="mono check-command">$ ${esc(check.kind === "review" ? "closeout review --independent" : check.command)}</span>${tools}</div><div class="check-terminal"><div class="between terminal-toolbar"><div class="row" role="group" aria-label="Output stream">${tabs}</div><span>attempt ${shown} · ${esc(checkMeta(check))}</span></div>${output(verdict.itemId, attempt.number, check, streams, wrap, selectedStream, log?.status === "loading")}${tailOnly}${truncated}${failed}</div>${findings}`;
}

/** A running check that Paws has not sent to its runner yet; `detail` says why. */
function waitingForRunner(check: StatusCheck): boolean {
  return check.state === "running" && check.detail?.startsWith("Waiting:") === true;
}

/** The loaded log of the row, or the output the check carries itself. */
function logStreams(
  check: StatusCheck,
  log: CheckLogView | undefined,
): { stdout: string; stderr: string } {
  if (log?.status === "loaded") return { stdout: log.stdout, stderr: log.stderr };
  return { stdout: check.stdout ?? "", stderr: check.stderr ?? "" };
}

function output(
  itemId: string,
  attempt: number,
  check: StatusCheck,
  streams: { stdout: string; stderr: string },
  wrap: boolean,
  selected: "stdout" | "stderr",
  loading = false,
): string {
  const lines = wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre";
  return (["stdout", "stderr"] as const)
    .map(
      (stream) =>
        `<pre class="out ${lines}" tabindex="0" aria-label="${stream}" data-log="${logKey(itemId, attempt, check.id, stream)}"${selected === stream ? "" : " hidden"}>${ansiToHtml(streams[stream] || (loading ? "Loading output." : waitingForRunner(check) || (check.state === "stopped" && check.detail) ? check.detail! : check.state === "running" ? "Waiting for output." : "No output."))}</pre>`,
    )
    .join("");
}

function artifactLink(
  verdict: StatusVerdict,
  attempt: StatusCloseoutAttempt,
  check: StatusCheck,
  kind: "log" | "evidence",
  label: string,
  engineUrl: string | null,
): string {
  const params = new URLSearchParams({
    item: verdict.itemId,
    check: check.id,
    kind,
    head: attempt.headSha ?? "",
    policy: attempt.policyDigest ?? "",
  });
  const path = `/api/closeout-artifact?${params.toString()}`;
  const engine = parseEngineUrl(engineUrl ?? "");
  const href = engine === null ? path : new URL(path, engine).href;
  const file = `${check.id.replace(/[^A-Za-z0-9_-]/g, "_")}-${attempt.number}.${kind === "log" ? "log" : "json"}`;
  return `<a href="${esc(href)}" download="${esc(file)}">${label}</a>`;
}

function logKey(itemId: string, attempt: number, checkId: string, stream: string): string {
  return `${encodeURIComponent(itemId)}:${attempt}:${encodeURIComponent(checkId)}:${stream}`;
}

function checkMeta(check: StatusCheck, checkAttempts?: number | null): string {
  const parts: string[] = [];
  if (
    checkAttempts !== undefined &&
    typeof check.attempt === "number" &&
    (check.attempt > 1 || check.state === "failed" || check.state === "exhausted")
  )
    parts.push(`attempt ${check.attempt}${checkAttempts === null ? "" : ` of ${checkAttempts}`}`);

  if (typeof check.elapsedMs === "number") parts.push(durationLabel(check.elapsedMs));
  if (typeof check.tokens === "number") parts.push(tokenLabel(check.tokens));

  if (typeof check.exitCode === "number") parts.push(`exit ${check.exitCode}`);
  if (check.timedOut) parts.push(esc(check.timeoutReason || "timed out"));
  return parts.join(" · ");
}

function tokenLabel(tokens: number): string {
  if (tokens < 1000) return `${tokens} tokens`;
  return `${Number((tokens / 1000).toFixed(1))}k tokens`;
}

export function checkMark(state: string): string {
  if (state === "passed") return "✓";
  if (state === "failed" || state === "blocked" || state === "exhausted") return "✕";
  if (state === "skipped") return "–";
  if (state === "stopped") return "■";
  return "";
}
