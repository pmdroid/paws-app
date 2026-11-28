import { journal, journalCaught } from "../journal";
import { defaultRecorder, statusClass, type MetricsRecorder } from "../metrics";
import {
  budgetFromHeaders,
  createLinearLedger,
  currentLinearCaller,
  linearCaller,
  linearDefaultCaller,
  linearLedger,
  rateLimitFrom,
  resetRetryMs,
  useLinearLedger,
  type LinearLedger,
  type LinearPriority,
} from "./budget";
import type { FetchLike, LinearAuth } from "./oauth";

const GRAPHQL_URL = "https://api.linear.app/graphql";

export const LINEAR_SLOW_CALL_MS = 5_000;

type LinearPhase = "ledger" | "current" | "authorize" | "token" | "fetch" | "body";

export type LinearClient = {
  query(
    query: string,
    variables?: Record<string, unknown>,
    options?: { signal?: AbortSignal; isCurrent?: () => Promise<boolean> },
  ): Promise<unknown>;
};

export function createLinearClient(options: {
  auth: LinearAuth;
  fetch?: FetchLike;
  ledger?: LinearLedger;
  metrics?: MetricsRecorder;
}): LinearClient {
  const fetchImpl = options.fetch ?? fetch;
  const metrics = options.metrics ?? defaultRecorder;
  const ledger = options.ledger ?? createLinearLedger();
  const client: LinearClient = {
    async query(query, variables, { signal, isCurrent } = {}) {
      const began = performance.now();
      const phases = new Map<LinearPhase, number>();
      let slow = false;
      const timed = async <T>(phase: LinearPhase, work: () => Promise<T>): Promise<T> => {
        const at = performance.now();
        try {
          return await work();
        } finally {
          const now = performance.now();
          metrics.recordDuration("linear.phase", { phase }, now - at);
          phases.set(phase, (phases.get(phase) ?? 0) + now - at);
          if (!slow && now - began > LINEAR_SLOW_CALL_MS) {
            slow = true;
            const spent = [...phases].sort((x, y) => y[1] - x[1]);
            journal(
              `linear call ${currentLinearCaller().caller} slow ${Math.round(now - began)}ms phase=${spent[0]![0]} ${spent.map(([name, ms]) => `${name}=${Math.round(ms)}`).join(" ")}`,
            );
          }
        }
      };
      const current = () =>
        timed("current", async () => {
          signal?.throwIfAborted();
          if (isCurrent && !(await isCurrent())) throw new Error("Linear request was superseded.");
        });
      await current();
      const { caller, priority, item, itemId } = currentLinearCaller();
      const held = await timed(
        "ledger",
        async () =>
          ledger.admit(caller, priority, query) ?? (await ledger.reserve(caller, priority)),
      );
      if (held !== null) throw held;
      const run = async (token: string) => {
        await current();
        await timed("authorize", async () => options.auth.assertAuthorized?.());
        const started = performance.now();
        const observe = (status: number | null) =>
          metrics.recordDuration(
            "linear.call",
            { caller, status_class: statusClass(status) },
            performance.now() - started,
          );
        const request = fetchImpl(GRAPHQL_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ query, variables: variables ?? {} }),
          ...(signal === undefined ? {} : { signal }),
        });
        const response = await timed("fetch", () => request).catch((error: unknown) => {
          if (!signal?.aborted) observe(null);
          throw error;
        });
        observe(response.status);
        return response;
      };
      let response: Response;
      try {
        let token = await timed("token", () => abortable(options.auth.ensureFresh(), signal));
        response = await run(token);
        if (response.status === 401) {
          void response.body?.cancel().catch(() => undefined);
          token = await timed("token", () => abortable(options.auth.forceRefresh(), signal));
          response = await run(token);
        }
      } catch (error) {
        await ledger.settle();
        throw error;
      }
      const budget = budgetFromHeaders(response.headers);
      if (budget.requestsRemaining !== null)
        metrics.setGauge("linear.rate_remaining", {}, budget.requestsRemaining);
      await ledger.observe(caller, budget, item, itemId, query);
      const body = () => readBody(response, signal);
      const json: unknown = await timed("body", body).catch((error: unknown) => {
        signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") throw error;
        journalCaught(error, "graphql.query.abortable", itemId, "cancellation may interrupt work");
        return null;
      });
      await current();
      const limited = rateLimitFrom(response, json, budget, ledger.now());
      if (limited !== null) {
        metrics.incrementCounter("linear.rate_limited", { caller });
        throw await ledger.limited(caller, limited);
      }
      const errors = isRecord(json) ? json["errors"] : undefined;
      let message: string | null = null;
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0];
        message =
          isRecord(first) && typeof first["message"] === "string"
            ? first["message"]
            : "request failed";
      }
      if (response.status < 500 && message !== null && message.startsWith("Entity not found: "))
        throw new LinearEntityNotFoundError(message);
      if (!response.ok) {
        const detail = message !== null ? `: ${message}` : "";
        throw new LinearHttpError(response.status, detail, response.headers, ledger.now());
      }
      if (message !== null)
        throw new LinearGraphQLError(message, Array.isArray(errors) ? errors : []);
      if (!isRecord(json)) throw new Error("Linear GraphQL returned no data");
      if (json["data"] === undefined) throw new Error("Linear GraphQL returned no data");
      return json["data"];
    },
  };
  useLinearLedger(client, ledger);
  return client;
}

export function defaultCallerClient(client: LinearClient, caller: string): LinearClient {
  const labelled: LinearClient = {
    query: (...args) => linearDefaultCaller(caller, () => client.query(...args)),
  };
  const ledger = linearLedger(client);
  if (ledger !== null) useLinearLedger(labelled, ledger);
  return labelled;
}

export function callerClient(
  client: LinearClient,
  caller: string,
  priority?: LinearPriority,
): LinearClient {
  const labelled: LinearClient = {
    query: (...args) => linearCaller(caller, () => client.query(...args), priority),
  };
  const ledger = linearLedger(client);
  if (ledger !== null) useLinearLedger(labelled, ledger);
  return labelled;
}

async function readBody(response: Response, signal?: AbortSignal): Promise<unknown> {
  if (signal === undefined || response.body === null) return response.json();
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel(signal.reason).catch(() => undefined);
  if (signal.aborted) cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    void operation.catch((error: unknown) =>
      journalCaught(error, "graphql.abortable", null, "cancellation may interrupt work"),
    );
    signal.throwIfAborted();
  }
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class LinearEntityNotFoundError extends Error {
  readonly entity: string;
  constructor(message: string) {
    super(`Linear GraphQL: ${message}`);
    this.name = "LinearEntityNotFoundError";
    this.entity = message.slice("Entity not found: ".length).trim();
  }
}

export class LinearHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  constructor(
    status: number,
    detail: string,
    headers: Headers,
    now = Date.now(),
    message?: string,
  ) {
    super(message ?? `Linear GraphQL HTTP ${status}${detail}`);
    this.name = "LinearHttpError";
    this.status = status;
    this.retryAfterMs = resetRetryMs(headers, now) ?? undefined;
  }
}

/** Structured GraphQL refusals are distinct from transport failures with an uncertain write. */
export class LinearGraphQLError extends Error {
  readonly codes: string[];
  readonly errorsCount: number;
  constructor(message: string, errors: readonly unknown[]) {
    super(`Linear GraphQL: ${message}`);
    this.name = "LinearGraphQLError";
    this.errorsCount = errors.length;
    this.codes = errors.flatMap((error) =>
      isRecord(error) && isRecord(error.extensions) && typeof error.extensions.code === "string"
        ? [error.extensions.code]
        : [],
    );
  }
}
