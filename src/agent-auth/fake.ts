export function fakeCodexOAuth(now: () => number) {
  const calls: string[] = [];
  let state = "pending";
  let failRefresh = false;
  let refreshToken = "refresh-secret";
  let generation = 0;
  function jwt(body: object) {
    return "header." + Buffer.from(JSON.stringify(body)).toString("base64url") + ".signature";
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (path.endsWith("/usercode"))
        return Response.json({ device_auth_id: "device", user_code: "USER-CODE", interval: "5" });
      if (path.endsWith("/deviceauth/token")) {
        if (state === "pending") return new Response(null, { status: 403 });
        if (state !== "approved") return Response.json({ error: state }, { status: 400 });
        return Response.json({ authorization_code: "code", code_verifier: "verifier" });
      }
      const body = await request.text();
      if (body.includes("refresh_token") && JSON.parse(body).refresh_token !== refreshToken)
        return new Response(null, { status: 401 });
      if (body.includes("refresh_token") && failRefresh) return new Response(null, { status: 401 });
      refreshToken = "refresh-secret-" + ++generation;
      return Response.json({
        id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }),
        access_token: jwt({ exp: Math.floor(now() / 1000) + 3600 }),
        refresh_token: refreshToken,
      });
    },
  });
  return {
    calls,
    issuer: server.url.origin,
    approve: () => (state = "approved"),
    deny: () => (state = "access_denied"),
    expire: () => (state = "expired_token"),
    failRefresh: (value = true) => (failRefresh = value),
    close: () => server.stop(true),
  };
}
export function fakeOpencodeConsole() {
  const calls: { path: string; body: Record<string, unknown>; authorization: string | null }[] = [];
  const polls = ["authorization_pending", "slow_down"];
  let final = "approved";
  let generation = 0;
  let refreshToken = "";
  let orgId: string | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const authorization = request.headers.get("authorization");
      const body =
        request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
      calls.push({ path, body, authorization });
      if (path === "/console/auth/device/code")
        return Response.json({
          device_code: "device-secret",
          user_code: "XBDM-QQNL",
          verification_uri_complete: "/console/device?user_code=XBDM-QQNL&client_id=opencode-cli",
          expires_in: 600,
          interval: 5,
        });
      if (
        path.startsWith("/console/api/") &&
        authorization !== "Bearer access-secret-" + generation
      )
        return new Response(null, { status: 401 });
      if (path === "/console/api/user")
        return Response.json({ id: "user-1", email: "person@test.invalid" });
      if (path === "/console/api/orgs")
        return Response.json([
          { id: "org-c", name: "Zeta" },
          { id: "org-b", name: "Beta" },
          { id: "org-a", name: "Beta" },
        ]);
      if (body.grant_type === "refresh_token" && body.refresh_token !== refreshToken)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (body.grant_type !== "refresh_token") {
        const state = polls.shift() ?? final;
        if (state !== "approved") return Response.json({ error: state }, { status: 400 });
      }
      refreshToken = "refresh-secret-" + ++generation;
      return Response.json({
        access_token: "access-secret-" + generation,
        refresh_token: refreshToken,
        expires_in: 3600,
        ...(orgId ? { org_id: orgId } : {}),
      });
    },
  });
  return {
    calls,
    server: server.url.origin + "/console",
    deny: () => ((polls.length = 0), (final = "access_denied")),
    expire: () => ((polls.length = 0), (final = "expired_token")),
    org: (id: string | undefined) => (orgId = id),
    revoke: () => (refreshToken = "revoked"),
    close: () => server.stop(true),
  };
}
export function fakeXaiOAuth(now: () => number) {
  const calls: { path: string; form: Record<string, string> }[] = [];
  let state = "authorization_pending";
  let generation = 0;
  let refreshToken = "";
  function jwt(body: object) {
    return "header." + Buffer.from(JSON.stringify(body)).toString("base64url") + ".signature";
  }
  function issue() {
    refreshToken = "xai-refresh-" + ++generation;
    return Response.json({
      access_token: "xai-access-" + generation,
      refresh_token: refreshToken,
      expires_in: 3600,
      id_token: jwt({ sub: "user-42", email: "grok@test.invalid", iat: now() }),
    });
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const form = Object.fromEntries(new URLSearchParams(await request.text()));
      calls.push({ path, form });
      if (path === "/oauth2/device/code")
        return Response.json({
          device_code: "device-secret",
          user_code: "GROK-CODE",
          verification_uri: "https://accounts.x.ai/device",
          verification_uri_complete: "https://accounts.x.ai/device?user_code=GROK-CODE",
          expires_in: 600,
          interval: 5,
        });
      if (form.grant_type === "refresh_token")
        return form.refresh_token === refreshToken
          ? issue()
          : Response.json({ error: "invalid_grant" }, { status: 400 });
      if (state !== "approved") return Response.json({ error: state }, { status: 400 });
      return issue();
    },
  });
  return {
    calls,
    issuer: server.url.origin,
    approve: () => (state = "approved"),
    slowDown: () => (state = "slow_down"),
    deny: () => (state = "access_denied"),
    expire: () => (state = "expired_token"),
    close: () => server.stop(true),
  };
}
