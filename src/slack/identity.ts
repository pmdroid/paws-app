import type { Database } from "bun:sqlite";
import { createSlackAuth, readSlackToken, type SlackFetch } from "./oauth";

export type SlackIdentityReads = {
  teamId: string;
  lookup(email: string, signal: AbortSignal): Promise<string | null>;
};

export function createSlackIdentityReads(options: {
  home: string;
  db: Database;
  fetch?: SlackFetch;
}): SlackIdentityReads | null {
  const installation = readSlackToken(options.home);
  if (installation === null) return null;
  const auth = createSlackAuth(options);
  return {
    teamId: installation.teamId,
    async lookup(email, signal) {
      const token = await auth.ensureFresh();
      if (readSlackToken(options.home)?.teamId !== installation.teamId)
        throw new Error("Slack installation changed.");
      const url = new URL("https://slack.com/api/users.lookupByEmail");
      url.searchParams.set("email", email);
      const response = await (options.fetch ?? fetch)(url.href, {
        headers: { authorization: `Bearer ${token}` },
        signal,
        redirect: "error",
      });
      const data: unknown = await response.json();
      if (!response.ok || !record(data)) throw new Error("Slack identity lookup failed.");
      if (data["ok"] === false && data["error"] === "users_not_found") return null;
      const user = data["user"];
      if (
        data["ok"] !== true ||
        !record(user) ||
        typeof user["id"] !== "string" ||
        !/^[UW][A-Z0-9]+$/.test(user["id"]) ||
        user["team_id"] !== installation.teamId ||
        user["deleted"] !== false ||
        user["is_bot"] !== false ||
        user["is_app_user"] !== false ||
        !record(user["profile"]) ||
        typeof user["profile"]["email"] !== "string" ||
        user["profile"]["email"].toLowerCase() !== email.toLowerCase()
      )
        throw new Error("Slack returned an unverified user identity.");
      return user["id"];
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
