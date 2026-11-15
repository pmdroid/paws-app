import { z } from "zod";
import { ClaudeOAuthTokenSchema } from "../runner-protocol";
import type { AgentLimit } from "../install";
export class UsageAuthExpired extends Error {}
export class UsageCredentialExpired extends Error {}
const window = z.object({
  used_percent: z.number().finite(),
  reset_at: z.number().finite().nullable(),
  limit_window_seconds: z.number().positive(),
});
const rate = z.object({ primary_window: window.nullish(), secondary_window: window.nullish() });
export function createUsageReader(
  origins = { codex: "https://chatgpt.com/backend-api", claude: "https://api.anthropic.com" },
  now = Date.now,
) {
  return async (agent: string, credential: string): Promise<AgentLimit[]> => {
    const files = z
      .array(z.object({ path: z.string(), data: z.string() }))
      .parse(JSON.parse(credential));
    const file =
      (agent === "claude" && files.find((f) => f.path === ".claude/paws-oauth.json")) ||
      files.find(
        (f) => f.path === (agent === "codex" ? ".codex/auth.json" : ".claude/.credentials.json"),
      );
    if (!file) throw new Error("Usage credential unavailable");
    const value = JSON.parse(Buffer.from(file.data, "base64").toString());
    let token: string;
    let expires: number;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (agent === "codex") {
      const tokens = z
        .object({ access_token: z.string(), account_id: z.string().nullish() })
        .parse(value.tokens);
      token = tokens.access_token;
      expires =
        z
          .object({ exp: z.number() })
          .parse(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString())).exp *
        1000;
      if (tokens.account_id) headers["ChatGPT-Account-Id"] = tokens.account_id;
      headers["User-Agent"] = "codex-cli";
    } else if (file.path === ".claude/paws-oauth.json") {
      const oauth = ClaudeOAuthTokenSchema.parse(value);
      token = oauth.token;
      expires = oauth.expiresAt;
      headers["anthropic-beta"] = "oauth-2025-04-20";
    } else {
      const oauth = z
        .object({ accessToken: z.string(), expiresAt: z.number() })
        .parse(value.claudeAiOauth);
      token = oauth.accessToken;
      expires = oauth.expiresAt;
      headers["anthropic-beta"] = "oauth-2025-04-20";
    }
    if (expires <= now()) throw new UsageCredentialExpired();
    headers.Authorization = `Bearer ${token}`;
    const response = await fetch(
      new URL(
        agent === "codex" ? "wham/usage" : "api/oauth/usage",
        (agent === "codex" ? origins.codex : origins.claude) + "/",
      ),
      { headers, redirect: "error", signal: AbortSignal.timeout(15_000) },
    );
    if (response.status === 401) throw new UsageAuthExpired();
    if (!response.ok) throw new Error("Provider usage unavailable");
    const body = await response.json();
    if (agent === "codex") {
      const payload = z
        .object({
          rate_limit: rate.nullish(),
          additional_rate_limits: z
            .array(z.object({ limit_name: z.string(), rate_limit: rate.nullish() }))
            .nullish(),
        })
        .parse(body);
      return [
        { name: "", rate: payload.rate_limit },
        ...(payload.additional_rate_limits ?? []).map((r) => ({
          name: r.limit_name + " ",
          rate: r.rate_limit,
        })),
      ].flatMap((r) =>
        [r.rate?.primary_window, r.rate?.secondary_window].flatMap((w) =>
          w
            ? [
                {
                  window:
                    r.name +
                    (w.limit_window_seconds === 18000
                      ? "5-hour"
                      : w.limit_window_seconds === 604800
                        ? "Weekly"
                        : `${w.limit_window_seconds / 60} minutes`),
                  usedPercent: w.used_percent,
                  resetsAt: w.reset_at === null ? null : w.reset_at * 1000,
                },
              ]
            : [],
        ),
      );
    }
    const payload = z.record(z.string(), z.unknown()).parse(body);
    return Object.entries({
      five_hour: "5-hour",
      seven_day: "Weekly",
      seven_day_sonnet: "Sonnet weekly",
      seven_day_opus: "Opus weekly",
    }).flatMap(([key, label]) => {
      if (payload[key] == null) return [];
      const w = z
        .object({
          utilization: z.number().finite(),
          resets_at: z.iso.datetime({ offset: true }).nullable(),
        })
        .parse(payload[key]);
      return [
        {
          window: label,
          usedPercent: w.utilization,
          resetsAt: w.resets_at === null ? null : Date.parse(w.resets_at),
        },
      ];
    });
  };
}
