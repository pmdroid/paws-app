import { renderFindingGroups, findingGroupsRequest } from "./finding-groups";
import type { FindingGroupAction, FindingGroupsResponse } from "../finding-groups";
import { journalCaught } from "../journal";
import {
  DEFAULT_FINDING_FILTER,
  DISMISS_REASON_LIMIT,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDINGS_API_PATH,
  findingQuery,
  parseFindingQuery,
  type FindingAction,
  type FindingFilter,
  type FindingStatus,
  type FindingView,
  type FindingsResponse,
} from "../findings";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { routeHref } from "./route";
import { renderMarkup } from "./theme";

export type FindingsView = {
  data: FindingsResponse | null;
  groups?: FindingGroupsResponse | null;
  groupsError?: string | null;
  mode?: "findings" | "groups";
  filter: FindingFilter;
  busy: boolean;
  error: string | null;
  /** The last change's outcome, read out to screen readers. */
  message: string;
  /** Whether this page can change findings: it reads a live engine on its own origin. */
  local: boolean;
};

const STATUS_LABEL: Record<FindingStatus, string> = {
  open: "Open",
  filed: "Filed",
  dismissed: "Dismissed",
  gone: "Gone",
};

/** The Findings page: counts per severity, the filters, then one row per finding. */
export function renderFindings(view: FindingsView): string {
  const tabs = `<div class="row" role="group" aria-label="Findings view"><button class="btn${view.mode !== "groups" ? " on" : ""}" type="button" data-findings-mode="findings" aria-pressed="${view.mode !== "groups"}">Findings</button><button class="btn${view.mode === "groups" ? " on" : ""}" type="button" data-findings-mode="groups" aria-pressed="${view.mode === "groups"}">Groups</button></div>`;
  if (view.mode === "groups")
    return `${tabs}${(view.groupsError ?? view.error) ? `<p role="alert" class="checkout-error">${esc(view.groupsError ?? view.error ?? "")} <button class="btn" data-findings-action="reload">Retry</button></p>` : ""}<p role="status">${esc(view.message)}</p>${renderFindingGroups(view.groups ?? null, view.local, view.busy)}`;
  const intro = `<p>Review findings that did not block a merge: in code the change did not touch, or below the review's <code>failOn</code>. Each is listed once, however many issues reported it.</p>`;
  const message = `<p class="muted" role="status" data-findings-message="">${esc(view.message)}</p>`;
  if (view.error && !view.data)
    return `${tabs}${intro}<div class="empty" role="status"><div>Findings unavailable</div>${esc(view.error)}<div><button class="btn primary" type="button" data-findings-action="reload">Retry</button></div></div>`;
  if (!view.data) return `${tabs}${intro}<div class="empty" role="status">Loading findings…</div>`;
  const data = view.data;
  const error = view.error ? `<p class="checkout-error" role="alert">${esc(view.error)}</p>` : "";
  const list = data.findings.length
    ? `<ul class="issue-list finding-list" role="list" aria-label="Findings">${data.findings.map((finding) => row(finding, view.local)).join("")}</ul>`
    : `<div class="empty" role="status">${emptyLine(view.filter)}</div>`;
  const cut =
    data.total > data.findings.length
      ? `<p class="muted">Showing the ${data.findings.length} seen last of ${data.total}. Narrow the filters to see the rest.</p>`
      : "";
  return `${tabs}${intro}${counts(data, view.filter)}${filters(data, view.filter)}${error}${message}${list}${cut}`;
}

function counts(data: FindingsResponse, filter: FindingFilter): string {
  const label = filter.status === "all" ? "" : `${STATUS_LABEL[filter.status].toLowerCase()} `;
  return `<div class="row findings-counts" role="group" aria-label="Findings per severity">${FINDING_SEVERITIES.map(
    (severity) =>
      `<button type="button" class="btn sm${filter.severity === severity ? " on" : ""}" data-findings-severity="${severity}" aria-pressed="${filter.severity === severity}"><span>${severity}</span> <b>${data.counts[severity]}</b><span class="sr-only"> ${label}finding${data.counts[severity] === 1 ? "" : "s"}</span></button>`,
  ).join("")}</div>`;
}

function filters(data: FindingsResponse, filter: FindingFilter): string {
  const select = (
    name: keyof FindingFilter,
    label: string,
    any: string | null,
    choices: readonly { value: string; label: string }[],
  ) =>
    `<label class="field"><span>${label}</span><select name="${name}" data-findings-filter="${name}">${any === null ? "" : `<option value="">${esc(any)}</option>`}${choices
      .map(
        (choice) =>
          `<option value="${esc(choice.value)}"${choice.value === filter[name] ? " selected" : ""}>${esc(choice.label)}</option>`,
      )
      .join("")}</select></label>`;
  const plain = (values: readonly string[]) => values.map((value) => ({ value, label: value }));
  const repositories = withSelected(data.repositories, filter.repository);
  const reviews = withSelected(data.reviews, filter.review);
  return `<form class="settings-controls findings-filters" role="search" aria-label="Filter findings" data-findings-filters="">
    ${select("repository", "Repository", "Any repository", plain(repositories))}
    ${select("severity", "Severity", "Any severity", plain(FINDING_SEVERITIES))}
    ${select("review", "Review", "Any review", plain(reviews))}
    ${select("status", "Status", null, [
      ...FINDING_STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] })),
      { value: "all", label: "Any status" },
    ])}
    <label class="field"><span>Path starts with</span><input name="path" type="search" value="${esc(filter.path)}" placeholder="src/auth/" autocomplete="off" spellcheck="false" data-findings-filter="path" /></label>
    <button class="btn" type="submit">Apply</button>
  </form>`;
}

/** A filter value the list no longer offers stays selectable, so the form shows what is applied. */
function withSelected(values: readonly string[], selected: string): string[] {
  return selected && !values.includes(selected) ? [...values, selected] : [...values];
}

function emptyLine(filter: FindingFilter): string {
  const filtered = Object.entries(filter).some(
    ([key, value]) => value !== DEFAULT_FINDING_FILTER[key as keyof FindingFilter],
  );
  if (filtered) return "No findings match these filters.";
  return "No open findings. Closeout records them here when it accepts a head.";
}

function row(finding: FindingView, local: boolean): string {
  const place = finding.lines ? `${finding.path}:${finding.lines}` : finding.path;
  const severity = `<span class="tag ${finding.severity === "P0" || finding.severity === "P1" ? "err" : finding.severity === "P2" ? "warn" : ""}">${esc(finding.severity)}</span>`;
  const status =
    finding.status === "open"
      ? ""
      : `<span class="tag ${finding.status === "gone" ? "done" : ""}">${esc(STATUS_LABEL[finding.status])}</span>`;
  const items = finding.items
    .map(
      (item) =>
        `<a href="${routeHref({ view: "issues", id: item.id })}" title="${esc(item.title)}"><span class="lin-id">${esc(item.id)}</span></a>`,
    )
    .join(", ");
  const reported = `Reported by ${finding.itemCount} issue${finding.itemCount === 1 ? "" : "s"}${items ? `: ${items}` : ""}`;
  const seen =
    finding.firstSeenAt === finding.lastSeenAt
      ? `Seen ${esc(utcDate(finding.firstSeenAt))} UTC`
      : `First seen ${esc(utcDate(finding.firstSeenAt))} UTC, last seen ${esc(utcDate(finding.lastSeenAt))} UTC`;
  return `<li class="finding" id="finding-${finding.id}" data-finding="${finding.id}" data-finding-status="${finding.status}">
    <div class="issue-row"><div class="min-w-0"><div class="row">${severity}<code>${esc(place)}</code>${status}</div><p class="finding-text">${esc(finding.text)}</p></div>${actions(finding, local)}
    <div class="issue-facts finding-facts"><span>${esc(finding.repository)}</span><span>${esc(finding.review)}</span><span>${esc(finding.bugClass)}</span><span>${esc(finding.why)}</span><span>${reported}</span><span>${seen}</span></div></div>
    ${statusLine(finding)}
  </li>`;
}

function statusLine(finding: FindingView): string {
  if (finding.status === "open" && finding.statusAt === null) return "";
  const when = finding.statusAt ? ` ${esc(utcDate(finding.statusAt))} UTC` : "";
  const who = finding.statusBy ? ` by ${esc(finding.statusBy)}` : " by Paws";
  if (finding.status === "filed")
    return `<p class="muted">Filed as <span class="lin-id">${esc(finding.filedIssue ?? "")}</span>${who}${when}.</p>`;
  if (finding.status === "dismissed")
    return `<p class="muted">Dismissed${who}${when}: ${esc(finding.statusReason ?? "")}</p>`;
  if (finding.status === "gone")
    return `<p class="muted">Gone${when}: ${esc(finding.statusReason ?? "")}</p>`;
  return `<p class="muted">Reopened${who}${when}.</p>`;
}

function actions(finding: FindingView, local: boolean): string {
  if (!local) return "";
  if (finding.status === "dismissed")
    return `<button class="btn sm" type="button" data-findings-action="reopen" data-finding-id="${finding.id}">Reopen</button>`;
  if (finding.status === "filed") return "";
  return `<details class="finding-dismiss"><summary class="btn sm">Dismiss</summary>
    <form class="col" data-finding-dismiss="${finding.id}">
      <label class="field"><span>Why dismiss it?</span><input name="reason" type="text" required maxlength="${DISMISS_REASON_LIMIT}" placeholder="Intended behavior, tracked elsewhere…" autocomplete="off" /></label>
      <button class="btn primary sm" type="submit">Dismiss finding</button>
    </form></details>`;
}

/** "2026-10-28 09:30": findings span days, so the date shows with the time. */
function utcDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 16).replace("T", " ");
}

/** `GET /api/findings` with the filter, or a dismiss or reopen with the CSRF token. */
export async function findingsRequest(
  engine: string,
  request: { filter: FindingFilter } | { action: FindingAction; csrf: string },
  fetchImpl: typeof fetch = fetch,
): Promise<FindingsResponse | { finding: FindingView }> {
  const read = "filter" in request;
  const response = await fetchImpl(
    new URL(`${FINDINGS_API_PATH}${read ? findingQuery(request.filter) : ""}`, engine),
    read
      ? { cache: "no-store", headers: { Accept: "application/json" } }
      : {
          method: "POST",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-paws-csrf": request.csrf,
          },
          body: JSON.stringify(request.action),
        },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      typeof body === "object" && body && "error" in body && typeof body.error === "string"
        ? body.error
        : `Request failed (${response.status}).`,
      { cause: response.status },
    );
  return body as FindingsResponse | { finding: FindingView };
}

/** Mounts the Findings page into `#findings-page` and keeps its filters in the address bar. */
export function createFindings(): {
  mount(root: HTMLElement, engine: string | null, source: string | undefined): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let generation = 0;
  let groupsGeneration = 0;
  let view: FindingsView = {
    data: null,
    filter: DEFAULT_FINDING_FILTER,
    busy: false,
    error: null,
    message: "",
    local: false,
  };
  const paint = () => {
    if (root) renderMarkup(root, renderFindings(view));
  };
  const load = async () => {
    if (!engine) return;
    const started = ++generation;
    view.busy = true;
    try {
      const data = (await findingsRequest(engine, { filter: view.filter })) as FindingsResponse;
      if (started !== generation) return;
      view.data = data;
      view.error = null;
    } catch (error) {
      journalCaught(error, "findings.createFindings.load", null);
      if (started === generation)
        view.error = error instanceof Error ? error.message : "Could not load findings.";
    } finally {
      if (started === generation) {
        view.busy = false;
        paint();
      }
    }
  };
  const loadGroups = async () => {
    if (!engine) return;
    const mounted = root;
    const started = ++groupsGeneration;
    try {
      const groups = (await findingGroupsRequest(engine)) as FindingGroupsResponse;
      if (root !== mounted || started !== groupsGeneration) return;
      view.groups = groups;
      view.groupsError = null;
    } catch (error) {
      journalCaught(error, "findings.loadGroups", null);
      if (root === mounted && started === groupsGeneration)
        view.groupsError = "Could not load groups. Retry to refresh groups.";
    }
    if (root === mounted && started === groupsGeneration) paint();
  };
  const filterTo = (filter: FindingFilter) => {
    view.filter = filter;
    view.message = "";
    const url = new URL(location.href);
    url.search = findingQuery(filter);
    history.replaceState(history.state, "", url);
    void load();
  };
  const act = async (action: FindingAction) => {
    if (!engine || view.busy) return;
    view.busy = true;
    try {
      await findingsRequest(engine, { action, csrf: readCsrfToken(document) });
      view.message = action.action === "dismiss" ? "Finding dismissed." : "Finding reopened.";
      view.error = null;
    } catch (error) {
      journalCaught(error, "findings.createFindings.act", null);
      view.error = error instanceof Error ? error.message : "The change failed. Try again.";
    } finally {
      view.busy = false;
    }
    await load();
    await loadGroups();
  };
  const groupAct = async (action: FindingGroupAction) => {
    if (!engine || view.busy) return;
    view.busy = true;
    paint();
    try {
      await findingGroupsRequest(engine, action, readCsrfToken(document));
      view.message =
        action.action === "run" ? "Grouping queued. Refresh to see the result." : "Group updated.";
      view.error = null;
    } catch (error) {
      journalCaught(error, "findings.groupAct", null);
      view.error = error instanceof Error ? error.message : "The group action failed.";
    } finally {
      view.busy = false;
      paint();
    }
    await loadGroups();
    if (!view.error) await load();
  };
  const formFilter = (form: HTMLFormElement): FindingFilter =>
    parseFindingQuery(
      new URLSearchParams(
        [...new FormData(form).entries()].map(([key, value]) => [key, String(value)]),
      ),
    );
  const click = (event: Event) => {
    const target = event.target as Element;
    const mode = target.closest<HTMLButtonElement>("[data-findings-mode]");
    if (mode) {
      view.mode = mode.dataset.findingsMode as "findings" | "groups";
      paint();
      return;
    }
    const finding = target.closest<HTMLAnchorElement>("[data-group-finding]");
    if (finding) {
      event.preventDefault();
      view.mode = "findings";
      view.filter = { ...DEFAULT_FINDING_FILTER, status: "all" };
      void load().then(() =>
        root?.querySelector(`#finding-${finding.dataset.groupFinding}`)?.scrollIntoView(),
      );
      return;
    }
    const group = target.closest<HTMLButtonElement>("[data-group-action]");
    if (group) {
      const action = group.dataset.groupAction as "run" | "file" | "add";
      void groupAct(action === "run" ? { action } : { action, id: group.dataset.groupId! });
      return;
    }
    const severity = target.closest<HTMLButtonElement>("[data-findings-severity]");
    if (severity) {
      const value = severity.dataset.findingsSeverity as FindingFilter["severity"];
      filterTo({ ...view.filter, severity: view.filter.severity === value ? "" : value });
      return;
    }
    const button = target.closest<HTMLButtonElement>("[data-findings-action]");
    if (!button) return;
    if (button.dataset.findingsAction === "reload") {
      void load();
      void loadGroups();
    }
    if (button.dataset.findingsAction === "reopen")
      void act({ id: Number(button.dataset.findingId), action: "reopen" });
  };
  const change = (event: Event) => {
    const target = event.target as HTMLElement;
    if (!(target instanceof HTMLSelectElement) || target.dataset.findingsFilter === undefined)
      return;
    const form = target.closest<HTMLFormElement>("form[data-findings-filters]");
    if (form) filterTo(formFilter(form));
  };
  const submit = (event: Event) => {
    const form = event.target as HTMLFormElement;
    if (form.dataset.findingsFilters !== undefined) {
      event.preventDefault();
      filterTo(formFilter(form));
      return;
    }
    if (form.dataset.groupDismiss !== undefined) {
      event.preventDefault();
      void groupAct({
        action: "dismiss",
        id: form.dataset.groupDismiss,
        reason: String(new FormData(form).get("reason") ?? "").trim(),
      });
      return;
    }
    const id = form.dataset.findingDismiss;
    if (id === undefined) return;
    event.preventDefault();
    const reason = String(new FormData(form).get("reason") ?? "").trim();
    if (!reason) {
      view.error = "Say why the finding is dismissed.";
      paint();
      return;
    }
    void act({ id: Number(id), action: "dismiss", reason });
  };
  return {
    mount(next, nextEngine, source) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root?.removeEventListener("change", change);
      root?.removeEventListener("submit", submit);
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      root.addEventListener("change", change);
      root.addEventListener("submit", submit);
      groupsGeneration++;
      view = {
        data: null,
        filter: parseFindingQuery(location.search),
        busy: false,
        error: engine ? null : "Connect to your Paws dashboard to see findings.",
        message: "",
        local: engine !== null && new URL(engine).origin === location.origin && source === "live",
      };
      paint();
      void load();
      void loadGroups();
    },
  };
}
