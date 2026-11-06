import { journalCaught } from "../journal";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  RUNNER_CODING_AGENTS,
  RunnerAccountSchema,
  runnerAccountAgentUnsupported,
  type RunnerAccount,
  type RunnerCodingAgent,
} from "../runner-protocol";
import { ExecutionIdSchema } from "./jobs";
import { listExecutionProcesses, startTime } from "./processes";
import { SETGID, clearInheritedSetgid, sharedDirectoryAllowed } from "./shared";

export const RUNNER_ACCOUNT_HOMES = ".paws-accounts";
const MANIFEST = "account.json";
const ACTIVE = ".paws-active";
const PUBLISHING = ".paws-publishing";
const ADMISSION_MS = 60_000;
const SHARE_LIMIT = 100_000;
const SHARED_ELSEWHERE = new Set(["work", RUNNER_ACCOUNT_HOMES, MANIFEST, ACTIVE, PUBLISHING]);

const HOME_FOLDERS = [
  ".claude",
  ".codex",
  ".codex/sessions",
  ".grok",
  ".config",
  ".local",
  ".local/share",
  ".local/state",
  ".cache",
] as const;

const ManifestSchema = z.strictObject({
  bindingId: RunnerAccountSchema.shape.bindingId,
  accountId: RunnerAccountSchema.shape.accountId,
  agent: z.enum(RUNNER_CODING_AGENTS),
});
const ScopeSchema = z.string().regex(/^[a-f0-9]{16}$/);
const PidSchema = z.number().int().min(2);
const BornSchema = z.string().min(1).max(64);
const LockSchema = z.strictObject({ pid: PidSchema, born: BornSchema });
const HoldSchema = z.union([
  z.strictObject({ scope: ScopeSchema, pid: PidSchema, born: BornSchema }),
  z.strictObject({ scope: ScopeSchema }),
  z
    .strictObject({ scope: ScopeSchema, receipt: z.string().min(1).max(4096) })
    .transform((hold) => ({
      scope: hold.scope,
    })),
]);
type Hold = { scope: string; pid?: number; born?: string };

export type RunnerAccountOwners = { runnerUid: number; agentGid: number };

function processOwners(): RunnerAccountOwners {
  return { runnerUid: process.getuid?.() ?? -1, agentGid: process.getgid?.() ?? -1 };
}

export class RunnerAccountHomeError extends Error {
  override readonly name = "RunnerAccountHomeError";
}

export function runnerAccountHome(agentHome: string, account?: RunnerAccount): string {
  if (!account) return agentHome;
  return join(agentHome, RUNNER_ACCOUNT_HOMES, RunnerAccountSchema.parse(account).bindingId);
}

export function openRunnerAccountHome(
  agentHome: string,
  account: RunnerAccount | undefined,
  agent: RunnerCodingAgent,
  options: { signIn?: boolean; folders?: boolean; owners?: RunnerAccountOwners } = {},
): string {
  if (!account) return agentHome;
  const owners = options.owners ?? processOwners();
  const { accountId, bindingId } = RunnerAccountSchema.parse(account);
  const unsupported = runnerAccountAgentUnsupported(agent);
  if (unsupported) throw new RunnerAccountHomeError(unsupported);
  if (!isAbsolute(agentHome)) throw new RunnerAccountHomeError("Runner agent home is invalid");
  privateDirectory(agentHome, false, owners);
  const root = join(agentHome, RUNNER_ACCOUNT_HOMES);
  privateDirectory(root, true, owners);
  const home = join(root, bindingId);
  const manifest = readManifest(home, options.signIn === true, owners);
  if (manifest === null) {
    if (!options.signIn)
      throw new RunnerAccountHomeError("Agent account binding is not signed in on this runner");
  } else if (
    manifest.bindingId !== bindingId ||
    manifest.accountId !== accountId ||
    manifest.agent !== agent
  )
    throw new RunnerAccountHomeError("Agent account binding belongs to another account");
  if (options.folders !== false)
    for (const folder of HOME_FOLDERS) privateDirectory(join(home, folder), true, owners);
  return home;
}

export function markRunnerAccountSignedIn(
  home: string,
  account: RunnerAccount,
  agent: RunnerCodingAgent,
  owners: RunnerAccountOwners = processOwners(),
): void {
  const manifest = ManifestSchema.parse({ ...RunnerAccountSchema.parse(account), agent });
  const current = readManifest(home, false, owners);
  if (current) {
    if (current.accountId !== manifest.accountId || current.agent !== manifest.agent)
      throw new RunnerAccountHomeError("Agent account binding belongs to another account");
    return;
  }
  writeSharedFile(join(home, MANIFEST), `${JSON.stringify(manifest)}\n`, owners);
}

export function runnerAccountBindings(
  agentHome: string,
  owners: RunnerAccountOwners = processOwners(),
): { bindingId: string; agent: RunnerCodingAgent }[] {
  const root = join(agentHome, RUNNER_ACCOUNT_HOMES);
  let names: string[];
  try {
    privateDirectory(root, false, owners);
    names = readdirSync(root).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      journalCaught(error, "accounts.runnerAccountBindings", null, "optional file may be absent");
      return [];
    }
    throw error;
  }
  const held: { bindingId: string; agent: RunnerCodingAgent }[] = [];
  for (const name of names) {
    if (held.length >= 64) break;
    if (!RunnerAccountSchema.shape.bindingId.safeParse(name).success) continue;
    try {
      const home = join(root, name);
      privateDirectory(home, false, owners);
      const manifest = readManifest(home, false, owners);
      if (manifest?.bindingId === name && !runnerAccountAgentUnsupported(manifest.agent))
        held.push({ bindingId: name, agent: manifest.agent });
    } catch (error) {
      journalCaught(error, "accounts.runnerAccountBindings.binding", null);
    }
  }
  return held;
}

export function holdRunnerAccountHome(
  home: string,
  executionId: string,
  holder: { scope: string },
  owners: RunnerAccountOwners = processOwners(),
): void {
  const active = join(home, ACTIVE);
  privateDirectory(active, true, owners);
  writeHold(home, executionId, { scope: holder.scope }, owners);
  const publisher = readLock(join(home, PUBLISHING));
  if (publisher && publisher !== "stale") {
    releaseRunnerAccountHome(home, executionId);
    throw new RunnerAccountHomeError("This agent account is signing in on the runner");
  }
}

export function confirmRunnerAccountHold(
  home: string,
  executionId: string,
  holder: { scope: string; pid: number; born: string },
  owners: RunnerAccountOwners = processOwners(),
): void {
  writeHold(home, executionId, holder, owners);
}

function writeHold(
  home: string,
  executionId: string,
  holder: Hold,
  owners: RunnerAccountOwners,
): void {
  writeSharedFile(
    join(home, ACTIVE, ExecutionIdSchema.parse(executionId)),
    JSON.stringify(HoldSchema.parse(holder)),
    owners,
  );
}

export function releaseRunnerAccountHome(home: string, executionId: string): void {
  rmSync(join(home, ACTIVE, ExecutionIdSchema.parse(executionId)), { force: true });
}

export function publishRunnerAccountHome(
  home: string,
  executionId: string,
  publish: () => void,
  owners: RunnerAccountOwners = processOwners(),
): void {
  const born = startTime(process.pid);
  if (!born) throw new RunnerAccountHomeError("Runner sign-in process is unavailable");
  const lock = join(home, PUBLISHING);
  const owner = readLock(lock);
  if (owner && owner !== "stale")
    throw new RunnerAccountHomeError("Another sign-in is publishing this agent account");
  if (owner === "stale") rmSync(lock, { force: true });
  let descriptor: number;
  try {
    descriptor = openSync(lock, "wx", 0o640);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new RunnerAccountHomeError("Another sign-in is publishing this agent account");
    throw error;
  }
  try {
    try {
      shareWithAgents(descriptor, owners);
      writeSync(descriptor, JSON.stringify({ pid: process.pid, born }));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const busy = activeExecutions(home, executionId);
    if (busy.length)
      throw new RunnerAccountHomeError(
        "Work is still running with this agent account. Let it finish or stop it, then sign in again.",
      );
    publish();
  } finally {
    rmSync(lock, { force: true });
  }
}

export function activeExecutions(home: string, except?: string): string[] {
  const active = join(home, ACTIVE);
  let names: string[];
  try {
    names = readdirSync(active);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      journalCaught(error, "accounts.activeExecutions", null, "optional file may be absent");
      return [];
    }
    throw error;
  }
  const live: string[] = [];
  for (const name of names) {
    if (name === except || !ExecutionIdSchema.safeParse(name).success) continue;
    const state = readHold(join(active, name), name);
    if (state === "stale") rmSync(join(active, name), { force: true });
    else if (state) live.push(name);
  }
  return live;
}

function readShared(path: string): { text: string; modified: number } | "live" | "stale" | null {
  try {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return { modified: fstatSync(descriptor).mtimeMs, text: readFileSync(descriptor, "utf8") };
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      journalCaught(error, "accounts.readShared", null, "optional file may be absent");
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return "stale";
    if ((error as NodeJS.ErrnoException).code === "EACCES") return "live";
    throw error;
  }
}

function admitting(modified: number): "live" | "stale" {
  return Date.now() - modified < ADMISSION_MS ? "live" : "stale";
}

function readLock(path: string): "live" | "stale" | null {
  const file = readShared(path);
  if (file === null || typeof file === "string") return file;
  let lock: z.infer<typeof LockSchema>;
  try {
    lock = LockSchema.parse(JSON.parse(file.text));
  } catch (caughtError1) {
    journalCaught(caughtError1, "accounts.readLock.parse", null);
    return admitting(file.modified);
  }
  return startTime(lock.pid) === lock.born ? "live" : "stale";
}

function readHold(path: string, executionId: string): "live" | "stale" | null {
  const file = readShared(path);
  if (file === null || typeof file === "string") return file;
  let hold: Hold;
  try {
    hold = HoldSchema.parse(JSON.parse(file.text));
  } catch (caughtError1) {
    journalCaught(caughtError1, "accounts.readHold.parse", null);
    return admitting(file.modified);
  }
  if (listExecutionProcesses(hold.scope).some((entry) => entry.executionId === executionId))
    return "live";
  if (hold.pid === undefined || hold.born === undefined) return admitting(file.modified);
  return startTime(hold.pid) === hold.born ? "live" : "stale";
}

function readManifest(
  home: string,
  create: boolean,
  owners: RunnerAccountOwners,
): z.infer<typeof ManifestSchema> | null {
  try {
    privateDirectory(home, create, owners);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") {
      journalCaught(error, "accounts.readManifest", null, "optional file may be absent");
      return null;
    }
    throw error;
  }
  let text: string;
  try {
    const descriptor = openSync(join(home, MANIFEST), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(descriptor);
      const self = process.getuid?.();
      if (
        !info.isFile() ||
        info.size > 4096 ||
        (info.mode & 0o022) !== 0 ||
        (info.uid !== self && info.uid !== owners.runnerUid && info.gid !== owners.agentGid)
      )
        throw new RunnerAccountHomeError("Agent account binding manifest is unsafe");
      if (info.uid === self && (info.gid !== owners.agentGid || (info.mode & 0o777) !== 0o640))
        shareWithAgents(descriptor, owners);
      text = readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      journalCaught(error, "accounts.readManifest.open", null, "optional file may be absent");
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new RunnerAccountHomeError("Agent account binding manifest is unsafe");
    throw error;
  }
  return ManifestSchema.parse(JSON.parse(text));
}

function privateDirectory(path: string, create: boolean, owners: RunnerAccountOwners): void {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    journalCaught(error, "accounts.privateDirectory", null, "path may not exist yet");
    try {
      mkdirSync(path, { mode: 0o770 });
    } catch (made) {
      if ((made as NodeJS.ErrnoException).code !== "EEXIST") throw made;
      journalCaught(made, "accounts.privateDirectory.mkdirSync", null, "path may already exist");
    }
    info = lstatSync(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new RunnerAccountHomeError("Agent account home path is not a private directory");
  const verdict = accountHomeVerdict(info, owners, process.getuid?.() ?? info.uid);
  if (verdict === "repair") chmodSync(path, 0o770);
  else if (verdict !== "shared") throw new RunnerAccountHomeError(verdict);
}

export function accountHomeVerdict(
  info: { uid: number; gid: number; mode: number },
  owners: RunnerAccountOwners,
  self: number,
): "shared" | "repair" | string {
  if (info.uid !== self && info.uid !== owners.runnerUid)
    return "Agent account home belongs to another user";
  if (info.gid !== owners.agentGid) return "Agent account home is not in the agent group";
  if ((info.mode & 0o007) !== 0) return "Agent account home is open to other users";
  const rule = { owners: [self, owners.runnerUid], gid: owners.agentGid, mode: 0o770 };
  if (sharedDirectoryAllowed(info, rule)) return "shared";
  if (info.uid !== self || (info.mode & SETGID) !== 0)
    return "Agent account home is not shared with the agent group";
  return "repair";
}

export function shareRunnerAgentState(home: string, owners: RunnerAccountOwners): void {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch (error) {
    if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  shareRunnerPaths(
    names.filter((name) => !SHARED_ELSEWHERE.has(name)).map((name) => join(home, name)),
    owners,
    { limit: 1_000_000 },
  );
}

/**
 * Gives the agent group the access paws-runner has to the work root it may have created while
 * agents ran as paws-runner: the root itself and its runner-wide `.paws` state. A leftover
 * checkout of a run that starts over is removed, as the worker would remove it. A resumed
 * execution keeps the user it started as, so its checkout is left as it is.
 */
export function prepareRunnerWorkRoot(
  workRoot: string,
  owners: RunnerAccountOwners,
  checkout?: { name: string },
): void {
  try {
    mkdirSync(workRoot, { mode: 0o770 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    journalCaught(
      error,
      "accounts.prepareRunnerWorkRoot.mkdirSync",
      null,
      "path may already exist",
    );
  }
  const root = lstatSync(workRoot);
  if (root.isSymbolicLink() || !root.isDirectory())
    throw new RunnerAccountHomeError("Runner work root is not a directory");
  // The worker clears an inherited setgid bit itself, but only the owner may, and that is us.
  if (root.uid === process.getuid?.()) clearInheritedSetgid(workRoot);
  shareRunnerPaths([workRoot], owners, { depth: 0 });
  shareRunnerPaths(
    readdirSync(workRoot)
      .filter((name) => name.startsWith(".paws") && !name.startsWith(".paws-skills-"))
      .map((name) => join(workRoot, name)),
    owners,
  );
  if (!checkout) return;
  const path = join(workRoot, checkout.name);
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.()) return;
  removeRunnerTree(path);
}

function removeRunnerTree(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory()) return unlinkSync(path);
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) removeRunnerTree(join(path, name));
  rmSync(path, { recursive: true });
}

function shareRunnerPaths(
  roots: readonly string[],
  owners: RunnerAccountOwners,
  bounds: { depth?: number; limit?: number } = {},
): void {
  const self = process.getuid?.();
  const limit = bounds.limit ?? SHARE_LIMIT;
  let seen = 0;
  const visit = (path: string, depth: number) => {
    if (++seen > limit) throw new RunnerAccountHomeError("Agent state has too many files");
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) return;
    if (info.uid === self) {
      const group = (info.mode & 0o700) >> 3;
      const regroup = info.gid !== owners.agentGid;
      const remode = (info.mode & 0o070) !== group;
      if (regroup || remode) {
        const descriptor = openSync(
          path,
          constants.O_RDONLY |
            constants.O_NOFOLLOW |
            (info.isDirectory() ? constants.O_DIRECTORY : 0),
        );
        try {
          if (regroup) fchownSync(descriptor, -1, owners.agentGid);
          if (remode) fchmodSync(descriptor, (info.mode & 0o707) | group);
        } finally {
          closeSync(descriptor);
        }
      }
    }
    if (!info.isDirectory() || depth === bounds.depth) return;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") return;
      throw error;
    }
    for (const name of names) visit(join(path, name), depth + 1);
  };
  for (const root of roots) visit(root, 0);
}

function shareWithAgents(descriptor: number, owners: RunnerAccountOwners): void {
  fchownSync(descriptor, -1, owners.agentGid);
  fchmodSync(descriptor, 0o640);
}

function writeSharedFile(path: string, text: string, owners: RunnerAccountOwners): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporary, "wx", 0o640);
    try {
      shareWithAgents(descriptor, owners);
      writeSync(descriptor, text);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  if (!lstatSync(path).isFile()) throw new RunnerAccountHomeError("Agent account file is unsafe");
}
