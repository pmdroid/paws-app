import { sha256Hex } from "../policy/canonical";
import { FINDING_FORMAT } from "./findings";
import { gitOutput } from "./git";

const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

export type ReviewMaterial = {
  skillPath: string;
  skill: string;
  references: Array<{ path: string; text: string }>;
  files: string[];
  diff: string;
};

export function assertCommit(value: string, label: string): void {
  if (!SHA.test(value)) throw new Error(`${label} is not a commit id`);
}

export function assertSkillPath(skill: string): void {
  assertRepoPath(skill);
  if (!skill.endsWith("/SKILL.md")) throw new Error("skill path must end in /SKILL.md");
}

/** Skill text, reference files, and the commit range, read from git objects. */
export async function loadReviewMaterial(input: {
  repo: string;
  skill: string;
  skillFiles?: ReadonlyMap<string, Uint8Array>;
  base: string;
  head: string;
}): Promise<ReviewMaterial> {
  assertCommit(input.base, "base");
  assertCommit(input.head, "head");
  assertSkillPath(input.skill);
  const range = `${input.base}..${input.head}`;
  const trusted = input.skillFiles;
  const skill = trusted
    ? skillText(trusted, input.skill)
    : await gitOutput(input.repo, ["show", `${input.head}:${input.skill}`]);
  const prefix = `${input.skill.slice(0, input.skill.lastIndexOf("/"))}/`;
  const references = trusted
    ? [...trusted.keys()]
        .filter((path) => path.startsWith(prefix) && path !== input.skill)
        .sort()
        .map((path) => ({ path, text: referenceText(trusted.get(path)!) }))
    : await loadReferences(input.repo, input.head, input.skill);
  const filesText = await gitOutput(input.repo, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--no-ext-diff",
    "--name-only",
    range,
  ]);
  const diff = await gitOutput(input.repo, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--no-ext-diff",
    "--no-color",
    range,
  ]);
  const files = filesText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { skillPath: input.skill, skill, references, files, diff };
}

export function renderReviewPrompt(material: ReviewMaterial, base: string, head: string): string {
  const references =
    material.references.length === 0
      ? "(none)"
      : material.references
          .map((entry) => `## ${entry.path}\n${entry.text.trimEnd()}`)
          .join("\n\n");
  return [
    "Review this candidate. The checkout is read-only. Do not edit files.",
    `Base ${base}`,
    `Head ${head}`,
    "",
    `# ${material.skillPath}`,
    material.skill.trimEnd(),
    "",
    "# References",
    references,
    "",
    "# Changed files",
    material.files.length === 0 ? "(none)" : material.files.join("\n"),
    "",
    `# Diff ${base}..${head}`,
    material.diff.trimEnd() || "(empty)",
    "",
    "# Finding format",
    FINDING_FORMAT,
  ].join("\n");
}

async function loadReferences(
  repo: string,
  head: string,
  skill: string,
): Promise<Array<{ path: string; text: string }>> {
  const skillDir = skill.slice(0, skill.lastIndexOf("/"));
  const prefix = `${skillDir}/references`;
  const listed = await gitOutput(repo, ["ls-tree", "-r", "-z", head, "--", prefix]);
  const entries: Array<{ path: string; text: string }> = [];
  for (const record of listed.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) throw new Error("git ls-tree returned an unexpected record");
    const meta = record.slice(0, tab);
    const path = record.slice(tab + 1);
    const mode = meta.split(" ")[0];
    if (mode !== "100644" && mode !== "100755") {
      throw new Error(`skill reference is not a regular file: ${path}`);
    }
    if (!path.startsWith(`${prefix}/`)) throw new Error(`skill reference escapes ${prefix}`);
    const text = await gitOutput(repo, ["show", `${head}:${path}`]);
    entries.push({ path, text });
  }
  entries.sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
  return entries;
}

function assertRepoPath(input: string): void {
  if (input.length === 0 || input.startsWith("/") || input.includes("\\") || input.includes("\0")) {
    throw new Error("skill path escapes the checkout");
  }
  const parts = input.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("skill path escapes the checkout");
  }
}

function skillText(files: ReadonlyMap<string, Uint8Array>, path: string): string {
  const bytes = files.get(path);
  if (bytes === undefined) throw new Error(`trusted skill file is missing: ${path}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function referenceText(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.includes("\0")) return text;
  } catch {}
  return `Binary resource, SHA-256 ${sha256Hex(bytes)}`;
}
