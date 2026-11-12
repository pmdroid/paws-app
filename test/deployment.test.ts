import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postgresDb } from "../src/db";
import {
  loadPublicTls,
  publicTlsProxy,
  PROXY_RUNNER_TLS_REQUIRED,
  validateTlsRenewal,
  type PublicTls,
} from "../src/deployment";
import { startPaws } from "../src/index";
import { startServer } from "../src/server";
import { createWorkspaceAccess, type WorkspaceAccess } from "../src/workspace";
import { tempHome } from "./helpers";
import { createPublicTlsFixture, probePublicTls } from "./local/public-tls";
import { pgliteDb } from "./pglite";

const root = mkdtempSync(join(tmpdir(), "paws-public-tls-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("direct public HTTPS configuration", () => {
  test("local defaults and webhook public URL do not enable public dashboard TLS", () => {
    expect(loadPublicTls({})).toBeUndefined();
    expect(loadPublicTls({ PAWS_PUBLIC_URL: "https://webhook.example.invalid" })).toBeUndefined();
    expect(() => loadPublicTls({ PAWS_PUBLIC_DASHBOARD: "1" })).toThrow("requires");
  });

  test("rejects incomplete paths, relative paths, exposed keys and mismatched material", () => {
    const files = createPublicTlsFixture(join(root, "validation"));
    const other = createPublicTlsFixture(join(root, "other"));
    expect(() => loadPublicTls({ PAWS_TLS_KEY_PATH: files.PAWS_TLS_KEY_PATH })).toThrow(
      "both be absolute",
    );
    expect(() => loadPublicTls({ ...files, PAWS_TLS_KEY_PATH: "relative.key" })).toThrow(
      "both be absolute",
    );
    expect(() => loadPublicTls({ ...files, PAWS_TLS_KEY_PATH: other.PAWS_TLS_KEY_PATH })).toThrow(
      "valid and match",
    );
    for (const mode of [0o644, 0o640, 0o700]) {
      chmodSync(files.PAWS_TLS_KEY_PATH, mode);
      expect(() => loadPublicTls(files)).toThrow("owner-only");
    }
    chmodSync(files.PAWS_TLS_KEY_PATH, 0o600);
    writeFileSync(files.PAWS_TLS_CERT_PATH, "invalid certificate");
    expect(() => loadPublicTls(files)).toThrow("valid and match");
  });

  test("real TLS verifies the configured certificate and serves HTTPS", async () => {
    const observations: boolean[] = [];
    await probePublicTls(root, (_name, passed) => observations.push(passed));
    expect(observations).toEqual([true, true]);
  });
});

describe("public HTTPS terminated by a proxy", () => {
  const proxied = {
    PAWS_HOST: "127.0.0.1",
    PAWS_PORT: "0",
    PAWS_PUBLIC_DASHBOARD: "1",
    PAWS_PUBLIC_TLS: "proxy",
    PAWS_PUBLIC_URL: "https://paws.example",
    LINEAR_CLIENT_ID: "fixture-client",
    LINEAR_CLIENT_SECRET: "fixture-client-secret",
    LINEAR_ORGANIZATION_ID: "org",
  };

  test("starts without a certificate and answers health over plain HTTP", async () => {
    const paws = await startPaws({ ...proxied, PAWS_HOME: tempHome() });
    try {
      const response = await fetch(`http://127.0.0.1:${paws.server.port}/health`, {
        headers: { host: "paws.example" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, service: "paws" });
    } finally {
      await paws.stop();
    }
  });

  test("refuses an HTTP origin, certificate paths, runner control and unknown modes", async () => {
    const start = (env: Record<string, string>) =>
      startPaws({ ...proxied, PAWS_HOME: tempHome(), ...env });
    await expect(start({ PAWS_PUBLIC_URL: "http://paws.example" })).rejects.toThrow(
      "Public dashboard requires an HTTPS origin in PAWS_PUBLIC_URL.",
    );
    for (const path of ["PAWS_TLS_KEY_PATH", "PAWS_TLS_CERT_PATH"])
      await expect(start({ [path]: "/etc/paws/tls" })).rejects.toThrow(
        "PAWS_PUBLIC_TLS=proxy does not use PAWS_TLS_KEY_PATH or PAWS_TLS_CERT_PATH",
      );
    await expect(start({ PAWS_PUBLIC_TLS: "yes" })).rejects.toThrow(
      "PAWS_PUBLIC_TLS must be proxy or unset",
    );
    expect(publicTlsProxy({})).toBe(false);
  });

  describe("runner URL and certificate", () => {
    const files = createPublicTlsFixture(join(root, "runner"));
    const other = createPublicTlsFixture(join(root, "runner-other"));
    const runner = {
      PAWS_RUNNER_HOST: "127.0.0.1",
      PAWS_RUNNER_URL: "https://localhost:8788",
      PAWS_RUNNER_TLS_KEY_PATH: files.PAWS_TLS_KEY_PATH,
      PAWS_RUNNER_TLS_CERT_PATH: files.PAWS_TLS_CERT_PATH,
    };
    const start = (env: Record<string, string | undefined>) =>
      startPaws({ ...proxied, PAWS_HOME: tempHome(), ...runner, ...env });

    test("proxy mode refuses runner control without its URL and both certificate paths", async () => {
      for (const missing of [
        { PAWS_RUNNER_URL: undefined },
        { PAWS_RUNNER_TLS_KEY_PATH: undefined, PAWS_RUNNER_TLS_CERT_PATH: undefined },
        { PAWS_RUNNER_URL: undefined, PAWS_RUNNER_TLS_CERT_PATH: undefined },
      ])
        await expect(start(missing)).rejects.toThrow(PROXY_RUNNER_TLS_REQUIRED);
    });

    test("PAWS_RUNNER_URL must be an HTTPS origin and needs PAWS_RUNNER_HOST", async () => {
      for (const url of [
        "http://localhost:8788",
        "https://localhost:8788/runner",
        "https://user@localhost:8788",
        "https://localhost:8788/?a=1",
        "localhost:8788",
      ])
        await expect(start({ PAWS_RUNNER_URL: url })).rejects.toThrow(
          "PAWS_RUNNER_URL must be an HTTPS origin.",
        );
      await expect(start({ PAWS_RUNNER_HOST: undefined })).rejects.toThrow(
        "require PAWS_RUNNER_HOST",
      );
    });

    test("a runner certificate that does not cover PAWS_RUNNER_URL fails startup", async () => {
      await expect(start({ PAWS_RUNNER_URL: "https://paws.example.ts.net:8788" })).rejects.toThrow(
        "Runner HTTPS certificate does not cover paws.example.ts.net",
      );
    });

    test("certificate renewal validates the runner certificate", () => {
      const env = { ...proxied, PAWS_HOME: tempHome(), ...runner };
      expect(() => validateTlsRenewal(env)).not.toThrow();
      expect(() =>
        validateTlsRenewal({ ...env, PAWS_RUNNER_TLS_KEY_PATH: other.PAWS_TLS_KEY_PATH }),
      ).toThrow("Runner TLS certificate and private key must be valid and match");
      expect(() =>
        validateTlsRenewal({ ...env, PAWS_RUNNER_URL: "https://paws.example.ts.net:8788" }),
      ).toThrow("paws.example.ts.net");
    });
  });

  test("certificate validation has nothing to check behind the proxy", async () => {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "src/index.ts", "public-tls", "validate"],
      {
        cwd: join(import.meta.dir, ".."),
        env: { PATH: "/usr/bin:/bin", HOME: root, ...proxied },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(exit).toBe(0);
    expect(stdout).toContain(
      "Public HTTPS is terminated by the proxy; no certificate to validate.",
    );
  });

  async function signInStarts(proxy: boolean, forwardedFor: string[]) {
    const pg = await pgliteDb();
    const tls: PublicTls | undefined = proxy
      ? undefined
      : loadPublicTls(createPublicTlsFixture(join(root, `limits-${forwardedFor.length}`)));
    let ready!: (access: WorkspaceAccess) => void;
    const server = startServer({
      hostname: "127.0.0.1",
      port: 0,
      webhooks: false,
      ...(tls ? { tls } : { proxy }),
      workspaceAccess: new Promise<WorkspaceAccess>((resolve) => (ready = resolve)),
    });
    const origin = `https://127.0.0.1:${server.port}`;
    const access = createWorkspaceAccess({
      store: postgresDb(pg),
      publicUrl: origin,
      clientId: "fixture-client",
      installedOrganization: { id: "org", name: "Workspace" },
      memberships: {
        async installation() {
          return { id: "org", name: "Workspace" };
        },
        async member(): Promise<never> {
          throw new Error("Unexpected membership read");
        },
      },
      log() {},
    });
    ready(access);
    try {
      const statuses: number[] = [];
      for (const header of forwardedFor) {
        const response = await fetch(
          `${tls ? origin : `http://127.0.0.1:${server.port}`}/auth/linear`,
          {
            redirect: "manual",
            headers: { "x-forwarded-for": header },
            ...(tls ? { tls: { ca: tls.cert } } : {}),
          },
        );
        statuses.push(response.status);
      }
      return statuses;
    } finally {
      access.stop();
      await server.stop(true);
      await pg.$client.close();
    }
  }

  const spoofed = [
    ...Array.from({ length: 10 }, (_, attempt) => `198.51.100.${attempt}, 192.0.2.1`),
    "203.0.113.9, 192.0.2.1",
    "192.0.2.1, 192.0.2.2",
  ];

  test("sign-in limits key on the last X-Forwarded-For entry only in proxy mode", async () => {
    expect(await signInStarts(true, spoofed)).toEqual([...Array(10).fill(303), 429, 303]);
    expect(await signInStarts(false, spoofed)).toEqual([...Array(10).fill(303), 429, 429]);
  });
});
