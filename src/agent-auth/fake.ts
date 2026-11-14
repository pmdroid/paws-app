export function fakeCodexOAuth(now: () => number) {
  const calls: string[] = [];
  let state = "pending";
  let failRefresh = false;
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
      if (body.includes("refresh_token") && failRefresh) return new Response(null, { status: 401 });
      return Response.json({
        id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }),
        access_token: jwt({ exp: Math.floor(now() / 1000) + 3600 }),
        refresh_token: "refresh-secret",
      });
    },
  });
  return {
    calls,
    issuer: server.url.origin,
    approve: () => {
      state = "approved";
    },
    deny: () => {
      state = "access_denied";
    },
    expire: () => {
      state = "expired_token";
    },
    failRefresh: () => {
      failRefresh = true;
    },
    close: () => server.stop(true),
  };
}
