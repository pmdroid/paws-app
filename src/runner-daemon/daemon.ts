import { journalCaught } from "../journal";
import { createHash, type KeyObject } from "node:crypto";
import { join } from "node:path";
import { chmodSync, writeSync } from "node:fs";
import { z } from "zod";
import { immediate, openDatabase } from "../db";
import { describeRunnerCertificate } from "../runner-identity";
import {
  RUNNER_ACCOUNT_PROTOCOL,
  RunnerAccountCapabilitySchema,
  type RunnerAccountCapability,
  RunnerCommandSchema,
  RunnerLoginUpdateSchema,
  RunnerLoginExchangeSchema,
  type RunnerLoginUpdate,
  RunnerArtifactChunkSchema,
  RunnerHealthResultSchema,
  RunnerHelperResultSchema,
  RunnerRepositoryCommandResultSchema,
  RunnerRetroCommandSchema,
  RunnerRetroInputRequestSchema,
  RunnerRetroResultSchema,
  SignedRunnerCommandSchema,
  verifyRunnerCommand,
  verifyRunnerRetroCommand,
  type RunnerCommand,
  type RunnerArtifactChunk,
  type RunnerCommandRejection,
  type RunnerHealthResult,
  type RunnerHelperResult,
  type RunnerAgentUser,
  type RunnerHostStatus,
  type RunnerRepositoryCommand,
  type RunnerRepositoryCommandResult,
  type RunnerRetroCommand,
  type RunnerRetroCommandRejection,
  type RunnerRetroInputRequest,
  type RunnerRetroResult,
  type RunnerInstalledAgent,
  type RunnerInstalledRuntime,
  type RunnerInstalledSkill,
  type RunnerResult,
  type RunnerSkill,
  RUNNER_SKILL_BUNDLE_LIMIT,
  RunnerInstalledAgentsSchema,
  RunnerInstalledRuntimesSchema,
  RunnerInstalledSkillsSchema,
  RunnerSkillSchema,
} from "../runner-protocol";
import {
  RunnerTranscriptChunkSchema,
  RunnerTranscriptFinishSchema,
  RUNNER_TRANSCRIPT_MAX_BYTES,
  type RunnerTranscriptChunk,
  type RunnerTranscriptFinish,
} from "../runner-transcripts";
import {
  AgentSessionChunkSchema,
  AgentSessionFinishSchema,
  AgentSessionReadSchema,
  AGENT_SESSION_MAX_BYTES,
  type AgentSessionChunk,
  type AgentSessionFinish,
  type AgentSessionRead,
} from "../agent-sessions";
import {
  ApprovedIdentitySchema,
  identifier,
  localKey,
  prepareState,
  readState,
  trustedSigningKeys,
  validateIdentity,
  writeState,
  type PairedState,
} from "./state";
import { downloadRunnerInputs } from "./inputs";
import {
  httpsOrigin,
  requestBytes,
  requestJson,
  requestStream,
  RunnerRequestError,
} from "./transport";
import {
  RunnerAnswersRequestSchema,
  RunnerAnswersSchema,
  RunnerEventDeliverySchema,
  RunnerEventReceiptSchema,
  RunnerFollowUpsSchema,
  RunnerGrantRequestSchema,
  RunnerGrantSchema,
  RunnerGrantTokenSchema,
  RunnerHeartbeatSchema,
  RunnerRepositoryAccessSchema,
  RunnerRepositoryCommandCredentialSchema,
  RunnerRepositoryCredentialSchema,
  RunnerGitHubReadCredentialSchema,
  RunnerResultDeliverySchema,
  type RunnerEventDelivery,
  type RunnerGrantRequest,
} from "./work";

const runnerName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) =>
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );
/** The enrollment token a member minted: 32 random bytes in base64url. */
export const EnrollmentTokenSchema = z
  .string()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

const RETIRED_RECEIPT_RETENTION_MS = 24 * 60 * 60_000;
const RETIRED_PRUNE_INTERVAL_MS = 10 * 60_000;

export type RunnerDaemonOptions = {
  root: string;
  controlPlaneUrl: string;
  runnerApiUrl: string;
  serverCa?: string;
  trustedKeys?: ReadonlyMap<string, KeyObject>;
  allowedRepositories?: readonly string[];
  concurrency?: number;
  conversationConcurrency?: number;
  agentUser?: RunnerAgentUser;
  now?: () => number;
  /** Host metrics sent with every heartbeat. */
  sampleHost?: () => RunnerHostStatus;
  accountBindings?: () => RunnerAccountCapability["bindings"];
};

export function openRunnerDaemon(options: RunnerDaemonOptions) {
  /** The config value is the host's ceiling; Paws chooses the applied value up to it. */
  const ceiling = z
    .number()
    .int()
    .min(1)
    .max(16)
    .parse(options.concurrency ?? 1);
  let applied = ceiling;
  const conversations =
    options.conversationConcurrency === undefined
      ? undefined
      : z.number().int().min(0).max(16).parse(options.conversationConcurrency);
  const origins = {
    controlPlaneUrl: httpsOrigin(options.controlPlaneUrl),
    runnerApiUrl: httpsOrigin(options.runnerApiUrl),
  };
  const now = options.now ?? Date.now;
  const pins = options.trustedKeys ? new Map(options.trustedKeys) : undefined;
  if (pins)
    for (const key of pins.values())
      if (key.type !== "public" || key.asymmetricKeyType !== "ed25519")
        throw new Error("Runner job signing pins must be Ed25519 public keys.");
  let state = readState(options.root);
  let closed = false;
  let observedAt = 0;
  if (
    state &&
    (state.controlPlaneUrl !== origins.controlPlaneUrl ||
      state.runnerApiUrl !== origins.runnerApiUrl)
  )
    throw new Error("Runner endpoint origins do not match the paired state.");
  if (state?.phase === "paired") validateIdentity(options.root, state, now(), true);
  const dbPath = join(options.root, "commands.db");
  const db = openDatabase(dbPath);
  chmodSync(dbPath, 0o600);
  db.run(
    "CREATE TABLE IF NOT EXISTS command_receipt (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS pending_command (id TEXT PRIMARY KEY REFERENCES command_receipt(id), payload TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1,2))) STRICT",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS pending_retro_command (id TEXT PRIMARY KEY REFERENCES command_receipt(id), payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1))) STRICT",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS retro_attempt (retro_id TEXT PRIMARY KEY, attempt INTEGER NOT NULL) STRICT",
  );

  let prunedAt = Number.NEGATIVE_INFINITY;
  function pruneRetired() {
    ensureOpen();
    const at = now();
    if (at - prunedAt < RETIRED_PRUNE_INTERVAL_MS && at >= prunedAt) return 0;
    prunedAt = at;
    const cutoff = at - RETIRED_RECEIPT_RETENTION_MS;
    return immediate(db, () => {
      const commands =
        db.run(
          "DELETE FROM pending_command WHERE acknowledged=2 AND id IN (SELECT id FROM command_receipt WHERE expires_at<?)",
          [cutoff],
        ).changes +
        db.run(
          "DELETE FROM pending_retro_command WHERE delivered=1 AND id IN (SELECT id FROM command_receipt WHERE expires_at<?)",
          [cutoff],
        ).changes;
      const receipts = db.run(
        "DELETE FROM command_receipt WHERE expires_at<? AND id NOT IN (SELECT id FROM pending_command) AND id NOT IN (SELECT id FROM pending_retro_command)",
        [cutoff],
      ).changes;
      return commands + receipts;
    });
  }
  function ensureOpen() {
    if (closed) throw new Error("Runner daemon is closed.");
  }
  function paired(): PairedState {
    ensureOpen();
    if (state?.phase !== "paired") throw new Error("Runner is not paired.");
    validateIdentity(options.root, state, now());
    return state;
  }
  function unchangedIdentity(identity: PairedState) {
    const current = paired();
    if (current.runnerId !== identity.runnerId || current.workspaceId !== identity.workspaceId)
      throw new Error("Runner identity changed while awaiting the response.");
  }
  function common() {
    if (!state) throw new Error("Runner identity is not prepared.");
    return { ...origins, csr: state.csr };
  }
  function status() {
    ensureOpen();
    if (!state || state.phase === "prepared") return { phase: "unpaired" as const };
    const certificate = describeRunnerCertificate(state.certificate);
    return {
      phase: certificate.notAfter <= now() ? ("expired" as const) : ("paired" as const),
      runnerId: state.runnerId,
      workspaceId: state.workspaceId,
      fingerprint: certificate.fingerprint,
      expiresAt: certificate.notAfter,
    };
  }
  async function authenticated(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    runGrant?: string,
  ) {
    const identity = paired();
    const response = await requestJson({
      origin: origins.runnerApiUrl,
      path,
      method,
      body,
      runGrant,
      serverCa: options.serverCa,
      identity: { certificate: identity.certificate, key: localKey(options.root) },
    });
    unchangedIdentity(identity);
    return response;
  }
  function pendingCommands(): RunnerCommand[] {
    paired();
    return db
      .query<{ payload: string }, []>(
        "SELECT payload FROM pending_command WHERE acknowledged=0 ORDER BY rowid",
      )
      .all()
      .map((row) => RunnerCommandSchema.parse(JSON.parse(row.payload)));
  }
  async function acknowledgeCommand(id: string): Promise<void> {
    const identity = paired();
    identifier.parse(id);
    const row = db
      .query<{ payload: string }, [string]>("SELECT payload FROM pending_command WHERE id=?")
      .get(id);
    if (!row) throw new Error("Runner command is unknown.");
    const command = RunnerCommandSchema.parse(JSON.parse(row.payload));
    const queue = command.type === "helper" ? "helper-commands" : "commands";
    db.run("UPDATE pending_command SET acknowledged=1 WHERE id=? AND acknowledged=0", [id]);
    try {
      const receipt = await authenticated(`/v1/${queue}/${encodeURIComponent(id)}/ack`, "POST", {});
      if (command.type === "helper") z.strictObject({ ok: z.literal(true) }).parse(receipt);
    } catch (error) {
      if (
        command.type !== "helper" ||
        !(error instanceof RunnerRequestError) ||
        error.status !== 409
      )
        throw error;
      journalCaught(error, "daemon.acknowledgeCommand.authenticated", null);
    }
    unchangedIdentity(identity);
    db.run("UPDATE pending_command SET acknowledged=2 WHERE id=?", [id]);
  }
  function helperCommand(id: string) {
    paired();
    identifier.parse(id);
    const row = db
      .query<{ payload: string }, [string]>("SELECT payload FROM pending_command WHERE id=?")
      .get(id);
    const command = row ? RunnerCommandSchema.parse(JSON.parse(row.payload)) : null;
    if (command?.type !== "helper" || command.expiresAt <= now())
      throw new Error("Runner helper command is unavailable or expired.");
    return command;
  }
  function repositoryCommand(id: string): RunnerRepositoryCommand {
    paired();
    identifier.parse(id);
    const row = db
      .query<{ payload: string }, [string]>("SELECT payload FROM pending_command WHERE id=?")
      .get(id);
    const command = row ? RunnerCommandSchema.parse(JSON.parse(row.payload)) : null;
    if (command?.type !== "rebase" || command.expiresAt <= now())
      throw new Error("Runner repository command is unavailable or expired.");
    return command;
  }
  const repositoryCommandPath = (id: string, action: string) =>
    `/v1/repository-commands/${encodeURIComponent(id)}/${action}`;
  function heldBindings(): RunnerAccountCapability["bindings"] {
    try {
      return options.accountBindings?.() ?? [];
    } catch (caughtError1) {
      journalCaught(caughtError1, "daemon.heldBindings", null);
      return [];
    }
  }
  async function pollCommands(path: string) {
    const identity = paired();
    trustedSigningKeys(identity, pins);
    pruneRetired();
    for (const row of db
      .query<{ id: string }, []>(
        "SELECT id FROM pending_command WHERE acknowledged=1 ORDER BY rowid",
      )
      .all())
      await acknowledgeCommand(row.id);
    const response = z
      .strictObject({ commands: z.array(SignedRunnerCommandSchema).max(16) })
      .parse(await authenticated(path, "GET"));
    ensureOpen();
    unchangedIdentity(identity);
    const trustedKeys = trustedSigningKeys(paired(), pins);
    const accountBindings = new Set(heldBindings().map((binding) => binding.bindingId));
    const rejected: RunnerCommandRejection[] = [];
    const deniedRepositories = new Set<string>();
    for (const envelope of response.commands) {
      const result = immediate(db, () => {
        const verified = verifyRunnerCommand(envelope, {
          trustedKeys,
          runnerId: identity.runnerId,
          workspaceId: identity.workspaceId,
          now: now(),
          allowedRepositories: options.allowedRepositories,
          accountBindings,
          claimCommand: (id, expiresAt) =>
            db.run("INSERT INTO command_receipt VALUES (?,?) ON CONFLICT DO NOTHING", [
              id,
              expiresAt,
            ]).changes === 1,
        });
        if (
          verified.ok &&
          (verified.command.type === "helper") !== (path === "/v1/helper-commands")
        )
          throw new Error("Runner command arrived through the wrong queue.");
        if (verified.ok)
          db.run("INSERT INTO pending_command (id,payload) VALUES (?,?)", [
            verified.command.id,
            JSON.stringify(verified.command),
          ]);
        return verified;
      });
      if (!result.ok) rejected.push(result.reason);
      if (!result.ok && result.repository) deniedRepositories.add(result.repository);
    }
    return { commands: pendingCommands(), rejected, deniedRepositories: [...deniedRepositories] };
  }
  function pendingRetroCommands(): RunnerRetroCommand[] {
    paired();
    return db
      .query<{ payload: string }, [number]>(
        "SELECT p.payload FROM pending_retro_command p JOIN command_receipt r ON r.id=p.id WHERE r.expires_at>? ORDER BY p.rowid",
      )
      .all(now())
      .map((row) => RunnerRetroCommandSchema.parse(JSON.parse(row.payload)));
  }
  function retroCommand(id: string): RunnerRetroCommand {
    paired();
    identifier.parse(id);
    const row = db
      .query<{ payload: string }, [string]>("SELECT payload FROM pending_retro_command WHERE id=?")
      .get(id);
    if (!row) throw new Error("Runner retro command is unknown.");
    return RunnerRetroCommandSchema.parse(JSON.parse(row.payload));
  }
  async function retroTerminal(id: string, action: "result" | "released", body: unknown) {
    try {
      const response = await authenticated(retroPath(id, action), "POST", body);
      db.run("UPDATE pending_retro_command SET delivered=1 WHERE id=?", [id]);
      return response;
    } catch (error) {
      if (error instanceof RunnerRequestError && error.status >= 400 && error.status < 500)
        db.run("UPDATE pending_retro_command SET delivered=1 WHERE id=?", [id]);
      throw error;
    }
  }
  async function pollRetroCommands() {
    const identity = paired();
    trustedSigningKeys(identity, pins);
    pruneRetired();
    const response = z
      .strictObject({ commands: z.array(z.unknown()).max(16) })
      .parse(await authenticated("/v1/retro-commands", "GET"));
    ensureOpen();
    unchangedIdentity(identity);
    const trustedKeys = trustedSigningKeys(paired(), pins);
    const accountBindings = new Set(heldBindings().map((binding) => binding.bindingId));
    const rejected: RunnerRetroCommandRejection[] = [];
    for (const envelope of response.commands) {
      const result = immediate(db, () => {
        const verified = verifyRunnerRetroCommand(envelope, {
          trustedKeys,
          runnerId: identity.runnerId,
          workspaceId: identity.workspaceId,
          now: now(),
          accountBindings,
          latestAttempt: (retroId) =>
            db
              .query<{ attempt: number }, [string]>(
                "SELECT attempt FROM retro_attempt WHERE retro_id=?",
              )
              .get(retroId)?.attempt,
          claimCommand: (id, expiresAt) =>
            db.run("INSERT INTO command_receipt VALUES (?,?) ON CONFLICT DO NOTHING", [
              id,
              expiresAt,
            ]).changes === 1,
        });
        if (verified.ok) {
          db.run("INSERT INTO pending_retro_command (id,payload) VALUES (?,?)", [
            verified.command.id,
            JSON.stringify(verified.command),
          ]);
          db.run(
            "INSERT INTO retro_attempt VALUES (?,?) ON CONFLICT(retro_id) DO UPDATE SET attempt=MAX(attempt,excluded.attempt)",
            [verified.command.retroId, verified.command.attempt],
          );
        }
        return verified;
      });
      if (!result.ok && result.reason !== "replayed" && result.reason !== "stale_attempt")
        rejected.push(result.reason);
    }
    return { commands: pendingRetroCommands(), rejected };
  }
  const retroPath = (id: string, action: string) =>
    `/v1/retro-commands/${encodeURIComponent(id)}/${action}`;
  return {
    status,
    capacity: () => applied,
    ceiling: () => ceiling,
    conversationCapacity: () => conversations ?? 0,
    pendingCommands,
    pruneRetired,
    /**
     * Enroll with a member's single-use token: prepare the key and CSR, post once, store the
     * identity Paws returns. A daemon already paired with a valid certificate returns its status
     * without contacting Paws, so a retried bootstrap is harmless.
     */
    async enroll(name: string, token: string) {
      ensureOpen();
      const previous = state?.phase === "paired" ? state : null;
      if (previous && describeRunnerCertificate(previous.certificate).notAfter > now())
        return status();
      const parsedName = runnerName.parse(name);
      const parsedToken = EnrollmentTokenSchema.parse(token);
      if (!state) state = await prepareState(options.root, origins);
      const prepared = state;
      const response = await requestJson({
        origin: origins.controlPlaneUrl,
        path: "/api/runner-enrollments",
        method: "POST",
        body: { token: parsedToken, name: parsedName, csr: prepared.csr },
        serverCa: options.serverCa,
      });
      ensureOpen();
      if (state !== prepared)
        throw new Error("Runner enrollment changed while awaiting the response.");
      const { status: _status, ...identity } = z
        .strictObject({ status: z.literal("approved"), ...ApprovedIdentitySchema.shape })
        .parse(response);
      const enrolled = { ...common(), phase: "paired" as const, ...identity };
      validateIdentity(options.root, enrolled, now());
      trustedSigningKeys(enrolled, pins);
      if (previous && identity.runnerId === previous.runnerId)
        throw new Error("Re-enrollment requires a new runner identity.");
      if (previous)
        immediate(db, () => {
          db.run("DELETE FROM pending_command");
          db.run("DELETE FROM pending_retro_command");
          db.run("DELETE FROM retro_attempt");
          db.run("DELETE FROM command_receipt");
        });
      observedAt = 0;
      writeState(options.root, enrolled);
      state = enrolled;
      return status();
    },
    /**
     * `skills` is what this runner has installed; sending it asks Paws for the skill manifest.
     * `runtimes` is what mise installed for tasks on this runner, sent once there is any.
     * `agents` is the coding agent versions the installer manages; sending it asks Paws for the
     * versions chosen on the Runners page. `live` is the work this runner still runs; Paws renews
     * only those leases and fences acknowledged work the runner no longer reports.
     */
    async heartbeat(
      skills?: readonly RunnerInstalledSkill[],
      runtimes?: readonly RunnerInstalledRuntime[],
      agents?: readonly RunnerInstalledAgent[],
      live?: readonly { runId: string; generation: number }[],
      terminated?: readonly import("../runner-protocol").RunnerTermination[],
    ) {
      const body = {
        ...options.sampleHost?.(),
        ...(options.concurrency === undefined ? {} : { capacity: applied, ceiling }),
      };
      const reported = skills && RunnerInstalledSkillsSchema.parse(skills);
      const installed = runtimes?.length
        ? RunnerInstalledRuntimesSchema.parse(runtimes)
        : undefined;
      const coding = agents && RunnerInstalledAgentsSchema.parse(agents);
      const withSkills = reported === undefined ? body : { ...body, skills: reported };
      const withRuntimes =
        installed === undefined ? withSkills : { ...withSkills, runtimes: installed };
      // A Paws release without agents, runtimes or skills refuses the unknown field with 403.
      // Drop the newest fields one at a time so the leases still renew.
      const withAgents = coding === undefined ? withRuntimes : { ...withRuntimes, agents: coding };
      const withLive =
        live === undefined
          ? withAgents
          : { ...withAgents, live: live.map(({ runId, generation }) => ({ runId, generation })) };
      const liveAfter = observedAt;
      const attempts: unknown[] = [
        ...(live === undefined
          ? []
          : [
              {
                ...withLive,
                repositories: options.allowedRepositories ?? null,
                ...(terminated === undefined ? {} : { terminated }),
                liveAfter,
              },
            ]),
        ...(terminated === undefined
          ? []
          : [{ ...withLive, repositories: options.allowedRepositories ?? null, terminated }]),
        { ...withLive, repositories: options.allowedRepositories ?? null },
        ...(live === undefined ? [] : [withLive]),
        withAgents,
        ...(coding === undefined ? [] : [withRuntimes]),
        ...(installed === undefined ? [] : [withSkills]),
        ...(reported?.some((skill) => skill.waiting)
          ? [{ ...body, skills: reported.map(({ waiting: _, ...skill }) => skill) }]
          : []),
        ...(reported === undefined ? [] : [body]),
      ];
      attempts.unshift({
        ...(attempts[0] as object),
        accounts: RunnerAccountCapabilitySchema.parse({
          protocol: RUNNER_ACCOUNT_PROTOCOL,
          bindings: heldBindings(),
        }),
      });
      if (options.agentUser)
        attempts.unshift({ ...(attempts[0] as object), agentUser: options.agentUser });
      if (conversations !== undefined)
        attempts.unshift({ ...(attempts[0] as object), conversationConcurrency: conversations });
      let reply: unknown;
      for (const [index, attempt] of attempts.entries()) {
        try {
          reply = await authenticated("/v1/heartbeat", "POST", attempt);
          break;
        } catch (error) {
          if (
            index === attempts.length - 1 ||
            !(error instanceof RunnerRequestError) ||
            error.status !== 403 ||
            /\bfenced\b/i.test(error.reason ?? "")
          )
            throw error;
          journalCaught(error, "daemon.heartbeat.authenticated", null);
        }
      }
      const response = RunnerHeartbeatSchema.parse(reply);
      if (response.observedAt !== undefined) observedAt = Math.max(observedAt, response.observedAt);
      if (options.concurrency !== undefined && response.concurrency !== undefined)
        applied = Math.min(response.concurrency, ceiling);
      return response;
    },
    /** The bundle bytes as Paws sent them. The caller checks size and checksum before using them. */
    async downloadSkill(skill: RunnerSkill): Promise<Uint8Array> {
      const { name, version, sizeBytes } = RunnerSkillSchema.parse(skill);
      const identity = paired();
      const bytes = await requestBytes(
        {
          origin: origins.runnerApiUrl,
          path: `/v1/skills/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
          method: "GET",
          serverCa: options.serverCa,
          identity: { certificate: identity.certificate, key: localKey(options.root) },
        },
        "application/gzip",
        Math.min(sizeBytes, RUNNER_SKILL_BUNDLE_LIMIT),
        5 * 60_000,
      );
      unchangedIdentity(identity);
      return bytes;
    },
    async exchangeLogin(id: string, update: RunnerLoginUpdate) {
      z.uuid().parse(id);
      return RunnerLoginExchangeSchema.parse(
        await authenticated(`/v1/login/${id}`, "POST", RunnerLoginUpdateSchema.parse(update)),
      );
    },
    async postHealth(result: RunnerHealthResult) {
      const body = RunnerHealthResultSchema.parse(result);
      return RunnerEventReceiptSchema.parse(await authenticated("/v1/health", "POST", body));
    },
    async uploadArtifact(runId: string, chunk: RunnerArtifactChunk, grantToken: string) {
      identifier.parse(runId);
      const body = RunnerArtifactChunkSchema.parse(chunk);
      RunnerGrantTokenSchema.parse(grantToken);
      return z
        .strictObject({ ok: z.literal(true) })
        .parse(
          await authenticated(
            `/v1/runs/${encodeURIComponent(runId)}/artifacts`,
            "POST",
            body,
            grantToken,
          ),
        );
    },
    async uploadTranscript(runId: string, chunk: RunnerTranscriptChunk, grantToken: string) {
      identifier.parse(runId);
      const body = RunnerTranscriptChunkSchema.parse(chunk);
      RunnerGrantTokenSchema.parse(grantToken);
      const receipt = z
        .strictObject({
          offset: z.number().int().nonnegative().max(RUNNER_TRANSCRIPT_MAX_BYTES),
          duplicate: z.boolean(),
        })
        .parse(
          await authenticated(
            `/v1/runs/${encodeURIComponent(runId)}/transcript/chunks`,
            "POST",
            body,
            grantToken,
          ),
        );
      if (receipt.offset !== body.offset + Buffer.from(body.data, "base64").byteLength)
        throw new Error("Runner transcript receipt offset is invalid.");
      return receipt;
    },
    async finishTranscript(runId: string, finish: RunnerTranscriptFinish, grantToken: string) {
      identifier.parse(runId);
      const body = RunnerTranscriptFinishSchema.parse(finish);
      RunnerGrantTokenSchema.parse(grantToken);
      return z
        .strictObject({ uri: z.string().min(1).max(8192) })
        .parse(
          await authenticated(
            `/v1/runs/${encodeURIComponent(runId)}/transcript/finish`,
            "POST",
            body,
            grantToken,
          ),
        );
    },
    /** One chunk of an agent session snapshot, under the run grant. */
    async uploadSession(runId: string, chunk: AgentSessionChunk, grantToken: string) {
      identifier.parse(runId);
      const body = AgentSessionChunkSchema.parse(chunk);
      RunnerGrantTokenSchema.parse(grantToken);
      const receipt = z
        .strictObject({
          offset: z.number().int().nonnegative().max(AGENT_SESSION_MAX_BYTES),
          duplicate: z.boolean(),
        })
        .parse(
          await authenticated(
            `/v1/runs/${encodeURIComponent(runId)}/session/chunks`,
            "POST",
            body,
            grantToken,
          ),
        );
      if (receipt.offset !== body.offset + Buffer.from(body.data, "base64").byteLength)
        throw new Error("Agent session receipt offset is invalid.");
      return receipt;
    },
    async finishSession(runId: string, finish: AgentSessionFinish, grantToken: string) {
      identifier.parse(runId);
      const body = AgentSessionFinishSchema.parse(finish);
      RunnerGrantTokenSchema.parse(grantToken);
      const receipt = z
        .strictObject({
          generation: z.number().int().positive(),
          sizeBytes: z.number().int().nonnegative(),
          sha256: z.string(),
        })
        .parse(
          await authenticated(
            `/v1/runs/${encodeURIComponent(runId)}/session/finish`,
            "POST",
            body,
            grantToken,
          ),
        );
      if (
        receipt.generation !== body.generation ||
        receipt.sizeBytes !== body.sizeBytes ||
        receipt.sha256 !== body.sha256
      )
        throw new Error("Agent session receipt is invalid.");
      return receipt;
    },
    /**
     * Streams a sealed agent session snapshot of the run into `output` under the run grant,
     * without holding it in memory. Returns the size, the sha256 of the bytes received and the
     * sha256 Paws sent; the caller compares them with the signed command.
     */
    async readSession(
      runId: string,
      read: AgentSessionRead,
      grantToken: string,
      output: number,
      maxBytes: number,
    ) {
      ensureOpen();
      identifier.parse(runId);
      const body = AgentSessionReadSchema.parse(read);
      RunnerGrantTokenSchema.parse(grantToken);
      const identity = paired();
      const digest = createHash("sha256");
      let sizeBytes = 0;
      const headers = await requestStream(
        {
          origin: origins.runnerApiUrl,
          path: `/v1/runs/${encodeURIComponent(runId)}/session/read`,
          method: "POST",
          body,
          runGrant: grantToken,
          serverCa: options.serverCa,
          identity: { certificate: identity.certificate, key: localKey(options.root) },
        },
        "application/octet-stream",
        Math.min(maxBytes, AGENT_SESSION_MAX_BYTES),
        (chunk) => {
          digest.update(chunk);
          sizeBytes += chunk.length;
          for (let written = 0; written < chunk.length;)
            written += writeSync(output, chunk, written);
        },
        30 * 60_000,
      );
      unchangedIdentity(identity);
      const sent = headers["x-paws-session-sha256"];
      return {
        sizeBytes,
        sha256: digest.digest("hex"),
        sentSha256: typeof sent === "string" ? sent : null,
      };
    },
    async readInputs(command: RunnerCommand, getGrant: () => Promise<string>, signal: AbortSignal) {
      ensureOpen();
      const input = RunnerCommandSchema.parse(command);
      if (input.type !== "run" && input.type !== "review" && input.type !== "task")
        throw new Error("Runner input command is invalid");
      const stored = db
        .query<{ payload: string }, [string]>("SELECT payload FROM pending_command WHERE id=?")
        .get(input.id);
      if (
        !stored ||
        JSON.stringify(RunnerCommandSchema.parse(JSON.parse(stored.payload))) !==
          JSON.stringify(input)
      )
        throw new Error("Runner input command is unknown");
      return downloadRunnerInputs(
        input,
        getGrant,
        (channel, body, token) => {
          RunnerGrantTokenSchema.parse(token);
          return authenticated(
            `/v1/runs/${encodeURIComponent(input.runId)}/${channel}/read`,
            "POST",
            body,
            token,
          );
        },
        signal,
      );
    },
    async issueRunGrant(runId: string, request: RunnerGrantRequest) {
      identifier.parse(runId);
      const body = RunnerGrantRequestSchema.parse(request);
      const grant = RunnerGrantSchema.parse(
        await authenticated(`/v1/runs/${encodeURIComponent(runId)}/grant`, "POST", body),
      );
      if (grant.expiresAt <= now()) throw new Error("Runner work grant is expired.");
      return grant;
    },
    async sendEvent(delivery: RunnerEventDelivery, token: string) {
      const body = RunnerEventDeliverySchema.parse(delivery);
      RunnerGrantTokenSchema.parse(token);
      return RunnerEventReceiptSchema.parse(await authenticated("/v1/events", "POST", body, token));
    },
    async postResult(runId: string, generation: number, result: RunnerResult, grantToken: string) {
      identifier.parse(runId);
      const body = RunnerResultDeliverySchema.parse({ generation, result });
      RunnerGrantTokenSchema.parse(grantToken);
      return RunnerEventReceiptSchema.parse(
        await authenticated(
          `/v1/runs/${encodeURIComponent(runId)}/result`,
          "POST",
          body,
          grantToken,
        ),
      );
    },
    async answers(runId: string, generation: number, after: number, grantToken: string) {
      identifier.parse(runId);
      const body = RunnerAnswersRequestSchema.parse({ generation, after });
      RunnerGrantTokenSchema.parse(grantToken);
      const response = RunnerAnswersSchema.parse(
        await authenticated(
          `/v1/runs/${encodeURIComponent(runId)}/answers`,
          "POST",
          body,
          grantToken,
        ),
      );
      let previous = after;
      for (const answer of response.answers) {
        if (answer.sequence <= previous) throw new Error("Runner answer sequence is invalid.");
        previous = answer.sequence;
      }
      return response;
    },
    async followUps(runId: string, generation: number, after: number, grantToken: string) {
      identifier.parse(runId);
      const body = RunnerAnswersRequestSchema.parse({ generation, after });
      RunnerGrantTokenSchema.parse(grantToken);
      const response = RunnerFollowUpsSchema.parse(
        await authenticated(
          `/v1/runs/${encodeURIComponent(runId)}/follow-ups`,
          "POST",
          body,
          grantToken,
        ),
      );
      let previous = after;
      for (const followUp of response.followUps) {
        if (followUp.sequence <= previous) throw new Error("Runner follow-up sequence is invalid.");
        previous = followUp.sequence;
      }
      return response;
    },
    async repositoryCredential(
      runId: string,
      generation: number,
      access: "read" | "write",
      grantToken: string,
    ) {
      ensureOpen();
      identifier.parse(runId);
      const body = RunnerRepositoryAccessSchema.parse({ generation, access });
      RunnerGrantTokenSchema.parse(grantToken);
      const stored = db
        .query<{ payload: string }, [string, number]>(
          "SELECT payload FROM pending_command WHERE json_extract(payload,'$.runId')=? AND json_extract(payload,'$.generation')=? AND json_extract(payload,'$.type') IN ('run','review','task') ORDER BY rowid DESC LIMIT 1",
        )
        .get(runId, generation);
      if (!stored) throw new Error("Runner work command is unknown.");
      const command = RunnerCommandSchema.parse(JSON.parse(stored.payload));
      if (
        (command.type !== "run" && command.type !== "review" && command.type !== "task") ||
        !command.repository
      )
        throw new Error("Runner work command is invalid.");
      if (access === "write" && command.type !== "run")
        throw new Error("Review commands cannot request repository write access.");
      const credential = RunnerRepositoryCredentialSchema.parse(
        await authenticated(
          `/v1/runs/${encodeURIComponent(runId)}/repository-credential`,
          "POST",
          body,
          grantToken,
        ),
      );
      const current = now();
      if (
        credential.expiresAt <= current ||
        credential.expiresAt > current + 60 * 60_000 ||
        credential.remoteUrl !== command.repository.remoteUrl ||
        (access === "read" ? credential.branch !== null : credential.branch === null)
      )
        throw new Error("Runner repository credential does not match the admitted work.");
      return credential;
    },
    async githubReadCredential(runId: string, generation: number, grantToken: string) {
      ensureOpen();
      identifier.parse(runId);
      const body = RunnerRepositoryAccessSchema.pick({ generation: true }).parse({ generation });
      RunnerGrantTokenSchema.parse(grantToken);
      const credential = RunnerGitHubReadCredentialSchema.parse(
        await authenticated(
          `/v1/runs/${encodeURIComponent(runId)}/github-read-credential`,
          "POST",
          body,
          grantToken,
        ),
      );
      if (!githubReadExpiryAllowed(credential.expiresAt, now()))
        throw new Error("Runner GitHub read token has an invalid expiry.");
      return credential;
    },
    async repositoryCommandGrant(id: string) {
      const command = repositoryCommand(id);
      const grant = RunnerGrantSchema.parse(
        await authenticated(repositoryCommandPath(command.id, "grant"), "POST", {}),
      );
      if (grant.expiresAt <= now()) throw new Error("Runner repository command grant is expired.");
      return grant;
    },
    async repositoryCommandCredential(id: string, grantToken: string) {
      const command = repositoryCommand(id);
      RunnerGrantTokenSchema.parse(grantToken);
      const credential = RunnerRepositoryCommandCredentialSchema.parse(
        await authenticated(
          repositoryCommandPath(command.id, "repository-credential"),
          "POST",
          {},
          grantToken,
        ),
      );
      const current = now();
      if (
        credential.expiresAt <= current ||
        credential.expiresAt > current + 60 * 60_000 ||
        credential.remoteUrl !== command.repository.remoteUrl ||
        credential.branch !== command.branch
      )
        throw new Error("Runner repository credential does not match the repository command.");
      return credential;
    },
    async postRepositoryCommandResult(id: string, result: RunnerRepositoryCommandResult) {
      const command = repositoryCommand(id);
      const body = RunnerRepositoryCommandResultSchema.parse(result);
      return RunnerEventReceiptSchema.parse(
        await authenticated(repositoryCommandPath(command.id, "result"), "POST", body),
      );
    },
    pollCommands: () => pollCommands("/v1/commands"),
    pollHelperCommands: () => pollCommands("/v1/helper-commands"),
    pollRetroCommands,
    pendingRetroCommands,
    async acknowledgeRetroCommand(id: string) {
      const command = retroCommand(id);
      const receipt = z
        .strictObject({ expiresAt: z.number().int().nonnegative() })
        .parse(await authenticated(retroPath(command.id, "ack"), "POST", {}));
      if (receipt.expiresAt !== command.expiresAt)
        throw new Error("Runner retro acknowledgement differs from the admitted command.");
      return receipt;
    },
    async retroInput(request: RunnerRetroInputRequest): Promise<unknown> {
      const body = RunnerRetroInputRequestSchema.parse(request);
      retroCommand(body.commandId);
      return authenticated(retroPath(body.commandId, "input"), "POST", body);
    },
    async postRetroResult(result: RunnerRetroResult) {
      const body = RunnerRetroResultSchema.parse(result);
      retroCommand(body.commandId);
      return z
        .strictObject({ duplicate: z.boolean() })
        .parse(await retroTerminal(body.commandId, "result", body));
    },
    async releaseRetroCommand(id: string) {
      const command = retroCommand(id);
      return z
        .strictObject({ ok: z.literal(true) })
        .parse(await retroTerminal(command.id, "released", { reason: "teardown" }));
    },
    async helperLease(id: string) {
      const command = helperCommand(id);
      const result = z
        .strictObject({ expiresAt: z.number().int().nonnegative() })
        .parse(
          await authenticated(`/v1/helper-commands/${encodeURIComponent(id)}/lease`, "POST", {}),
        );
      if (result.expiresAt !== command.expiresAt || result.expiresAt <= now())
        throw new Error("Runner helper lease differs from the admitted command.");
      return result;
    },
    async postHelperResult(result: RunnerHelperResult) {
      const body = RunnerHelperResultSchema.parse(result);
      helperCommand(body.commandId);
      return RunnerEventReceiptSchema.parse(
        await authenticated(
          `/v1/helper-commands/${encodeURIComponent(body.commandId)}/result`,
          "POST",
          body,
        ),
      );
    },
    acknowledgeCommand,
    async renewCertificate() {
      const previous = paired();
      const identity = ApprovedIdentitySchema.parse(
        await authenticated("/v1/certificate", "POST", { csr: previous.csr }),
      );
      ensureOpen();
      unchangedIdentity(previous);
      if (identity.runnerId !== previous.runnerId || identity.workspaceId !== previous.workspaceId)
        throw new Error("Renewed certificate changes the paired identity.");
      const renewed = { ...common(), phase: "paired" as const, ...identity };
      validateIdentity(options.root, renewed, now());
      trustedSigningKeys(renewed, pins);
      writeState(options.root, renewed);
      state = renewed;
      return status();
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

export type RunnerDaemon = ReturnType<typeof openRunnerDaemon>;

const GITHUB_READ_TTL_MS = 60 * 60_000;
const GITHUB_READ_CLOCK_SKEW_MS = 30_000;

export function githubReadExpiryAllowed(expiresAt: number, now: number): boolean {
  return expiresAt > now && expiresAt <= now + GITHUB_READ_TTL_MS + GITHUB_READ_CLOCK_SKEW_MS;
}
