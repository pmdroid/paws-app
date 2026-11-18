import { z } from "zod";
import { ClaudeOAuthTokenSchema } from "../runner-protocol";
import type { AgentLimit } from "../install";
export class UsageAuthExpired extends Error {}
export class UsageCredentialExpired extends Error {}
export class UsageUnavailable extends Error {}
const unavailable = (status: number) => new UsageUnavailable(`Usage unavailable (HTTP ${status})`);
const window = z.object({
  used_percent: z.number().finite(),
  reset_at: z.number().finite().nullable(),
  limit_window_seconds: z.number().positive(),
});
const rate = z.object({ primary_window: window.nullish(), secondary_window: window.nullish() });
export function createUsageReader(
  origins: { codex: string; claude: string; grok?: string; opencode?: string } = {
    codex: "https://chatgpt.com/backend-api",
    claude: "https://api.anthropic.com",
  },
  now = Date.now,
) {
  return async (agent: string, credential: string): Promise<AgentLimit[]> => {
    const files = z
      .array(z.object({ path: z.string(), data: z.string() }))
      .parse(JSON.parse(credential));
    const decoded = (path: string) => {
      const found = files.find((f) => f.path === path);
      if (!found) throw new Error("Usage credential unavailable");
      return JSON.parse(Buffer.from(found.data, "base64").toString()) as unknown;
    };
    if (agent === "grok") return grokLimits(origins.grok, decoded(".grok/auth.json"), now);
    if (agent === "opencode")
      return opencodeLimits(origins.opencode, decoded(".paws/opencode-credential.json"), now);
    const file =
      (agent === "claude" && files.find((f) => f.path === ".claude/paws-oauth.json")) ||
      files.find(
        (f) => f.path === (agent === "codex" ? ".codex/auth.json" : ".claude/.credentials.json"),
      );
    if (!file) throw new Error("Usage credential unavailable");
    const value = JSON.parse(Buffer.from(file.data, "base64").toString());
    if (file.path === ".claude/paws-oauth.json") {
      const oauth = ClaudeOAuthTokenSchema.parse(value);
      if (oauth.expiresAt <= now()) throw new UsageCredentialExpired();
      return await setupTokenLimits(origins.claude, oauth.token);
    }
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
    if (!response.ok) throw unavailable(response.status);
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

const SETUP_TOKEN_WINDOWS = [
  ["5h", "5-hour"],
  ["7d", "Weekly"],
] as const;

async function setupTokenLimits(origin: string, token: string): Promise<AgentLimit[]> {
  const response = await fetch(new URL("v1/messages", origin + "/"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: "." }],
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new UsageAuthExpired();
  const limits = SETUP_TOKEN_WINDOWS.flatMap(([key, label]) => {
    const used = Number(response.headers.get(`anthropic-ratelimit-unified-${key}-utilization`));
    const reset = Number(response.headers.get(`anthropic-ratelimit-unified-${key}-reset`));
    if (
      !response.headers.has(`anthropic-ratelimit-unified-${key}-utilization`) ||
      !Number.isFinite(used)
    )
      return [];
    return [
      {
        window: label,
        usedPercent: Math.round(used * 100),
        resetsAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
      },
    ];
  });
  if (limits.length === 0)
    throw response.ok
      ? new UsageUnavailable("Usage not available for this sign-in")
      : unavailable(response.status);
  return limits;
}

const GROK_SCOPE = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const resetTime = z
  .union([z.string(), z.number().finite()])
  .nullish()
  .transform((value) => {
    if (value == null) return null;
    const time =
      typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
    return Number.isFinite(time) ? time : null;
  });

async function getJson(url: URL, headers: Record<string, string>, absent?: number) {
  const response = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new UsageCredentialExpired();
  if (response.status === absent) return undefined;
  if (!response.ok) throw unavailable(response.status);
  return (await response.json()) as unknown;
}

async function grokLimits(
  origin = "https://cli-chat-proxy.grok.com",
  value: unknown,
  now: () => number,
): Promise<AgentLimit[]> {
  const auth = z
    .object({ key: z.string().min(1), user_id: z.string().min(1), expires_at: resetTime })
    .parse(z.record(z.string(), z.unknown()).parse(value)[GROK_SCOPE]);
  if (auth.expires_at !== null && auth.expires_at <= now()) throw new UsageCredentialExpired();
  const url = new URL("v1/billing", origin + "/");
  url.searchParams.set("format", "credits");
  const body = await getJson(url, {
    Authorization: `Bearer ${auth.key}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-userid": auth.user_id,
    "x-grok-client-version": "paws",
  });
  const config = z
    .object({
      credit_usage_percent: z.number().finite(),
      current_period: z.object({ period_type: z.string().nullish(), end: resetTime }).nullish(),
    })
    .parse(z.object({ config: z.unknown() }).parse(body).config);
  return [
    {
      window:
        config.current_period?.period_type === "USAGE_PERIOD_TYPE_WEEKLY" ? "Weekly" : "Monthly",
      usedPercent: config.credit_usage_percent,
      resetsAt: config.current_period?.end ?? null,
    },
  ];
}

const goWindow = z.object({
  status: z.string().nullish(),
  percent: z.number().finite(),
  resetsAt: resetTime,
});

async function opencodeLimits(
  origin = "https://opencode.ai",
  value: unknown,
  now: () => number,
): Promise<AgentLimit[]> {
  const auth = z
    .object({
      access: z.string().min(1),
      expires: z.number().finite(),
      metadata: z.object({ orgID: z.string().nullish() }).nullish(),
    })
    .parse(value);
  if (auth.expires <= now()) throw new UsageCredentialExpired();
  const headers: Record<string, string> = { Authorization: `Bearer ${auth.access}` };
  if (auth.metadata?.orgID) headers["x-opencode-org-id"] = auth.metadata.orgID;
  const go = await getJson(new URL("zen/go/v1/usage", origin + "/"), headers, 403);
  if (go !== undefined) {
    const usage = z
      .object({
        usage: z.object({
          rolling: goWindow.nullish(),
          weekly: goWindow.nullish(),
          monthly: goWindow.nullish(),
        }),
      })
      .parse(go).usage;
    return (
      [
        ["5-hour", usage.rolling],
        ["Weekly", usage.weekly],
        ["Monthly", usage.monthly],
      ] as const
    ).flatMap(([label, w]) =>
      w
        ? [
            {
              window: label,
              usedPercent: w.status === "rate-limited" ? 100 : w.percent,
              resetsAt: w.resetsAt,
            },
          ]
        : [],
    );
  }
  const budgets = await getJson(
    new URL("console/api/policies/current-budgets", origin + "/"),
    headers,
    403,
  );
  if (budgets === undefined) return [];
  return z
    .array(
      z.object({
        limitDollars: z.number().finite(),
        spentDollars: z.number().finite(),
        resetsAt: resetTime,
      }),
    )
    .parse(budgets)
    .filter((b) => b.limitDollars > 0)
    .map((b) => ({
      window: "Monthly budget",
      usedPercent: Math.min(100, (b.spentDollars / b.limitDollars) * 100),
      resetsAt: b.resetsAt,
    }));
}
