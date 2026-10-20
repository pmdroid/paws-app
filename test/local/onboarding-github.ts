import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import { INSTALLATION_PERMISSIONS } from "../../src/github";

const direct = globalThis.fetch;

export type GitHubCredential = "none" | "user" | "app" | "installation" | "invalid";

export type OnboardingGitHub = {
  origin: string;
  access: "admin" | "push" | "pull";
  requests: {
    sequence: number;
    path: string;
    method: string;
    credential: GitHubCredential;
    tokenSha256: string | null;
    memberPush: boolean | null;
    status: number;
  }[];
  minted: {
    sequence: number;
    tokenSha256: string;
    installationId: string;
    repositories: unknown;
    permissions: unknown;
  }[];
  issued(): string[];
  onToken: (kind: "user" | "repository" | "metadata", token: string) => void;
  consent(authorizeUrl: string): Promise<URL>;
  stop(): Promise<void>;
};

export function freshPermissionDenial(
  projection: {
    revision: number;
    state: string;
    reason: string | null;
    memberGitHub: unknown;
  } | null,
  revisionBefore: number,
  checks: number,
) {
  const access = projection?.memberGitHub as { state?: string; reason?: string } | null;
  return (
    projection !== null &&
    projection.revision > revisionBefore &&
    checks > 0 &&
    projection.state === "waiting" &&
    projection.reason === "github" &&
    access?.state === "denied" &&
    access.reason === "permission"
  );
}

export function startOnboardingGitHub(app: {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKeyPem: string;
  installationId: string;
  repository: string;
  user: { id: number; login: string };
}): OnboardingGitHub {
  const [owner, repo] = app.repository.split("/") as [string, string];
  const publicKey: KeyObject = createPublicKey(app.privateKeyPem);
  const slug = "paws-fixture";
  const codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string | null; used: boolean }
  >();
  const userTokens = new Set<string>();
  const installationTokens = new Set<string>();
  const digest = (token: string) => createHash("sha256").update(token).digest("hex");
  let sequence = 0;
  const secret = (prefix: string) => `${prefix}${randomBytes(18).toString("hex")}`;
  const repository = () => ({
    id: 99,
    name: repo,
    full_name: app.repository,
    private: true,
    clone_url: `https://github.com/${app.repository}.git`,
    default_branch: "main",
    archived: false,
    disabled: false,
    owner: { login: owner, id: 9000, type: "Organization" },
    permissions: {
      admin: fake.access === "admin",
      push: fake.access !== "pull",
      pull: true,
    },
  });
  const installation = () => ({
    id: Number(app.installationId),
    app_id: Number(app.appId),
    app_slug: slug,
    suspended_at: null,
    account: { login: owner, id: 9000, type: "Organization" },
    permissions: INSTALLATION_PERMISSIONS,
    repository_selection: "selected",
  });
  function credential(request: Request): GitHubCredential {
    const header = request.headers.get("authorization");
    if (!header) return "none";
    const token = /^(?:Bearer|token) (\S+)$/.exec(header)?.[1];
    if (!token) return "invalid";
    if (userTokens.has(token)) return "user";
    if (installationTokens.has(token)) return "installation";
    const parts = token.split(".");
    if (parts.length !== 3) return "invalid";
    try {
      const jose = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as {
        alg?: string;
      };
      const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
        iss?: unknown;
        exp?: unknown;
        iat?: unknown;
      };
      const now = Math.floor(Date.now() / 1000);
      const signed = verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        publicKey,
        Buffer.from(parts[2]!, "base64url"),
      );
      return signed &&
        jose.alg === "RS256" &&
        String(claims.iss) === app.appId &&
        typeof claims.exp === "number" &&
        claims.exp > now &&
        typeof claims.iat === "number" &&
        claims.iat <= now + 60
        ? "app"
        : "invalid";
    } catch {
      return "invalid";
    }
  }
  function page(field: string, entries: unknown[]) {
    return Response.json({ total_count: entries.length, [field]: entries });
  }
  async function handle(
    request: Request,
    url: URL,
    seen: GitHubCredential,
    order: number,
  ): Promise<Response> {
    const path = url.pathname;
    if (path === "/login/oauth/authorize" && request.method === "GET") {
      const clientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      if (
        clientId !== app.clientId ||
        !redirectUri ||
        !state ||
        (challenge !== null && url.searchParams.get("code_challenge_method") !== "S256")
      )
        return Response.json({ error: "invalid_request" }, { status: 400 });
      const code = secret("code");
      codes.set(code, { clientId, redirectUri, challenge, used: false });
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: location.href } });
    }
    if (path === "/login/oauth/access_token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const grant = codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier");
      if (
        !grant ||
        grant.used ||
        form.get("client_id") !== grant.clientId ||
        form.get("client_secret") !== app.clientSecret ||
        (form.has("redirect_uri") && form.get("redirect_uri") !== grant.redirectUri) ||
        (grant.challenge !== null &&
          (!verifier ||
            createHash("sha256").update(verifier).digest("base64url") !== grant.challenge))
      )
        return Response.json({ error: "bad_verification_code" });
      grant.used = true;
      const token = secret("ghu_");
      userTokens.add(token);
      fake.onToken("user", token);
      return Response.json({ access_token: token, token_type: "bearer", scope: "" });
    }
    if (seen === "none" || seen === "invalid")
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    const repositoryPath = `/repos/${owner}/${repo}`;
    if (seen === "app") {
      if (path === "/app" && request.method === "GET")
        return Response.json({
          id: Number(app.appId),
          client_id: app.clientId,
          slug,
          name: "Paws fixture",
        });
      if (path === `${repositoryPath}/installation` && request.method === "GET")
        return Response.json(installation());
      if (path === "/app/installations" && request.method === "GET")
        return Response.json([installation()]);
      if (
        path === `/app/installations/${app.installationId}/access_tokens` &&
        request.method === "POST"
      ) {
        const body = (await request.json()) as { repositories?: unknown; permissions?: unknown };
        const metadataOnly =
          body.repositories === undefined &&
          JSON.stringify(body.permissions) === JSON.stringify({ metadata: "read" });
        if (
          !metadataOnly &&
          (!Array.isArray(body.repositories) ||
            body.repositories.length !== 1 ||
            body.repositories[0] !== repo)
        )
          return Response.json({ message: "Repository not installed" }, { status: 422 });
        const token = secret("ghs_");
        fake.minted.push({
          sequence: order,
          tokenSha256: digest(token),
          installationId: app.installationId,
          repositories: body.repositories ?? null,
          permissions: body.permissions ?? null,
        });
        installationTokens.add(token);
        fake.onToken(metadataOnly ? "metadata" : "repository", token);
        return Response.json(
          {
            token,
            expires_at: new Date(Date.now() + 50 * 60_000).toISOString(),
            permissions: body.permissions ?? INSTALLATION_PERMISSIONS,
            repository_selection: "selected",
            repositories: [{ id: 99, name: repo, full_name: app.repository }],
          },
          { status: 201 },
        );
      }
    }
    if (path === `/users/${encodeURIComponent(`${slug}[bot]`)}` || path === `/users/${slug}[bot]`)
      return Response.json({ id: 5555, login: `${slug}[bot]`, type: "Bot" });
    if (seen === "installation") {
      if (path === repositoryPath && request.method === "GET")
        return Response.json({ ...repository(), permissions: undefined });
      if (path === "/installation/repositories" && request.method === "GET")
        return page("repositories", [repository()]);
    }
    if (seen === "user") {
      if (path === "/user" && request.method === "GET")
        return Response.json({ id: app.user.id, login: app.user.login, type: "User" });
      if (path === repositoryPath && request.method === "GET") return Response.json(repository());
      if (path === `/user/memberships/orgs/${owner}` && request.method === "GET")
        return Response.json({
          state: "active",
          role: fake.access === "admin" ? "admin" : "member",
          organization: { login: owner },
        });
      if (path === "/user/installations" && request.method === "GET")
        return page("installations", [installation()]);
      if (
        path === `/user/installations/${app.installationId}/repositories` &&
        request.method === "GET"
      )
        return page("repositories", [repository()]);
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const seen = credential(request);
      const order = ++sequence;
      const memberPush =
        url.pathname === `/repos/${owner}/${repo}` && seen === "user"
          ? fake.access !== "pull"
          : null;
      const token = /^(?:Bearer|token) (\S+)$/.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      const response = await handle(request, url, seen, order);
      fake.requests.push({
        sequence: order,
        tokenSha256: token && installationTokens.has(token) ? digest(token) : null,
        memberPush,
        path: url.pathname,
        method: request.method,
        credential: seen,
        status: response.status,
      });
      return response;
    },
  });
  const fake: OnboardingGitHub = {
    origin: `http://127.0.0.1:${server.port}`,
    access: "admin",
    requests: [],
    minted: [],
    issued: () => [...userTokens, ...installationTokens, ...codes.keys()],
    onToken: () => {},
    async consent(authorizeUrl) {
      const upstream = new URL(authorizeUrl);
      if (
        upstream.origin !== "https://github.com" ||
        upstream.pathname !== "/login/oauth/authorize"
      )
        throw new Error("Paws did not redirect to the GitHub authorization endpoint.");
      const response = await direct(`${fake.origin}${upstream.pathname}${upstream.search}`, {
        redirect: "manual",
      });
      const location = response.headers.get("location");
      if (response.status !== 302 || !location)
        throw new Error(`GitHub consent rejected the authorization request (${response.status}).`);
      return new URL(location);
    },
    stop: () => server.stop(true),
  };
  return fake;
}
