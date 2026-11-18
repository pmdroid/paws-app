import { journalCaught } from "../journal";
import type {
  ContextView,
  ContextViewDetail,
  ContextViewRecord,
  ContextViewSource,
  ContextViewSummary,
} from "../project-context";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { renderMarkup } from "./theme";

export type ContextRoute = { view: "context"; kind: "project"; id: string };

export type ContextQuery = {
  tab: "summary" | "records";
  q: string;
  offset: number;
  record: string | null;
};

type Phase = "loading" | "ready" | "unavailable" | "error";

export type ContextForget = { id: string; phase: "confirm" | "sending" | "error" };

export type ContextState = {
  query: ContextQuery;
  phase: Phase;
  view: ContextView | null;
  detail: { phase: Phase; data: ContextViewDetail | null } | null;
  forget?: ContextForget | null;
};

export const CONTEXT_FORGET_PROMPT = "Forget this entry? Agents stop seeing it on their next turn.";

export function contextQuery(search: string): ContextQuery {
  const params = new URLSearchParams(search);
  const offset = Number(params.get("offset") ?? 0);
  const record = params.get("record");
  return {
    tab: params.get("tab") === "records" ? "records" : "summary",
    q: (params.get("q") ?? "").slice(0, 200),
    offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
    record: record && /^[\w-]{1,100}$/.test(record) ? record : null,
  };
}

export function contextSearch(query: ContextQuery): string {
  const params = new URLSearchParams();
  if (query.tab !== "summary") params.set("tab", query.tab);
  if (query.q) params.set("q", query.q);
  if (query.offset) params.set("offset", String(query.offset));
  if (query.record) params.set("record", query.record);
  const search = params.toString();
  return search ? `?${search}` : "";
}

const KIND: Record<string, [string, string]> = {
  decision: ["Decision", "ok"],
  unresolved_question: ["Open question", "warn"],
  verified_fact: ["Verified fact", ""],
  reported_fact: ["Reported fact", ""],
  inference: ["Inference", ""],
};

const SUMMARY_STATE: Record<ContextViewSummary["state"], [string, string]> = {
  current: ["Current", "ok"],
  stale: ["Stale", "warn"],
  rebuilding: ["Rebuilding", "warn"],
};

const when = (ms: number | null) =>
  ms === null ? "never" : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

const badge = ([label, tone]: [string, string]) => `<span class="st ${tone}">${esc(label)}</span>`;

function safeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return ["https:", "http:"].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}

function sourceLine(source: ContextViewSource): string {
  const label = esc(source.label || "Source");
  const url = safeUrl(source.url);
  const name = url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : label;
  return `${name} · <code title="${esc(source.revision)}">${esc(source.revision.slice(0, 18))}</code>`;
}

function forgetControl(item: ContextViewRecord, forget: ContextForget | null): string {
  if (!item.forgettable) return "";
  if (forget?.id !== item.id)
    return `<button class="btn sm ghost" type="button" data-context-forget="${esc(item.id)}" aria-label="Forget this entry">Forget</button>`;
  const sending = forget.phase === "sending";
  const failed =
    forget.phase === "error"
      ? `<p role="alert">Paws could not forget this entry. Try again.</p>`
      : "";
  return `<div class="row context-forget" role="group" aria-label="Confirm forgetting this entry"><span>${esc(CONTEXT_FORGET_PROMPT)}</span><button class="btn danger sm" type="button" data-context-forget-confirm="${esc(item.id)}"${sending ? " disabled" : ""}>${sending ? "Forgetting…" : "Forget"}</button><button class="btn sm ghost" type="button" data-context-forget-cancel=""${sending ? " disabled" : ""}>Cancel</button></div>${failed}`;
}

function recordRow(
  item: ContextViewRecord,
  selected: string | null,
  forget: ContextForget | null,
): string {
  const status =
    item.status === "superseded"
      ? badge(["Superseded", "bad"])
      : item.corrected
        ? badge(["Corrected", "ok"])
        : "";
  const current = item.id === selected;
  return `<li class="context-record" aria-current="${current}"><div class="row">${badge(KIND[item.classification] ?? ["Record", ""])}${status}<button class="btn sm ml-auto" type="button" data-context-record="${esc(item.id)}" aria-pressed="${current}" aria-label="Provenance for this record">Provenance</button>${forget?.id === item.id ? "" : forgetControl(item, null)}</div><p>${esc(item.text)}</p><p class="muted">${sourceLine(item.source)} · ${when(item.observedAt)}</p>${forget?.id === item.id ? forgetControl(item, forget) : ""}</li>`;
}

const recordList = (
  items: ContextViewRecord[],
  selected: string | null,
  label: string,
  forget: ContextForget | null,
) =>
  `<ul class="improvement-rows" aria-label="${label}">${items.map((item) => recordRow(item, selected, forget)).join("")}</ul>`;

const card = (title: string, body: string, extra = "") =>
  `<section class="improvement-detail"><div class="improvement-head"><h2>${title}</h2>${extra}</div>${body}</section>`;

function summaryTab(
  view: ContextView,
  selected: string | null,
  forget: ContextForget | null,
): string {
  const notice = `<p class="muted">Paws derived this summary from the records it keeps. It is not an authoritative decision and not the exact prompt any agent received.</p>`;
  const summaries = view.summaries.length
    ? view.summaries
        .map((summary) =>
          card(
            "Summary",
            `${notice}${summary.state === "current" ? "" : `<p role="status">${summary.state === "stale" ? "Records it covered changed since it was built. Paws rebuilds it at the next session." : "Paws is rebuilding this summary."}</p>`}<p class="whitespace-pre-wrap">${esc(summary.body)}</p>`,
            `${badge(SUMMARY_STATE[summary.state])}<span class="improvement-period">v${summary.version}</span>`,
          ),
        )
        .join("")
    : card("Summary", `<p class="muted">Paws has not built a summary for this project yet.</p>`);
  const open = (title: string, items: ContextViewRecord[], none: string) =>
    card(
      title,
      items.length ? recordList(items, selected, title, forget) : `<p class="muted">${none}</p>`,
    );
  return `${summaries}${open("Decisions", view.decisions, "No decisions retained.")}${open("Open questions", view.questions, "No open questions retained.")}`;
}

function recordsTab(
  view: ContextView,
  selected: string | null,
  forget: ContextForget | null,
): string {
  const { page } = view;
  const form = `<form class="row" role="search" aria-label="Search stored context" data-context-search=""><label><span class="sr-only">Search records</span><input name="q" type="search" value="${esc(page.search)}" placeholder="Search records" autocomplete="off" /></label><button class="btn sm" type="submit">Search</button></form>`;
  const empty = page.search
    ? "No records match this search."
    : "Paws has not retained context for this project yet.";
  const pager =
    page.offset > 0 || page.more
      ? `<div class="row" role="group" aria-label="Pages"><button class="btn sm" type="button" data-context-page="prev"${page.offset > 0 ? "" : " disabled"}>Previous</button><span class="muted">Records ${page.offset + 1}–${page.offset + view.records.length}</span><button class="btn sm" type="button" data-context-page="next"${page.more ? "" : " disabled"}>Next</button></div>`
      : "";
  return `${form}${view.records.length ? recordList(view.records, selected, "Stored context", forget) : `<div class="empty" role="status">${empty}</div>`}${pager}`;
}

function provenance(detail: ContextState["detail"]): string {
  if (!detail)
    return `<p class="muted">Choose Provenance on a record to see where it came from.</p>`;
  if (detail.phase === "loading") return `<p role="status">Loading provenance…</p>`;
  if (detail.phase !== "ready" || !detail.data)
    return `<p role="${detail.phase === "error" ? "alert" : "status"}">${detail.phase === "error" ? "Could not load this record." : "This record is not available."}</p>`;
  const { record: item, versions } = detail.data;
  const facts: [string, string][] = [
    ["Source", sourceLine(item.source)],
    ["Recorded", esc(when(item.observedAt))],
    ["Actor", esc(item.actorId ?? "Paws")],
    ["Version", `v${item.version}${item.status === "superseded" ? " · superseded" : ""}`],
  ];
  if (item.correctedBy) facts.push(["Corrected by", esc(item.correctedBy)]);
  return `<p class="whitespace-pre-wrap">${esc(item.body)}</p><dl class="improvement-fields">${facts.map(([term, value]) => `<div class="improvement-field"><dt class="muted">${term}</dt><dd>${value}</dd></div>`).join("")}</dl>${versions.length > 1 ? `<ol class="improvement-history" aria-label="Versions">${versions.map((version) => `<li>v${version.version} · ${esc(version.status)} · ${esc(when(version.observedAt))}</li>`).join("")}</ol>` : ""}`;
}

function compaction(view: ContextView): string {
  const summary = view.summaries[0];
  if (!summary) return `<p class="muted">No summary has been built.</p>`;
  const sources = summary.sources.length
    ? `<ul class="improvement-history" aria-label="Preserved sources">${summary.sources.map((item) => `<li>${sourceLine(item)}</li>`).join("")}</ul>`
    : "";
  return `<dl class="improvement-fields">${[
    ["Version", `v${summary.version} · ${esc(when(summary.builtAt))}`],
    ["State", badge(SUMMARY_STATE[summary.state])],
    ["Records covered", String(summary.covered)],
    ["Decisions kept", String(summary.decisions)],
    ["Open questions kept", String(summary.questions)],
  ]
    .map(
      ([term, value]) =>
        `<div class="improvement-field"><dt class="muted">${term}</dt><dd>${value}</dd></div>`,
    )
    .join("")}</dl>${sources}`;
}

export function renderContext(state: ContextState): string {
  if (state.phase === "loading")
    return `<div class="empty" role="status" aria-live="polite">Loading project context…</div>`;
  if (state.phase === "error")
    return `<div class="empty" role="alert"><div>Could not load project context</div>Paws could not read it just now.<div><button class="btn primary" type="button" data-context-action="retry">Retry</button></div></div>`;
  if (state.phase === "unavailable" || !state.view)
    return `<div class="empty" role="status"><div>Context unavailable</div>This context does not exist, or you cannot read it.</div>`;
  const { view, query } = state;
  const forget = state.forget ?? null;
  const editable = [...view.decisions, ...view.questions, ...view.records].some(
    (item) => item.forgettable,
  );
  const url = safeUrl(view.scope.url);
  const head = card(
    esc(view.scope.name ?? "Linear project"),
    `<p class="muted">Project <code>${esc(view.scope.id)}</code>${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open in Linear</a>` : ""} · updated ${esc(when(view.updatedAt))}${view.summaries[0] ? ` · summary v${view.summaries[0].version}` : ""}</p>`,
    editable ? "" : `<span class="tag">Read-only</span>`,
  );
  const tab = (id: ContextQuery["tab"], label: string) =>
    `<button class="seg" type="button" data-context-tab="${id}" aria-pressed="${query.tab === id}">${label}</button>`;
  const tabs = `<div class="segmented" role="group" aria-label="Context sections">${tab("summary", "Summary")}${tab("records", "Stored context")}</div>`;
  const main =
    query.tab === "records"
      ? recordsTab(view, query.record, forget)
      : summaryTab(view, query.record, forget);
  const side = `${card("Provenance", provenance(state.detail))}${card("Compaction", compaction(view))}`;
  return `${head}${tabs}<div class="context-layout"><div class="improvement-detail-pane">${main}</div><aside class="improvement-detail-pane" aria-label="Provenance and compaction">${side}</aside></div>`;
}

type Answer<T> = { phase: Phase; data: T | null };

async function read<T>(url: URL, signal: AbortSignal, fetcher: typeof fetch): Promise<Answer<T>> {
  try {
    const response = await fetcher(url, { signal, credentials: "same-origin", cache: "no-store" });
    if (response.status === 404 || response.status === 400)
      return { phase: "unavailable", data: null };
    if (!response.ok) return { phase: "error", data: null };
    const body = (await response.json()) as Record<string, T>;
    return { phase: "ready", data: body.view ?? body.detail ?? null };
  } catch (error) {
    if (signal.aborted) throw error;
    journalCaught(error, "projectContext.read", null);
    return { phase: "error", data: null };
  }
}

export function createProjectContext(options: {
  go: (search: string) => void;
  fetch?: typeof fetch;
  search?: () => string;
  csrf?: () => string;
}) {
  const fetcher = options.fetch ?? fetch;
  const csrf = options.csrf ?? (() => readCsrfToken(document));
  const search = options.search ?? (() => location.search);
  let root: HTMLElement | null = null;
  let engine = "";
  let scope = "";
  let listKey: string | null = null;
  let detailKey: string | null = null;
  let state: ContextState | null = null;
  let list: AbortController | null = null;
  let detail: AbortController | null = null;
  const paint = () => {
    if (root && state) renderMarkup(root, renderContext(state));
  };
  const scopeUrl = (suffix = "") => new URL(`/api/context/${scope}${suffix}`, engine);
  const loadList = async () => {
    list?.abort();
    const controller = (list = new AbortController());
    const query = state!.query;
    state = { ...state!, phase: "loading", view: null };
    paint();
    const url = scopeUrl();
    if (query.q) url.searchParams.set("q", query.q);
    if (query.offset) url.searchParams.set("offset", String(query.offset));
    const answer = await read<ContextView>(url, controller.signal, fetcher).catch(() => null);
    if (!answer || controller !== list || !state) return;
    state = { ...state, phase: answer.phase, view: answer.data };
    if (answer.phase !== "ready") state.detail = null;
    paint();
  };
  const loadDetail = async (id: string | null) => {
    detail?.abort();
    detail = null;
    if (!state) return;
    state.detail = id ? { phase: "loading", data: null } : null;
    paint();
    if (!id) return;
    const controller = (detail = new AbortController());
    const answer = await read<ContextViewDetail>(
      scopeUrl(`/records/${encodeURIComponent(id)}`),
      controller.signal,
      fetcher,
    ).catch(() => null);
    if (!answer || controller !== detail || !state) return;
    state.detail = answer;
    paint();
  };
  const go = (change: Partial<ContextQuery>) =>
    options.go(contextSearch({ ...state!.query, ...change }));
  const forgetEntry = async (id: string) => {
    if (!state || state.forget?.phase === "sending") return;
    const sending = (state.forget = { id, phase: "sending" });
    paint();
    let ok = false;
    try {
      const response = await fetcher(scopeUrl(`/records/${encodeURIComponent(id)}/forget`), {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "x-paws-csrf": csrf() },
      });
      ok = response.ok;
    } catch (error) {
      journalCaught(error, "projectContext.forget", null);
    }
    if (!state || state.forget !== sending) return;
    if (!ok) {
      state.forget = { id, phase: "error" };
      return paint();
    }
    state.forget = null;
    if (state.query.record === id) return go({ record: null });
    void loadList();
  };
  const click = (event: Event) => {
    const target = event.target as Element;
    const ask = target.closest<HTMLElement>("[data-context-forget]");
    if (ask && state) {
      state.forget = { id: ask.dataset.contextForget!, phase: "confirm" };
      return paint();
    }
    const confirm = target.closest<HTMLElement>("[data-context-forget-confirm]");
    if (confirm) return void forgetEntry(confirm.dataset.contextForgetConfirm!);
    if (target.closest("[data-context-forget-cancel]") && state) {
      state.forget = null;
      return paint();
    }
    const tab = target.closest<HTMLElement>("[data-context-tab]");
    if (tab) return go({ tab: tab.dataset.contextTab as ContextQuery["tab"] });
    const pick = target.closest<HTMLElement>("[data-context-record]");
    if (pick) {
      const id = pick.dataset.contextRecord!;
      return go({ record: state?.query.record === id ? null : id });
    }
    const page = target.closest<HTMLElement>("[data-context-page]");
    if (page && state?.view) {
      const { offset, limit } = state.view.page;
      return go({
        offset: Math.max(0, offset + (page.dataset.contextPage === "next" ? limit : -limit)),
      });
    }
    if (target.closest("[data-context-action=retry]")) refresh();
  };
  const submit = (event: Event) => {
    const form = event.target as HTMLFormElement;
    if (form.dataset.contextSearch === undefined) return;
    event.preventDefault();
    go({ q: String(new FormData(form).get("q") ?? "").trim(), offset: 0, tab: "records" });
  };
  const refresh = () => {
    if (!state) return;
    void loadList();
    void loadDetail(state.query.record);
  };
  const hide = () => {
    if (root && state) renderMarkup(root, renderContext({ ...state, phase: "loading" }));
  };
  const restore = (event: Event) => {
    if ((event as Event & { persisted?: boolean }).persisted) refresh();
  };
  return {
    mount(next: HTMLElement, nextEngine: string, route: ContextRoute) {
      if (root !== next) {
        root?.removeEventListener("click", click);
        root?.removeEventListener("submit", submit);
        next.addEventListener("click", click);
        next.addEventListener("submit", submit);
        if (!root) {
          addEventListener("pagehide", hide);
          addEventListener("pageshow", restore);
        }
        root = next;
      }
      const query = contextQuery(search());
      const nextScope = `${route.kind}/${encodeURIComponent(route.id)}`;
      if (!state || nextScope !== scope || nextEngine !== engine) {
        list?.abort();
        detail?.abort();
        scope = nextScope;
        engine = nextEngine;
        listKey = detailKey = null;
        state = { query, phase: "loading", view: null, detail: null };
      }
      state.query = query;
      const nextList = `${query.q}\0${query.offset}`;
      if (nextList !== listKey) {
        listKey = nextList;
        void loadList();
      }
      if (query.record !== detailKey) {
        detailKey = query.record;
        void loadDetail(query.record);
      }
      paint();
    },
    leave() {
      list?.abort();
      detail?.abort();
      root?.removeEventListener("click", click);
      root?.removeEventListener("submit", submit);
      removeEventListener("pagehide", hide);
      removeEventListener("pageshow", restore);
      root = null;
      state = null;
    },
  };
}
