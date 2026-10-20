import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { git } from "../src/acp";
import { createRepositoryGit } from "../src/loop";
import {
  addReview,
  decision,
  policyFixBudget,
  reviewRequirements,
  run,
  trustedPolicyFiles,
  validate,
  type PolicyGit,
} from "../src/closeout-spec";
import { createCloseoutGate } from "../src/closeout";
import { tempHome } from "./helpers";

const token = "synthetic-private-policy-secret";
const credential = Buffer.from(`x-access-token:${token}`).toString("base64");
const policy = (id: string) => `specVersion: "0.1"
items:
  - id: ${id}
    kind: review
    gate: beforePR
    failOn: P1
    skill: .agents/skills/review/SKILL.md
    independence:
      differentSession: true
      differentModel: true
`;

test("policy transport denial cannot fall back to an already fetched origin", async () => {
  const home = tempHome();
  try {
    await git(["init", "-b", "main", home]);
    await writeFile(join(home, "seed"), "seed");
    await git(["-C", home, "add", "."]);
    await git([
      "-C",
      home,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Seed",
    ]);
    await git(["-C", home, "remote", "add", "origin", home]);
    await git(["-C", home, "fetch", "origin", "main"]);
    const denied: PolicyGit = async () => {
      throw new Error("Membership revoked");
    };
    expect(await reviewRequirements(home, home, undefined, denied)).toMatchObject({
      ok: false,
      message: expect.stringContaining("Membership revoked"),
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("private policy fetch and second answer stay authenticated, fresh and responsive across all Closeout operations", async () => {
  const home = tempHome();
  const source = join(home, "source");
  const bare = join(home, "private.git");
  const checkout = join(home, "checkout");
  const cert = join(home, "cert.pem");
  const key = join(home, "key.pem");
  await mkdir(source);
  await git(["init", "-b", "main", source]);
  await mkdir(join(source, ".agents/skills/review"), { recursive: true });
  await writeFile(join(source, ".agents/closeout.yaml"), policy("first"));
  await writeFile(join(source, ".agents/skills/review/SKILL.md"), "Review the change.\n");
  await git(["-C", source, "add", "."]);
  const commit = () =>
    git([
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-am",
      "Policy",
    ]);
  await commit();
  await git(["clone", "--bare", source, bare]);
  await git(["--git-dir", bare, "update-server-info"]);
  await git(["clone", bare, checkout]);
  const certificate = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await certificate.exited).toBe(0);
  let accepted = 0;
  let refused = 0;
  let held: Promise<void> | undefined;
  let seen = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(cert), key: Bun.file(key) },
    async fetch(request) {
      seen.resolve();
      if (held) await held;
      if (request.headers.get("authorization") !== `Basic ${credential}`) {
        refused++;
        return new Response("Sign in", {
          status: 401,
          headers: { "www-authenticate": "Basic realm=private" },
        });
      }
      accepted++;
      const path = resolve(home, `.${new URL(request.url).pathname}`);
      if (!path.startsWith(`${bare}${sep}`)) return new Response(null, { status: 404 });
      const file = Bun.file(path);
      return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
    },
  });
  const remoteUrl = `https://127.0.0.1:${server.port}/private.git`;
  const controller = new AbortController();
  let allowed = true;
  let assertions = 0;
  const network = createRepositoryGit({
    remoteUrl,
    signal: controller.signal,
    token: async () => token,
    assert: async () => {
      assertions++;
      if (!allowed) throw new Error("Membership revoked");
    },
    onCleanupFailure: () => {
      throw new Error("Unverified cleanup");
    },
    env: { ...process.env, GIT_SSL_CAINFO: cert },
  });
  const calls: string[][] = [];
  const policyGit: PolicyGit = (repo, operation) => {
    const args = [
      "-C",
      repo,
      operation,
      operation === "fetch" ? "--no-tags" : "--exit-code",
      remoteUrl,
      "refs/heads/main",
    ];
    calls.push(args);
    return network(args);
  };
  try {
    await git(["-C", checkout, "remote", "set-url", "origin", remoteUrl]);
    await git(["-C", checkout, "config", "http.lowSpeedLimit", "1"]);
    await git(["-C", checkout, "config", "http.lowSpeedTime", "1"]);
    const bounded = new AbortController();
    await expect(
      git(["-C", checkout, "ls-remote", remoteUrl, "refs/heads/main"], {
        env: { ...process.env, GIT_SSL_CAINFO: cert, GIT_TERMINAL_PROMPT: "0" },
        signal: bounded.signal,
      }),
    ).rejects.toThrow();
    expect(refused).toBeGreaterThan(0);
    const required = await reviewRequirements(checkout, home, undefined, policyGit);
    expect(required).toMatchObject({ ok: true, items: [{ id: "first" }] });
    expect(calls.map((args) => args[2])).toEqual(["fetch", "ls-remote"]);
    expect(accepted).toBeGreaterThan(0);
    await writeFile(join(source, ".agents/closeout.yaml"), policy("second"));
    await commit();
    await git(["-C", source, "push", bare, "main"]);
    await git(["--git-dir", bare, "update-server-info"]);
    expect(await reviewRequirements(checkout, home, undefined, policyGit)).toMatchObject({
      ok: true,
      items: [{ id: "second" }],
    });
    const release = Promise.withResolvers<void>();
    held = release.promise;
    seen = Promise.withResolvers<void>();
    const pending = trustedPolicyFiles(checkout, home, undefined, policyGit);
    await seen.promise;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    await Bun.sleep(40);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(1);
    release.resolve();
    held = undefined;
    expect(await pending).toMatchObject({ ok: true, absent: false });
    const head = (await git(["-C", checkout, "rev-parse", "HEAD"])).trim();
    const input = {
      repo: checkout,
      base: head,
      head,
      gate: "beforePR" as const,
      home,
      policyGit,
      candidate: { session: "implementer", model: "one", provider: "fixture" },
      evidenceDir: join(home, "evidence"),
    };
    expect((await run(input)).items.map((item) => item.id)).toEqual(["second"]);
    expect(
      await addReview({
        ...input,
        itemId: "second",
        reviewer: {
          review: async () => ({
            producer: { session: "reviewer", model: "two", provider: "fixture" },
            findings: [],
            artifacts: [],
          }),
        },
      }),
    ).toMatchObject({ ok: true });
    expect((await decision(input)).decision).toBe("accepted");
    expect(await validate(checkout, home, undefined, policyGit)).toMatchObject({
      ok: true,
      items: ["second"],
    });
    expect(await policyFixBudget(checkout, home, undefined, policyGit)).toBeNull();
    const beforeGate = calls.length;
    const gate = createCloseoutGate({
      candidate: input.candidate,
      home,
      pawsHome: join(home, "paws"),
      policyGit,
      reviewer: {
        review: async () => ({
          session: "reviewer",
          model: "two",
          provider: "fixture",
          findings: [],
        }),
      },
      fixer: { applyFix: async () => ({ ok: false, reason: "No fix" }) },
    });
    expect(
      (
        await gate.run({
          taskId: "private-policy",
          worktree: checkout,
          baseSha: head,
          headSha: head,
          attempt: 1,
        })
      ).decision,
    ).toBe("accepted");
    expect(calls.length - beforeGate).toBe(6);
    const mismatch: PolicyGit = async (repo, operation) =>
      operation === "ls-remote"
        ? `${"0".repeat(40)}\trefs/heads/main\n`
        : policyGit(repo, operation);
    expect(await trustedPolicyFiles(checkout, home, undefined, mismatch)).toMatchObject({
      ok: false,
      message: "origin/main is unavailable",
    });
    const requests = accepted;
    allowed = false;
    expect(await trustedPolicyFiles(checkout, home, undefined, policyGit)).toMatchObject({
      ok: false,
    });
    expect(accepted).toBe(requests);
    allowed = true;
    const revoked: PolicyGit = async (repo, operation) => {
      const value = await policyGit(repo, operation);
      if (operation === "fetch") allowed = false;
      return value;
    };
    expect(await trustedPolicyFiles(checkout, home, undefined, revoked)).toMatchObject({
      ok: false,
    });
    allowed = true;
    let checks = 0;
    const redacted = createRepositoryGit({
      remoteUrl,
      signal: controller.signal,
      token: async () => token,
      assert: async () => {
        if (++checks === 3) throw new Error(`${token} ${credential}`);
      },
      onCleanupFailure: () => {
        throw new Error("Unverified cleanup");
      },
      env: { ...process.env, GIT_SSL_CAINFO: cert },
    });
    const error = await redacted([
      "-C",
      checkout,
      "ls-remote",
      "--exit-code",
      remoteUrl,
      "refs/heads/main",
    ]).catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("[redacted]");
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain(credential);
    await expect(network(["ls-remote", remoteUrl, "refs/heads/main"])).rejects.toThrow("bound");
    await expect(
      network(["-C", checkout, "ls-remote", "--exit-code", remoteUrl, "refs/heads/other"]),
    ).rejects.toThrow("bound");
    const revokeRelease = Promise.withResolvers<void>();
    held = revokeRelease.promise;
    seen = Promise.withResolvers<void>();
    const revokedDuringRead = trustedPolicyFiles(checkout, home, undefined, policyGit);
    await seen.promise;
    allowed = false;
    revokeRelease.resolve();
    held = undefined;
    expect(await revokedDuringRead).toMatchObject({
      ok: false,
      message: expect.stringContaining("Membership revoked"),
    });
    allowed = true;
    const unblock = Promise.withResolvers<void>();
    held = unblock.promise;
    seen = Promise.withResolvers<void>();
    const cancelled = trustedPolicyFiles(checkout, home, undefined, policyGit);
    await seen.promise;
    controller.abort(new Error("Stopped by owner"));
    expect(await cancelled).toMatchObject({
      ok: false,
      message: expect.stringContaining("Stopped by owner"),
    });
    unblock.resolve();
    held = undefined;
    expect(assertions).toBeGreaterThan(calls.length);
    expect(JSON.stringify(calls)).not.toContain(token);
    expect(JSON.stringify(calls)).not.toContain(credential);
    const config = await readFile(join(checkout, ".git/config"), "utf8");
    expect(config).not.toContain(token);
    expect(config).not.toContain(credential);
    expect(JSON.stringify(process.env)).not.toContain(token);
  } finally {
    controller.abort();
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
