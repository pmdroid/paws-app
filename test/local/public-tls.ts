import { chmodSync, mkdirSync } from "node:fs";
import { get } from "node:https";
import { join } from "node:path";
import { loadPublicTls } from "../../src/deployment";
import { startServer } from "../../src/server";

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
  const server = startServer({
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
    observe(
      "public TLS configuration serves direct verified HTTPS",
      result.status === 200 && result.body === JSON.stringify({ ok: true, service: "paws" }),
      result,
    );
  } finally {
    await server.stop(true);
  }
}
