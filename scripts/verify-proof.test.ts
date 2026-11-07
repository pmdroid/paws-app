import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;

const HARNESS = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const name = process.argv[2];
const file = join(process.env.PAWS_EVIDENCE_DIR, \`proof-\${name}.md\`);
const assertions = "## Assertions\\n- PASS the item settles after the turn\\n";
if (name === "bundled") writeFileSync(file, \`# Proof: bundled — PASS\\n\\n\${assertions}\`);
if (name === "large")
  writeFileSync(
    file,
    [
      "# Proof: large — PASS",
      "",
      "## GitHub calls",
      ...Array.from({ length: 2000 }, (_, n) => \`- GET /repos/acme/widgets/pulls/\${n} → 200\`),
      "",
      "## Work item transitions",
      "- queued → running (dispatched)",
      "",
      assertions,
    ].join("\\n"),
  );
`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "verify-proof-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "test/proofs"), { recursive: true });
  for (const file of ["verify-proof.ts", "throwaway-environment.ts"])
    copyFileSync(join(import.meta.dir, file), join(root, "scripts", file));
  writeFileSync(join(root, "test/proofs/harness.ts"), HARNESS);
  for (const name of ["bundled", "unbundled", "large"])
    writeFileSync(join(root, `test/proofs/${name}.ts`), "export default {};\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function verify(name: string) {
  const evidence = join(root, `evidence-${name}`, "proofs");
  const result = spawnSync(
    process.execPath,
    ["--no-env-file", join(root, "scripts/verify-proof.ts"), name],
    { cwd: root, encoding: "utf8", env: { ...process.env, PAWS_EVIDENCE_DIR: evidence } },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}`, evidence };
}

test("a scenario's bundle lands in the log when the evidence directory doesn't exist yet", () => {
  const { status, output, evidence } = verify("bundled");
  expect(output).toContain("PASS bundled");
  expect(output).toContain("## Assertions\n- PASS the item settles after the turn");
  expect(existsSync(join(evidence, "proof-bundled.md"))).toBe(true);
  expect(status).toBe(0);
});

test("a scenario that exits 0 without a bundle fails with no proof bundle", () => {
  const { status, output } = verify("unbundled");
  expect(output).toContain("FAIL unbundled: no proof bundle");
  expect(output).not.toContain("PASS unbundled");
  expect(status).toBe(1);
});

test("a bundle over 64 KB keeps its transitions and assertions and cuts the call list", () => {
  const { status, output } = verify("large");
  expect(output).toContain("## GitHub calls\n- 2000 cut to keep the log under 64 KB");
  expect(output).not.toContain("/pulls/1999");
  expect(output).toContain("## Work item transitions\n- queued → running (dispatched)");
  expect(output).toContain("## Assertions\n- PASS the item settles after the turn");
  expect(status).toBe(0);
});
