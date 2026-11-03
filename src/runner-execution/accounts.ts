import { journalCaught } from "../journal";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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
import { startTime } from "./processes";

export const RUNNER_ACCOUNT_HOMES = ".paws-accounts";
const MANIFEST = "account.json";
const ACTIVE = ".paws-active";
const PUBLISHING = ".paws-publishing";
const ADMISSION_MS = 60_000;

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
const ReceiptSchema = z.union([
  z.strictObject({ receipt: z.string().min(1).max(4096) }),
  z.strictObject({ pid: z.number().int().min(2), born: z.string().min(1).max(64) }),
]);

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
  options: { signIn?: boolean } = {},
): string {
  if (!account) return agentHome;
  const { accountId, bindingId } = RunnerAccountSchema.parse(account);
  const unsupported = runnerAccountAgentUnsupported(agent);
  if (unsupported) throw new RunnerAccountHomeError(unsupported);
  if (!isAbsolute(agentHome)) throw new RunnerAccountHomeError("Runner agent home is invalid");
  privateDirectory(agentHome, false);
  const root = join(agentHome, RUNNER_ACCOUNT_HOMES);
  privateDirectory(root, true);
  const home = join(root, bindingId);
  const manifest = readManifest(home, options.signIn === true);
  if (manifest === null) {
    if (!options.signIn)
      throw new RunnerAccountHomeError("Agent account binding is not signed in on this runner");
  } else if (
    manifest.bindingId !== bindingId ||
    manifest.accountId !== accountId ||
    manifest.agent !== agent
  )
    throw new RunnerAccountHomeError("Agent account binding belongs to another account");
  for (const folder of HOME_FOLDERS) privateDirectory(join(home, folder), true);
  return home;
}

export function markRunnerAccountSignedIn(
  home: string,
  account: RunnerAccount,
  agent: RunnerCodingAgent,
): void {
  const manifest = ManifestSchema.parse({ ...RunnerAccountSchema.parse(account), agent });
  const current = readManifest(home, false);
  if (current) {
    if (current.accountId !== manifest.accountId || current.agent !== manifest.agent)
      throw new RunnerAccountHomeError("Agent account binding belongs to another account");
    return;
  }
  writePrivateFile(join(home, MANIFEST), `${JSON.stringify(manifest)}\n`);
}

export function runnerAccountBindings(
  agentHome: string,
): { bindingId: string; agent: RunnerCodingAgent }[] {
  const root = join(agentHome, RUNNER_ACCOUNT_HOMES);
  let names: string[];
  try {
    privateDirectory(root, false);
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
      privateDirectory(home, false);
      const manifest = readManifest(home, false);
      if (manifest?.bindingId === name && !runnerAccountAgentUnsupported(manifest.agent))
        held.push({ bindingId: name, agent: manifest.agent });
    } catch (error) {
      journalCaught(error, "accounts.runnerAccountBindings.binding", null);
    }
  }
  return held;
}

export function holdRunnerAccountHome(home: string, executionId: string, receipt: string): void {
  const active = join(home, ACTIVE);
  privateDirectory(active, true);
  writePrivateFile(
    join(active, ExecutionIdSchema.parse(executionId)),
    JSON.stringify({ receipt }),
  );
  const publisher = readReceipt(join(home, PUBLISHING));
  if (publisher && publisher !== "stale") {
    releaseRunnerAccountHome(home, executionId);
    throw new RunnerAccountHomeError("This agent account is signing in on the runner");
  }
}

export function releaseRunnerAccountHome(home: string, executionId: string): void {
  rmSync(join(home, ACTIVE, ExecutionIdSchema.parse(executionId)), { force: true });
}

export function publishRunnerAccountHome(
  home: string,
  executionId: string,
  publish: () => void,
): void {
  const born = startTime(process.pid);
  if (!born) throw new RunnerAccountHomeError("Runner sign-in process is unavailable");
  const lock = join(home, PUBLISHING);
  const owner = readReceipt(lock);
  if (owner && owner !== "stale")
    throw new RunnerAccountHomeError("Another sign-in is publishing this agent account");
  if (owner === "stale") rmSync(lock, { force: true });
  let descriptor: number;
  try {
    descriptor = openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new RunnerAccountHomeError("Another sign-in is publishing this agent account");
    throw error;
  }
  try {
    try {
      writeSync(descriptor, JSON.stringify({ pid: process.pid, born }));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const busy = activeExecutions(home).filter((id) => id !== executionId);
    if (busy.length)
      throw new RunnerAccountHomeError(
        "Work is still running with this agent account. Let it finish or stop it, then sign in again.",
      );
    publish();
  } finally {
    rmSync(lock, { force: true });
  }
}

export function activeExecutions(home: string): string[] {
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
    if (!ExecutionIdSchema.safeParse(name).success) continue;
    const state = readReceipt(join(active, name));
    if (state === "stale") rmSync(join(active, name), { force: true });
    else if (state) live.push(name);
  }
  return live;
}

function readReceipt(path: string): "live" | "stale" | null {
  let text: string;
  let modified: number;
  try {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      modified = fstatSync(descriptor).mtimeMs;
      text = readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      journalCaught(error, "accounts.readReceipt", null, "optional file may be absent");
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return "stale";
    throw error;
  }
  let holder: z.infer<typeof ReceiptSchema>;
  try {
    holder = ReceiptSchema.parse(JSON.parse(text));
  } catch (caughtError1) {
    journalCaught(caughtError1, "accounts.readReceipt.parse", null);
    return Date.now() - modified < ADMISSION_MS ? "live" : "stale";
  }
  if ("pid" in holder) return startTime(holder.pid) === holder.born ? "live" : "stale";
  let worker: string;
  try {
    worker = readFileSync(holder.receipt, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    journalCaught(error, "accounts.readReceipt.worker", null, "optional file may be absent");
    return Date.now() - modified < ADMISSION_MS ? "live" : "stale";
  }
  const [pidText, born] = worker.split(" ");
  const pid = Number(pidText);
  if (!born || !Number.isSafeInteger(pid) || pid <= 1) return "stale";
  return startTime(pid) === born ? "live" : "stale";
}

function readManifest(home: string, create: boolean): z.infer<typeof ManifestSchema> | null {
  try {
    privateDirectory(home, create);
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
      if (!info.isFile() || info.uid !== process.getuid?.() || info.size > 4096)
        throw new RunnerAccountHomeError("Agent account binding manifest is unsafe");
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

function privateDirectory(path: string, create: boolean): void {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    journalCaught(error, "accounts.privateDirectory", null, "path may not exist yet");
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (made) {
      if ((made as NodeJS.ErrnoException).code !== "EEXIST") throw made;
      journalCaught(made, "accounts.privateDirectory.mkdirSync", null, "path may already exist");
    }
    info = lstatSync(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new RunnerAccountHomeError("Agent account home path is not a private directory");
  if (process.getuid && info.uid !== process.getuid())
    throw new RunnerAccountHomeError("Agent account home belongs to another user");
  if ((info.mode & 0o077) !== 0) chmodSync(path, info.mode & 0o700);
}

function writePrivateFile(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
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
  if (!statSync(path).isFile()) throw new RunnerAccountHomeError("Agent account file is unsafe");
}
