import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyConfigFile, parseConfigToml } from "../config";
import { executeItem } from "./executor";
import { git } from "./git";
import { runAgent } from "./run";
import { decidePermission } from "./permissions";
import { readGuarded } from "./host-tools";
import { loadImplementationSkills } from "./skills";
import type { FakeResult, FakeScript } from "./testing/script";

const roots: string[] = [];
const fakeAgent = new URL("./testing/fake-agent.ts", import.meta.url).pathname;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paws-local-skills-"));
  roots.push(root);
  const source = join(root, "source");
  const pawsRoot = join(root, "paws");
  const skillRoot = join(pawsRoot, "local skills");
  for (const directory of [
    join(source, ".agents/skills/check"),
    join(source, ".agents/skills/unrelated"),
    join(skillRoot, "check/scripts"),
    join(skillRoot, "added/references"),
  ])
    await mkdir(directory, { recursive: true });
  await writeFile(join(source, ".agents/skills/check/SKILL.md"), "Repository check\n");
  await writeFile(join(source, ".agents/skills/unrelated/SKILL.md"), "Unrelated skill\n");
  await writeFile(join(source, "README.md"), "Original checkout\n");
  await git(["init", "-b", "main", source]);
  await git(["-C", source, "add", "."]);
  await git([
    "-C",
    source,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "initial",
  ]);
  await writeFile(join(source, "README.md"), "Uncommitted user change\n");
  await writeFile(
    join(skillRoot, "check/SKILL.md"),
    "Local check replacement\nUse scripts/check.sh.\n",
  );
  await writeFile(
    join(skillRoot, "check/scripts/check.sh"),
    "printf 'resource script worked' > result.txt\n",
  );
  await writeFile(
    join(skillRoot, "added/SKILL.md"),
    "Local added skill\nRead references/context.txt.\n",
  );
  await writeFile(join(skillRoot, "added/references/context.txt"), "Local reference\n");
  await writeFile(
    join(pawsRoot, "config.toml"),
    '[skills.projects."Acme/Demo"]\nroot = "local skills"\n',
  );
  return { root, source, pawsRoot, skillRoot };
}

test("local additions and replacements run with resources without entering candidate commits", async () => {
  const layout = await fixture();
  const reference = join(layout.skillRoot, "added/references/context.txt");
  const scriptPath = join(layout.skillRoot, "check/scripts/check.sh");
  const escape = join(layout.skillRoot, "added/references/escape");
  await symlink(join(layout.source, "README.md"), escape);
  const before = await git(["-C", layout.source, "status", "--porcelain"]);
  const beforeIndex = await git(["-C", layout.source, "write-tree"]);
  const script: FakeScript = {
    steps: [
      { type: "fs_read", path: reference },
      { type: "fs_read", path: escape },
      { type: "fs_write", path: reference, content: "bad" },
      { type: "terminal", command: "bash", args: [scriptPath] },
      { type: "terminal", command: "rm", args: [reference] },
      { type: "end" },
    ],
  };
  const scriptFile = join(layout.root, "script.json");
  const resultFile = join(layout.root, "result.json");
  await writeFile(scriptFile, JSON.stringify(script));
  const result = await executeItem({
    owner: "acme",
    repo: "demo",
    remoteUrl: layout.source,
    itemId: "skill-demo",
    runId: "skill-run",
    prompt: "Do the task",
    pawsRoot: layout.pawsRoot,
    command: process.execPath,
    args: [fakeAgent, resultFile, scriptFile],
  });
  expect(result.run.stopReason).toBe("end_turn");
  expect(result.run.checkpoint?.committed).toBe(true);
  const trace = JSON.parse(await readFile(resultFile, "utf8")) as FakeResult;
  const prompt = JSON.stringify(trace.prompts);
  expect(prompt).toContain("Local check replacement");
  expect(prompt).toContain("Local added skill");
  expect(prompt).toContain("replaces the repository skill with the same directory name");
  expect(trace.fs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        op: "read",
        path: reference,
        ok: true,
        content: "Local reference\n",
      }),
      expect.objectContaining({ op: "read", path: escape, ok: false }),
      expect.objectContaining({ op: "write", path: reference, ok: false }),
    ]),
  );
  expect(trace.terminals).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ command: "bash", ok: true, exitCode: 0 }),
      expect.objectContaining({ command: "rm", ok: false }),
    ]),
  );
  expect(
    (await git(["-C", result.worktreePath, "diff", "HEAD~1", "HEAD", "--name-only"])).trim(),
  ).toBe("result.txt");
  expect(await readFile(join(result.worktreePath, "result.txt"), "utf8")).toBe(
    "resource script worked",
  );
  expect(await readFile(join(result.worktreePath, ".agents/skills/check/SKILL.md"), "utf8")).toBe(
    "Repository check\n",
  );
  expect(
    await readFile(join(result.worktreePath, ".agents/skills/unrelated/SKILL.md"), "utf8"),
  ).toBe("Unrelated skill\n");
  expect(await git(["-C", result.worktreePath, "status", "--porcelain"])).toBe("");
  expect(await git(["-C", layout.source, "status", "--porcelain"])).toBe(before);
  expect(await git(["-C", layout.source, "write-tree"])).toBe(beforeIndex);
  expect(await readFile(join(layout.source, "README.md"), "utf8")).toBe(
    "Uncommitted user change\n",
  );
  expect(await readFile(reference, "utf8")).toBe("Local reference\n");
});

test("follow-up runs discover project skills from origin while review material stays authoritative", async () => {
  const layout = await fixture();
  await git(["-C", layout.source, "remote", "add", "origin", "git@github.com:acme/demo.git"]);
  const config = parseConfigToml(await readFile(join(layout.pawsRoot, "config.toml"), "utf8"));
  const selected = await loadImplementationSkills({
    config,
    pawsRoot: layout.pawsRoot,
    worktree: layout.source,
  });
  expect(selected.prompt).toContain("Local check replacement");
  const scriptFile = join(layout.root, "script.json");
  const resultFile = join(layout.root, "result.json");
  await writeFile(scriptFile, JSON.stringify({ steps: [{ type: "end" }] }));
  const result = await runAgent({
    role: "reviewer",
    repository: "acme/demo",
    itemId: "review",
    runId: "review",
    prompt: "Trusted Closeout skill",
    worktreePath: layout.source,
    pawsRoot: layout.pawsRoot,
    command: process.execPath,
    args: [fakeAgent, resultFile, scriptFile],
    checkpoint: false,
  });
  expect(result.stopReason).toBe("end_turn");
  const trace = JSON.parse(await readFile(resultFile, "utf8")) as FakeResult;
  expect(JSON.stringify(trace.prompts)).toContain("Trusted Closeout skill");
  expect(JSON.stringify(trace.prompts)).not.toContain("Local check replacement");
});

test("configured skills fail before execution for missing roots and unsafe repository roots", async () => {
  const layout = await fixture();
  const config = emptyConfigFile();
  config.projectSkills = [{ repo: "acme/demo", root: "missing" }];
  const input = {
    config,
    pawsRoot: layout.pawsRoot,
    worktree: layout.source,
    repository: "acme/demo",
  };
  await expect(loadImplementationSkills(input)).rejects.toThrow();
  config.projectSkills[0]!.root = layout.source;
  await expect(loadImplementationSkills(input)).rejects.toThrow("outside the repository worktree");
  config.projectSkills[0]!.root = layout.root;
  await expect(loadImplementationSkills(input)).rejects.toThrow("outside the repository worktree");
  expect(await loadImplementationSkills({ ...input, repository: "other/repo" })).toEqual({
    prompt: "",
    roots: [],
  });
});

test("native adapter shell requests allow direct resource use and reject mutation and shell composition", async () => {
  const layout = await fixture();
  const script = join(layout.skillRoot, "check/scripts/check.sh");
  const reference = join(layout.skillRoot, "added/references/context.txt");
  const guard = {
    home: layout.root,
    worktree: layout.source,
    pawsRoot: layout.pawsRoot,
    skillRoots: [join(layout.skillRoot, "check"), join(layout.skillRoot, "added")],
  };
  for (const command of [`bash '${script}'`, `cat "${reference}"`]) {
    expect(
      decidePermission({ kind: "execute", title: command, rawInput: { command } }, guard).allow,
    ).toBe(true);
  }
  for (const command of [
    `rm ${reference}`,
    `bash ${script}; rm ${reference}`,
    `bash ${script} > ${reference}`,
    `bash -c 'rm ${reference}'`,
    `cat ${reference} | sh`,
    `bash ${script} $(rm ${reference})`,
  ]) {
    expect(
      decidePermission({ kind: "execute", title: command, rawInput: { command } }, guard).allow,
    ).toBe(false);
  }
});

test("permitted home-relative skill reads use the same path as the guard", async () => {
  const layout = await fixture();
  const result = await readGuarded(
    { sessionId: "test", path: "~/paws/local skills/added/references/context.txt" },
    {
      worktree: layout.source,
      home: layout.root,
      pawsRoot: layout.pawsRoot,
      skillRoots: [join(layout.skillRoot, "added")],
    },
  );
  expect(result.content).toBe("Local reference\n");
});
