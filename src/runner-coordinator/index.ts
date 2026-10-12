import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Database } from "bun:sqlite";
import { readSecretFile, writeSecretFile } from "../credentials";
import { createRunnerControl, createRunnerHttp } from "../runner-control";
import {
  initializeRunnerAuthority,
  openRunnerAuthority,
  startRunnerListener,
  type RunnerListener,
} from "../runner-identity";
import { createRunnerResults } from "../runner-results";
import { createRunnerHealth } from "../runner-health";
import type { WorkspacePrincipal } from "../workspace";
import { createRunnerWork, createRunnerWorkHttp } from "../runner-work";

const SIGNING_FILE = "runner-command-key.pem";

export async function initializeRunnerCoordinator(root: string) {
  if (!isAbsolute(root)) throw new Error("Runner identity path must be absolute.");
  mkdirSync(root, { mode: 0o700 });
  try {
    await initializeRunnerAuthority(root);
    const { privateKey } = generateKeyPairSync("ed25519");
    writeSecretFile(
      rootKey(root),
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      true,
    );
    return signingIdentity(root).signingKeys;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function openRunnerCoordinator(options: {
  db: Database;
  root: string;
  tls: { key: string; cert: string };
  hostname?: string;
  port: number;
  now?: () => number;
  onError(error: unknown): void;
}) {
  if (!isAbsolute(options.root)) throw new Error("Runner identity path must be absolute.");
  const authority = openRunnerAuthority(options.root);
  const signing = signingIdentity(options.root);
  let listener: RunnerListener | undefined;
  const control = createRunnerControl({
    db: options.db,
    authority,
    certificateRoot: options.root,
    disconnect: (fingerprint) => listener?.revoke(fingerprint),
    now: options.now,
  });
  const http = createRunnerHttp(control);
  const work = createRunnerWork({
    db: options.db,
    keyId: signing.signingKeys[0].keyId,
    privateKey: signing.privateKey,
    now: options.now,
  });
  const workHttp = createRunnerWorkHttp(work);
  const results = createRunnerResults({ db: options.db, work, now: options.now });
  const health = createRunnerHealth({ db: options.db, work, now: options.now });
  listener = await startRunnerListener({
    tls: { ...options.tls, ca: authority.certificate },
    hostname: options.hostname,
    port: options.port,
    now: options.now,
    authorize(peer) {
      try {
        control.authenticate(peer);
        return true;
      } catch {
        return false;
      }
    },
    async fetch(request, peer) {
      const runnerId = control.authenticate(peer).id;
      const renewal = await http.runner(request, peer);
      if (renewal) return withSigningKeys(renewal, signing.signingKeys);
      return (
        (await workHttp(request, runnerId)) ??
        (await results.fetch(request, runnerId)) ??
        (await health.fetch(request, runnerId)) ??
        new Response(null, { status: 404 })
      );
    },
  });
  const timer = setInterval(() => {
    try {
      control.expireConnections();
    } catch (error) {
      options.onError(error);
      void listener?.stop().catch(options.onError);
    }
  }, 1000);
  timer.unref();
  return {
    port: listener.port,
    signingKeys: signing.signingKeys,
    control,
    work,
    results,
    health,
    async browser(request: Request, principal: WorkspacePrincipal) {
      return (await http.browser(request, principal)) ?? health.browser(request, principal);
    },
    async enrollment(request: Request) {
      return withSigningKeys(await http.enrollment(request), signing.signingKeys);
    },
    async stop() {
      clearInterval(timer);
      await listener?.stop();
    },
  };
}

function rootKey(root: string) {
  return join(root, SIGNING_FILE);
}

function signingIdentity(root: string) {
  const pem = readSecretFile(rootKey(root));
  if (!pem) throw new Error("Runner command signing key is missing.");
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("Runner command signing requires Ed25519.");
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  const keyId = createHash("sha256").update(publicKeyPem).digest("hex");
  return { privateKey, signingKeys: [{ keyId, publicKeyPem }] as const };
}

async function withSigningKeys(
  response: Response,
  signingKeys: readonly { keyId: string; publicKeyPem: string }[],
) {
  if (!response.ok) return response;
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object")
    throw new Error("Invalid runner identity response.");
  return Response.json("certificate" in body ? { ...body, signingKeys } : body, {
    status: response.status,
    headers: response.headers,
  });
}

export type RunnerCoordinator = Awaited<ReturnType<typeof openRunnerCoordinator>>;
