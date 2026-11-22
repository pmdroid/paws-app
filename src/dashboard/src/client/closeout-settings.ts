import { journalCaught } from "../journal";
import { esc } from "./format";
import { renderMarkup } from "./theme";

const PATH = "/api/settings/closeout-summary";

type Select = { runner: string; always?: string[]; full_on?: string[]; max_selected?: number };
type Check = { id: string; ci?: string; since?: string[]; select?: Select };
type Rerun = {
  conflict?: { run?: string[]; reviews: boolean };
  ci?: { run: "all" | "failed" };
};
export type CloseoutSummaryEntry =
  | { repository: string; commit: string; rerun: Rerun | null; checks: Check[] }
  | { repository: string; commit?: string; error: string };

const SELECTS_BY: Record<string, string> = {
  bun: "Test file",
  vitest: "Test file",
  jest: "Test file",
  pytest: "Test file",
  go: "Package",
  cargo: "Crate",
  nextest: "Crate",
};

const SKIP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/></svg>';

const code = (value: string) => `<code>${esc(value)}</code>`;
const list = (values: string[] | undefined) =>
  values?.length ? values.map(code).join(" ") : '<span class="sub">None</span>';
const everything = '<p class="text-sm">Every check runs again.</p>';

function header(entry: CloseoutSummaryEntry): string {
  const commit = entry.commit;
  const link = commit
    ? `<a href="https://github.com/${esc(entry.repository)}/blob/${esc(commit)}/.agents/closeout.yaml" target="_blank" rel="noreferrer">Open closeout.yaml on GitHub</a>`
    : "";
  const at = commit
    ? `<p class="sub"><code>.agents/closeout.yaml</code> at main ${code(commit.slice(0, 7))}</p>`
    : "";
  return `<div class="between"><h2>${esc(entry.repository)}</h2>${link}</div>${at}`;
}

function conflictColumn(rerun: Rerun, checks: Check[]): string {
  const conflict = rerun.conflict;
  if (!conflict) return everything;
  const run = conflict.run;
  const checksPart = run
    ? `<div class="flex min-w-0 flex-col gap-1">${run.map((id) => `<div>${code(id)} <span class="sub">runs</span></div>`).join("")}${checks
        .filter((check) => !run.includes(check.id))
        .map((check) => `<div>${code(check.id)} <span class="sub">kept</span></div>`)
        .join("")}</div>`
    : everything;
  const reviews = conflict.reviews
    ? ""
    : `<span class="tag" data-reviews-skipped>${SKIP_ICON}Reviews are skipped</span><p class="sub">Only when the fix touches files the reviewed pull request already changed and it wasn't high risk.</p>`;
  return checksPart + reviews;
}

function ciColumn(rerun: Rerun, checks: Check[]): string {
  if (rerun.ci?.run !== "failed") return everything;
  const rows = checks
    .filter((check) => check.ci !== undefined)
    .map(
      (check) =>
        `<div>${code(check.id)} <span class="sub">CI</span> ${code(check.ci!)}${check.since ? ` <span class="sub">since</span> ${code(check.since.join(" "))}` : check.select ? ` <span class="sub">select</span> ${code(check.select.runner)}` : ""}</div>`,
    )
    .join("");
  return `<p class="text-sm">Only the check the failed CI job belongs to runs again, for what changed since the failed commit.</p>${rows ? `<div class="flex min-w-0 flex-col gap-1">${rows}</div>` : ""}`;
}

function rerunSnippet(checks: Check[]): string {
  const ids = checks.map((check) => check.id).join(", ");
  return `rerun:\n  conflict:\n    run: [${ids}]\n    reviews: false\n  ci:\n    run: failed`;
}

function reruns(rerun: Rerun | null, checks: Check[]): string {
  if (!rerun)
    return `<h3>Reruns</h3><p class="text-sm" data-reruns-everything>Reruns everything</p><p class="sub">Add this to .agents/closeout.yaml:</p><pre>${esc(rerunSnippet(checks))}</pre>`;
  const column = (title: string, body: string) =>
    `<div class="flex min-w-0 flex-col gap-2 rounded-base border border-border p-3"><h4 class="text-sm font-semibold">${title}</h4>${body}</div>`;
  return `<h3>Reruns</h3><div class="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-3" data-reruns>${column("After a conflict fix", conflictColumn(rerun, checks))}${column("After a failed CI check", ciColumn(rerun, checks))}${column("Every other restart", '<p class="text-sm">The whole plan runs; passed checks are kept while their files don\'t change.</p>')}</div>`;
}

function language(checks: Check[]): string | null {
  const test = checks.find((check) => check.id === "test" || check.id.endsWith("/test"));
  const tool = test?.since?.[0]?.split("/").pop();
  return tool === "bun" ? "bun" : null;
}

function selection(checks: Check[]): string {
  const selecting = checks.filter((check) => check.select);
  if (!selecting.length) {
    const lang = language(checks);
    const snippet =
      lang === "bun"
        ? `<p class="sub">Add this under the test check:</p><pre>${esc("select:\n  runner: bun\n  full_on: [bun.lock, package.json]\n  max_selected: 120")}</pre>`
        : "";
    return `<h3>Test selection</h3><p class="text-sm" data-no-select>No check narrows its tests</p>${snippet}`;
  }
  const rows = selecting
    .map((check) => {
      const select = check.select!;
      return `<tr><td>${code(check.id)}</td><td>${esc(select.runner)}</td><td>${SELECTS_BY[select.runner] ?? "Test file"}</td><td>${list(select.always)}</td><td>${list(select.full_on)}</td><td>${select.max_selected ?? '<span class="sub">None</span>'}</td></tr>`;
    })
    .join("");
  return `<h3>Test selection</h3><div class="min-w-0 overflow-x-auto [overflow-wrap:normal] [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap"><table data-select><thead><tr><th>Check</th><th>Runner</th><th>Selects by</th><th>Always runs</th><th>Full suite on</th><th>Max selected</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function renderCloseoutEntry(entry: CloseoutSummaryEntry): string {
  if ("error" in entry)
    return `<section class="card border-state-failed" data-closeout-error="${esc(entry.repository)}">${header(entry)}<p class="text-sm text-state-failed" role="status">${esc(entry.error)}</p><p class="text-sm">Closeout reruns everything until it's fixed.</p></section>`;
  return `<section class="card" data-closeout-repo="${esc(entry.repository)}">${header(entry)}${reruns(entry.rerun, entry.checks)}${selection(entry.checks)}</section>`;
}

export function createCloseoutSettings() {
  let root: HTMLElement | undefined;
  let engine: string | null = null;
  const paint = (html: string) => {
    if (root?.isConnected) renderMarkup(root, html);
  };
  const load = async () => {
    const target = root;
    try {
      if (!engine) throw new Error("Connect to your Paws dashboard to load settings.");
      const response = await fetch(new URL(PATH, engine), {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const data = (await response.json()) as {
        repositories?: CloseoutSummaryEntry[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
      if (target !== root) return;
      const entries = data.repositories ?? [];
      paint(
        entries.length
          ? entries.map(renderCloseoutEntry).join("")
          : '<p class="empty">No repositories are connected yet.</p>',
      );
    } catch (error) {
      journalCaught(error, "closeout-settings.load", null);
      if (target !== root) return;
      paint(
        `<p class="settings-message err" role="alert">${esc(error instanceof Error ? error.message : "Closeout settings are unavailable.")}</p>`,
      );
    }
  };
  return {
    mount(next: HTMLElement, nextEngine: string | null) {
      if (root === next && engine === nextEngine) return;
      root = next;
      engine = nextEngine;
      paint('<p class="sub">Loading Closeout settings…</p>');
      void load();
    },
  };
}
