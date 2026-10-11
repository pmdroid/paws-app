import { budgetFromHeaders, rateLimitFrom, rememberLinearBudget } from "./budget";
import type { FetchLike, LinearAuth } from "./oauth";

const GRAPHQL_URL = "https://api.linear.app/graphql";

export type LinearClient = {
  query(query: string, variables?: Record<string, unknown>): Promise<unknown>;
};

export function createLinearClient(options: { auth: LinearAuth; fetch?: FetchLike }): LinearClient {
  const fetchImpl = options.fetch ?? fetch;
  const client: LinearClient = {
    async query(query, variables) {
      const run = async (token: string) =>
        fetchImpl(GRAPHQL_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ query, variables: variables ?? {} }),
        });
      let token = await options.auth.ensureFresh();
      let response = await run(token);
      if (response.status === 401) {
        token = await options.auth.forceRefresh();
        response = await run(token);
      }
      const budget = budgetFromHeaders(response.headers);
      rememberLinearBudget(client, budget);
      const json: unknown = await response.json().catch(() => null);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
