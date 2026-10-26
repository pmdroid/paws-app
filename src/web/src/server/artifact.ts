import { journalCaught } from "../../../journal";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { Database } from "bun:sqlite";
import {
  listCloseoutProgress,
  listWorkItems,
  type CloseoutProgressRecord,
  type CloseoutStepRecord,
} from "../../../db";

export const ARTIFACT_API_PATH = "/api/closeout-artifact";

const CAP_BYTES = 256 * 1024;
const REDACTED = "[redacted]";

const DENY = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
  "PAWS_GITHUB_TOKEN",
  "OAUTH_TOKEN",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]);

const PREFIXES = ["AWS_", "AZURE_", "CLOUDSDK_", "GH_", "GITHUB_", "GOOGLE_"];

export function readCloseoutArtifact(input: {
  db: Database;
  sessionIds?: readonly string[];
  itemId: string;
  checkId: string;
  kind: string;
  head: string;
  policy: string;
  evidenceRoot: string;
  env?: NodeJS.ProcessEnv;
}): { status: number; body: string } {
  if (input.kind !== "log" && input.kind !== "evidence") return { status: 404, body: "Not found" };
  if (input.itemId.length === 0 || input.checkId.length === 0 || input.head.length === 0) {
    return { status: 404, body: "Not found" };
  }
  const item = listWorkItems(input.db).find(
    (record) => publicId(record) === input.itemId || record.id === input.itemId,
  );
  if (item === undefined) return { status: 404, body: "Not found" };
  if (
    input.sessionIds !== undefined &&
    (item.sessionKey === null || !input.sessionIds.includes(item.sessionKey))
  )
    return { status: 404, body: "Not found" };
  const rows = listCloseoutProgress(input.db).filter((row) => {
    if (row.itemId !== item.id) return false;
    if (row.head.toLowerCase() !== input.head.toLowerCase()) return false;
    if (row.policyDigest !== input.policy) return false;
    return row.steps.some((step) => step.id === input.checkId);
  });
  const row = rows.length === 1 ? rows[0] : undefined;
  if (row === undefined) return { status: 404, body: "Not found" };
  const step = row.steps.find((entry) => entry.id === input.checkId);
  if (step === undefined) return { status: 404, body: "Not found" };
  const portable = input.kind === "log" ? step.logPath : step.evidencePath;
  if (portable === null || !owns(row, step, input.kind, portable))
    return { status: 404, body: "Not found" };
  const file = resolveInside(input.evidenceRoot, row.taskId, portable);
  if (file === null) return { status: 404, body: "Not found" };
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (caughtError1) {
    journalCaught(caughtError1, "artifact.readCloseoutArtifact.readFileSync", input.itemId);
    return { status: 404, body: "Not found" };
  }
  const clipped = bytes.subarray(0, CAP_BYTES);
  const text = clipped.toString("utf8");
  const body = redactCloseoutText(text, input.env ?? process.env);
  return { status: 200, body };
}

function publicId(record: { id: string; linearIdentifier: string }): string {
  const trimmed = record.linearIdentifier.trim();
  return trimmed.length > 0 ? trimmed : record.id;
}

function owns(
  row: CloseoutProgressRecord,
  step: CloseoutStepRecord,
  kind: "log" | "evidence",
  portable: string,
): boolean {
  const parts = portable.split("/");
  if (parts.length < 5) return false;
  if (parts[0] !== (kind === "log" ? "logs" : "evidence")) return false;
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return false;
  if (parts[1] !== row.policyDigest.replace(/^sha256:/, "")) return false;
  if (parts[2] !== row.head.toLowerCase()) return false;
  const leaf = parts[parts.length - 1] ?? "";
  const suffix = kind === "log" ? ".log" : ".json";
  if (!leaf.endsWith(suffix)) return false;
  const attempt = Number(leaf.slice(0, -suffix.length));
  if (!Number.isInteger(attempt) || attempt < 1 || (step.attempt > 0 && attempt !== step.attempt))
    return false;
  const idParts = step.id.split("/");
  if (idParts.some((part) => part.length === 0 || part === "." || part === "..")) return false;
  if (parts.length !== idParts.length + 4) return false;
  const middle = parts.slice(0, -1);
  for (let index = 0; index < idParts.length; index += 1) {
    if (middle[middle.length - idParts.length + index] !== idParts[index]) return false;
  }
  return true;
}

function resolveInside(evidenceRoot: string, taskId: string, portable: string): string | null {
  const task = taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  if (task.length === 0 || task === "." || task === "..") return null;
  const root = join(evidenceRoot, task);
  const absolute = join(root, ...portable.split("/"));
  try {
    if (!lstatSync(root).isDirectory()) return null;
    const evidenceReal = realpathSync(evidenceRoot);
    const rootReal = realpathSync(root);
    if (!rootReal.startsWith(evidenceReal.endsWith(sep) ? evidenceReal : evidenceReal + sep))
      return null;
    const fileReal = realpathSync(absolute);
    const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
    if (fileReal !== rootReal && !fileReal.startsWith(prefix)) return null;
    if (!lstatSync(absolute).isFile()) return null;
    return fileReal;
  } catch (caughtError2) {
    journalCaught(caughtError2, "artifact.resolveInside.isDirectory", taskId);
    return null;
  }
}

export function redactCloseoutText(text: string, env: NodeJS.ProcessEnv): string {
  const secrets = credentialValues(env).sort((left, right) => right.length - left.length);
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  return out.replace(
    /github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}/g,
    REDACTED,
  );
}

function credentialValues(env: NodeJS.ProcessEnv): string[] {
  const found = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value.length < 8) continue;
    if (!isCredential(key)) continue;
    found.add(value);
  }
  return [...found];
}

function isCredential(key: string): boolean {
  if (DENY.has(key)) return true;
  if (PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  if (key.includes("OAUTH") && key.includes("TOKEN")) return true;
  return /API_KEY|PASSWORD|SECRET|TOKEN/i.test(key);
}
