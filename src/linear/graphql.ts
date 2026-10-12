import { budgetFromHeaders, rateLimitFrom, rememberLinearBudget } from "./budget";
import type { FetchLike, LinearAuth } from "./oauth";

const GRAPHQL_URL = "https://api.linear.app/graphql";

export type LinearClient = {
  query(
    query: string,
    variables?: Record<string, unknown>,
    options?: { signal?: AbortSignal; isCurrent?: () => boolean },
  ): Promise<unknown>;
};

export function createLinearClient(options: { auth: LinearAuth; fetch?: FetchLike }): LinearClient {
  const fetchImpl = options.fetch ?? fetch;
  const client: LinearClient = {
    async query(query, variables, { signal, isCurrent } = {}) {
      const current = () => {
        signal?.throwIfAborted();
        if (isCurrent && !isCurrent()) throw new Error("Linear request was superseded.");
      };
      current();
      const run = async (token: string) => {
        current();
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
      rememberLinearBudget(client, budget);
      const json: unknown = await abortable(response.json(), signal).catch((error: unknown) => {
        signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") throw error;
        return null;
      });
      current();
      const limited = rateLimitFrom(response, json, budget);
      if (limited !== null) throw limited;
      const errors = isRecord(json) ? json["errors"] : undefined;
      let message: string | null = null;
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0];
        message =
          isRecord(first) && typeof first["message"] === "string"
            ? first["message"]
            : "request failed";
      }
      if (!response.ok) {
        const detail = message !== null ? `: ${message}` : "";
        throw new Error(`Linear GraphQL HTTP ${response.status}${detail}`);
      }
      if (message !== null) throw new Error(`Linear GraphQL: ${message}`);
      if (!isRecord(json)) throw new Error("Linear GraphQL returned no data");
      if (json["data"] === undefined) throw new Error("Linear GraphQL returned no data");
      return json["data"];
    },
  };
  return client;
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
