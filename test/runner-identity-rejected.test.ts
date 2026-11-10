import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRunnerDaemon } from "../src/runner-daemon";
import { initializeRunnerAuthority, startRunnerListener } from "../src/runner-identity";
import { serverIdentity } from "./local/runner-daemon";

const TOKEN = "n".repeat(43);
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function paws() {
  const base = mkdtempSync(join(tmpdir(), "paws-identity-rejected-"));
  const root = join(base, "daemon");
  const authority = await initializeRunnerAuthority(join(base, "issuer"));
  const server = await serverIdentity(join(base, "server"));
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const p = {
    root,
    active: new Set<string>(),
    tokens: [] as string[],
    probes: [] as string[],
    beats: 0,
    refused: 0,
    lines: [] as string[],
    offset: 0,
    probeStatus: 405,
    revoked: false,
  };
  const enrollment = createServer(server, async (request, response) => {
    const body = JSON.parse(await new Response(request as never).text());
    p.tokens.push(body.token);
    const issued = await authority.issue(body.csr);
    p.active.add(issued.fingerprint);
    response.end(
      JSON.stringify({
        runnerId: `runner-${p.tokens.length}`,
        workspaceId: "workspace",
        status: "approved",
        certificate: issued.pem,
        authority: authority.certificate,
        signingKeys: [{ keyId: "coordinator", publicKeyPem }],
      }),
    );
  });
  await new Promise<void>((resolve) => enrollment.listen(0, "127.0.0.1", resolve));
  const listener = await startRunnerListener({
    tls: { ...server, ca: authority.certificate },
    authorize: (peer) => p.active.has(peer.fingerprint),
    revoked: () => p.revoked,
    log: (line) => (p.refused += line.includes("answered 403") ? 1 : 0),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/certificate") {
        p.probes.push(request.method);
        return Response.json({}, { status: p.probeStatus });
      }
      if (path === "/v1/heartbeat") return (p.beats++, Response.json({ leases: [], fenced: [] }));
      return Response.json({ commands: [] });
    },
  });
  const address = enrollment.address() as { port: number };
  const controlPlaneUrl = `https://localhost:${address.port}`;
  const open = () =>
    openRunnerDaemon({
      root,
      controlPlaneUrl,
      runnerApiUrl: `https://localhost:${listener.port}`,
      serverCa: server.cert,
      now: () => Date.now() + p.offset,
      log: (line) => p.lines.push(line),
    });
  const daemon = open();
  stops.push(async () => {
    daemon.close();
    await listener.stop();
    enrollment.close();
    rmSync(base, { recursive: true, force: true });
  });
  await daemon.enroll("host", "f".repeat(43));
  const replaced = () => readdirSync(root).filter((name) => name.startsWith("identity.replaced-"));
  const state = () => readFileSync(join(root, "identity", "state.json"), "utf8");
  const refusal = () => daemon.heartbeat().catch((caught) => caught);
  return { p, daemon, open, replaced, state, refusal, controlPlaneUrl };
}

test("enroll moves a refused identity aside and pairs with the token", async () => {
  const { p, daemon, replaced, state } = await paws();
  const before = state();
  const commands = new Database(join(p.root, "commands.db"));
  commands.run("INSERT INTO command_receipt (id, expires_at) VALUES ('old', 1)");
  p.active.clear();
  expect(await daemon.enroll("host", TOKEN)).toMatchObject({ runnerId: "runner-2" });
  expect(p.tokens.at(-1)).toBe(TOKEN);
  expect(replaced()).toHaveLength(1);
  expect(replaced()[0]).toMatch(/^identity\.replaced-\d+$/);
  expect(readFileSync(join(p.root, replaced()[0]!, "state.json"), "utf8")).toBe(before);
  expect(commands.query("SELECT id FROM command_receipt").all()).toEqual([]);
  commands.close();
}, 30_000);

test("enroll on an accepted identity changes nothing and leaves the token unused", async () => {
  const { p, daemon, replaced, state } = await paws();
  const before = state();
  expect(await daemon.enroll("host", TOKEN)).toMatchObject({ runnerId: "runner-1" });
  expect([p.tokens.length, p.probes, p.beats, replaced()]).toEqual([1, ["GET"], 0, []]);
  expect(state()).toBe(before);
}, 30_000);

test("enroll keeps the identity on another answer from Paws or without a token", async () => {
  const { p, daemon, replaced } = await paws();
  for (const status of [503, 403]) {
    p.probeStatus = status;
    expect(await daemon.enroll("host", TOKEN)).toMatchObject({ runnerId: "runner-1" });
  }
  p.active.clear();
  expect(await daemon.enroll("host", "")).toMatchObject({ runnerId: "runner-1" });
  expect([p.tokens.length, replaced()]).toEqual([1, []]);
}, 30_000);

test("a refused daemon logs once and waits 60 s between attempts", async () => {
  const { p, daemon, refusal, controlPlaneUrl } = await paws();
  p.active.clear();
  for (let i = 0; i < 5; i++) expect((await refusal()).status).toBe(403);
  expect(p.refused).toBe(1);
  p.offset = 59_000;
  await refusal();
  expect(p.refused).toBe(1);
  p.offset = 60_000;
  expect(daemon.identityRetryIn()).toBe(0);
  for (let i = 0; i < 3; i++) await refusal();
  expect(p.refused).toBe(2);
  expect(p.lines).toEqual([
    `This runner's identity is no longer known to ${controlPlaneUrl}. Add it again from Runners and run the command there.`,
  ]);
}, 30_000);

test("a revoked daemon backs off and still sees the fence", async () => {
  const { p, refusal } = await paws();
  p.active.clear();
  p.revoked = true;
  for (let i = 0; i < 3; i++) expect((await refusal()).reason).toContain("fenced");
  expect([p.refused, p.lines.length]).toEqual([1, 1]);
}, 30_000);

test("a refused daemon notices the identity enroll wrote", async () => {
  const { p, daemon, open, refusal } = await paws();
  p.active.clear();
  await refusal();
  expect(daemon.identityReplaced()).toBe(false);
  const enrolling = open();
  await enrolling.enroll("host", TOKEN);
  enrolling.close();
  expect(daemon.identityReplaced()).toBe(true);
}, 30_000);
