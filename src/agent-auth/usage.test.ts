import { expect, test } from "bun:test";
import { createUsageReader } from "./index";
import { UsageAuthExpired, UsageCredentialExpired } from "./usage";
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
      status = 401;
      await expect(read(agent, credential)).rejects.toBeInstanceOf(UsageAuthExpired);
      time = 1900000000000;
      await expect(read(agent, credential)).rejects.toBeInstanceOf(UsageCredentialExpired);
      expect(calls).toBe(2);
    } finally {
      await server.stop(true);
    }
  });

test("a setup token reads its limits from the rate-limit headers of a one-token message", async () => {
  let seen: { path: string; headers: Headers; body: Record<string, unknown> } | undefined;
  let status = 200;
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
          headers: {
            "anthropic-ratelimit-unified-5h-utilization": "0.42",
            "anthropic-ratelimit-unified-5h-reset": "2000000000",
            "anthropic-ratelimit-unified-7d-utilization": "1",
            "anthropic-ratelimit-unified-7d-reset": "2000100000",
          },
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
  } finally {
    await server.stop(true);
  }
});
