import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRunnerDaemon } from "../src/runner-daemon";
import { initializeRunnerAuthority, startRunnerListener } from "../src/runner-identity";
import {
  CONTROL_PLANE_PROTOCOL_LEVEL,
  RunnerHelperResultSchema,
  signRunnerCommand,
  takeRejectedFields,
  withRejectedFields,
  type RunnerCommand,
  type RunnerHelperResult,
  type RunnerHostStatus,
} from "../src/runner-protocol";
import { serverIdentity } from "./local/runner-daemon";

/** b2fe062c (Nov 7): before `interrupted`, `replies` and `startWork`, and still strict. */
const NOV_7 = RunnerHelperResultSchema.omit({ interrupted: true, replies: true, startWork: true });
const HELPER_ID = "b6b0a3f2-3f5f-4f5e-9f7a-1c2d3e4f5a6b";
const result: RunnerHelperResult = {
  executionId: "0".repeat(26),
  commandId: HELPER_ID,
  role: "implementer",
  stopReason: "end_turn",
  timedOut: false,
  cancelled: false,
  interrupted: false,
  authRequired: false,
  agentExited: true,
  text: "done",
  replies: ["On it."],
  startWork: "The plan.",
};

async function withControlPlane(
  level: string | undefined,
  run: (plane: {
    daemon: ReturnType<typeof openRunnerDaemon>;
    accepted: unknown[];
    logged: string[];
    level: string | undefined;
    heartbeats: Record<string, unknown>[];
  }) => Promise<void>,
  sampleHost?: () => RunnerHostStatus,
) {
  const root = mkdtempSync(join(tmpdir(), "paws-control-plane-level-"));
  const authority = await initializeRunnerAuthority(join(root, "issuer"));
  const server = await serverIdentity(join(root, "server"));
  const signingKey = generateKeyPairSync("ed25519");
  const publicKeyPem = signingKey.publicKey.export({ type: "spki", format: "pem" }).toString();
  const identity = { runnerId: "runner-local", workspaceId: "workspace-local" };
  const active = new Set<string>();
  const accepted: unknown[] = [];
  const logged: string[] = [];
  const heartbeats: Record<string, unknown>[] = [];
  const at = Date.now();
  const command: RunnerCommand = {
    ...identity,
    id: HELPER_ID,
    type: "helper",
    issuedAt: at,
    expiresAt: at + 60_000,
    sessionId: "session",
    sessionGeneration: 1,
    purpose: "classify",
    profile: { agent: "claude", model: "fixture-model" },
    prompt: "Classify this request without tools",
  };
  const enrollment = createServer(server, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const issued = await authority.issue(JSON.parse(Buffer.concat(chunks).toString()).csr);
    active.add(issued.fingerprint);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ...identity,
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
    authorize: (peer) => active.has(peer.fingerprint),
    log: (line) => logged.push(line),
    takeLogDetail: takeRejectedFields,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/heartbeat") {
        const body = (await request.json()) as Record<string, unknown>;
        heartbeats.push(body);
        if ("healthFailure" in body) return Response.json({ error: "denied" }, { status: 403 });
        return Response.json({ leases: [], fenced: [], protocolLevel: plane.level });
      }
      if (path === "/v1/helper-commands") {
        const signed = signRunnerCommand({
          keyId: "coordinator",
          privateKey: signingKey.privateKey,
          command,
        });
        return Response.json({ commands: [signed] });
      }
      try {
        accepted.push(NOV_7.parse(await request.json()));
        return Response.json({ duplicate: false });
      } catch (error) {
        return withRejectedFields(Response.json({ error: "denied" }, { status: 403 }), error);
      }
    },
  });
  const address = enrollment.address();
  if (!address || typeof address === "string") throw new Error("Enrollment has no port");
  const daemon = openRunnerDaemon({
    root: join(root, "daemon"),
    controlPlaneUrl: `https://localhost:${address.port}`,
    runnerApiUrl: `https://localhost:${listener.port}`,
    serverCa: server.cert,
    ...(sampleHost ? { sampleHost } : {}),
  });
  const plane = { daemon, accepted, logged, level, heartbeats };
  try {
    await daemon.enroll("level-proof", "t".repeat(43));
    await daemon.pollHelperCommands();
    await run(plane);
  } finally {
    daemon.close();
    await listener.stop();
    enrollment.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("the listener's 403 line names the schema paths that failed", async () => {
  await withControlPlane(CONTROL_PLANE_PROTOCOL_LEVEL, async ({ daemon, logged }) => {
    const error = await daemon.postHelperResult(result).catch((caught) => caught);
    expect(error.status).toBe(403);
    const line = logged.find((entry) => entry.includes("/result answered 403"));
    for (const field of ["interrupted", "replies", "startWork"]) expect(line).toContain(field);
  });
}, 30_000);

test("a heartbeat a Paws without health reporting refuses is sent again without it", async () => {
  const failure = "EACCES: permission denied, lstat '/var/lib/paws-agent/.local/share'";
  await withControlPlane(
    CONTROL_PLANE_PROTOCOL_LEVEL,
    async ({ daemon, heartbeats }) => {
      heartbeats.length = 0;
      await daemon.heartbeat();
      expect(heartbeats.map((body) => body.healthFailure)).toEqual([failure, undefined]);
      expect(heartbeats[1]).toMatchObject({ runnerVersion: "1.4.0" });
    },
    () => ({ runnerVersion: "1.4.0", healthFailure: failure }),
  );
}, 30_000);

test("a runner below the control plane's level says so after a heartbeat, in either deploy order", async () => {
  await withControlPlane(
    "0.1.108",
    async (plane) => {
      expect(plane.daemon.belowMinimum()).toBe(false);
      await plane.daemon.heartbeat();
      expect(plane.daemon.belowMinimum()).toBe(true);
      plane.level = "0.1.107";
      await plane.daemon.heartbeat();
      expect(plane.daemon.belowMinimum()).toBe(false);
      plane.level = undefined;
      await plane.daemon.heartbeat();
      expect(plane.daemon.belowMinimum()).toBe(false);
    },
    () => ({ runnerVersion: "0.1.107" }),
  );
}, 30_000);
