import type { FetchLike, LinearAuth } from "./oauth";

const GRAPHQL_URL = "https://api.linear.app/graphql";

export type LinearClient = {
  query(query: string, variables?: Record<string, unknown>): Promise<unknown>;
};

export function createLinearClient(options: { auth: LinearAuth; fetch?: FetchLike }): LinearClient {
  const fetchImpl = options.fetch ?? fetch;
  return {
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
      if (!response.ok) {
        throw new Error(`Linear GraphQL HTTP ${response.status}`);
      }
      const json: unknown = await response.json();
      if (!isRecord(json)) throw new Error("Linear GraphQL returned no data");
      const errors = json["errors"];
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0];
        const message =
          isRecord(first) && typeof first["message"] === "string"
            ? first["message"]
            : "request failed";
        throw new Error(`Linear GraphQL: ${message}`);
      }
      if (json["data"] === undefined) throw new Error("Linear GraphQL returned no data");
      return json["data"];
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
