import type { StatusCheck, StatusCloseoutAttempt, StatusVerdict } from "../contract";
import { parseEngineUrl } from "../endpoint";
import { ansiToHtml } from "./ansi";
import { esc } from "./format";

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
  /** The output tab the reader chose, by `checkKey`. */
  stream: Record<string, "stdout" | "stderr" | "findings">;
}

export function emptyCloseoutView(): CloseoutView {
  return { attempt: {}, open: {}, wrap: {}, stream: {} };
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

/** Failed and running checks start open so their output is in view. */
function startsOpen(check: StatusCheck): boolean {
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
  } catch {
    return null;
  }
}

export function checkAnchor(attempt: number, checkId: string): string {
  return `check-${attempt}-${checkId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** What the result banner says beyond the checks: the pull request, when there is one. */
export interface CloseoutContext {
  pullRequest: number | null;
  waitingToMerge: boolean;
  reviewer: string | null;
}

export function renderCloseout(
  verdict: StatusVerdict,
  view: CloseoutView,
  engineUrl: string | null,
  context: CloseoutContext,
): string {
  const attempts = attemptsOf(verdict);
  const attempt = shownAttempt(verdict, view);
  const item = esc(verdict.itemId);
  const tabs = attempts
    .map((entry) => {
      const on = entry.number === attempt.number;
      return `<button type="button" class="sm" data-action="closeout-attempt" data-item="${item}" data-attempt="${entry.number}" aria-pressed="${on}" aria-label="Attempt ${entry.number}, ${attemptLabel(entry)}"><span class="attempt-dot ${esc(entry.decision)}" aria-hidden="true"></span>Attempt ${entry.number}</button>`;
    })
    .join("");
  const allOpen =
    attempt.checks.length > 0 &&
    attempt.checks.every((check) => isOpen(view, verdict.itemId, attempt.number, check));
  const toggleAll = attempt.checks.length
    ? `<button type="button" class="sm" data-action="closeout-expand-all" data-item="${item}" data-attempt="${attempt.number}" aria-pressed="false">${allOpen ? "Collapse all" : "Expand all"}</button>`
    : "";
  const rows = attempt.checks.length
    ? attempt.checks
        .map((check) => checkRow(verdict, attempt, check, view, engineUrl, context))
        .join("")
    : '<div class="empty">No checks recorded for this attempt yet.</div>';
  return `<div class="closeout-head"><h2>Closeout</h2><div class="closeout-tools"><div class="attempt-tabs" role="group" aria-label="Closeout attempt">${tabs}</div>${toggleAll}</div></div>
    ${resultBanner(verdict, attempt, context)}
    <div class="checks">${rows}</div>`;
}

/** One banner for the shown attempt: what Closeout decided and on which head. */
export function resultBanner(
  verdict: StatusVerdict,
  attempt: StatusCloseoutAttempt,
  context: CloseoutContext,
): string {
  const of = `attempt ${attempt.number} of ${verdict.maxAttempts}`;
  const head = attempt.headSha ? ` on head ${attempt.headSha.slice(0, 7)}` : "";
  const failed = attempt.checks.filter((check) => FAILED.has(check.state));
  const failing = failed[0]?.id ?? verdict.failingCheck;
  const everyAttempt =
    failing !== null &&
    attemptsOf(verdict).every((entry) =>
      entry.checks.some((check) => check.id === failing && FAILED.has(check.state)),
    );
  const failure = failing
    ? `${failing} failed${everyAttempt && attempt.number > 1 ? " every attempt" : ""}.`
    : "";
  let tone = "failed";
  let title: string;
  let body: string;
  if (attempt.decision === "accepted") {
    tone = "passed";
    title = `Accepted on ${of}`;
    const pr = context.pullRequest
      ? ` Pull request #${context.pullRequest}${context.waitingToMerge ? " is waiting to merge" : " is open"}.`
      : "";
    body = `All ${attempt.checks.length} check${attempt.checks.length === 1 ? "" : "s"} passed${head}.${pr}`;
  } else if (attempt.decision === "running") {
    tone = "running";
    title = `Running ${of}`;
    const done = attempt.checks.filter(
      (check) => check.state !== "running" && check.state !== "pending",
    ).length;
    body = `${done} of ${attempt.checks.length} checks finished${head}.`;
  } else if (attempt.decision === "exhausted") {
    title = `Exhausted after ${attempt.number} of ${verdict.maxAttempts} attempts`;
    body = `${failure} A person decides in Linear what happens next.`.trim();
  } else if (attempt.decision === "blocked") {
    title = `Blocked on ${of}`;
    body = `${failure} Closeout stopped and needs a person.`.trim();
  } else {
    title = `Failed on ${of}`;
    body = `${failure} The findings went back to the agent.`.trim();
  }
  const mark = tone === "passed" ? "✓" : tone === "running" ? "…" : "✕";
  return `<div class="result-banner ${tone}" role="status"><span class="result-mark" aria-hidden="true">${mark}</span><div><b>${esc(title)}</b><span>${esc(body)}</span></div></div>`;
}

const FAILED = new Set(["failed", "blocked", "exhausted"]);

function attemptLabel(attempt: StatusCloseoutAttempt): string {
  if (attempt.decision === "accepted") return "passed";
  if (attempt.decision === "running") return "running";
  if (attempt.decision === "blocked") return "blocked";
  if (attempt.decision === "exhausted") return "exhausted";
  return "failed";
}

/** "3.1s", "24.2s", "2m 14s". */
export function checkDuration(ms: number): string {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function checkCommand(check: StatusCheck, context: CloseoutContext): string {
  if (check.kind !== "review") return check.command;
  return context.reviewer && context.reviewer !== "Unknown"
    ? `independent review by ${context.reviewer}`
    : "independent review";
}

function checkRow(
  verdict: StatusVerdict,
  attempt: StatusCloseoutAttempt,
  check: StatusCheck,
  view: CloseoutView,
  engineUrl: string | null,
  context: CloseoutContext,
): string {
  const open = isOpen(view, verdict.itemId, attempt.number, check);
  const anchor = checkAnchor(attempt.number, check.id);
  const meta = checkMeta(check);
  const command = checkCommand(check, context);
  const head = `<button class="chk${open ? " on" : ""}" type="button" data-action="toggle-check" data-item="${esc(verdict.itemId)}" data-attempt="${attempt.number}" data-check="${esc(check.id)}" aria-expanded="${open}" aria-controls="${anchor}-out"><span class="chk-mark ${esc(check.state)}" role="img" aria-label="${esc(check.state)}">${checkMark(check.state)}</span><span class="chk-name">${esc(check.id)}</span><span class="chk-cmd" title="${esc(check.command)}">${esc(command)}</span><span class="tag">${esc(check.kind)}</span><span class="chk-meta">${esc(meta)}</span><span class="chk-chev" aria-hidden="true">${open ? "⌄" : "›"}</span></button>`;
  const body = open
    ? `<div class="check-body" id="${anchor}-out">${checkBody(verdict, attempt, check, view, engineUrl, command)}</div>`
    : "";
  return `<div class="check${open ? " open" : ""}" id="${anchor}">${head}${body}</div>`;
}

type Stream = "stdout" | "stderr" | "findings";

/** The tab a check opens on: findings for a review, otherwise the first stream with output. */
export function shownStream(check: StatusCheck, chosen: Stream | undefined): Stream | null {
  const streams = streamsOf(check);
  if (chosen && streams.includes(chosen)) return chosen;
  return streams[0] ?? null;
}

function streamsOf(check: StatusCheck): Stream[] {
  const streams: Stream[] = [];
  if (check.findings) streams.push("findings");
  if (check.stdout) streams.push("stdout");
  if (check.stderr) streams.push("stderr");
  return streams;
}

function checkBody(
  verdict: StatusVerdict,
  attempt: StatusCloseoutAttempt,
  check: StatusCheck,
  view: CloseoutView,
  engineUrl: string | null,
  command: string,
): string {
  const key = checkKey(verdict.itemId, attempt.number, check.id);
  const wrap = view.wrap[key] === true;
  const data = `data-item="${esc(verdict.itemId)}" data-attempt="${attempt.number}" data-check="${esc(check.id)}"`;
  const finished = check.state !== "running" && check.state !== "pending";
  const fullLog =
    finished && check.logPath
      ? artifactLink(verdict, attempt, check, "log", "Full log", engineUrl)
      : "";
  const download =
    fullLog ||
    (check.stdout || check.stderr
      ? `<button class="sm" type="button" data-action="download-output" ${data}>Download output</button>`
      : "");
  const evidence =
    finished && check.evidencePath
      ? artifactLink(verdict, attempt, check, "evidence", "Evidence", engineUrl)
      : "";
  const tools = `<div class="check-tools"><code class="check-prompt">$ ${esc(command)}</code><div class="row"><button class="sm" type="button" data-action="wrap-output" ${data} aria-pressed="${wrap}">Wrap lines</button><button class="sm" type="button" data-action="copy-check-link" ${data}>Copy link</button>${download}${evidence}</div></div>`;
  const detail = check.detail ? `<p class="muted">${esc(check.detail)}</p>` : "";
  const stream = shownStream(check, view.stream[key]);
  const tabs = streamsOf(check)
    .map(
      (name) =>
        `<button class="sm" type="button" data-action="closeout-stream" data-stream="${name}" ${data} aria-pressed="${name === stream}">${name}</button>`,
    )
    .join("");
  const took = typeof check.elapsedMs === "number" ? ` · ${checkDuration(check.elapsedMs)}` : "";
  const lines = wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre";
  const text = stream === null ? "" : (check[stream] ?? "");
  const out = stream
    ? `<pre class="term-out ${lines}" tabindex="0" data-log="${logKey(verdict.itemId, attempt.number, check.id, stream)}">${stream === "findings" ? esc(text) : ansiToHtml(text)}</pre>`
    : `<p class="term-empty">${check.state === "running" ? "Waiting for output." : "No output."}</p>`;
  const truncated = check.truncated
    ? `<p class="term-note" role="note">Showing the end of the output. ${fullLog ? "Full log has all of it." : "The full log is available once the check finishes."}</p>`
    : "";
  return `${tools}${detail}<div class="term"><div class="term-bar"><div class="term-tabs" role="group" aria-label="Output stream">${tabs}</div><span>attempt ${attempt.number}${esc(took)}</span></div>${out}${truncated}</div>`;
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
  return `<a class="btn sm" href="${esc(href)}" download="${esc(file)}">${label}</a>`;
}

function logKey(itemId: string, attempt: number, checkId: string, stream: string): string {
  return `${encodeURIComponent(itemId)}:${attempt}:${encodeURIComponent(checkId)}:${stream}`;
}

/** "24.2s · exit 0", or why the check did not finish. */
function checkMeta(check: StatusCheck): string {
  const parts: string[] = [];
  if (typeof check.elapsedMs === "number") parts.push(checkDuration(check.elapsedMs));
  if (check.timedOut) parts.push(check.timeoutReason || "timed out");
  else if (typeof check.exitCode === "number") parts.push(`exit ${check.exitCode}`);
  else if (check.state === "running") parts.push("running");
  return parts.join(" · ");
}

function checkMark(state: string): string {
  if (state === "passed") return "✓";
  if (state === "failed" || state === "blocked" || state === "exhausted") return "✕";
  if (state === "skipped") return "–";
  return "";
}
