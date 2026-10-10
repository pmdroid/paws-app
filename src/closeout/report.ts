import { createHash } from "node:crypto";
import { lstat, readFile, appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Artifact,
  DecisionDocument as SpecDecision,
  DecisionItem,
  EvidenceRecord,
} from "../closeout-spec";
import { formatCloseoutEvidence, type ArtifactLink, type RequirementLinks } from "./summary";
import type { DecisionDocument, GateResult } from "./types";

export interface VerdictRecorder {
  record(verdict: GateResult): Promise<void>;
}

export async function writeVerdictReport(reportDir: string, result: GateResult): Promise<string> {
  await mkdir(reportDir, { recursive: true });
  const verdictPath = path.join(reportDir, "closeout-verdict.json");
  const decisionPath = path.join(reportDir, "closeout-decision.json");
  await writeFile(verdictPath, `${JSON.stringify(result, null, 2)}\n`);
  if (result.decision) {
    await writeFile(decisionPath, `${JSON.stringify(result.decision, null, 2)}\n`);
  }
  return verdictPath;
}

export async function appendDecisionHistory(
  reportDir: string,
  entry: {
    evaluation: number;
    exitCode: number | null;
    decision: DecisionDocument | null;
    error?: string;
  },
): Promise<void> {
  await mkdir(reportDir, { recursive: true });
  const target = path.join(reportDir, "closeout-history.jsonl");
  await appendFile(
    target,
    `${JSON.stringify({ recordedAt: new Date().toISOString(), ...entry })}\n`,
  );
}

const MAX_ARTIFACTS = 16;

/**
 * Render a decision for a pull request body, a GitHub or Linear evidence comment, and the dashboard.
 * Artifact bytes are hashed before a log link is written. A mismatch is shown in place of the link.
 */
export async function renderCloseoutEvidence(input: {
  decision: SpecDecision;
  records: readonly EvidenceRecord[];
  root: string;
}): Promise<string> {
  const links: RequirementLinks[] = [];
  for (const item of input.decision.items) {
    if (item.state === "skipped") continue;
    const record = matchRecord(input.decision, item, input.records);
    if (!record) continue;
    links.push({
      itemId: item.id,
      attempt: item.attempt ?? record.attempt,
      artifacts: await checkedArtifacts(input.root, record.artifacts),
    });
  }
  return formatCloseoutEvidence(input.decision, links);
}

function matchRecord(
  decision: SpecDecision,
  item: DecisionItem,
  records: readonly EvidenceRecord[],
): EvidenceRecord | undefined {
  const digest = decision.policy.digest;
  let best: EvidenceRecord | undefined;
  for (const record of records) {
    if (record.itemId !== item.id) continue;
    if (record.base !== decision.base || record.head !== decision.head) continue;
    if (digest !== null && record.policyDigest !== digest) continue;
    if (item.attempt !== undefined && record.attempt !== item.attempt) continue;
    if (!best || record.attempt > best.attempt) best = record;
  }
  return best;
}

async function checkedArtifacts(
  root: string,
  artifacts: readonly Artifact[],
): Promise<ArtifactLink[]> {
  if (artifacts.length > MAX_ARTIFACTS) return [{ path: "", status: "unreadable" }];
  const links: ArtifactLink[] = [];
  for (const artifact of artifacts) links.push(await verifyArtifact(root, artifact));
  return links;
}

async function verifyArtifact(root: string, artifact: Artifact): Promise<ArtifactLink> {
  const resolved = resolveInside(root, artifact.path);
  if (resolved === null) return { path: artifact.path, status: "unreadable" };
  let bytes: Buffer;
  try {
    const info = await lstat(resolved);
    if (!info.isFile()) return { path: artifact.path, status: "unreadable" };
    bytes = await readFile(resolved);
  } catch {
    return { path: artifact.path, status: "unreadable" };
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== artifact.sha256) return { path: artifact.path, status: "mismatch" };
  return { path: artifact.path, status: "ok" };
}

function resolveInside(root: string, artifactPath: string): string | null {
  if (artifactPath.length === 0 || artifactPath.length > 512) return null;
  if (artifactPath.includes("\\") || artifactPath.includes("\0")) return null;
  if (artifactPath.startsWith("/") || artifactPath.startsWith("~")) return null;
  const segments = artifactPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".."))
    return null;
  const base = path.resolve(root);
  const absolute = path.resolve(base, ...segments);
  const rel = path.relative(base, absolute);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return absolute;
}
