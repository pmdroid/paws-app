import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { get } from "node:https";
import { join } from "node:path";
import { loadPublicTls } from "../../src/deployment";
import { migrate, openDatabase } from "../../src/db";
import { startServer, type HealthReport } from "../../src/server";

export function createPublicTlsFixture(root: string): {
  PAWS_TLS_KEY_PATH: string;
  PAWS_TLS_CERT_PATH: string;
} {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = join(root, "public.key");
  const cert = join(root, "public.crt");
  const result = Bun.spawnSync(
    [
      "/usr/bin/openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-config",
      "/dev/null",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
    ],
    { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root } },
  );
  if (result.exitCode !== 0) throw new Error("Could not generate local TLS fixture");
  chmodSync(key, 0o600);
  return { PAWS_TLS_KEY_PATH: key, PAWS_TLS_CERT_PATH: cert };
}

export async function probePublicTls(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  const files = createPublicTlsFixture(join(root, "public-tls"));
  const tls = loadPublicTls({ ...files, PAWS_PUBLIC_DASHBOARD: "1" });
  if (!tls) throw new Error("Public TLS was not loaded");
  const db = openDatabase(":memory:");
  migrate(db);
  const server = startServer({
    db,
    hostname: "127.0.0.1",
    port: 0,
    tls,
    webhooks: false,
  });
  try {
    const result = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const request = get(
          {
            hostname: "127.0.0.1",
            port: server.port,
            path: "/health",
            ca: tls.cert,
            rejectUnauthorized: true,
          },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => resolve({ status: response.statusCode, body }));
            response.on("error", reject);
          },
        );
        request.setTimeout(5_000, () => request.destroy(new Error("Local TLS request timed out")));
        request.on("error", reject);
      },
    );
    const health = JSON.parse(result.body) as HealthReport;
    observe(
      "public TLS configuration serves direct verified HTTPS",
      result.status === 200 &&
        health.ok &&
        health.service === "paws" &&
        health.failedChecks.length === 0,
      result,
    );
  } finally {
    await server.stop(true);
    db.close();
  }
  await probePublicTlsErrorPages(root, observe);
}

export async function probePublicTlsErrorPages(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  const files = createPublicTlsFixture(join(root, "error-pages"));
  const service = readFileSync(new URL("../../deploy/linux/paws.service", import.meta.url), "utf8");
  const nodeEnv = service.match(/^Environment=NODE_ENV=(.*)$/m)?.[1] ?? "";
  const program = `
    import { loadPublicTls } from ${JSON.stringify(new URL("../../src/deployment/index.ts", import.meta.url).href)};
    import { startServer } from ${JSON.stringify(new URL("../../src/server/index.ts", import.meta.url).href)};
    const tls = loadPublicTls(${JSON.stringify(files)});
    const server = startServer({hostname:"127.0.0.1",port:0,tls,webhooks:false,
      runnerEnrollment:async()=>{throw new Error("PAWS_ERROR_PAGE_SENTINEL")}});
    try {
      const response = await fetch("https://127.0.0.1:"+server.port+"/api/runner-pairings",{
        headers:{accept:"text/html"},tls:{ca:tls.cert,rejectUnauthorized:true},signal:AbortSignal.timeout(5000)});
      console.log(JSON.stringify({status:response.status,body:await response.text()}));
    } finally { await server.stop(true); }
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", program], {
    env: { PATH: "/usr/bin:/bin", HOME: root, NODE_ENV: nodeEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`Public TLS error-page child failed: ${stderr}`);
  const result = JSON.parse(stdout) as { status: number; body: string };
  const detailsVisible = result.body.includes("PAWS_ERROR_PAGE_SENTINEL");
  observe(
    "production service hides uncaught route details on verified HTTPS",
    result.status === 500 && !detailsVisible,
    { status: result.status, nodeEnv, detailsVisible },
  );
}
