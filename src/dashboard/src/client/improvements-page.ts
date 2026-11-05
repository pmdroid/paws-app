import {
  DEFAULT_IMPROVEMENT_FILTER,
  IMPROVEMENT_ATTENTION_PATH,
  IMPROVEMENTS_API_PATH,
  RETRO_HISTORY_API_PATH,
  RETRO_RUNS_API_PATH,
  RETRO_SCHEDULE_API_PATH,
  improvementPath,
  improvementQuery,
  parseAttention,
  parseFollowThrough,
  parseImprovementDetail,
  parseImprovementList,
  parseImprovementQuery,
  parseOutcome,
  parseRetroHistory,
  parseRetroReport,
  parseRetroSchedule,
  retroReportPath,
  type ImprovementItem,
  type ImprovementList,
  type ImprovementOutcome,
} from "../improvements";
import { FINDING_GROUPS_API_PATH, type FindingGroupsResponse } from "../finding-groups";
import { journalCaught } from "../journal";
import { readCsrfToken } from "./csrf";
import { renderImprovements, type ImprovementsView } from "./improvements";
import { livePoll, PAGE_POLL_MS } from "./poll";
import type { ImprovementTab, Route } from "./route";
import { renderMarkup } from "./theme";

export type ImprovementRoute = Extract<Route, { view: "improvements" }>;

export type ImprovementsOptions = {
  fetch?: typeof fetch;
  poll?: (tick: () => void, every: number) => () => void;
  csrf?: () => string;
  now?: () => number;
  paint?: (root: HTMLElement, html: string) => void;
  location?: () => { pathname: string; search: string };
  replaceSearch?: (search: string) => void;
  counted?: (total: number) => void;
};

type Answer = { status: number; body: unknown };

const QUIET_ATTENTION = new Set(["rejected", "verified", "closed"]);
const SETTLED_GENERATION = new Set(["ready", "failed"]);

const MESSAGES: Record<string, string> = {
  create: "Accepted. Paws files the issue in Linear and shows it here when Linear confirms it.",
  link: "Accepted. Paws confirms the link with Linear and shows the issue here.",
  reject: "Rejected. It stays in history and nothing was filed.",
  reopen: "Reopened for review.",
  retry: "Filing queued again under the same operation. Paws never files a second issue.",
  "cancel-comment": "The evidence comment was dropped. The link stays.",
  destination: "Paws files it in the team you chose.",
  delegate: "Delegated. The normal Paws workflow starts on the issue.",
  criterion: "Verification criterion saved.",
  verification: "Verification recorded.",
  recovery: "Recovery recorded.",
  "run-retro": "Retro requested. It waits for a free runner slot, then generates.",
};

const CONFLICT: Record<string, string> = {
  stale:
    "Someone changed this improvement after you opened it. It now shows the current state; check it before deciding again.",
  reconciling:
    "Paws is still checking whether Linear received the earlier write. It does not file twice; wait for the check.",
};

function emptyView(local: boolean, now: number): ImprovementsView {
  return {
    tab: "review",
    id: null,
    filter: DEFAULT_IMPROVEMENT_FILTER,
    list: null,
    listError: null,
    attention: null,
    detail: null,
    follow: null,
    detailState: "idle",
    detailError: null,
    schedule: null,
    daily: null,
    report: null,
    reportState: "loading",
    history: null,
    historyError: null,
    expanded: false,
    choice: null,
    drafts: {},
    confirmClosed: null,
    busy: null,
    message: "",
    error: null,
    local,
    now,
  };
}

const errorOf = (answer: Answer, fallback: string) => {
  const body = answer.body as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : fallback;
};

const isItem = (value: unknown): value is ImprovementItem =>
  typeof value === "object" && value !== null && "proposal" in value && "lifecycle" in value;

function mergeList(previous: ImprovementList | null, next: ImprovementList): ImprovementList {
  if (previous === null) return next;
  const held = new Map(previous.items.map((item) => [item.id, item]));
  return {
    ...next,
    items: next.items.map((item) => {
      const known = held.get(item.id);
      return known && known.version > item.version ? known : item;
    }),
  };
}

export function createImprovements(options: ImprovementsOptions = {}) {
  const fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const poll = options.poll ?? livePoll;
  const csrf = options.csrf ?? (() => readCsrfToken(document));
  const now = options.now ?? Date.now;
  const draw = options.paint ?? renderMarkup;
  const where = options.location ?? (() => location);
  const replaceSearch =
    options.replaceSearch ??
    ((search: string) => {
      const url = new URL(location.href);
      url.search = search;
      history.replaceState(history.state, "", url);
    });

  let root: HTMLElement | null = null;
  let engine = "";
  let reader = "";
  let view = emptyView(false, now());
  let epoch = 0;
  const latest: Record<string, number> = {};
  let shown = "";
  let stopPolling: (() => void) | null = null;
  let focusAfterPaint: string | null = null;
  let dailyLoaded = false;

  const request = async (path: string, init?: RequestInit): Promise<Answer> => {
    const response = await fetchImpl(new URL(path, engine), {
      cache: "no-store",
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body !== undefined
          ? { "Content-Type": "application/json", "x-paws-csrf": csrf() }
          : {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const guarded = async (key: string, run: (current: () => boolean) => Promise<void>) => {
    const mounted = root;
    const started = epoch;
    const token = (latest[key] = (latest[key] ?? 0) + 1);
    const current = () => root === mounted && epoch === started && latest[key] === token;
    try {
      await run(current);
    } catch (error) {
      journalCaught(error, `improvements.${key}`, null);
      if (!current()) return;
      if (key === "list") view.listError = "Paws did not answer. Retry in a moment.";
      else if (key === "detail") {
        view.detailError = "Paws did not answer. Retry in a moment.";
        if (!view.detail) view.detailState = "error";
      } else if (key === "report") view.reportState = "error";
      else if (key === "history") view.historyError = "Paws did not answer. Retry in a moment.";
    }
    if (current()) paint();
  };

  const loadList = (append = false) =>
    guarded("list", async (current) => {
      const cursor = append ? view.list?.nextCursor : null;
      const query = improvementQuery(view.filter, cursor);
      const limit = append ? 0 : Math.min(100, Math.max(50, view.list?.items.length ?? 0));
      const path = `${IMPROVEMENTS_API_PATH}${query}${limit ? `${query ? "&" : "?"}limit=${limit}` : ""}`;
      const answer = await request(path);
      if (!current()) return;
      if (answer.status !== 200) {
        view.listError =
          answer.status === 403
            ? "Your workspace access changed, so Paws cannot list improvements for you now."
            : errorOf(answer, "Improvements did not load.");
        return;
      }
      const parsed = parseImprovementList(answer.body);
      if (!parsed.ok) {
        view.listError = parsed.error;
        return;
      }
      view.listError = null;
      if (append && view.list) {
        const seen = new Set(view.list.items.map((item) => item.id));
        view.list = {
          ...parsed.value,
          items: [...view.list.items, ...parsed.value.items.filter((item) => !seen.has(item.id))],
        };
      } else view.list = mergeList(view.list, parsed.value);
    });

  const loadAttention = () =>
    guarded("attention", async (current) => {
      const answer = await request(IMPROVEMENT_ATTENTION_PATH);
      if (!current() || answer.status !== 200) return;
      const parsed = parseAttention(answer.body);
      if (!parsed.ok) return;
      view.attention = parsed.value;
      options.counted?.(parsed.value.counts.total);
    });

  const loadDetail = () =>
    guarded("detail", async (current) => {
      const id = view.id;
      if (id === null || view.tab !== "review") return;
      const [detail, follow] = await Promise.all([
        request(improvementPath(id)),
        request(improvementPath(id, "follow-through")),
      ]);
      if (!current() || view.id !== id) return;
      if (detail.status === 404 || detail.status === 403) {
        view.detailState = detail.status === 404 ? "missing" : "forbidden";
        view.detail = null;
        view.follow = null;
        return;
      }
      if (detail.status !== 200) {
        view.detailError = errorOf(detail, "The improvement did not load.");
        if (!view.detail) view.detailState = "error";
        return;
      }
      const parsed = parseImprovementDetail(detail.body);
      if (!parsed.ok) {
        view.detailError = parsed.error;
        if (!view.detail) view.detailState = "error";
        return;
      }
      const held = view.detail?.item.id === id ? view.detail : null;
      if (!held || held.item.version <= parsed.value.item.version) view.detail = parsed.value;
      view.detailState = "ready";
      view.detailError = null;
      if (follow.status === 200) {
        const next = parseFollowThrough(follow.body);
        const before = view.follow?.followThrough.id === id ? view.follow : null;
        if (
          next.ok &&
          (!before || before.followThrough.version <= next.value.followThrough.version)
        )
          view.follow = next.value;
      }
    });

  const loadSchedule = () =>
    guarded("schedule", async (current) => {
      const answer = await request(RETRO_SCHEDULE_API_PATH);
      if (!current() || answer.status !== 200) return;
      const parsed = parseRetroSchedule(answer.body);
      if (parsed.ok) view.schedule = parsed.value;
    });

  const loadDaily = () =>
    guarded("daily", async (current) => {
      const answer = await request(FINDING_GROUPS_API_PATH);
      if (!current() || answer.status !== 200) return;
      const body = answer.body as FindingGroupsResponse | null;
      if (body && typeof body.enabled === "boolean")
        view.daily = { enabled: body.enabled, lastRun: body.lastRun };
    });

  const loadReport = () =>
    guarded("report", async (current) => {
      const id = view.id;
      if (id === null || view.tab !== "report") return;
      const answer = await request(retroReportPath(id));
      if (!current() || view.id !== id) return;
      if (answer.status === 404 || answer.status === 403) {
        view.reportState = "missing";
        view.report = null;
        return;
      }
      const parsed = answer.status === 200 ? parseRetroReport(answer.body) : null;
      if (!parsed?.ok) {
        view.error = parsed ? parsed.error : errorOf(answer, "The retro did not load.");
        view.reportState = view.report ? "ready" : "error";
        return;
      }
      view.report = parsed.value;
      view.reportState = "ready";
    });

  const loadHistory = (append = false) =>
    guarded("history", async (current) => {
      const cursor = append ? view.history?.nextCursor : null;
      const answer = await request(
        `${RETRO_HISTORY_API_PATH}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (!current()) return;
      const parsed = answer.status === 200 ? parseRetroHistory(answer.body) : null;
      if (!parsed?.ok) {
        view.historyError = parsed ? parsed.error : errorOf(answer, "Retro history did not load.");
        return;
      }
      view.historyError = null;
      view.history =
        append && view.history
          ? { ...parsed.value, retros: [...view.history.retros, ...parsed.value.retros] }
          : parsed.value;
    });

  const detailNeedsPolling = () => {
    if (view.id === null) return false;
    const attention = view.follow?.followThrough.attention;
    const deliveries = view.detail?.item.deliveries ?? [];
    return (
      attention === undefined ||
      !QUIET_ATTENTION.has(attention) ||
      deliveries.some((d) => d.status !== "succeeded")
    );
  };

  const tick = () => {
    if (!root || !root.isConnected || view.busy !== null) return;
    view.now = now();
    if (view.tab === "review") {
      void loadList();
      void loadAttention();
      if (view.schedule === null || !["ready", "empty"].includes(view.schedule.state))
        void loadSchedule();
      if (detailNeedsPolling()) void loadDetail();
    } else if (view.tab === "report") {
      const state = view.report?.retro.generation.state;
      if (
        view.report === null ||
        view.report.report === null ||
        !SETTLED_GENERATION.has(state ?? "")
      )
        if (view.reportState !== "missing") void loadReport();
    } else if (view.tab === "history") {
      if (view.history?.retros.some((r) => !SETTLED_GENERATION.has(r.generation.state ?? "")))
        void loadHistory();
    }
  };

  const loadTab = () => {
    if (view.tab === "review") {
      void loadList();
      void loadAttention();
      void loadSchedule();
      if (!dailyLoaded) {
        dailyLoaded = true;
        void loadDaily();
      }
      if (view.id !== null) void loadDetail();
    } else if (view.tab === "report") void loadReport();
    else if (view.tab === "history") void loadHistory();
    else void loadSchedule();
  };

  const reload = () => {
    epoch++;
    view.error = null;
    loadTab();
  };

  const focusKey = (element: Element | null): string | null => {
    if (!(element instanceof HTMLElement) || !root?.contains(element)) return null;
    for (const name of [
      "improvementDraft",
      "improvementFilter",
      "improvementChoice",
      "improvementRow",
      "improvementAction",
    ] as const) {
      const value = element.dataset[name];
      if (value !== undefined) {
        const attribute = `data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
        return `[${attribute}="${CSS.escape(value)}"]`;
      }
    }
    return element.id ? `#${CSS.escape(element.id)}` : null;
  };

  function paint() {
    if (!root) return;
    const html = renderImprovements(view);
    if (html === shown && focusAfterPaint === null) return;
    const active = typeof document === "undefined" ? null : document.activeElement;
    const focused = focusKey(active);
    const selection =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? [active.selectionStart, active.selectionEnd]
        : null;
    const panes = [...root.querySelectorAll<HTMLElement>("[data-scroll-key]")].map(
      (pane) => [pane.dataset.scrollKey, pane.scrollTop] as const,
    );
    if (html !== shown) draw(root, html);
    shown = html;
    for (const [key, top] of panes) {
      const pane = root.querySelector<HTMLElement>(`[data-scroll-key="${key}"]`);
      if (pane) pane.scrollTop = top;
    }
    const target = focusAfterPaint ?? focused;
    const element = target ? root.querySelector<HTMLElement>(target) : null;
    if (element) {
      if (focusAfterPaint !== null) focusAfterPaint = null;
      element.focus({ preventScroll: focused !== null });
      if (
        selection &&
        (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      )
        try {
          element.setSelectionRange(selection[0] ?? null, selection[1] ?? null);
        } catch (error) {
          journalCaught(error, "improvements.restoreSelection", null);
        }
    }
  }

  const applyOutcome = (outcome: ImprovementOutcome) => {
    const item = outcome.item;
    if (!item) return;
    if (isItem(item)) {
      if (view.detail?.item.id === item.id && view.detail.item.version <= item.version)
        view.detail = { ...view.detail, item };
    } else if (view.follow?.followThrough.id === item.id) {
      if (view.follow.followThrough.version <= item.version)
        view.follow = { ...view.follow, followThrough: item };
    }
  };

  const mutate = async (key: string, path: string, body: unknown) => {
    if (view.busy !== null || !view.local) return;
    view.busy = key;
    view.error = null;
    view.message = "";
    epoch++;
    paint();
    try {
      const answer = await request(path, { method: "POST", body: JSON.stringify(body ?? {}) });
      const outcome = parseOutcome(answer.body);
      if (answer.status >= 200 && answer.status < 300) {
        view.message = MESSAGES[key] ?? "Saved.";
        if (outcome?.status === "unchanged")
          view.message = "Already recorded. Nothing changed and nothing was sent twice.";
        if (outcome?.status === "existing")
          view.message = "The issue already has work or a delegate. Paws follows it instead.";
        if (outcome?.status === "in_progress")
          view.message = "Paws is already on it. Nothing was sent twice.";
        view.choice = null;
        view.confirmClosed = null;
        view.drafts = {};
      } else if (outcome?.reason === "issue_closed") {
        const issue = (answer.body as { issue?: { identifier?: string } } | null)?.issue;
        view.confirmClosed = issue?.identifier ?? view.drafts["issue"] ?? "This issue";
      } else if (answer.status === 403) {
        view.error =
          outcome?.message ??
          "Your workspace access changed. Nothing was saved; ask an admin if you need access.";
      } else {
        view.error =
          (outcome?.reason ? CONFLICT[outcome.reason] : undefined) ??
          outcome?.message ??
          `Paws refused the change (${answer.status}).`;
      }
      if (outcome) applyOutcome(outcome);
    } catch (error) {
      journalCaught(error, `improvements.mutate.${key}`, null);
      view.error =
        "Paws did not confirm the change. The page reloads what Paws has saved; nothing is filed twice.";
    } finally {
      view.busy = null;
    }
    epoch++;
    paint();
    if (view.tab === "review") {
      await Promise.all([loadDetail(), loadList(), loadAttention()]);
      if (key === "run-retro") await loadSchedule();
    } else if (view.tab === "report") await loadReport();
    else if (view.tab === "history") await loadHistory();
    else await loadSchedule();
  };

  const field = (form: HTMLFormElement, name: string) => {
    const value = new FormData(form).get(name);
    return typeof value === "string" ? value.trim() : (view.drafts[name] ?? "").trim();
  };

  const decide = (decision: unknown) => {
    const item = view.detail?.item;
    if (!item) return;
    return mutate(
      (decision as { kind: string }).kind === "accept"
        ? ((decision as { intent: { kind: string } }).intent.kind as string)
        : (decision as { kind: string }).kind,
      improvementPath(item.id, "decision"),
      { expectedVersion: item.version, decision },
    );
  };

  const accept = (intent: unknown, form: HTMLFormElement) => {
    const item = view.detail?.item;
    if (!item) return;
    const criterion = field(form, "criterion");
    if (!item.criterion && !criterion) {
      view.error = "Write the verification criterion first: how you will know the change worked.";
      paint();
      return;
    }
    return decide({
      kind: "accept",
      proposalVersion: item.proposal.version,
      ...(!item.criterion ? { verificationCriterion: criterion } : {}),
      intent,
    });
  };

  const linkIntent = (form: HTMLFormElement | null, allowClosed: boolean) => {
    const issue = form ? field(form, "issue") : (view.drafts["issue"] ?? "").trim();
    const fallback =
      view.detail?.candidates.find((c) => c.issue.identifier)?.issue.identifier ?? "";
    const chosen = issue || view.confirmClosed || fallback;
    const comment = form
      ? new FormData(form).get("comment") === "true"
      : view.drafts["comment"] === "true";
    return {
      kind: "link",
      issue: chosen,
      ...(comment ? { addEvidenceComment: true } : {}),
      ...(allowClosed ? { allowClosed: true } : {}),
    };
  };

  const followVersion = () => view.follow?.followThrough.version ?? view.detail?.item.version ?? 1;

  const click = (event: Event) => {
    const target = event.target as Element;
    const choice = target.closest<HTMLElement>("[data-improvement-choice]");
    if (choice) {
      view.choice = choice.dataset.improvementChoice as ImprovementsView["choice"];
      view.confirmClosed = null;
      paint();
      return;
    }
    const button = target.closest<HTMLElement>("[data-improvement-action]");
    if (!button || (button as HTMLButtonElement).disabled) return;
    const action = button.dataset.improvementAction!;
    const id = view.detail?.item.id;
    if (action === "reload") reload();
    else if (action === "more") {
      view.busy = "more";
      paint();
      void loadList(true).finally(() => {
        view.busy = null;
        paint();
      });
    } else if (action === "more-history") void loadHistory(true);
    else if (action === "evidence") {
      view.expanded = !view.expanded;
      paint();
    } else if (action === "use-issue") {
      view.choice = "link";
      view.drafts = { ...view.drafts, issue: button.dataset.issue ?? "" };
      focusAfterPaint = '[data-improvement-draft="issue"]';
      paint();
    } else if (action === "run-retro") void mutate("run-retro", RETRO_RUNS_API_PATH, {});
    else if (action === "reopen") void decide({ kind: "reopen" });
    else if (action === "link-closed") {
      const form = root?.querySelector<HTMLFormElement>('[data-improvement-form="link"]') ?? null;
      if (view.detail && form) void accept(linkIntent(form, true), form);
    } else if (id && action === "retry")
      void mutate(
        "retry",
        `${improvementPath(id)}/deliveries/${encodeURIComponent(button.dataset.delivery!)}/retry`,
        {},
      );
    else if (id && action === "cancel-comment")
      void mutate(
        "cancel-comment",
        `${improvementPath(id)}/deliveries/${encodeURIComponent(button.dataset.delivery!)}/cancel`,
        {},
      );
    else if (id && action === "delegate")
      void mutate("delegate", improvementPath(id, "delegate"), {
        expectedVersion: followVersion(),
      });
  };

  const input = (event: Event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const name = target.dataset?.improvementDraft;
    if (name === undefined) return;
    view.drafts = {
      ...view.drafts,
      [name]:
        target instanceof HTMLInputElement && target.type === "checkbox"
          ? String(target.checked)
          : target.value,
    };
    if (event.type === "change") paint();
  };

  const change = (event: Event) => {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLSelectElement && target.dataset.improvementFilter !== undefined) {
      const form = target.closest<HTMLFormElement>("form[data-improvement-filters]");
      if (!form) return;
      const data = new FormData(form);
      const filter = parseImprovementQuery(
        new URLSearchParams(
          [...data.entries()].filter(([, v]) => v !== "").map(([k, v]) => [k, String(v)]),
        ),
      );
      view.filter = filter;
      replaceSearch(improvementQuery(filter));
      epoch++;
      void loadList();
      return;
    }
    input(event);
  };

  const submit = (event: SubmitEvent) => {
    const form = event.target as HTMLFormElement;
    const kind = form.dataset.improvementForm;
    if (kind === undefined) return;
    event.preventDefault();
    if (view.busy !== null) return;
    const id = view.detail?.item.id;
    if (!id) return;
    if (kind === "create") {
      const team = field(form, "team") || view.detail?.destinations[0];
      if (team) void accept({ kind: "create", teamId: team }, form);
    } else if (kind === "link") {
      const intent = linkIntent(form, false);
      if (!intent.issue) {
        view.error = "Name the Linear issue to link, such as PAS-123.";
        paint();
        return;
      }
      void accept(intent, form);
    } else if (kind === "reject") {
      const reason = field(form, "reason");
      if (!reason) {
        view.error = "Say why you reject it. The reason stays in history.";
        paint();
        return;
      }
      void decide({ kind: "reject", reason });
    } else if (kind === "destination")
      void mutate(
        "destination",
        `${improvementPath(id)}/deliveries/${encodeURIComponent(form.dataset.delivery!)}/destination`,
        { teamId: field(form, "destination") || view.detail?.destinations[0] },
      );
    else if (kind === "criterion")
      void mutate("criterion", improvementPath(id, "criterion"), {
        expectedVersion: followVersion(),
        criterion: field(form, "new-criterion"),
      });
    else if (kind === "verification") {
      const revision = field(form, "revision");
      const deployment = field(form, "deployment");
      const url = field(form, "url");
      void mutate("verification", improvementPath(id, "verification"), {
        expectedVersion: followVersion(),
        outcome: field(form, "outcome") || "verified",
        check: field(form, "check"),
        result: field(form, "result"),
        ...(revision ? { revision } : {}),
        ...(deployment ? { deployment } : {}),
        evidence: { kind: "attestation", ...(url ? { url } : {}) },
      });
    } else if (kind === "recovery") {
      const choice = (event.submitter as HTMLButtonElement | null)?.value;
      const reason = field(form, "recovery-reason");
      if (!choice || !reason) {
        view.error = "Say why you choose this recovery.";
        paint();
        return;
      }
      void mutate("recovery", improvementPath(id, "recovery"), {
        expectedVersion: followVersion(),
        choice,
        reason,
      });
    }
  };

  const listen = (next: HTMLElement | null) => {
    root?.removeEventListener("click", click);
    root?.removeEventListener("change", change);
    root?.removeEventListener("input", input);
    root?.removeEventListener("submit", submit as EventListener);
    root = next;
    root?.addEventListener("click", click);
    root?.addEventListener("change", change);
    root?.addEventListener("input", input);
    root?.addEventListener("submit", submit as EventListener);
  };

  const navigate = (route: ImprovementRoute) => {
    const tab: ImprovementTab = route.tab ?? "review";
    const previous = { tab: view.tab, id: view.id };
    const filter = parseImprovementQuery(where().search);
    const filterChanged = improvementQuery(filter) !== improvementQuery(view.filter);
    if (previous.tab === tab && previous.id === route.id && !filterChanged) return false;
    epoch++;
    view.tab = tab;
    view.id = route.id;
    view.error = null;
    view.message = "";
    if (tab === "review" || filterChanged) view.filter = filter;
    if (previous.id !== route.id || previous.tab !== tab) {
      view.expanded = false;
      view.choice = null;
      view.drafts = {};
      view.confirmClosed = null;
      if (tab === "review" && route.id !== null) {
        if (view.detail?.item.id !== route.id) view.detailState = "loading";
        view.detailError = null;
        focusAfterPaint = "#improvement-heading";
      } else if (tab === "review" && previous.tab === "review" && previous.id !== null)
        focusAfterPaint = `[data-improvement-row="${CSS.escape(previous.id)}"]`;
      if (tab === "report") {
        if (view.report?.retro.id !== route.id) view.report = null;
        view.reportState = "loading";
      }
    }
    return true;
  };

  return {
    mount(next: HTMLElement, nextEngine: string, route: ImprovementRoute, nextReader: string) {
      const fresh = root !== next || engine !== nextEngine || reader !== nextReader;
      if (fresh) {
        listen(next);
        engine = nextEngine;
        reader = nextReader;
        epoch++;
        dailyLoaded = false;
        shown = "";
        const page = (globalThis as { location?: { origin: string } }).location;
        const origin = new URL(nextEngine).origin;
        view = emptyView(origin === (page?.origin ?? origin), now());
        view.filter = parseImprovementQuery(where().search);
        view.tab = route.tab ?? "review";
        view.id = route.id;
        if (view.id !== null && view.tab === "review") {
          view.detailState = "loading";
          focusAfterPaint = "#improvement-heading";
        }
        stopPolling?.();
        stopPolling = poll(tick, PAGE_POLL_MS);
        paint();
        loadTab();
        return;
      }
      if (stopPolling === null) stopPolling = poll(tick, PAGE_POLL_MS);
      if (navigate(route)) {
        paint();
        loadTab();
      }
    },
    leave() {
      stopPolling?.();
      stopPolling = null;
      epoch++;
      listen(null);
      shown = "";
    },
    async refreshCount(nextEngine: string) {
      try {
        const response = await fetchImpl(new URL(IMPROVEMENT_ATTENTION_PATH, nextEngine), {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (response.status !== 200) return;
        const parsed = parseAttention(await response.json());
        if (parsed.ok) options.counted?.(parsed.value.counts.total);
      } catch (error) {
        journalCaught(error, "improvements.refreshCount", null);
      }
    },
    view: () => view,
  };
}
