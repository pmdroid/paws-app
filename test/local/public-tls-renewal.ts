import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorktree, ensureBareMirror, git, worktreePath } from "../../src/acp";
import { beginImplementRun, getWorkItem, insertQueuedItem, openDatabase } from "../../src/db";
import { loadPublicTls, validatePublicTls, PUBLIC_TLS_RESTART_EXIT } from "../../src/deployment";
import { startServer } from "../../src/server";

type Observe = (name: string, passed: boolean, observed: unknown) => void;

export async function probePublicTlsRenewal(root: string, observe: Observe) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = join(root, "home");
  mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
  function openssl(args: string[]) {
    const result = Bun.spawnSync(["/usr/bin/openssl", ...args], {
      env: { PATH: "/usr/bin:/bin", HOME: root },
    });
    assert.equal(result.exitCode, 0, result.stderr.toString());
  }
  openssl([
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    join(root, "ca.key"),
    "-out",
    join(root, "ca.crt"),
    "-days",
    "1",
    "-subj",
    "/CN=Disposable Paws CA",
    "-config",
    "/dev/null",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  function pair(
    name: string,
    serial: number,
    hostname = "localhost",
    eku: string | null = "serverAuth",
    ca = false,
  ) {
    const keyPath = join(root, `${name}.key`),
      certPath = join(root, `${name}.crt`);
    writeFileSync(
      join(root, "extensions"),
      `subjectAltName=DNS:${hostname}\nbasicConstraints=critical,CA:${ca ? "TRUE" : "FALSE"}\n${eku === null ? "" : `extendedKeyUsage=${eku}\n`}`,
    );
    openssl([
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      join(root, `${name}.csr`),
      "-subj",
      `/CN=${hostname}`,
      "-config",
      "/dev/null",
    ]);
    openssl([
      "x509",
      "-req",
      "-in",
      join(root, `${name}.csr`),
      "-CA",
      join(root, "ca.crt"),
      "-CAkey",
      join(root, "ca.key"),
      "-set_serial",
      String(serial),
      "-out",
      certPath,
      "-days",
      "1",
      "-extfile",
      join(root, "extensions"),
    ]);
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  }
  const old = pair("old", 1),
    replacement = pair("new", 2),
    wrongHost = pair("wrong", 3, "wrong.example.invalid");
  const wrongPurposes = [
    ["client-auth-only", pair("client-auth-only", 4, "localhost", "clientAuth")],
    ["any-eku", pair("any-eku", 5, "localhost", "anyExtendedKeyUsage")],
    ["any-and-client", pair("any-and-client", 6, "localhost", "anyExtendedKeyUsage,clientAuth")],
    ["code-signing", pair("code-signing", 7, "localhost", "codeSigning")],
  ] as const;
  const validPurposes = [
    ["absent-eku", pair("absent-eku", 8, "localhost", null)],
    ["ca-server-auth", pair("ca-server-auth", 9, "localhost", "serverAuth", true)],
    ["server-and-client", pair("server-and-client", 10, "localhost", "serverAuth,clientAuth")],
  ] as const;
  const ca = readFileSync(join(root, "ca.crt"), "utf8");
  const keyPath = join(home, "secrets", "public.key"),
    certPath = join(home, "secrets", "public.crt");
  function stage(tls: { key: string; cert: string }) {
    for (const path of [keyPath, certPath]) if (existsSync(path)) chmodSync(path, 0o600);
    writeFileSync(keyPath, tls.key, { mode: 0o600 });
    writeFileSync(certPath, tls.cert, { mode: 0o600 });
    chmodSync(keyPath, 0o400);
    chmodSync(certPath, 0o400);
  }
  stage(old);
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    KYOTOAGENT_ROOT: home,
    PAWS_HOME: home,
    PAWS_PORT: "0",
    PAWS_HOST: "127.0.0.1",
    LINEAR_MODE: "agent-session",
    LINEAR_CLIENT_ID: "client",
    LINEAR_ACCESS_TOKEN: "fixture-access",
    LINEAR_APP_USER_ID: "app",
    LINEAR_WEBHOOKS: "false",
    PAWS_PUBLIC_DASHBOARD: "1",
    PAWS_PUBLIC_URL: "https://localhost",
    PAWS_TLS_KEY_PATH: keyPath,
    PAWS_TLS_CERT_PATH: certPath,
    PAWS_NO_TUNNEL: "1",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-verification-bus",
  };
  const cwd = fileURLToPath(new URL("../..", import.meta.url));
  async function validateCli() {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "src/index.ts", "public-tls", "validate"],
      {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return exit;
  }
  function listen(port = 0) {
    return startServer({
      hostname: "127.0.0.1",
      port,
      tls: validatePublicTls(env),
      webhooks: false,
    });
  }
  async function fingerprint(port: number, hostname = "localhost") {
    return new Promise<string>((resolve, reject) => {
      const req = get(
        {
          hostname: "127.0.0.1",
          servername: hostname,
          port,
          path: "/health",
          ca,
          rejectUnauthorized: true,
          agent: false,
        },
        (response) => {
          const peer = (response.socket as import("node:tls").TLSSocket).getPeerCertificate();
          response.resume();
          response.on("end", () =>
            response.statusCode === 200
              ? resolve(peer.fingerprint256)
              : reject(new Error("Health failed")),
          );
          response.on("error", reject);
        },
      );
      req.setTimeout(5000, () => req.destroy(new Error("TLS request timed out")));
      req.on("error", reject);
    });
  }
  let server = listen();
  const port = server.port!;
  const oldFingerprint = new X509Certificate(old.cert).fingerprint256;
  assert.equal(await fingerprint(port), oldFingerprint);
  const rejected: string[] = [];
  const acceptedPurposes: string[] = [];
  try {
    for (const [, tls] of wrongPurposes) {
      const candidate = startServer({ hostname: "127.0.0.1", port: 0, tls, webhooks: false });
      try {
        await assert.rejects(fingerprint(candidate.port!), /certificate purpose/);
      } finally {
        await candidate.stop(true);
      }
    }
    for (const [name, tls] of validPurposes) {
      stage(tls);
      assert.equal(await validateCli(), 0);
      assert.deepEqual(loadPublicTls(env), tls);
      const candidate = listen();
      try {
        assert.equal(
          await fingerprint(candidate.port!),
          new X509Certificate(tls.cert).fingerprint256,
        );
        acceptedPurposes.push(name);
      } finally {
        await candidate.stop(true);
      }
    }
    for (const [name, tls] of [
      ["malformed", { key: old.key, cert: "invalid certificate" }],
      ["mismatch", { key: old.key, cert: replacement.cert }],
      ["wrong-hostname", wrongHost],
      ...wrongPurposes,
    ] as const) {
      stage(tls);
      assert.equal(await validateCli(), 1);
      assert.throws(() => validatePublicTls(env));
      if (wrongPurposes.some(([purpose]) => purpose === name))
        assert.throws(() => loadPublicTls(env));
      assert.equal(await fingerprint(port), oldFingerprint);
      rejected.push(name);
    }
    stage(replacement);
    assert.equal(await validateCli(), 0);
    await server.stop(true);
    server = listen(port);
    const newFingerprint = await fingerprint(port);
    assert.equal(newFingerprint, new X509Certificate(replacement.cert).fingerprint256);
    assert.notEqual(newFingerprint, oldFingerprint);
    await assert.rejects(fingerprint(port, "wrong.example.invalid"));
    assert.equal(readFileSync(keyPath, "utf8"), replacement.key);
    assert.equal(readFileSync(certPath, "utf8"), replacement.cert);
    assert.equal(statSync(keyPath).mode & 0o777, 0o400);
    assert.equal(statSync(certPath).mode & 0o777, 0o400);
    observe(
      "published direct HTTPS listener retains old identity on invalid renewal and verifies replacement after restart",
      true,
      {
        rejected,
        acceptedPurposes,
        nativeWrongPurposeRejected: true,
        oldFingerprint,
        newFingerprint,
        hostnameRejected: true,
        listenerFilesReadOnly: true,
      },
    );
  } finally {
    await server.stop(true);
  }
  const source = join(root, "source");
  mkdirSync(source);
  await git(["init", "-b", "main"], { cwd: source });
  writeFileSync(join(source, "README.md"), "initial\n");
  await git(["add", "README.md"], { cwd: source });
  await git(
    [
      "-c",
      "user.name=Paws Verification",
      "-c",
      "user.email=paws@example.invalid",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: source },
  );
  await ensureBareMirror({ remoteUrl: source, owner: "acme", repo: "demo", pawsRoot: home });
  const itemId = "TLS-1";
  await createWorktree({ owner: "acme", repo: "demo", itemId, pawsRoot: home });
  const worktree = worktreePath(home, itemId);
  writeFileSync(join(worktree, "notes.txt"), "shutdown work\n");
  stage(old);
  function runCli(logName: string) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        "./test/fixtures/workspace-runtime-linear.ts",
        "src/index.ts",
        "--no-tunnel",
      ],
      { cwd, env, stdout: "pipe", stderr: "pipe" },
    );
    let output = "",
      error = "";
    const stdout = (async () => {
      for await (const part of child.stdout) output += new TextDecoder().decode(part);
    })();
    const stderr = (async () => {
      for await (const part of child.stderr) error += new TextDecoder().decode(part);
    })();
    return {
      child,
      get output() {
        return output;
      },
      get error() {
        return error;
      },
      async stop() {
        child.kill("SIGTERM");
        await child.exited;
        await Promise.all([stdout, stderr]);
        writeFileSync(join(root, logName), output + error);
      },
    };
  }
  stage(wrongHost);
  const invalidStartup = runCli("cli-invalid-startup.log");
  const invalidTimeout = setTimeout(() => invalidStartup.child.kill("SIGTERM"), 5000);
  try {
    assert.equal(await invalidStartup.child.exited, 1);
  } finally {
    clearTimeout(invalidTimeout);
    await invalidStartup.stop();
  }
  assert.match(invalidStartup.error, /certificate does not match its hostname/);
  assert.equal(existsSync(join(home, "paws.db")), false);
  stage(old);
  const running = runCli("cli.log");
  const child = running.child;
  try {
    await until(() => running.output.includes("paws ready"));
    const cliPort = Number(running.output.match(/https:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
    assert(cliPort > 0, running.output);
    assert.equal(await fingerprint(cliPort), oldFingerprint);
    const db = openDatabase(join(home, "paws.db"));
    insertQueuedItem(db, { id: itemId, branchName: "paws/tls-1", now: Date.now() });
    beginImplementRun(db, itemId, Date.now(), { phase: "running", turn: 1 });
    db.close();
    const rejectedSignals: string[] = [];
    for (const [name, tls] of [
      ["malformed", { key: old.key, cert: "invalid certificate" }],
      ["mismatch", { key: old.key, cert: replacement.cert }],
      ["wrong-hostname", wrongHost],
      ...wrongPurposes,
    ] as const) {
      stage(tls);
      const previous = running.error.length;
      child.kill("SIGHUP");
      await until(() => running.error.length > previous);
      assert.match(running.error.slice(previous), /renewal rejected/);
      assert.equal(await fingerprint(cliPort), oldFingerprint);
      assert.equal(child.exitCode, null);
      rejectedSignals.push(name);
    }
    stage(replacement);
    child.kill("SIGHUP");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exit = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Renewal shutdown timed out")), 15000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(exit, PUBLIC_TLS_RESTART_EXIT);
    assert.equal(
      (await git(["log", "-1", "--format=%s"], { cwd: worktree })).trim(),
      "wip: shutdown",
    );
    const after = openDatabase(join(home, "paws.db"));
    const state = getWorkItem(after, itemId)?.state;
    after.close();
    assert.equal(state, "recovering");
    const restarted = runCli("cli-restarted.log");
    try {
      await until(() => restarted.output.includes("paws ready"));
      const nextPort = Number(restarted.output.match(/https:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
      assert(nextPort > 0, restarted.output);
      assert.equal(
        await fingerprint(nextPort),
        new X509Certificate(replacement.cert).fingerprint256,
      );
      await assert.rejects(fingerprint(nextPort, "wrong.example.invalid"));
    } finally {
      await restarted.stop();
    }
    observe(
      "normal CLI rejects invalid renewal signals and joins WIP recovery before restart exit",
      true,
      {
        rejectedSignals,
        restartExit: exit,
        wipCommitted: true,
        state,
        wrongHostnameStartupRejectedBeforeDatabase: true,
        verifiedNormalHttps: true,
        replacementVerifiedAfterFreshProcess: true,
      },
    );
  } finally {
    await running.stop();
  }
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for CLI");
    await Bun.sleep(10);
  }
}
