import { journalCaught } from "../journal";
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

export type LinearClient = {
  query(
    query: string,
    variables?: Record<string, unknown>,
    options?: { signal?: AbortSignal; isCurrent?: () => boolean },
  ): Promise<unknown>;
};

export function createLinearClient(options: {
  auth: LinearAuth;
  fetch?: FetchLike;
  ledger?: LinearLedger;
}): LinearClient {
  const fetchImpl = options.fetch ?? fetch;
  const ledger = options.ledger ?? createLinearLedger();
  const client: LinearClient = {
    async query(query, variables, { signal, isCurrent } = {}) {
      const current = () => {
        signal?.throwIfAborted();
        if (isCurrent && !isCurrent()) throw new Error("Linear request was superseded.");
      };
      current();
      const { caller, priority, item, itemId } = currentLinearCaller();
      const held = ledger.admit(caller, priority, query);
      if (held !== null) throw held;
      const run = async (token: string) => {
        current();
        options.auth.assertAuthorized?.();
        return fetchImpl(GRAPHQL_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ query, variables: variables ?? {} }),
          ...(signal === undefined ? {} : { signal }),
        });
      };
      let token = await abortable(options.auth.ensureFresh(), signal);
      let response = await run(token);
      if (response.status === 401) {
        token = await abortable(options.auth.forceRefresh(), signal);
        response = await run(token);
      }
      const budget = budgetFromHeaders(response.headers);
      ledger.observe(caller, budget, item, itemId, query);
      const json: unknown = await abortable(response.json(), signal).catch((error: unknown) => {
        signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") throw error;
        journalCaught(error, "graphql.query.abortable", itemId, "cancellation may interrupt work");
        return null;
      });
      current();
      const limited = rateLimitFrom(response, json, budget, ledger.now());
      if (limited !== null) throw ledger.limited(caller, limited);
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

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  signal.throwIfAborted();
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
