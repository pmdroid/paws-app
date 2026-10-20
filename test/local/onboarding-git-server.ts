import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [projects, repository, certPath, keyPath] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const BACKEND = "/usr/lib/git-core/git-http-backend";
const granted = new Map<string, string>();
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

void (async () => {
  let buffered = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffered += new TextDecoder().decode(chunk);
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const [kind, hash] = line.split(" ");
      if (kind && hash) granted.set(hash, kind);
    }
  }
  process.exit(0);
})();

const prefix = `/${repository}.git/`;
function credential(request: Request) {
  const basic = /^Basic (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!basic) return { user: undefined, kind: "none" };
  const [user, token] = Buffer.from(basic, "base64").toString("utf8").split(":", 2);
  return {
    user,
    kind:
      user === "x-access-token" && token ? (granted.get(digest(token)) ?? "unknown") : "invalid",
  };
}

async function handle(
  request: Request,
  url: URL,
  service: string | null,
  seen: { user: string | undefined; kind: string },
) {
  if (!url.pathname.startsWith(prefix)) return new Response("Not Found", { status: 404 });
  const upload =
    (request.method === "GET" &&
      url.pathname === `${prefix}info/refs` &&
      service === "git-upload-pack") ||
    (request.method === "POST" && url.pathname === `${prefix}git-upload-pack`);
  if (!upload) return new Response("Forbidden", { status: 403 });
  if (seen.kind !== "repository" && seen.kind !== "user")
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="GitHub"' },
    });
  const body = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : null;
  const child = Bun.spawn([BACKEND], {
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_PROJECT_ROOT: projects,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers.get("content-type") ?? "",
      ...(body ? { CONTENT_LENGTH: String(body.byteLength) } : {}),
      HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
      HTTP_GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
      REMOTE_USER: seen.user ?? "",
    },
    stdin: body ?? "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = Buffer.from(await new Response(child.stdout).arrayBuffer());
  await child.exited;
  const split = output.indexOf("\r\n\r\n");
  if (split < 0) return new Response("Bad Gateway", { status: 502 });
  const headers = new Headers();
  let status = 200;
  for (const line of output.subarray(0, split).toString("latin1").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
    else headers.append(name, value);
  }
  return new Response(output.subarray(split + 4), { status, headers });
}

Bun.serve({
  hostname: "127.0.0.1",
  port: 443,
  tls: { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") },
  async fetch(request) {
    const url = new URL(request.url);
    const service = url.searchParams.get("service");
    const seen = credential(request);
    const response = await handle(request, url, service, seen).catch(
      () => new Response("Internal Server Error", { status: 500 }),
    );
    console.log(
      JSON.stringify({
        at: Date.now(),
        path: url.pathname,
        method: request.method,
        service,
        credential: seen.kind,
        status: response.status,
      }),
    );
    return response;
  },
});
console.log(JSON.stringify({ ready: true }));
