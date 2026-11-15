import { expect, test } from "bun:test";
import { createUsageReader } from "./index";
import { UsageAuthExpired, UsageCredentialExpired } from "./usage";
for (const format of ["claude", "claude-oauth", "codex"])
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
