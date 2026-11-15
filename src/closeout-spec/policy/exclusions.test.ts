import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createCloseoutSession } from "../session";
import { workspacePolicyFiles } from "../facade";
import { loadMemoryPolicy, PUBLIC_POLICY_PATH } from "./resolve";
import { parsePolicy } from "./document";

const policy = (except: string) => `specVersion: "0.1"
items:
  - id: visual-proof
    kind: evidence
    gate: beforePR
    paths: ["src/dashboard/**", "landing/**"]
    except: ${except}
`;

test("except uses the paths schema and pattern validation", () => {
  for (const value of ['"*.test.ts"', "[123]", "[]"]) {
    expect(parsePolicy(policy(value)).ok).toBe(false);
  }
  for (const value of ['["!foo"]', '["../foo"]', '["/foo"]']) {
    const result = loadMemoryPolicy(
      new Map([[PUBLIC_POLICY_PATH, new TextEncoder().encode(policy(value))]]),
    );
    expect(result.ok).toBe(false);
  }
  const parsed = parsePolicy(policy('["**/*.test.ts"]'));
  expect(parsed.ok && parsed.document.items?.[0]?.except).toEqual(["**/*.test.ts"]);
});

test("visual proof skips dashboard tests and still requires dashboard source changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "closeout-except-"));
  try {
    mkdirSync(join(root, ".agents"));
    writeFileSync(join(root, PUBLIC_POLICY_PATH), policy('["**/*.test.ts"]'));
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"],
      { cwd: root },
    );
    spawnSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
    const client = join(root, "src/dashboard/src/client");
    mkdirSync(client, { recursive: true });
    writeFileSync(join(client, "foo.test.ts"), "test");
    const session = createCloseoutSession(root, { policy: async () => workspacePolicyFiles(root) });
    expect(JSON.parse(await session.report()).required).toEqual([]);
    writeFileSync(join(client, "foo.ts"), "source");
    const report = JSON.parse(await session.report());
    expect(report.required.map((item: { id: string }) => item.id)).toEqual(["visual-proof"]);
    expect(report.required[0].matched_paths).toEqual(["src/dashboard/src/client/foo.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
