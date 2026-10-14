import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotImplementationSkills, materializeImplementationSkills } from "./skill-bundle";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-skills-bundle-"));
  roots.push(root);
  const pawsRoot = join(root, "paws");
  const worktree = join(root, "checkout");
  const skill = join(pawsRoot, "skills/check");
  mkdirSync(worktree);
  mkdirSync(join(skill, "scripts"), { recursive: true });
  writeFileSync(join(pawsRoot, "config.toml"), '[skills.projects."acme/repo"]\nroot = "skills"\n');
  writeFileSync(join(skill, "SKILL.md"), "Check with scripts/run.sh");
  writeFileSync(join(skill, "scripts/run.sh"), "printf checked");
  chmodSync(join(skill, "scripts/run.sh"), 0o755);
  writeFileSync(join(skill, "binary.dat"), Buffer.from([0, 255, 3]));
  return { root, pawsRoot, worktree, skill, repository: "acme/repo" };
}

test("skill bundles preserve full resource bytes and executable mode outside checkout", async () => {
  const input = fixture();
  const bytes = await snapshotImplementationSkills(input);
  const output = materializeImplementationSkills(bytes!, input.root);
  expect(readFileSync(join(output, "check/binary.dat"))).toEqual(Buffer.from([0, 255, 3]));
  expect(statSync(join(output, "check/scripts/run.sh")).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(output, "check/SKILL.md"), "utf8")).toBe("Check with scripts/run.sh");
  expect(
    await snapshotImplementationSkills({ ...input, repository: "other/repo" }),
  ).toBeUndefined();
});

test("skill bundles reject symlinks, traversal, duplicate paths and excessive size", async () => {
  const input = fixture();
  symlinkSync(join(input.skill, "SKILL.md"), join(input.skill, "linked"));
  await expect(snapshotImplementationSkills(input)).rejects.toThrow("regular files");
  for (const path of ["../escape", "/absolute/file", "check/.git/config", "check\\file"])
    expect(() =>
      materializeImplementationSkills(
        Buffer.from(JSON.stringify([{ path, executable: false, data: "" }])),
        input.root,
      ),
    ).toThrow();
  const entry = { path: "check/SKILL.md", executable: false, data: "" };
  expect(() =>
    materializeImplementationSkills(Buffer.from(JSON.stringify([entry, entry])), input.root),
  ).toThrow("Duplicate");
  expect(() =>
    materializeImplementationSkills(
      Buffer.from(JSON.stringify([entry, { ...entry, path: "check/SKILL.md/child" }])),
      input.root,
    ),
  ).toThrow();
  expect(readdirSync(input.root).some((name) => name.startsWith(".paws-skills-"))).toBe(false);
  expect(() =>
    materializeImplementationSkills(new Uint8Array(20 * 1024 * 1024 + 1), input.root),
  ).toThrow("20 MiB");
});
