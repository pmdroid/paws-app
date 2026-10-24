import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerSkill } from "../runner-protocol";
import { createRunnerSkillInstaller } from "./skills";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const owner = { uid: process.getuid!(), gid: process.getgid!() };
const homeA = "agent-a";
const homeB = "agent-b";

async function bundle(name: string, version: string, body: string, agents = ["claude", "codex"]) {
  const bytes = await new Bun.Archive(
    { "SKILL.md": `---\nname: ${name}\n---\n${body}\n`, "scripts/run.sh": "echo hi\n" },
    { compress: "gzip" },
  ).bytes();
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
  const installer = createRunnerSkillInstaller({
    root: join(root, "state"),
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
  const home = (id: string) => join(base, id);
  return { installer, served, downloads, errors, home };
}

describe("runner skill installer", () => {
  test("installs a new skill into every agent home with the agent owner", async () => {
    const { installer, served, home } = setup();
    const { skill, bytes } = await bundle("impeccable", "2.4.1", "v1");
    served.set("impeccable@2.4.1", bytes);
    await installer.sync([skill]);
    for (const base of [home(homeA), home(homeB)]) {
      for (const folder of [".claude/skills", ".codex/skills"]) {
        const dir = join(base, folder, "impeccable");
        expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("v1");
        for (const path of [dir, join(dir, "SKILL.md"), join(dir, "scripts", "run.sh")]) {
          const info = statSync(path);
          expect([info.uid, info.gid]).toEqual([owner.uid, owner.gid]);
        }
      }
      expect(existsSync(join(base, ".grok/skills/impeccable"))).toBe(false);
      expect(existsSync(join(base, ".paws-skills"))).toBe(true);
    }
    expect(installer.installed()).toEqual([
      { name: "impeccable", version: "2.4.1", sha256: skill.sha256, status: "installed" },
    ]);
  });

  test("refuses and reports a bundle whose checksum does not match", async () => {
    const { installer, served, errors, downloads, home } = setup();
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
    const manifest = join(home(homeA), ".claude/skills/impeccable/SKILL.md");
    expect(readFileSync(manifest, "utf8")).toContain("v1");
    // A refused bundle is not fetched again on every heartbeat.
    await installer.sync([next.skill]);
    expect(downloads.filter((entry) => entry === "impeccable@2.5.0")).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  test("a home created after the sync gets the skills before its first run", async () => {
    const { installer, served, home, downloads } = setup([homeA, homeB], [homeA]);
    const { skill, bytes } = await bundle("impeccable", "2.4.1", "v1");
    served.set("impeccable@2.4.1", bytes);
    await installer.sync([skill]);
    expect(existsSync(home(homeB))).toBe(false);
    mkdirSync(home(homeB));
    installer.prepareHome(home(homeB));
    expect(readFileSync(join(home(homeB), ".claude/skills/impeccable/SKILL.md"), "utf8")).toContain(
      "v1",
    );
    expect(downloads).toEqual(["impeccable@2.4.1"]);
  });

  test("deletes a skill removed in Paws and leaves skills Paws did not install", async () => {
    const { installer, served, home } = setup();
    const { skill, bytes } = await bundle("impeccable", "2.4.1", "v1");
    served.set("impeccable@2.4.1", bytes);
    await installer.sync([skill]);
    mkdirSync(join(home(homeA), ".claude/skills/own"), { recursive: true });
    await installer.sync([]);
    for (const base of [home(homeA), home(homeB)])
      for (const folder of [".claude/skills", ".codex/skills"])
        expect(existsSync(join(base, folder, "impeccable"))).toBe(false);
    expect(existsSync(join(home(homeA), ".claude/skills/own"))).toBe(true);
    expect(installer.installed()).toEqual([]);
  });

  test("drops an agent folder when the skill no longer applies to that agent", async () => {
    const { installer, served, home } = setup([homeA]);
    const both = await bundle("impeccable", "2.4.1", "v1");
    served.set("impeccable@2.4.1", both.bytes);
    await installer.sync([both.skill]);
    await installer.sync([{ ...both.skill, agents: ["claude"] }]);
    expect(existsSync(join(home(homeA), ".claude/skills/impeccable/SKILL.md"))).toBe(true);
    expect(existsSync(join(home(homeA), ".codex/skills/impeccable"))).toBe(false);
  });

  test("a run in progress keeps its version through an update, and the next run gets the new one", async () => {
    const { installer, served, home } = setup();
    const first = await bundle("impeccable", "2.4.1", "v1");
    const second = await bundle("impeccable", "2.5.0", "v2");
    served.set("impeccable@2.4.1", first.bytes);
    served.set("impeccable@2.5.0", second.bytes);
    await installer.sync([first.skill]);
    installer.prepareHome(home(homeA));
    installer.hold(home(homeA), "execution-1");
    await installer.sync([second.skill]);
    const skill = (id: string) =>
      readFileSync(join(home(id), ".claude/skills/impeccable/SKILL.md"), "utf8");
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

  test("reports how many running tasks hold a home on the earlier version", async () => {
    const { installer, served, home } = setup([homeA]);
    const first = await bundle("impeccable", "2.4.1", "v1");
    const second = await bundle("impeccable", "2.5.0", "v2");
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
});
