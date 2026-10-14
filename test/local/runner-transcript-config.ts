import assert from "node:assert/strict";
import { S3Client } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { startPaws } from "../../src/index";
import { createFakeRunnerTranscriptObjects } from "../../src/runner-transcripts";
import { probeRunnerTranscripts } from "./runner-transcripts";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  configureRunnerTranscriptStorage,
  loadRunnerTranscriptObjects,
} from "../../src/runner-transcript-config";

type Observe = (name: string, passed: boolean, observed: unknown) => void;
const config = {
  bucket: "fixture-transcripts",
  endpoint: "https://objects.example.invalid",
  region: "explicit-region",
  accessKeyId: "explicit-fixture-key",
  secretAccessKey: "explicit-fixture-secret",
};

export async function probeRunnerTranscriptStorage(root: string, observe: Observe) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = join(root, "home");
  async function cli(text: string, target = home, args = ["configure"]) {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "src/index.ts", "runner-storage", ...args],
      {
        cwd: new URL("../..", import.meta.url).pathname,
        env: { PATH: process.env.PATH, HOME: root, PAWS_HOME: target },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.write(text);
    child.stdin.end();
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    for (const value of [config.accessKeyId, config.secretAccessKey])
      assert(!`${output}${error}`.includes(value));
    return { code, output, error };
  }
  const created = await cli(JSON.stringify(config));
  assert.equal(created.code, 0, created.error);
  assert.equal(created.output.trim(), "Runner transcript storage configured.");
  const path = join(home, "secrets", "runner-transcript-storage.json");
  const bytes = readFileSync(path, "utf8");
  assert(bytes.startsWith("paws-envelope-v1\n"));
  assert(!bytes.includes(config.secretAccessKey));
  for (const file of [path, join(home, "secrets", ".envelope-key")])
    assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const directory of [home, join(home, "secrets")])
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(
    loadRunnerTranscriptObjects(home).uri("proof.jsonl"),
    "s3://fixture-transcripts/proof.jsonl",
  );
  assert.equal((await cli(JSON.stringify(config))).code, 0);
  assert.equal(readFileSync(path, "utf8"), bytes);
  observe(
    "normal CLI saves idempotent encrypted transcript configuration without credential output",
    true,
    { cliCode: created.code, modes: "0700/0600", encrypted: true, unchanged: true },
  );

  const invalid = [
    { ...config, extra: true },
    { ...config, endpoint: "http://objects.example.invalid" },
    {
      ...config,
      endpoint: Object.assign(new URL(config.endpoint), {
        username: "fixture",
        password: "fixture",
      }).href,
    },
    { ...config, endpoint: "https://objects.example.invalid?" },
    { ...config, endpoint: "https://objects.example.invalid#" },
    { ...config, sessionToken: "" },
    { ...config, secretAccessKey: "" },
    { ...config, bucket: "INVALID" },
    { ...config, region: "" },
  ];
  for (const value of invalid) {
    assert.throws(
      () => configureRunnerTranscriptStorage(home, JSON.stringify(value)),
      /configuration is missing or invalid/,
    );
    assert.equal(readFileSync(path, "utf8"), bytes);
  }
  for (const text of ["{", "x".repeat(65_537)]) assert.equal((await cli(text)).code, 1);
  assert.equal(
    (await cli(JSON.stringify(config), home, ["configure", config.secretAccessKey])).code,
    1,
  );
  observe(
    "invalid storage schemas and oversized stdin fail without changing stored credentials",
    true,
    { rejectedSchemas: invalid.length, boundedStdin: true, cliArgumentsDenied: true },
  );

  const cases: [string, (directory: string) => void][] = [
    [
      "plaintext",
      (directory) =>
        writeFileSync(
          join(directory, "secrets", "runner-transcript-storage.json"),
          JSON.stringify(config),
        ),
    ],
    [
      "public-file",
      (directory) => chmodSync(join(directory, "secrets", "runner-transcript-storage.json"), 0o644),
    ],
    ["public-key", (directory) => chmodSync(join(directory, "secrets", ".envelope-key"), 0o644)],
    ["public-home", (directory) => chmodSync(directory, 0o755)],
    ["public-secrets", (directory) => chmodSync(join(directory, "secrets"), 0o755)],
    ["missing-key", (directory) => rmSync(join(directory, "secrets", ".envelope-key"))],
    [
      "invalid-key",
      (directory) => writeFileSync(join(directory, "secrets", ".envelope-key"), "wrong"),
    ],
    [
      "oversized-file",
      (directory) =>
        writeFileSync(
          join(directory, "secrets", "runner-transcript-storage.json"),
          "x".repeat(65_537),
        ),
    ],
    [
      "hardlink",
      (directory) =>
        linkSync(
          join(directory, "secrets", "runner-transcript-storage.json"),
          join(directory, "alias"),
        ),
    ],
    [
      "symlink-file",
      (directory) => {
        const file = join(directory, "secrets", "runner-transcript-storage.json");
        rmSync(file);
        symlinkSync(path, file);
      },
    ],
    [
      "symlink-key",
      (directory) => {
        const file = join(directory, "secrets", ".envelope-key");
        rmSync(file);
        symlinkSync(join(home, "secrets", ".envelope-key"), file);
      },
    ],
    [
      "fifo",
      (directory) => {
        const file = join(directory, "secrets", "runner-transcript-storage.json");
        rmSync(file);
        const child = Bun.spawnSync(["/usr/bin/mkfifo", "-m", "600", file]);
        assert.equal(child.exitCode, 0);
      },
    ],
    [
      "symlink-secrets",
      (directory) => {
        rmSync(join(directory, "secrets"), { recursive: true });
        symlinkSync(join(home, "secrets"), join(directory, "secrets"));
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const target = join(root, name);
    cpSync(home, target, { recursive: true });
    mutate(target);
    const started = Date.now();
    assert.throws(() => loadRunnerTranscriptObjects(target), /configuration is missing or invalid/);
    assert(Date.now() - started < 1_000, name);
    assert.throws(
      () => configureRunnerTranscriptStorage(target, JSON.stringify(config)),
      /configuration is missing or invalid/,
    );
  }
  symlinkSync(home, join(root, "symlink-home"));
  assert.throws(() => loadRunnerTranscriptObjects(join(root, "symlink-home")));
  assert.throws(() => loadRunnerTranscriptObjects(join(root, "missing")));
  assert(!existsSync(join(root, "missing")));
  observe(
    "unsafe filesystem objects, plaintext and missing envelope keys fail closed without blocking",
    true,
    { rejectedFilesystemCases: cases.length + 2, fifoNonblocking: true, noImplicitCreation: true },
  );

  const names = [
    "S3_BUCKET",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_SESSION_TOKEN",
    "AWS_BUCKET",
    "AWS_ENDPOINT",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ];
  const previous = names.map((name) => process.env[name]);
  const file = S3Client.prototype.file;
  let signed: URL | undefined;
  try {
    for (const name of names) process.env[name] = "ambient-fixture";
    S3Client.prototype.file = function (key, ...args) {
      signed = new URL(this.presign(key));
      return Object.assign(file.call(this, key, ...args), { stream: () => new Blob([]).stream() });
    };
    loadRunnerTranscriptObjects(home).read("proof.jsonl");
    assert(signed);
    assert.equal(signed.origin, config.endpoint);
    assert.equal(signed.pathname, "/fixture-transcripts/proof.jsonl");
    assert(signed.searchParams.get("X-Amz-Credential")!.startsWith(`${config.accessKeyId}/`));
    assert(signed.searchParams.get("X-Amz-Credential")!.includes(`/${config.region}/`));
    assert(!signed.searchParams.has("X-Amz-Security-Token"));
    configureRunnerTranscriptStorage(
      home,
      JSON.stringify({ ...config, sessionToken: "explicit-fixture-session" }),
    );
    loadRunnerTranscriptObjects(home).read("proof.jsonl");
    assert.equal(signed.searchParams.get("X-Amz-Security-Token"), "explicit-fixture-session");
  } finally {
    S3Client.prototype.file = file;
    for (const [index, name] of names.entries()) {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }
  }
  observe("actual Bun S3 presigning uses explicitly stored credentials and session token", true, {
    signer: "Bun.S3Client",
    explicitBucketEndpointRegion: true,
    absentSessionTokenNotSigned: true,
    explicitSessionTokenUsed: true,
    networkRequests: 0,
  });

  const missing = join(root, "startup-missing");
  assert.throws(
    () => startPaws({ PAWS_HOME: missing, PAWS_PORT: "0", PAWS_EXECUTION: "remote" }),
    /configuration is missing or invalid/,
  );
  assert(!existsSync(missing));
  const started = startPaws({
    PAWS_HOME: join(root, "startup-control"),
    PAWS_PORT: "0",
    PAWS_NO_TUNNEL: "1",
  });
  try {
    await started.ready;
    assert.equal((await fetch(`http://127.0.0.1:${started.server.port}/health`)).status, 200);
  } finally {
    await started.stop();
  }
  assert.throws(
    () =>
      startPaws(
        {
          PAWS_HOME: join(root, "startup-injected"),
          PAWS_PORT: "0",
          PAWS_NO_TUNNEL: "1",
          PAWS_EXECUTION: "remote",
        },
        { runnerTranscriptObjects: createFakeRunnerTranscriptObjects() },
      ),
    /Remote execution requires runner HTTPS/,
  );
  assert(!existsSync(join(root, "startup-injected")));
  observe(
    "explicit remote storage and runner prerequisites fail before opening files; startup without a runner answers health",
    true,
    { missingHomeUnchanged: true, health: 200, injectedRemotePrerequisitesRejected: true },
  );
  const objects = new Map<string, Uint8Array>();
  const nativeFile = S3Client.prototype.file;
  let requests = 0;
  try {
    S3Client.prototype.file = function (key, ...args) {
      const objectSignature = new URL(this.presign(key));
      assert.equal(objectSignature.origin, config.endpoint);
      assert(
        objectSignature.searchParams.get("X-Amz-Credential")!.startsWith(`${config.accessKeyId}/`),
      );
      requests++;
      return Object.assign(nativeFile.call(this, key, ...args), {
        async write(payload: Blob | Response) {
          const value = new Uint8Array(await payload.arrayBuffer());
          objects.set(key, value);
          return value.length;
        },
        stream() {
          const value = objects.get(key);
          if (!value) throw new Error("Fake object missing");
          return new Blob([value]).stream();
        },
      });
    };
    await probeRunnerTranscripts(
      join(root, "stored-transcripts"),
      (name, passed) => {
        assert(passed, name);
      },
      loadRunnerTranscriptObjects(home),
    );
    assert(requests > 0);
  } finally {
    S3Client.prototype.file = nativeFile;
  }
  observe(
    "configured real Bun S3 adapter preserves full scoped transcript through explicit fake object storage",
    true,
    { requests, objects: objects.size, networkRequests: 0 },
  );
  observe(
    "fresh-process actual HTTPS S3 requests preserve explicit credentials and reject inherited tokens",
    true,
    await probeActualStorage(root),
  );
  const localHome = join(root, "local-home");
  assert.equal((await cli('{"kind":"local"}', localHome)).code, 0);
  const local = loadRunnerTranscriptObjects(localHome);
  await local.write("restart", new Blob(["persistent transcript"]));
  assert.equal(
    await new Response(loadRunnerTranscriptObjects(localHome).read("restart")).text(),
    "persistent transcript",
  );
  let localObservations = 0;
  await probeRunnerTranscripts(
    join(root, "local-transcripts"),
    (name, passed) => {
      assert(passed, name);
      localObservations++;
    },
    local,
  );
  assert(localObservations > 5);
  observe(
    "local disk configuration preserves scoped uploads, sealing, restart and digest checks",
    true,
    {
      transcriptObservations: localObservations,
      storage: "local",
      directoryMode: statSync(join(localHome, "runner-transcripts")).mode & 0o777,
    },
  );
}

async function probeActualStorage(root: string) {
  const key = join(root, "s3.key"),
    cert = join(root, "s3.pem");
  const generated = Bun.spawnSync(
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
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  assert.equal(generated.exitCode, 0, generated.stderr.toString());
  chmodSync(key, 0o600);
  const payloads = new Map<string, string>();
  const requests: { method: string; explicitCredential: boolean; explicitToken: boolean }[] = [];
  let expectedToken: string | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: readFileSync(key), cert: readFileSync(cert) },
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push({
        method: request.method,
        explicitCredential: (request.headers.get("authorization") ?? "").includes(
          `Credential=${config.accessKeyId}/`,
        ),
        explicitToken: request.headers.get("x-amz-security-token") === expectedToken,
      });
      if (request.method === "PUT") {
        payloads.set(path, await request.text());
        return new Response(null, { headers: { etag: '"proof"' } });
      }
      return new Response(payloads.get(path) ?? null, { status: payloads.has(path) ? 200 : 404 });
    },
  });
  try {
    for (const mode of ["absent", "ambient", "stored"]) {
      const home = join(root, `https-${mode}`);
      expectedToken = mode === "stored" ? "explicit-fixture-session" : null;
      configureRunnerTranscriptStorage(
        home,
        JSON.stringify({
          ...config,
          endpoint: `https://127.0.0.1:${server.port}`,
          ...(expectedToken ? { sessionToken: expectedToken } : {}),
        }),
      );
      const before = requests.length;
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", new URL(import.meta.url).pathname, "s3-client"],
        {
          env: {
            PATH: process.env.PATH,
            HOME: root,
            PAWS_HOME: home,
            NODE_EXTRA_CA_CERTS: cert,
            ...(mode !== "absent"
              ? {
                  S3_SESSION_TOKEN: "ambient-fixture-session",
                  AWS_SESSION_TOKEN: "ambient-fixture-session",
                }
              : {}),
            PAWS_EXPECT_STORAGE_DENIAL: mode === "ambient" ? "1" : "0",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10000,
        },
      );
      const [code, out, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(code, 0, out + error);
      for (const value of [
        config.accessKeyId,
        config.secretAccessKey,
        "ambient-fixture-session",
        "explicit-fixture-session",
      ])
        assert(!`${out}${error}`.includes(value));
      assert.equal(requests.length - before, mode === "ambient" ? 0 : 2);
    }
    assert(requests.every((request) => request.explicitCredential && request.explicitToken));
    return {
      httpsVerified: true,
      requests: requests.length,
      ambientRejectedBeforeNetwork: true,
      explicitStoredToken: true,
    };
  } finally {
    await server.stop(true);
  }
}

if (import.meta.main && process.argv[2] === "s3-client") {
  if (process.env.PAWS_EXPECT_STORAGE_DENIAL === "1")
    assert.throws(
      () => loadRunnerTranscriptObjects(process.env.PAWS_HOME!),
      /configuration is missing or invalid/,
    );
  else {
    const objects = loadRunnerTranscriptObjects(process.env.PAWS_HOME!);
    await objects.write("actual.jsonl", new Blob(["raw proof\n"]));
    assert.equal(await new Response(objects.read("actual.jsonl")).text(), "raw proof\n");
  }
  console.log("Storage child verified.");
} else if (import.meta.main) {
  const root = mkdtempSync(join(tmpdir(), "paws-transcript-config-"));
  const observations: unknown[] = [];
  await probeRunnerTranscriptStorage(root, (name, passed, observed) =>
    observations.push({ name, passed, observed }),
  );
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
  console.log(JSON.stringify({ root, observations: observations.length }));
}
