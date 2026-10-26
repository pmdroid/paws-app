import { journalCaught, journalRejection } from "../journal";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createRunnerInputStore } from "../runner-inputs";
import type { Database } from "bun:sqlite";
import { createRunnerModels } from "../runner-models";
import { readSecretFile, writeSecretFile } from "../credentials";
import { createRunnerControl, createRunnerHttp } from "../runner-control";
import {
  initializeRunnerAuthority,
  openRunnerAuthority,
  startRunnerListener,
  type RunnerListener,
} from "../runner-identity";
import { createRunnerResults } from "../runner-results";
import { createRunnerHelpers } from "../runner-helpers";
import { createRunnerLogin } from "../runner-login";
import { createRunnerHealth } from "../runner-health";
import type { WorkspacePrincipal } from "../workspace";
import { createRunnerWork, createRunnerWorkHttp } from "../runner-work";
import type { GitHubApp } from "../github";
import { createRunnerRepositoryAccess } from "../runner-repository-access";
import { createRunnerArtifactStore } from "../runner-artifacts";
import {
  createRunnerTranscripts,
  createRunnerTranscriptsHttp,
  type RunnerTranscriptObjects,
} from "../runner-transcripts";
import {
  createAgentSessions,
  createAgentSessionsHttp,
  type AgentSessionObjects,
} from "../agent-sessions";

export type RunnerRepositoryAccessOptions = {
  github: GitHubApp;
  installationForRepository(repository: string): string | null;
  checkpointBot?: (repository: string) => Promise<{ appId: string; login: string; id: number }>;
};

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
  repositoryAccess?: RunnerRepositoryAccessOptions;
  transcriptObjects?: RunnerTranscriptObjects;
  /** Encrypted agent session snapshot storage and its key from `~/.paws/secrets`. */
  agentSessions?: { objects: AgentSessionObjects; key: Buffer };
  discoverModels?: boolean;
  /** Queue login_check commands in the background so agent sign-in status stays current. */
  checkSignIn?: boolean;
  /** Registered skill bundles runners download, `<name>/<version>/skill.tar.gz`. */
  skillsRoot?: string;
  /** The dashboard's public HTTPS origin, written into a new host's config on Add a host. */
  publicUrl?: string | null;
  /** The repositories a new host may run, written into its config on Add a host. */
  repositories?: () => readonly string[];
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
  const work = createRunnerWork({
    db: options.db,
    keyId: signing.signingKeys[0].keyId,
    privateKey: signing.privateKey,
    now: options.now,
  });
  const workHttp = createRunnerWorkHttp(work, { skillsRoot: options.skillsRoot });
  const inputs = createRunnerInputStore({ root: join(options.root, "inputs"), work });
  const helpers = createRunnerHelpers({
    db: options.db,
    keyId: signing.signingKeys[0].keyId,
    privateKey: signing.privateKey,
    now: options.now,
  });
  const results = createRunnerResults({ db: options.db, work, now: options.now });
  const health = createRunnerHealth({ db: options.db, work, now: options.now });
  const login = createRunnerLogin({
    db: options.db,
    work,
    now: options.now,
    onSignedIn: ({ runnerId, agent }) => {
      try {
        health.afterSignIn(runnerId, agent);
      } catch (error) {
        journalCaught(error, "runner-coordinator.onSignedIn.afterSignIn", null);
        options.onError(error);
      }
    },
  });
  const http = createRunnerHttp(control, {
    agents: (principal, runnerId) => health.agents(principal, runnerId),
    hostConfig: () => {
      if (!options.publicUrl || !listener) return null;
      const runnerApi = new URL(options.publicUrl);
      runnerApi.port = String(listener.port);
      return {
        controlPlaneUrl: new URL(options.publicUrl).origin,
        runnerApiUrl: runnerApi.origin,
        allowedRepositories: (options.repositories?.() ?? []).slice(0, 256),
      };
    },
  });
  const models = createRunnerModels({ db: options.db, work, now: options.now });
  const artifacts = createRunnerArtifactStore({ root: join(options.root, "artifacts"), work });
  const repository = options.repositoryAccess
    ? createRunnerRepositoryAccess({ ...options.repositoryAccess, work, now: options.now })
    : undefined;
  const transcripts = options.transcriptObjects
    ? createRunnerTranscripts({ db: options.db, work, objects: options.transcriptObjects })
    : undefined;
  const transcriptsHttp = transcripts ? createRunnerTranscriptsHttp(transcripts) : undefined;
  const agentSessions = options.agentSessions
    ? createAgentSessions({ db: options.db, work, now: options.now, ...options.agentSessions })
    : undefined;
  const agentSessionsHttp = agentSessions ? createAgentSessionsHttp(agentSessions) : undefined;
  listener = await startRunnerListener({
    tls: { ...options.tls, ca: authority.certificate },
    hostname: options.hostname,
    port: options.port,
    now: options.now,
    authorize(peer) {
      try {
        control.authenticate(peer);
        return true;
      } catch (caughtError1) {
        journalCaught(caughtError1, "runner-coordinator.authorize.authenticate", null);
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
        (await helpers.fetch(request, runnerId)) ??
        (await health.fetch(request, runnerId)) ??
        (await login.fetch(request, runnerId)) ??
        (await repository?.(request, runnerId)) ??
        (await artifacts.fetch(request, runnerId)) ??
        (await inputs.fetch(request, runnerId)) ??
        (await transcriptsHttp?.(request, runnerId)) ??
        (await agentSessionsHttp?.(request, runnerId)) ??
        new Response(null, { status: 404 })
      );
    },
  });
  const timer = setInterval(() => {
    try {
      control.expireConnections();
    } catch (error) {
      journalCaught(error, "runner-coordinator.openRunnerCoordinator.expireConnections", null);
      options.onError(error);
      void listener
        ?.stop()
        .catch(
          journalRejection("runner-coordinator.openRunnerCoordinator.stop", options.onError, null),
        );
    }
  }, 1000);
  timer.unref();
  const refreshModels = () => {
    try {
      models.refresh();
    } catch (error) {
      journalCaught(error, "runner-coordinator.openRunnerCoordinator.refresh", null);
      options.onError(error);
    }
  };
  const modelTimer = options.discoverModels ? setInterval(refreshModels, 15_000) : undefined;
  modelTimer?.unref();
  if (options.discoverModels) refreshModels();
  const checkSignIn = () => {
    try {
      health.refresh();
    } catch (error) {
      journalCaught(error, "runner-coordinator.openRunnerCoordinator.refresh", null);
      options.onError(error);
    }
  };
  const signInTimer = options.checkSignIn ? setInterval(checkSignIn, 15_000) : undefined;
  signInTimer?.unref();
  if (options.checkSignIn) checkSignIn();
  // The first pass also deletes objects a crash left behind between discarding rows and deleting.
  const pruneAgentSessions = () =>
    void agentSessions
      ?.prune()
      .catch((error: unknown) =>
        journalCaught(error, "runner-coordinator.openRunnerCoordinator.prune", null),
      );
  const pruneTimer = agentSessions ? setInterval(pruneAgentSessions, 60_000) : undefined;
  pruneTimer?.unref();
  pruneAgentSessions();
  return {
    port: listener.port,
    signingKeys: signing.signingKeys,
    control,
    work,
    results,
    health,
    models,
    login,
    helpers,
    artifacts,
    inputs,
    transcripts,
    agentSessions,
    async browser(request: Request, principal: WorkspacePrincipal) {
      return (
        (await models.browser(request, principal)) ??
        (await http.browser(request, principal)) ??
        (await health.browser(request, principal)) ??
        login.browser(request, principal)
      );
    },
    /** `POST /api/runner-enrollments`: a host enrolls itself with a member's token. */
    async hostEnrollment(request: Request) {
      return withSigningKeys(await http.hostEnrollment(request), signing.signingKeys);
    },
    async stop() {
      login.stop();
      clearInterval(timer);
      clearInterval(modelTimer);
      clearInterval(signInTimer);
      clearInterval(pruneTimer);
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
