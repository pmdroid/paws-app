import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
const failed: string[] = [];
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
  console.log(`${exit === 0 ? "PASS" : "FAIL"} ${name} (${root})`);
  if (existsSync(`${bundle}.md`)) console.log(readFileSync(`${bundle}.md`, "utf8"));
  if (exit !== 0) failed.push(name);
}
for (const name of failed) {
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
