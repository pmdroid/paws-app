import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { throwawayEnvironment } from "./throwaway-environment";

const repo = resolve(import.meta.dir, "..");
const proofs = join(repo, "test/proofs");
const evidence = resolve(process.env.PAWS_EVIDENCE_DIR ?? join(repo, "proof-evidence"));
const args = process.argv.slice(2);
const changedAt = args.indexOf("--changed");
const base = changedAt >= 0 ? args[changedAt + 1] : undefined;
if (changedAt >= 0 && !base)
  throw new Error("Usage: bun run verify:proof [--changed <base>] [name…]");
const named = args.filter(
  (_, index) => changedAt < 0 || (index !== changedAt && index !== changedAt + 1),
);
const all = readdirSync(proofs)
  .filter((file) => file.endsWith(".ts") && file !== "harness.ts")
  .map((file) => file.slice(0, -3))
  .sort();
for (const name of named) if (!all.includes(name)) throw new Error(`No proof scenario ${name}`);

type Assertion = { name: string; passed: boolean; observed: unknown };

const LOG_BUNDLE_BYTES = 64 * 1024;
const CALL_SECTIONS = ["## Linear activity", "## Linear issue changes", "## GitHub calls"];

function forLog(markdown: string): string {
  if (Buffer.byteLength(markdown) <= LOG_BUNDLE_BYTES) return markdown;
  return markdown
    .split(/\n(?=## )/)
    .map((section) => {
      const [heading = "", ...rows] = section.split("\n");
      if (!CALL_SECTIONS.includes(heading)) return section;
      const cut = rows.filter((row) => row.startsWith("- ")).length;
      return `${heading}\n- ${cut} cut to keep the log under 64 KB\n`;
    })
    .join("\n");
}

function git(...command: string[]) {
  const result = Bun.spawnSync(["git", ...command], { cwd: repo });
  if (result.exitCode !== 0) throw new Error(`git ${command.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().split("\n").filter(Boolean);
}

async function covered(name: string, changed: string[]) {
  const { covers } = (await import(join(proofs, `${name}.ts`))).default as { covers: string[] };
  return covers.some((glob) => changed.some((file) => new Bun.Glob(glob).match(file)));
}

let selected = named.length > 0 ? named : all;
if (base) {
  const since = git("merge-base", base, "HEAD")[0]!;
  const changed = [
    ...git("diff", "--name-only", since),
    ...git("ls-files", "--others", "--exclude-standard"),
  ];
  const matches = await Promise.all(selected.map((name) => covered(name, changed)));
  selected = selected.filter((_, index) => matches[index]);
}
console.log(
  `${selected.length > 0 ? `Proof scenarios: ${selected.join(", ")}` : "No proof scenario covers these paths"}\nEvidence: ${evidence}`,
);
mkdirSync(evidence, { recursive: true });
const failed: string[] = [];
const unbundled = new Set<string>();
for (const name of selected) {
  const bundle = join(evidence, `proof-${name}`);
  rmSync(`${bundle}.md`, { force: true });
  rmSync(`${bundle}.json`, { force: true });
  const { root, home, env } = throwawayEnvironment();
  const child = Bun.spawn([process.execPath, "--no-env-file", "test/proofs/harness.ts", name], {
    cwd: repo,
    env: { ...env, PAWS_EVIDENCE_DIR: evidence },
    stdout: "inherit",
    stderr: "inherit",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
  const exit = await child.exited;
  clearTimeout(timer);
  rmSync(home, { recursive: true, force: true });
  const markdown = existsSync(`${bundle}.md`) ? readFileSync(`${bundle}.md`, "utf8") : undefined;
  if (exit === 0 && markdown === undefined) unbundled.add(name);
  console.log(`${exit === 0 && markdown !== undefined ? "PASS" : "FAIL"} ${name} (${root})`);
  if (markdown !== undefined) console.log(forLog(markdown));
  if (exit !== 0 || markdown === undefined) failed.push(name);
}
for (const name of failed) {
  if (unbundled.has(name)) {
    console.error(`FAIL ${name}: no proof bundle`);
    continue;
  }
  const bundle = join(evidence, `proof-${name}.json`);
  const { assertions = [] } = existsSync(bundle)
    ? (JSON.parse(readFileSync(bundle, "utf8")) as { assertions?: Assertion[] })
    : {};
  const missed = assertions.filter((entry) => !entry.passed);
  console.error(
    `FAIL ${name}${missed.length === 0 ? ": the scenario stopped before its result" : ""}`,
  );
  for (const entry of missed)
    console.error(`  ${entry.name}: ${JSON.stringify(entry.observed)?.slice(0, 500)}`);
}
process.exitCode = failed.length > 0 ? 1 : 0;
