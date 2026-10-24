import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTarModes, type RunnerSkill } from "../runner-protocol";
import { createRunnerSkillInstaller } from "./skills";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const owner = { uid: process.getuid!(), gid: process.getgid!() };
const homeA = "agent-a";
const homeB = "agent-b";
const mode = (path: string) => statSync(path).mode & 0o7777;

async function bundle(
  name: string,
  version: string,
  body: string,
  agents = ["claude", "codex"],
  modes = new Map<string, number>(),
) {
  const tar = await new Bun.Archive({
    "SKILL.md": `---\nname: ${name}\n---\n${body}\n`,
    "scripts/run.sh": "echo hi\n",
  }).bytes();
  const bytes = Bun.gzipSync(withTarModes(tar, modes));
  const skill = {
    name,
    version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    agents,
  } as RunnerSkill;
  return { skill, bytes };
}

/** `homes` are the agent homes the installer serves; only `created` exist at the start. */
function setup(homes: string[] = [homeA, homeB], created: string[] = homes) {
  const root = mkdtempSync(join(tmpdir(), "paws-skills-"));
  roots.push(root);
  const base = join(root, "homes");
  for (const home of created) mkdirSync(join(base, home), { recursive: true });
  const served = new Map<string, Uint8Array>();
  const downloads: string[] = [];
  const errors: string[] = [];
  const state = join(root, "state");
  const open = () =>
    createRunnerSkillInstaller({
      root: state,
      homes: homes.map((home) => join(base, home)),
      owner,
      async download(skill) {
        downloads.push(`${skill.name}@${skill.version}`);
        const bytes = served.get(`${skill.name}@${skill.version}`);
        if (!bytes) throw new Error("not found");
        return bytes;
      },
      onError: (error) => errors.push(error.message),
    });
  const installer = open();
  const home = (id: string) => join(base, id);
  let peeks = 0;
  const skills = (agentHome: string) => {
    const execution = `peek-${++peeks}`;
    const set = installer.hold(agentHome, execution)!;
    installer.release(execution);
    return set;
  };
  return { installer, open, served, downloads, errors, home, skills, state };
}

describe("runner skill installer", () => {
  test("installs a new skill into every agent home with the agent owner", async () => {
    const { installer, served, home } = setup();
    const { skill, bytes } = await bundle("impeccable", "2.4.1", "v1");
    served.set("impeccable@2.4.1", bytes);
    await installer.sync([skill]);
    for (const base of [home(homeA), home(homeB)]) {
      const set = installer.hold(base, `run-${base}`)!;
      for (const folder of [".claude/skills", ".codex/skills"]) {
        expect(existsSync(join(base, folder, "impeccable"))).toBe(false);
        const dir = join(set, folder, "impeccable");
        expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("v1");
        for (const path of [dir, join(dir, "SKILL.md"), join(dir, "scripts", "run.sh")]) {
          const info = statSync(path);
          expect([info.uid, info.gid]).toEqual([owner.uid, owner.gid]);
        }
      }
      expect(existsSync(join(base, ".grok/skills/impeccable"))).toBe(false);
      expect(existsSync(join(set, ".grok"))).toBe(false);
    }
    expect(installer.installed()).toEqual([
      { name: "impeccable", version: "2.4.1", sha256: skill.sha256, status: "installed" },
    ]);
  });

  test("refuses and reports a bundle whose checksum does not match", async () => {
    const { installer, served, errors, downloads, home, skills } = setup();
    const good = await bundle("impeccable", "2.4.1", "v1");
    served.set("impeccable@2.4.1", good.bytes);
    await installer.sync([good.skill]);
    const next = await bundle("impeccable", "2.5.0", "v2");
    served.set("impeccable@2.5.0", (await bundle("impeccable", "2.5.0", "tampered")).bytes);
    await installer.sync([next.skill]);
    expect(errors).toEqual(["Skill impeccable 2.5.0 failed its checksum and was not installed."]);
    expect(installer.installed()).toEqual([
      {
        name: "impeccable",
        version: "2.5.0",
        sha256: next.skill.sha256,
        status: "refused",
        error: "Skill impeccable 2.5.0 failed its checksum and was not installed.",
      },
    ]);
    const manifest = join(skills(home(homeA)), ".claude/skills/impeccable/SKILL.md");
    expect(readFileSync(manifest, "utf8")).toContain("v1");
    // A refused bundle is not fetched again on every heartbeat.
    await installer.sync([next.skill]);
    expect(downloads.filter((entry) => entry === "impeccable@2.5.0")).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  test("a home created after the sync gets the skills before its first run", async () => {
    const { installer, served, home, skills, downloads } = setup([homeA, homeB], [homeA]);
    const { skill, bytes } = await bundle("impeccable", "2.4.1", "v1");
    served.set("impeccable@2.4.1", bytes);
    await installer.sync([skill]);
    expect(existsSync(home(homeB))).toBe(false);
    mkdirSync(home(homeB));
    installer.prepareHome(home(homeB));
    expect(
      readFileSync(join(skills(home(homeB)), ".claude/skills/impeccable/SKILL.md"), "utf8"),
    ).toContain("v1");
    expect(downloads).toEqual(["impeccable@2.4.1"]);
  });

  test("deletes a skill removed in Paws and leaves skills Paws did not install", async () => {
    const { installer, served, home, skills } = setup();
    const { skill, bytes } = await bundle("impeccable", "2.4.1", "v1");
    served.set("impeccable@2.4.1", bytes);
    await installer.sync([skill]);
    mkdirSync(join(home(homeA), ".claude/skills/own"), { recursive: true });
    await installer.sync([]);
    for (const base of [home(homeA), home(homeB)])
      for (const folder of [".claude/skills", ".codex/skills"])
        expect(existsSync(join(skills(base), folder, "impeccable"))).toBe(false);
    expect(existsSync(join(home(homeA), ".claude/skills/own"))).toBe(true);
    expect(installer.installed()).toEqual([]);
  });

  test("drops an agent folder when the skill no longer applies to that agent", async () => {
    const { installer, served, home, skills } = setup([homeA]);
    const all = await bundle("impeccable", "2.4.1", "v1", ["claude", "codex", "grok"]);
    served.set("impeccable@2.4.1", all.bytes);
    await installer.sync([all.skill]);
    await installer.sync([{ ...all.skill, agents: ["claude"] }]);
    expect(existsSync(join(skills(home(homeA)), ".claude/skills/impeccable/SKILL.md"))).toBe(true);
    expect(existsSync(join(skills(home(homeA)), ".codex/skills/impeccable"))).toBe(false);
    expect(existsSync(join(home(homeA), ".grok/skills/impeccable"))).toBe(false);
  });

  test("a task that starts while another runs gets the new version for Claude and Codex", async () => {
    const { installer, served, home } = setup([homeA]);
    const first = await bundle("impeccable", "2.4.1", "v1");
    const second = await bundle("impeccable", "2.5.0", "v2");
    served.set("impeccable@2.4.1", first.bytes);
    served.set("impeccable@2.5.0", second.bytes);
    await installer.sync([first.skill]);
    installer.prepareHome(home(homeA));
    const running = installer.hold(home(homeA), "execution-1")!;
    const before = (folder: string) =>
      readFileSync(join(running, folder, "impeccable/SKILL.md"), "utf8");
    await installer.sync([second.skill]);
    installer.prepareHome(home(homeA));
    const started = installer.hold(home(homeA), "execution-2")!;
    expect(started).not.toBe(running);
    for (const folder of [".claude/skills", ".codex/skills"]) {
      expect(before(folder)).toContain("v1");
      expect(readFileSync(join(started, folder, "impeccable/SKILL.md"), "utf8")).toContain("v2");
    }
    expect(installer.installed()).toEqual([
      { name: "impeccable", version: "2.5.0", sha256: second.skill.sha256, status: "installed" },
    ]);
    expect(installer.hold(home(homeA), "execution-1")).toBe(running);
    installer.release("execution-1");
    installer.prepareHome(home(homeA));
    expect(existsSync(running)).toBe(false);
    expect(existsSync(join(started, ".claude/skills/impeccable/SKILL.md"))).toBe(true);
  });

  test("moves skills Paws put in the shared Claude and Codex folders into the versioned folder", async () => {
    const { open, served, home, state } = setup([homeA]);
    const { skill, bytes } = await bundle("impeccable", "2.4.1", "v1");
    served.set("impeccable@2.4.1", bytes);
    await open().sync([skill]);
    for (const folder of [".claude/skills", ".codex/skills"]) {
      mkdirSync(join(home(homeA), folder, "impeccable"), { recursive: true });
      writeFileSync(join(home(homeA), folder, "impeccable/SKILL.md"), "old");
    }
    const saved = JSON.parse(readFileSync(join(state, "state.json"), "utf8"));
    saved.homes[home(homeA)].impeccable.agents = ["claude", "codex"];
    writeFileSync(join(state, "state.json"), JSON.stringify(saved));
    const installer = open();
    await installer.sync([skill]);
    for (const folder of [".claude/skills", ".codex/skills"])
      expect(existsSync(join(home(homeA), folder, "impeccable"))).toBe(false);
    const set = installer.hold(home(homeA), "execution-1")!;
    expect(readFileSync(join(set, ".claude/skills/impeccable/SKILL.md"), "utf8")).toContain("v1");
  });

  test("a Grok run in progress keeps its version through an update, and the next run gets the new one", async () => {
    const { installer, served, home } = setup();
    const first = await bundle("impeccable", "2.4.1", "v1", ["grok"]);
    const second = await bundle("impeccable", "2.5.0", "v2", ["grok"]);
    served.set("impeccable@2.4.1", first.bytes);
    served.set("impeccable@2.5.0", second.bytes);
    await installer.sync([first.skill]);
    installer.prepareHome(home(homeA));
    installer.hold(home(homeA), "execution-1");
    await installer.sync([second.skill]);
    const skill = (id: string) =>
      readFileSync(join(home(id), ".grok/skills/impeccable/SKILL.md"), "utf8");
    expect(skill(homeA)).toContain("v1");
    expect(skill(homeB)).toContain("v2");
    expect(installer.installed()[0]).toMatchObject({ version: "2.5.0", status: "pending" });
    // A resumed worker for the same run is admitted again and stays on its version.
    installer.prepareHome(home(homeA));
    expect(skill(homeA)).toContain("v1");
    installer.release("execution-1");
    installer.prepareHome(home(homeA));
    expect(skill(homeA)).toContain("v2");
    expect(installer.installed()[0]).toMatchObject({ version: "2.5.0", status: "installed" });
  });

  test("reports how many running Grok tasks hold a home on the earlier version", async () => {
    const { installer, served, home } = setup([homeA]);
    const first = await bundle("impeccable", "2.4.1", "v1", ["grok"]);
    const second = await bundle("impeccable", "2.5.0", "v2", ["grok"]);
    served.set("impeccable@2.4.1", first.bytes);
    served.set("impeccable@2.5.0", second.bytes);
    await installer.sync([first.skill]);
    installer.hold(home(homeA), "execution-1");
    installer.hold(home(homeA), "execution-2");
    await installer.sync([second.skill]);
    expect(installer.installed() as unknown[]).toEqual([
      {
        name: "impeccable",
        version: "2.5.0",
        sha256: second.skill.sha256,
        status: "pending",
        waiting: 2,
      },
    ]);
    installer.release("execution-1");
    expect(installer.installed()[0]).toMatchObject({ status: "pending", waiting: 1 });
    installer.release("execution-2");
    installer.prepareHome(home(homeA));
    expect(installer.installed()[0]).not.toHaveProperty("waiting");
  });

  test("refuses a bundle with a path outside the skill folder", async () => {
    const { installer, served, errors } = setup([homeA]);
    const bytes = await new Bun.Archive(
      { "SKILL.md": "x", "../escape.txt": "x" },
      { compress: "gzip" },
    ).bytes();
    const skill: RunnerSkill = {
      name: "escape",
      version: "1.0.0",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      agents: ["claude"],
    };
    served.set("escape@1.0.0", bytes);
    await installer.sync([skill]);
    expect(installer.installed()[0]).toMatchObject({
      status: "refused",
      error: "Skill escape has a file outside its folder.",
    });
    expect(errors).toEqual(["Skill escape has a file outside its folder."]);
  });

  test("keeps a script executable and every other file private, in bundles and the agent home", async () => {
    const { installer, served, home, skills, state } = setup([homeA]);
    const { skill, bytes } = await bundle(
      "impeccable",
      "2.4.1",
      "v1",
      ["claude", "grok"],
      new Map([["scripts/run.sh", 0o755]]),
    );
    served.set("impeccable@2.4.1", bytes);
    await installer.sync([skill]);
    const unpacked = readdirSync(join(state, "bundles")).map((entry) =>
      join(state, "bundles", entry),
    );
    expect(unpacked).toHaveLength(1);
    for (const dir of [
      ...unpacked,
      join(home(homeA), ".grok/skills/impeccable"),
      join(skills(home(homeA)), ".claude/skills/impeccable"),
    ]) {
      expect(mode(join(dir, "scripts/run.sh"))).toBe(0o700);
      expect(mode(join(dir, "SKILL.md"))).toBe(0o600);
    }
  });

  test("drops group, world, setuid and setgid bits", async () => {
    const { installer, served, home } = setup([homeA]);
    const { skill, bytes } = await bundle(
      "impeccable",
      "2.4.1",
      "v1",
      ["grok"],
      new Map([
        ["scripts/run.sh", 0o6777],
        ["SKILL.md", 0o6666],
      ]),
    );
    served.set("impeccable@2.4.1", bytes);
    await installer.sync([skill]);
    const dir = join(home(homeA), ".grok/skills/impeccable");
    expect(mode(join(dir, "scripts/run.sh"))).toBe(0o700);
    expect(mode(join(dir, "SKILL.md"))).toBe(0o600);
  });

  test("an install that lost a script's executable bit is fixed on the next sync", async () => {
    const { open, served, home, state } = setup([homeA]);
    const { skill, bytes } = await bundle(
      "impeccable",
      "2.4.1",
      "v1",
      ["grok"],
      new Map([["scripts/run.sh", 0o755]]),
    );
    served.set("impeccable@2.4.1", bytes);
    const installed = join(home(homeA), ".grok/skills/impeccable");
    for (const dir of [join(state, "bundles", skill.sha256), installed]) {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: impeccable\n---\nv1\n");
      writeFileSync(join(dir, "scripts/run.sh"), "echo hi\n");
      chmodSync(join(dir, "scripts/run.sh"), 0o600);
    }
    writeFileSync(
      join(state, "state.json"),
      JSON.stringify({
        desired: [skill],
        refused: [],
        homes: {
          [home(homeA)]: {
            impeccable: { version: skill.version, sha256: skill.sha256, agents: skill.agents },
          },
        },
      }),
    );
    await open().sync([skill]);
    expect(mode(join(installed, "scripts/run.sh"))).toBe(0o700);
  });
});
