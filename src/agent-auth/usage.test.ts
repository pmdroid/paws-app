import { expect, test } from "bun:test";
import { createUsageReader } from "./index";
import { UsageAuthExpired, UsageCredentialExpired, UsageUnavailable } from "./usage";
for (const format of ["claude", "codex"])
  test(`${format} reads provider windows without refreshing credentials`, async () => {
    const agent = format === "claude-oauth" ? "claude" : format;
    let status = 200;
    let calls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        calls++;
        expect(new URL(request.url).pathname).toBe(
          agent === "codex" ? "/wham/usage" : "/api/oauth/usage",
        );
        expect(request.headers.get("Authorization")).toBe(`Bearer ${token}`);
        if (agent === "codex") expect(request.headers.get("ChatGPT-Account-Id")).toBe("account");
        else expect(request.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
        return Response.json(
          agent === "codex"
            ? {
                rate_limit: {
                  primary_window: {
                    used_percent: 45,
                    limit_window_seconds: 18000,
                    reset_at: 2000000000,
                  },
                  secondary_window: {
                    used_percent: 100,
                    limit_window_seconds: 604800,
                    reset_at: 2000100000,
                  },
                },
              }
            : {
                five_hour: { utilization: 45, resets_at: new Date(2000000000000).toISOString() },
                seven_day: { utilization: 100, resets_at: new Date(2000100000000).toISOString() },
              },
          { status },
        );
      },
    });
    let time = 1800000000000;
    const token =
      agent === "codex"
        ? "header." +
          Buffer.from(JSON.stringify({ exp: 1900000000 })).toString("base64url") +
          ".sig"
        : "sk-ant-oat01-test-token";
    const credential = JSON.stringify([
      {
        path:
          agent === "codex"
            ? ".codex/auth.json"
            : format === "claude-oauth"
              ? ".claude/paws-oauth.json"
              : ".claude/.credentials.json",
        data: Buffer.from(
          JSON.stringify(
            agent === "codex"
              ? { tokens: { access_token: token, account_id: "account" } }
              : format === "claude-oauth"
                ? { kind: "oauth_token", token, createdAt: time, expiresAt: 1900000000000 }
                : { claudeAiOauth: { accessToken: token, expiresAt: 1900000000000 } },
          ),
        ).toString("base64"),
      },
    ]);
    try {
      const read = createUsageReader(
        { codex: server.url.origin, claude: server.url.origin },
        () => time,
      );
      expect(await read(agent, credential)).toEqual([
        { window: "5-hour", usedPercent: 45, resetsAt: 2000000000000 },
        { window: "Weekly", usedPercent: 100, resetsAt: 2000100000000 },
      ]);
      for (const refused of [403, 429]) {
        status = refused;
        const error = await read(agent, credential).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UsageUnavailable);
        expect((error as Error).message).toBe(`Usage unavailable (HTTP ${refused})`);
      }
      status = 401;
      await expect(read(agent, credential)).rejects.toBeInstanceOf(UsageAuthExpired);
      time = 1900000000000;
      await expect(read(agent, credential)).rejects.toBeInstanceOf(UsageCredentialExpired);
      expect(calls).toBe(4);
    } finally {
      await server.stop(true);
    }
  });

test("a setup token reads its limits from the rate-limit headers of a one-token message", async () => {
  let seen: { path: string; headers: Headers; body: Record<string, unknown> } | undefined;
  let status = 200;
  let headers = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen = {
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: (await request.json()) as Record<string, unknown>,
      };
      return Response.json(
        {},
        {
          status,
          headers: headers
            ? {
                "anthropic-ratelimit-unified-5h-utilization": "0.42",
                "anthropic-ratelimit-unified-5h-reset": "2000000000",
                "anthropic-ratelimit-unified-7d-utilization": "1",
                "anthropic-ratelimit-unified-7d-reset": "2000100000",
              }
            : {},
        },
      );
    },
  });
  try {
    const read = createUsageReader(
      { codex: "http://127.0.0.1:1", claude: `http://127.0.0.1:${server.port}` },
      () => 1800000000000,
    );
    const credential = JSON.stringify([
      {
        path: ".claude/paws-oauth.json",
        data: Buffer.from(
          JSON.stringify({
            kind: "oauth_token",
            token: "sk-ant-oat01-test-token",
            createdAt: 1700000000000,
            expiresAt: 1900000000000,
          }),
        ).toString("base64"),
      },
    ]);
    const limits = [
      { window: "5-hour", usedPercent: 42, resetsAt: 2000000000000 },
      { window: "Weekly", usedPercent: 100, resetsAt: 2000100000000 },
    ];
    expect(await read("claude", credential)).toEqual(limits);
    expect(seen?.path).toBe("/v1/messages");
    expect(seen?.headers.get("authorization")).toBe("Bearer sk-ant-oat01-test-token");
    expect(seen?.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(seen?.body.max_tokens).toBe(1);
    status = 429;
    expect(await read("claude", credential)).toEqual(limits);
    status = 401;
    await expect(read("claude", credential)).rejects.toBeInstanceOf(UsageAuthExpired);
    headers = false;
    for (const [code, reason] of [
      [200, "Usage not available for this sign-in"],
      [429, "Usage unavailable (HTTP 429)"],
    ] as const) {
      status = code;
      const error = await read("claude", credential).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UsageUnavailable);
      expect((error as Error).message).toBe(reason);
    }
  } finally {
    await server.stop(true);
  }
});

type Seen = { url: URL; headers: Record<string, string> };
function serve(routes: Record<string, () => Response>, seen: Seen[]) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      seen.push({ url: new URL(request.url), headers: request.headers.toJSON() });
      const route = routes[new URL(request.url).pathname];
      return route ? route() : new Response(null, { status: 404 });
    },
  });
}
const file = (path: string, value: unknown) =>
  JSON.stringify([{ path, data: Buffer.from(JSON.stringify(value)).toString("base64") }]);

test("grok reads one billing window with the CLI headers", async () => {
  const seen: Seen[] = [];
  let status = 200;
  let period = "USAGE_PERIOD_TYPE_WEEKLY";
  const server = serve(
    {
      "/v1/billing": () =>
        Response.json(
          {
            config: {
              credit_usage_percent: 37,
              current_period: {
                period_type: period,
                start: "2027-01-01T00:00:00Z",
                end: "2027-01-08T00:00:00Z",
              },
            },
          },
          { status },
        ),
    },
    seen,
  );
  let time = 1800000000000;
  const credential = file(".grok/auth.json", {
    "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
      key: "xai-key",
      user_id: "user-42",
      create_time: "2026-11-18T00:00:00Z",
      expires_at: new Date(1900000000000).toISOString(),
    },
  });
  try {
    const read = createUsageReader(
      { codex: "http://127.0.0.1:1", claude: "http://127.0.0.1:1", grok: server.url.origin },
      () => time,
    );
    expect(await read("grok", credential)).toEqual([
      { window: "Weekly", usedPercent: 37, resetsAt: Date.parse("2027-01-08T00:00:00Z") },
    ]);
    expect(seen[0]!.url.search).toBe("?format=credits");
    expect(seen[0]!.headers["authorization"]).toBe("Bearer xai-key");
    expect(seen[0]!.headers["x-xai-token-auth"]).toBe("xai-grok-cli");
    expect(seen[0]!.headers["x-userid"]).toBe("user-42");
    expect(seen[0]!.headers["x-grok-client-version"]).toBe("paws");
    period = "USAGE_PERIOD_TYPE_MONTHLY";
    expect((await read("grok", credential))[0]!.window).toBe("Monthly");
    status = 500;
    await expect(read("grok", credential)).rejects.toBeInstanceOf(UsageUnavailable);
    status = 401;
    await expect(read("grok", credential)).rejects.toBeInstanceOf(UsageCredentialExpired);
    time = 1900000000000;
    await expect(read("grok", credential)).rejects.toBeInstanceOf(UsageCredentialExpired);
    expect(seen).toHaveLength(4);
  } finally {
    await server.stop(true);
  }
});

test("opencode reads Go windows, falls back to budgets and saves nothing without either", async () => {
  const seen: Seen[] = [];
  let go = 200;
  let budgets = 200;
  const server = serve(
    {
      "/zen/go/v1/usage": () =>
        Response.json(
          {
            usage: {
              rolling: { status: "rate-limited", percent: 64, resetsAt: "2027-01-01T05:00:00Z" },
              weekly: { status: "ok", percent: 40, resetsAt: "2027-01-04T00:00:00Z" },
              monthly: { status: "ok", percent: 12, resetsAt: "2027-02-01T00:00:00Z" },
            },
          },
          { status: go },
        ),
      "/console/api/policies/current-budgets": () =>
        Response.json(
          [
            { limitDollars: 50, spentDollars: 20, resetsAt: "2027-02-01T00:00:00Z" },
            { limitDollars: 10, spentDollars: 15, resetsAt: null },
          ],
          { status: budgets },
        ),
    },
    seen,
  );
  const credential = file(".paws/opencode-credential.json", {
    type: "oauth",
    access: "oc-access",
    refresh: "oc-refresh",
    expires: 1900000000000,
    metadata: { orgID: "org-1" },
  });
  try {
    const read = createUsageReader(
      { codex: "http://127.0.0.1:1", claude: "http://127.0.0.1:1", opencode: server.url.origin },
      () => 1800000000000,
    );
    expect(await read("opencode", credential)).toEqual([
      { window: "5-hour", usedPercent: 100, resetsAt: Date.parse("2027-01-01T05:00:00Z") },
      { window: "Weekly", usedPercent: 40, resetsAt: Date.parse("2027-01-04T00:00:00Z") },
      { window: "Monthly", usedPercent: 12, resetsAt: Date.parse("2027-02-01T00:00:00Z") },
    ]);
    expect(seen[0]!.headers["authorization"]).toBe("Bearer oc-access");
    expect(seen[0]!.headers["x-opencode-org-id"]).toBe("org-1");
    go = 403;
    expect(await read("opencode", credential)).toEqual([
      { window: "Monthly budget", usedPercent: 40, resetsAt: Date.parse("2027-02-01T00:00:00Z") },
      { window: "Monthly budget", usedPercent: 100, resetsAt: null },
    ]);
    budgets = 403;
    expect(await read("opencode", credential)).toEqual([]);
    budgets = 401;
    await expect(read("opencode", credential)).rejects.toBeInstanceOf(UsageCredentialExpired);
    go = 401;
    await expect(read("opencode", credential)).rejects.toBeInstanceOf(UsageCredentialExpired);
    go = 502;
    await expect(read("opencode", credential)).rejects.toBeInstanceOf(UsageUnavailable);
  } finally {
    await server.stop(true);
  }
});
