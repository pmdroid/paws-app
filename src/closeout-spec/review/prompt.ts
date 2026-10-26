import { journalCaught } from "../../journal";
import { sha256Hex } from "../policy/canonical";
import type { ReviewScope } from "../types";
import { FINDING_FORMAT } from "./findings";
import { gitOutput, gitRun } from "./git";

const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

export const DIFF_BUDGET = 300_000;

export type OmittedFile = { path: string; added: number; removed: number; generated: boolean };

export type ReviewMaterial = {
  skillPath: string;
  skill: string;
  references: Array<{ path: string; text: string }>;
  files: string[];
  diff: string;
  omitted?: OmittedFile[];
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
  diffBudget?: number;
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
        .map((path) => ({
          path,
          text: path.startsWith(`${prefix}references/`)
            ? referenceText(trusted.get(path)!)
            : listedOnly(trusted.get(path)!),
        }))
    : await loadReferences(input.repo, input.head, input.skill);
  const filesText = await gitOutput(input.repo, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--no-ext-diff",
    "--name-only",
    range,
  ]);
  const files = filesText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const { diff, omitted } = await budgetedDiff(
    input.repo,
    input.base,
    input.head,
    input.diffBudget ?? DIFF_BUDGET,
  );
  return {
    skillPath: input.skill,
    skill,
    references,
    files,
    diff,
    ...(omitted.length ? { omitted } : {}),
  };
}

async function budgetedDiff(
  repo: string,
  base: string,
  head: string,
  budget: number,
): Promise<{ diff: string; omitted: OmittedFile[] }> {
  const range = `${base}..${head}`;
  const numstat = await gitOutput(repo, [
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--numstat",
    "-z",
    range,
  ]);
  const changed = numstat
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const [added = "", removed = "", ...rest] = record.split("\t");
      return { path: rest.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0 };
    });
  const generated = await generatedPaths(
    repo,
    head,
    changed.map((file) => file.path),
  );
  const kept: string[] = [];
  const omitted: OmittedFile[] = [];
  let used = 0;
  for (const file of changed) {
    if (generated.has(file.path)) {
      omitted.push({ ...file, generated: true });
      continue;
    }
    if (used >= budget) {
      omitted.push({ ...file, generated: false });
      continue;
    }
    const text = await gitOutput(repo, [
      "-c",
      "core.quotepath=false",
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--no-renames",
      range,
      "--",
      `:(literal)${file.path}`,
    ]);
    if (used + text.length > budget) {
      omitted.push({ ...file, generated: false });
      continue;
    }
    kept.push(text);
    used += text.length;
  }
  return { diff: kept.join(""), omitted };
}

async function generatedPaths(repo: string, head: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const result = await gitRun(repo, [
    "check-attr",
    "-z",
    "--source",
    head,
    "linguist-generated",
    "--",
    ...paths,
  ]);
  if (result.exitCode !== 0) return new Set();
  const fields = result.stdout.split("\0");
  const generated = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const value = fields[index + 2];
    if (value === "set" || value === "true") generated.add(fields[index] ?? "");
  }
  return generated;
}

export const DIFF_SCOPE =
  "Review only the diff below and the changed files it lists. Open a changed file only for context the diff lacks. Do not read unchanged files, search the repository, or run commands or tests. This overrides broader instructions in the skill.";

export function renderReviewPrompt(
  material: ReviewMaterial,
  base: string,
  head: string,
  scope: ReviewScope = "candidate",
): string {
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
    ...(scope === "diff" ? [DIFF_SCOPE] : []),
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
    ...omittedSection(material.omitted ?? [], base, head, scope),
    "",
    "# Finding format",
    FINDING_FORMAT,
  ].join("\n");
}

function omittedSection(
  omitted: OmittedFile[],
  base: string,
  head: string,
  scope: ReviewScope,
): string[] {
  if (omitted.length === 0) return [];
  const how =
    scope === "diff"
      ? "Open them in the read-only checkout when they matter."
      : `Open them in the read-only checkout when they matter; \`git diff ${base} ${head} -- <path>\` shows the change.`;
  return [
    "",
    "# Changed files not in the diff above",
    `Generated files and files past the diff's size budget are left out. ${how}`,
    ...omitted.map(
      (file) =>
        `- ${file.path} (+${file.added} -${file.removed}${file.generated ? ", generated" : ""})`,
    ),
  ];
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

function listedOnly(bytes: Uint8Array): string {
  const text = referenceText(bytes);
  if (text.startsWith("Binary resource, SHA-256 ")) return text;
  return `Not inlined: ${bytes.length} bytes outside references/, SHA-256 ${sha256Hex(bytes)}`;
}

function referenceText(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.includes("\0")) return text;
  } catch (caughtError1) {
    journalCaught(caughtError1, "prompt.referenceText.decode", null);
  }
  return `Binary resource, SHA-256 ${sha256Hex(bytes)}`;
}
