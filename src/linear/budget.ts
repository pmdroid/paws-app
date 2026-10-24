import { AsyncLocalStorage } from "node:async_hooks";

const ledgers = new WeakMap<object, LinearLedger>();
const callers = new AsyncLocalStorage<LinearCallerStore>();

export const LINEAR_USAGE_WINDOW_MS = 60 * 60_000;
export const DEFAULT_LINEAR_CALLER = "tracker";
export const BACKGROUND_BUDGET_FRACTION = 0.2;
export const NORMAL_BUDGET_FRACTION = 0.05;
export const LINEAR_TOP_ITEMS = 20;
const UNKNOWN_RESET_WAIT_MS = 60_000;

export type LinearPriority = "critical" | "normal" | "background";

type LinearCallerContext = {
  caller: string;
  priority: LinearPriority;
  item?: string;
  itemId?: string;
};
type LinearCallerStore = {
  caller?: string;
  priority?: LinearPriority;
  item?: string;
  itemId?: string;
};

const CALLER_PRIORITY: Record<string, LinearPriority> = {
  poller: "background",
  "repository-hints": "background",
  context: "background",
  "epics-sweep": "background",
  events: "critical",
};

/** Latest Linear rate-limit headers seen for a client. Complexity and request budget. */
export type LinearRateBudget = {
  requestsRemaining: number | null;
  requestsLimit: number | null;
  requestsResetMs: number | null;
  complexityRemaining: number | null;
  complexityLimit: number | null;
  complexityResetMs: number | null;
  complexity: number | null;
  endpoint?: LinearEndpointLimit;
};

export type LinearEndpointLimit = {
  name: string;
  requestsRemaining: number | null;
  requestsLimit: number | null;
  requestsResetMs: number | null;
};

export class LinearRateLimitError extends Error {
  readonly retryAfterMs: number;
  readonly budget: LinearRateBudget;
  readonly endpoint: string | null;

  constructor(delayMs: number, budget: LinearRateBudget, endpoint: string | null = null) {
    super("Linear GraphQL: RATELIMITED");
    this.name = "LinearRateLimitError";
    this.retryAfterMs = Math.max(0, delayMs);
    this.budget = budget;
    this.endpoint = endpoint;
  }
}

export type LinearCallerUsage = {
  requests: number;
  complexity: number;
  rateLimited: number;
  held: number;
};

export type LinearUsage = {
  budget: LinearRateBudget | null;
  holdUntilMs: number | null;
  windowMs: number;
  callers: Record<string, LinearCallerUsage>;
  items: LinearItemUsage[];
  endpoints: LinearEndpointLimit[];
  lastCatchUpMs?: number | null;
};

export type LinearItemUsage = { item: string; requests: number };

export type LinearLedger = {
  admit(caller: string, priority?: LinearPriority, operation?: string): LinearRateLimitError | null;
  observe(
    caller: string,
    budget: LinearRateBudget,
    item?: string,
    itemId?: string,
    operation?: string,
  ): void;
  limited(caller: string, error: LinearRateLimitError): LinearRateLimitError;
  usage(): LinearUsage;
  now(): number;
};

type LedgerEntry = { at: number; caller: string; item: string | null } & LinearCallerUsage;

export function linearCaller<T>(caller: string, run: () => T, priority?: LinearPriority): T {
  return callers.run(
    {
      ...callers.getStore(),
      caller,
      priority: priority ?? CALLER_PRIORITY[caller] ?? "normal",
    },
    run,
  );
}

export function linearDefaultCaller<T>(caller: string, run: () => T): T {
  return callers.getStore()?.caller === undefined ? linearCaller(caller, run) : run();
}

export function linearItem<T>(item: string, run: () => T, itemId?: string): T {
  return callers.run({ ...callers.getStore(), item, itemId }, run);
}

export function linearDefaultCallers<T extends object>(
  target: T,
  caller: string | { readonly [K in keyof T]?: string },
): T {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key);
      if (typeof value !== "function") return value;
      const name = typeof caller === "string" ? caller : caller[key as keyof T];
      if (name === undefined) return value;
      return (...args: unknown[]) => linearDefaultCaller(name, () => value.apply(object, args));
    },
  });
}

export function linearCallerFor<T extends object>(
  target: T,
  caller: string,
  priority?: LinearPriority,
): T {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        linearCaller(caller, () => value.apply(object, args), priority);
    },
  });
}

export function currentLinearCaller(): LinearCallerContext {
  const store = callers.getStore();
  return {
    caller: store?.caller ?? DEFAULT_LINEAR_CALLER,
    priority: store?.priority ?? "normal",
    ...(store?.item === undefined ? {} : { item: store.item }),
    ...(store?.itemId === undefined ? {} : { itemId: store.itemId }),
  };
}

export function createLinearLedger(
  options: {
    now?: () => number;
    random?: () => number;
    log?: (line: string) => void;
    countItem?: (itemId: string, caller: string) => void;
  } = {},
): LinearLedger {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const log = options.log ?? ((line: string) => console.warn(line));
  const entries: LedgerEntry[] = [];
  let budget: LinearRateBudget | null = null;
  let holdUntilMs: number | null = null;
  const endpoints = new Map<string, LinearEndpointLimit>();
  const operations = new Map<string, string>();
  const prune = () => {
    const since = now() - LINEAR_USAGE_WINDOW_MS;
    let stale = 0;
    while (stale < entries.length && entries[stale]!.at <= since) stale += 1;
    if (stale > 0) entries.splice(0, stale);
  };
  const record = (caller: string, usage: Partial<LinearCallerUsage>, item?: string) => {
    prune();
    entries.push({
      at: now(),
      caller,
      item: item ?? null,
      requests: usage.requests ?? 0,
      complexity: usage.complexity ?? 0,
      rateLimited: usage.rateLimited ?? 0,
      held: usage.held ?? 0,
    });
  };
  const holdMs = () => {
    if (holdUntilMs === null) return 0;
    const left = holdUntilMs - now();
    if (left > 0) return left;
    holdUntilMs = null;
    return 0;
  };
  const jitter = (delayMs: number) =>
    Math.round(random() * Math.min(5_000, Math.max(250, delayMs / 10)));
  const usage = (): LinearUsage => {
    prune();
    const totals: Record<string, LinearCallerUsage> = {};
    const items = new Map<string, number>();
    for (const entry of entries) {
      if (entry.item !== null && entry.requests > 0)
        items.set(entry.item, (items.get(entry.item) ?? 0) + entry.requests);
      const total = (totals[entry.caller] ??= {
        requests: 0,
        complexity: 0,
        rateLimited: 0,
        held: 0,
      });
      total.requests += entry.requests;
      total.complexity += entry.complexity;
      total.rateLimited += entry.rateLimited;
      total.held += entry.held;
    }
    holdMs();
    return {
      budget,
      holdUntilMs,
      windowMs: LINEAR_USAGE_WINDOW_MS,
      callers: totals,
      items: [...items]
        .map(([item, requests]) => ({ item, requests }))
        .sort(
          (left, right) => right.requests - left.requests || left.item.localeCompare(right.item),
        )
        .slice(0, LINEAR_TOP_ITEMS),
      endpoints: [...endpoints.values()]
        .filter((limit) => endpointIsLow(limit, now()))
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  };
  return {
    admit(caller, priority = "normal", operation) {
      const endpoint = operation === undefined ? undefined : operations.get(operation);
      const left = Math.max(
        holdMs(),
        reserveMs(budget, priority, now()),
        endpointHoldMs(endpoint === undefined ? undefined : endpoints.get(endpoint), now()),
      );
      if (left === 0) return null;
      record(caller, { held: 1 });
      return new LinearRateLimitError(left + jitter(left), budget ?? emptyBudget());
    },
    observe(caller, seen, item, itemId, operation) {
      record(caller, { requests: 1, complexity: seen.complexity ?? 0 }, item);
      if (itemId !== undefined) options.countItem?.(itemId, caller);
      const { endpoint, ...limits } = seen;
      if (endpoint !== undefined) {
        endpoints.set(endpoint.name, endpoint);
        if (operation !== undefined) operations.set(operation, endpoint.name);
      }
      if (Object.values(limits).some((value) => value !== null)) budget = limits;
    },
    limited(caller, error) {
      if (error.endpoint === null)
        holdUntilMs = Math.max(holdUntilMs ?? 0, now() + error.retryAfterMs);
      record(caller, { rateLimited: 1 });
      log(rateLimitLine(caller, error, usage()));
      const left = error.endpoint === null ? holdUntilMs! - now() : error.retryAfterMs;
      return new LinearRateLimitError(left + jitter(left), error.budget, error.endpoint);
    },
    usage,
    now,
  };
}

export function useLinearLedger(client: object, ledger: LinearLedger): void {
  ledgers.set(client, ledger);
}

export function linearLedger(client: object): LinearLedger | null {
  return ledgers.get(client) ?? null;
}

export function linearBudget(client: object): LinearRateBudget | null {
  return ledgers.get(client)?.usage().budget ?? null;
}

function reserveMs(budget: LinearRateBudget | null, priority: LinearPriority, now: number): number {
  if (budget === null || priority === "critical") return 0;
  const floor = priority === "background" ? BACKGROUND_BUDGET_FRACTION : NORMAL_BUDGET_FRACTION;
  let wait = 0;
  for (const [remaining, limit, reset] of [
    [budget.requestsRemaining, budget.requestsLimit, budget.requestsResetMs],
    [budget.complexityRemaining, budget.complexityLimit, budget.complexityResetMs],
  ] as const) {
    if (remaining === null || limit === null || limit <= 0 || remaining / limit >= floor) continue;
    if (reset !== null && reset <= now) continue;
    wait = Math.max(wait, reset === null ? UNKNOWN_RESET_WAIT_MS : reset - now);
  }
  return wait;
}

function endpointHoldMs(limit: LinearEndpointLimit | undefined, now: number): number {
  if (limit?.requestsRemaining !== 0 || limit.requestsResetMs === null) return 0;
  return Math.max(0, limit.requestsResetMs - now);
}

function endpointIsLow(limit: LinearEndpointLimit, now: number): boolean {
  const { requestsRemaining: remaining, requestsLimit: max, requestsResetMs: reset } = limit;
  if (remaining === null || max === null || max <= 0) return false;
  if (reset !== null && reset <= now) return false;
  return remaining / max < BACKGROUND_BUDGET_FRACTION;
}

function rateLimitLine(caller: string, error: LinearRateLimitError, usage: LinearUsage): string {
  const { budget, retryAfterMs: holdMs, endpoint } = error;
  const reset = budget.requestsResetMs ?? budget.complexityResetMs;
  const top = Object.entries(usage.callers)
    .sort(
      ([, left], [, right]) => right.complexity - left.complexity || right.requests - left.requests,
    )
    .slice(0, 5)
    .map(([name, spent]) => `${name} ${spent.requests} req/${spent.complexity} cx`)
    .join(", ");
  return [
    `linear RATELIMITED caller=${caller}${endpoint === null ? "" : ` endpoint=${endpoint}`} hold ${Math.ceil(holdMs / 1000)}s`,
    `requests ${count(budget.requestsRemaining)}/${count(budget.requestsLimit)}`,
    `complexity ${count(budget.complexityRemaining)}/${count(budget.complexityLimit)}`,
    `reset ${reset === null ? "unknown" : new Date(reset).toISOString()}`,
    `last hour: ${top.length > 0 ? top : "none"}`,
  ].join("; ");
}

function count(value: number | null): string {
  return value === null ? "?" : String(value);
}

function emptyBudget(): LinearRateBudget {
  return {
    requestsRemaining: null,
    requestsLimit: null,
    requestsResetMs: null,
    complexityRemaining: null,
    complexityLimit: null,
    complexityResetMs: null,
    complexity: null,
  };
}

export function budgetFromHeaders(headers: Headers): LinearRateBudget {
  return {
    requestsRemaining: headerNumber(headers, "x-ratelimit-requests-remaining"),
    requestsLimit: headerNumber(headers, "x-ratelimit-requests-limit"),
    requestsResetMs: headerTimestamp(headers, "x-ratelimit-requests-reset"),
    complexityRemaining: headerNumber(headers, "x-ratelimit-complexity-remaining"),
    complexityLimit: headerNumber(headers, "x-ratelimit-complexity-limit"),
    complexityResetMs: headerTimestamp(headers, "x-ratelimit-complexity-reset"),
    complexity: headerNumber(headers, "x-complexity"),
    ...endpointFromHeaders(headers),
  };
}

function endpointFromHeaders(headers: Headers): { endpoint?: LinearEndpointLimit } {
  const name = headers.get("x-ratelimit-endpoint-name")?.trim();
  if (!name) return {};
  return {
    endpoint: {
      name,
      requestsRemaining: headerNumber(headers, "x-ratelimit-endpoint-requests-remaining"),
      requestsLimit: headerNumber(headers, "x-ratelimit-endpoint-requests-limit"),
      requestsResetMs: headerTimestamp(headers, "x-ratelimit-endpoint-requests-reset"),
    },
  };
}

export function resetRetryMs(headers: Headers, now = Date.now()): number | null {
  return (
    exhaustedLimit(budgetFromHeaders(headers), now)?.waitMs ?? retryAfterHeaderMs(headers, now)
  );
}

/** Null when the response is not a Linear `RATELIMITED` result. */
export function rateLimitFrom(
  response: Response,
  json: unknown,
  budget: LinearRateBudget,
  now = Date.now(),
): LinearRateLimitError | null {
  if (response.status !== 429 && !bodyIsRateLimited(json)) return null;
  const ran = exhaustedLimit(budget, now);
  const delayMs =
    ran?.waitMs ?? retryAfterHeaderMs(response.headers, now) ?? metaRetryMs(json, now) ?? 15_000;
  return new LinearRateLimitError(delayMs, budget, ran?.endpoint ?? null);
}

/** How long to wait when the remaining request or complexity budget is already zero. */
export function budgetHoldMs(budget: LinearRateBudget | null, now: number): number {
  if (budget === null) return 0;
  const requestsBlocked = budget.requestsRemaining === 0;
  const complexityBlocked = budget.complexityRemaining === 0;
  if (!requestsBlocked && !complexityBlocked) return 0;
  const reset = requestsBlocked
    ? (budget.requestsResetMs ?? budget.complexityResetMs)
    : (budget.complexityResetMs ?? budget.requestsResetMs);
  if (reset === null) return 15_000;
  return Math.max(0, reset - now);
}

function bodyIsRateLimited(json: unknown): boolean {
  if (!isRecord(json) || !Array.isArray(json["errors"])) return false;
  return json["errors"].some((error) => {
    if (!isRecord(error)) return false;
    const extensions = isRecord(error["extensions"]) ? error["extensions"] : null;
    const code = extensions === null ? null : extensions["code"];
    if (code === "RATELIMITED") return true;
    const message = error["message"];
    return typeof message === "string" && message.toLowerCase().includes("ratelimited");
  });
}

function exhaustedLimit(
  budget: LinearRateBudget,
  now: number,
): { waitMs: number; endpoint: string | null } | null {
  let wait = 0;
  for (const [remaining, reset] of [
    [budget.requestsRemaining, budget.requestsResetMs],
    [budget.complexityRemaining, budget.complexityResetMs],
  ] as const) {
    if (remaining !== null && remaining <= 0 && reset !== null) wait = Math.max(wait, reset - now);
  }
  if (wait > 0) return { waitMs: wait, endpoint: null };
  const endpoint = budget.endpoint;
  const waitMs = endpointHoldMs(endpoint, now);
  return endpoint !== undefined && waitMs > 0 ? { waitMs, endpoint: endpoint.name } : null;
}

function retryAfterHeaderMs(headers: Headers, now: number): number | null {
  const header = headers.get("retry-after")?.trim();
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - now) : null;
}

function metaRetryMs(json: unknown, now: number): number | null {
  const reset = readReset(json);
  return reset === null ? null : Math.max(0, reset - now);
}

function readReset(json: unknown): number | null {
  if (!isRecord(json) || !Array.isArray(json["errors"])) return null;
  for (const error of json["errors"]) {
    if (!isRecord(error)) continue;
    const extensions = isRecord(error["extensions"]) ? error["extensions"] : null;
    const meta = extensions !== null && isRecord(extensions["meta"]) ? extensions["meta"] : null;
    const result =
      meta !== null && isRecord(meta["rateLimitResult"]) ? meta["rateLimitResult"] : null;
    const reset = result === null ? null : result["reset"];
    if (typeof reset === "number" && Number.isFinite(reset)) return timestampMs(reset);
  }
  return null;
}

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function headerTimestamp(headers: Headers, name: string): number | null {
  const value = headerNumber(headers, name);
  return value === null ? null : timestampMs(value);
}

/** Linear sends reset as epoch milliseconds. Small values are seconds. */
function timestampMs(value: number): number {
  if (value > 0 && value < 1_000_000_000_000) return value * 1000;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
