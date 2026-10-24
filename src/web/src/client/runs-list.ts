import type { RunState, StatusItem, StatusRun, StatusSnapshot } from "../contract";
import {
  PHASE_NAMES,
  RUN_STATES,
  ago,
  esc,
  runLabel,
  safeHref,
  statePill,
  taskPhase,
  waitReason,
} from "./format";
import { routeHref } from "./route";

export const RUN_FILTER_KEYS = ["project", "lead", "status", "phase"] as const;
export type RunFilterKey = (typeof RUN_FILTER_KEYS)[number];
export type RunFilters = Record<RunFilterKey, string[]>;

const PHASE_KEYS = ["implementation", "closeout", "merge", "complete"] as const;
const NONE = "none";

interface RunRow {
  run: StatusRun;
  item: StatusItem | undefined;
  project: string;
  lead: string;
  status: RunState;
  phase: number;
}

export function parseRunFilters(search: string): RunFilters {
  const params = new URLSearchParams(search);
  const values = (key: RunFilterKey) => [...new Set(params.getAll(key))];
  return {
    project: values("project"),
    lead: values("lead"),
    status: values("status").filter((value) => (RUN_STATES as string[]).includes(value)),
    phase: values("phase").filter((value) => (PHASE_KEYS as readonly string[]).includes(value)),
  };
}

export function runFilterSearch(current: string, filters: RunFilters): string {
  const params = new URLSearchParams(current);
  for (const key of RUN_FILTER_KEYS) {
    params.delete(key);
    for (const value of filters[key]) params.append(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function runPhase(snapshot: StatusSnapshot, run: StatusRun): number {
  const item = snapshot.items.find((entry) => entry.id === run.itemId);
  const verdict = snapshot.verdicts.find((entry) => entry.itemId === run.itemId);
  return taskPhase(item?.state ?? null, run.state, verdict?.decision).current;
}

export function renderRunsList(
  snapshot: StatusSnapshot,
  runs: readonly StatusRun[],
  search: string,
): string {
  const filters = parseRunFilters(search);
  const rows = runs.map((run) => runRow(snapshot, run));
  const shown = rows.filter((row) => matches(row, filters));
  const active = RUN_FILTER_KEYS.some((key) => filters[key].length > 0);
  const clear = `<a class="btn" href="${routeHref({ view: "runs", id: null })}">Clear filters</a>`;
  const summary = active ? `${shown.length} of ${rows.length} runs` : `${rows.length} runs`;
  return `<form class="run-filters" aria-label="Filter runs" data-run-filters>
      ${filterGroup("project", "Project", projectOptions(rows), filters.project)}
      ${filterGroup("lead", "Lead", leadOptions(rows), filters.lead)}
      ${filterGroup(
        "status",
        "Status",
        RUN_STATES.map((state) => ({ value: state, label: runLabel(state) })),
        filters.status,
      )}
      ${filterGroup(
        "phase",
        "Phase",
        PHASE_KEYS.map((value, index) => ({ value, label: PHASE_NAMES[index]! })),
        filters.phase,
      )}
      ${active && shown.length ? clear : ""}
    </form>
    <p class="muted" role="status">${esc(summary)}</p>
    ${
      shown.length
        ? `<table class="run-table"><thead><tr><th class="run-cell">Issue</th><th class="run-cell hide-phone">Project</th><th class="run-cell hide-phone">Lead</th><th class="run-cell">Phase</th><th class="run-cell hide-phone">Status</th><th class="run-cell hide-phone">Started</th><th class="run-cell">Pull request</th></tr></thead><tbody>${shown.map((row) => rowMarkup(snapshot, row)).join("")}</tbody></table>`
        : `<div class="empty run-empty"><p>No runs match these filters.</p>${clear}</div>`
    }`;
}

function runRow(snapshot: StatusSnapshot, run: StatusRun): RunRow {
  const item = snapshot.items.find((entry) => entry.id === run.itemId);
  return {
    run,
    item,
    project: item?.project?.id ?? NONE,
    lead: item?.owner ?? NONE,
    status: run.state,
    phase: runPhase(snapshot, run),
  };
}

function matches(row: RunRow, filters: RunFilters): boolean {
  const facts: Record<RunFilterKey, string> = {
    project: row.project,
    lead: row.lead,
    status: row.status,
    phase: PHASE_KEYS[row.phase]!,
  };
  return RUN_FILTER_KEYS.every((key) => !filters[key].length || filters[key].includes(facts[key]));
}

function projectOptions(rows: readonly RunRow[]): { value: string; label: string }[] {
  const projects = new Map<string, string>();
  for (const row of rows) if (row.item?.project) projects.set(row.project, row.item.project.name);
  return [
    ...[...projects]
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    { value: NONE, label: "No project" },
  ];
}

function leadOptions(rows: readonly RunRow[]): { value: string; label: string }[] {
  const leads = [...new Set(rows.flatMap((row) => (row.item?.owner ? [row.item.owner] : [])))];
  return [
    ...leads
      .sort((left, right) => left.localeCompare(right))
      .map((lead) => ({
        value: lead,
        label: lead,
      })),
    ...(rows.some((row) => !row.item?.owner) ? [{ value: NONE, label: "No lead" }] : []),
  ];
}

function filterGroup(
  key: RunFilterKey,
  label: string,
  options: readonly { value: string; label: string }[],
  selected: readonly string[],
): string {
  const count = options.filter((option) => selected.includes(option.value)).length;
  return `<details class="run-filter" name="run-filter" data-run-filter-group="${key}"><summary class="btn${count ? " on" : ""}">${esc(label)}${count ? ` · ${count}` : ""}</summary><fieldset class="run-filter-menu"><legend class="sr-only">${esc(label)}</legend>${options
    .map(
      (option) =>
        `<label><input type="checkbox" name="${key}" value="${esc(option.value)}" data-run-filter${selected.includes(option.value) ? " checked" : ""}>${esc(option.label)}</label>`,
    )
    .join("")}</fieldset></details>`;
}

function rowMarkup(snapshot: StatusSnapshot, row: RunRow): string {
  const { run, item } = row;
  const pr = item?.pr ? safeHref(item.pr.url) : null;
  const waiting = item ? waitReason(snapshot, item) : null;
  return `<tr data-run-id="${esc(run.id)}"><td class="run-cell"><a class="work-title" href="${routeHref({ view: "issues", id: run.itemId })}"><span class="lin-id">${esc(run.itemId)}</span> <b>${esc(item?.title ?? run.id)}</b></a>${waiting ? `<div class="muted" data-wait-reason>${esc(waiting)}</div>` : ""}</td><td class="run-cell hide-phone">${esc(item?.project?.name ?? "No project")}</td><td class="run-cell hide-phone">${esc(item?.owner ?? "")}</td><td class="run-cell"><span class="tag" data-run-phase>${esc(PHASE_NAMES[row.phase]!)}</span></td><td class="run-cell hide-phone">${statePill(run.state, runLabel(run.state))}</td><td class="run-cell hide-phone"><span class="muted">${esc(ago(run.startedAt, snapshot.generatedAt))}</span></td><td class="run-cell">${pr && item?.pr ? `<a href="${esc(pr)}" target="_blank" rel="noopener noreferrer" aria-label="Pull request ${item.pr.number}">#${item.pr.number}</a>` : ""}</td></tr>`;
}
