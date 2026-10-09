const budgets = new WeakMap<object, LinearRateBudget>();

/** Latest Linear rate-limit headers seen for a client. Complexity and request budget. */
export type LinearRateBudget = {
  requestsRemaining: number | null;
  requestsLimit: number | null;
  requestsResetMs: number | null;
  complexityRemaining: number | null;
  complexityLimit: number | null;
  complexityResetMs: number | null;
  complexity: number | null;
};

export class LinearRateLimitError extends Error {
  readonly retryAfterMs: number;
  readonly budget: LinearRateBudget;

  constructor(delayMs: number, budget: LinearRateBudget) {
    super("Linear GraphQL: RATELIMITED");
    this.name = "LinearRateLimitError";
    this.retryAfterMs = Math.max(0, delayMs);
    this.budget = budget;
  }
}

export function rememberLinearBudget(client: object, budget: LinearRateBudget): void {
  budgets.set(client, budget);
}

export function linearBudget(client: object): LinearRateBudget | null {
  return budgets.get(client) ?? null;
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
  };
}

/** Null when the response is not a Linear `RATELIMITED` result. */
export function rateLimitFrom(
  response: Response,
  json: unknown,
  budget: LinearRateBudget,
  now = Date.now(),
): LinearRateLimitError | null {
  if (response.status !== 429 && !bodyIsRateLimited(json)) return null;
  return new LinearRateLimitError(retryAfterMs(response, json, budget, now), budget);
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

function retryAfterMs(
  response: Response,
  json: unknown,
  budget: LinearRateBudget,
  now: number,
): number {
  const header = response.headers.get("retry-after");
  if (header !== null && header.length > 0) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
    const when = Date.parse(header);
    if (Number.isFinite(when)) return Math.max(0, when - now);
  }
  const reset = readReset(json) ?? budget.requestsResetMs ?? budget.complexityResetMs;
  if (reset !== null) return Math.max(0, reset - now);
  return 15_000;
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
