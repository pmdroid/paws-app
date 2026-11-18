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
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let state = "authorization_pending";
  let generation = 0;
  let refreshToken = "";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ path, body });
      if (path === "/console/auth/device/code")
        return Response.json({
          device_code: "device-secret",
          user_code: "XBDM-QQNL",
          verification_uri_complete: "/console/device?user_code=XBDM-QQNL&client_id=opencode-cli",
          expires_in: 600,
          interval: 5,
        });
      if (body.grant_type === "refresh_token" && body.refresh_token !== refreshToken)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (body.grant_type !== "refresh_token" && state !== "approved")
        return Response.json({ error: state }, { status: 400 });
      refreshToken = "refresh-secret-" + ++generation;
      return Response.json({
        access_token: "access-secret-" + generation,
        refresh_token: refreshToken,
        expires_in: 3600,
      });
    },
  });
  return {
    calls,
    server: server.url.origin + "/console",
    approve: () => (state = "approved"),
    deny: () => (state = "access_denied"),
    expire: () => (state = "expired_token"),
    close: () => server.stop(true),
  };
}
