import { readFileSync } from "node:fs";

const DIRECTORIES = [
  "src/core",
  "src/db",
  "src/loop",
  "src/linear",
  "src/acp",
  "src/runner-backend",
];

type Counts = {
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
};

function emptyCounts(): Counts {
  return { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 };
}

function parseLcov(text: string): Map<string, Counts> {
  const files = new Map<string, Counts>();
  let current = emptyCounts();
  for (const line of text.split("\n")) {
    const [key, value = ""] = line.split(":", 2);
    if (key === "SF") {
      current = emptyCounts();
      files.set(value, current);
    }
    if (key === "LF") current.linesFound += Number(value);
    if (key === "LH") current.linesHit += Number(value);
    if (key === "FNF") current.functionsFound += Number(value);
    if (key === "FNH") current.functionsHit += Number(value);
  }
  return files;
}

function percent(hit: number, found: number): string {
  return found === 0 ? "-" : `${((hit / found) * 100).toFixed(1)} %`;
}

function row(name: string, counts: Counts): string {
  const lines = `${percent(counts.linesHit, counts.linesFound)} (${counts.linesHit}/${counts.linesFound})`;
  return `| ${name} | ${lines} | ${percent(counts.functionsHit, counts.functionsFound)} |`;
}

function add(total: Counts, counts: Counts): void {
  total.linesFound += counts.linesFound;
  total.linesHit += counts.linesHit;
  total.functionsFound += counts.functionsFound;
  total.functionsHit += counts.functionsHit;
}

const files = parseLcov(readFileSync(process.argv[2] ?? "coverage/lcov.info", "utf8"));
const header = ["| Path | Lines | Functions |", "| --- | --- | --- |"];
const summary = [...header];
const details: string[] = [];

for (const directory of DIRECTORIES) {
  const total = emptyCounts();
  const fileRows: string[] = [];
  for (const [file, counts] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!file.startsWith(`${directory}/`)) continue;
    add(total, counts);
    fileRows.push(row(file.slice(directory.length + 1), counts));
  }
  summary.push(row(directory, total));
  details.push("", `### ${directory}`, "", ...header, ...fileRows);
}

console.log(["## Coverage", "", ...summary, ...details].join("\n"));
