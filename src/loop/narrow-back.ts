import { shortCommit } from "../questions";

export type GitRead = (args: string[]) => Promise<string>;

export type CandidateSize = { head: string; lines: number; files: number };

type GrownFile = { path: string; added: number; removed: number };

export type Growth = {
  current: CandidateSize;
  previous: CandidateSize | null;
  smaller: CandidateSize | null;
  limit: number;
  doubled: boolean;
};

export const DOUBLING_FLOOR = 200;

const LISTED = 40;

export async function candidateSize(
  git: GitRead,
  repo: string,
  base: string,
  head: string,
): Promise<CandidateSize> {
  const files = numstat(
    await git(["-C", repo, "diff", "--numstat", "--no-renames", `${base}...${head}`, "--"]),
  );
  return {
    head,
    lines: files.reduce((total, file) => total + file.added + file.removed, 0),
    files: files.length,
  };
}

export function candidateGrowth(rounds: readonly CandidateSize[], limit: number): Growth | null {
  const current = rounds.at(-1);
  if (current === undefined || limit <= 0) return null;
  const previous = rounds.at(-2) ?? null;
  const doubled =
    previous !== null &&
    previous.lines > 0 &&
    current.lines >= DOUBLING_FLOOR &&
    current.lines >= previous.lines * 2;
  if (current.lines <= limit && !doubled) return null;
  const smaller =
    rounds
      .slice(0, -1)
      .findLast(
        (round) =>
          round.lines <= limit &&
          round.lines < current.lines &&
          (!doubled || round.lines * 2 <= current.lines),
      ) ?? null;
  return { current, previous, smaller, limit, doubled };
}

export async function narrowBackHandoff(
  git: GitRead,
  input: { repo: string; base: string; growth: Growth; findings: string },
): Promise<string> {
  const { repo, base, growth } = input;
  const { current, smaller } = growth;
  const from = smaller?.head ?? base;
  const [changed, grown, log] = await Promise.all([
    git(["-C", repo, "diff", "--name-only", "--no-renames", "-z", `${base}...${current.head}`]),
    git(["-C", repo, "diff", "--numstat", "--no-renames", from, current.head, "--"]),
    git([
      "-C",
      repo,
      "log",
      "--no-merges",
      "--format=%h %s",
      current.head,
      `^${from}`,
      `^${base}`,
    ]),
  ]);
  const candidateFiles = new Set(changed.split("\0").filter((path) => path !== ""));
  const files = numstat(grown)
    .filter((file) => candidateFiles.has(file.path))
    .sort((left, right) => right.added + right.removed - (left.added + left.removed));
  const commits = log
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const since =
    smaller === null
      ? "the base"
      : `${shortCommit(smaller.head)} (${lineCount(smaller.lines)} in ${fileCount(smaller.files)})`;
  return [
    `Paws stopped the next fix round: ${growthLine(growth)}. Agents overbuild when they answer findings with new machinery, and every new layer gives the review more to find.`,
    "Narrow the change back to the issue before you fix anything. Re-read the issue and keep only what it asks for: remove layers, abstractions, options and state the issue does not need. A finding in code you remove goes away with it. Then fix the findings that are left with the smallest change that removes their cause, and say in your final message what you removed.",
    `Added since ${since}:`,
    "Files:",
    ...listed(files.map((file) => `- ${file.path} (+${file.added} −${file.removed})`)),
    "Commits:",
    ...listed(commits.map((commit) => `- ${commit}`)),
    ...(input.findings.trim() === "" ? [] : ["Closeout's findings:", input.findings]),
  ].join("\n");
}

export function growthLine(growth: Growth): string {
  const { current, previous, limit, doubled } = growth;
  const size = `the change grew to ${lineCount(current.lines)} in ${fileCount(current.files)}`;
  const past = current.lines > limit ? `, past the ${limit.toLocaleString("en-US")}-line limit` : "";
  const twice =
    doubled && previous !== null
      ? `${past === "" ? "," : " and"} double the ${lineCount(previous.lines)} at ${shortCommit(previous.head)}`
      : "";
  return `${size}${past}${twice}`;
}

export function lineCount(lines: number): string {
  return `${lines.toLocaleString("en-US")} changed ${lines === 1 ? "line" : "lines"}`;
}

function fileCount(files: number): string {
  return `${files} ${files === 1 ? "file" : "files"}`;
}

function listed(lines: readonly string[]): string[] {
  if (lines.length === 0) return ["- none"];
  if (lines.length <= LISTED) return [...lines];
  return [...lines.slice(0, LISTED), `- and ${lines.length - LISTED} more`];
}

function numstat(output: string): GrownFile[] {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [added = "", removed = "", ...path] = line.split("\t");
      return {
        path: path.join("\t"),
        added: added === "-" ? 1 : Number(added) || 0,
        removed: removed === "-" ? 0 : Number(removed) || 0,
      };
    })
    .filter((file) => file.path !== "");
}
