import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  getSkill,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordRunnerSkills,
  syncWorkspaceMember,
} from "../src/db";
import { handleSkillSettingsRequest, type SkillSettingsOptions } from "../src/settings";
import {
  addSkill,
  addSkills,
  createSkillResolver,
  createSkillUpdates,
  fakeSkillResolver,
  findSkills,
  readSkillSource,
  removeSkill,
  SKILL_BUNDLE_FILE,
  skillFolders,
  updateSkill,
  type SkillRegistry,
} from "../src/skills";

const SKILL = "---\nname: impeccable\ndescription: Design polish\n---\nUse care.\n";

let root: string;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paws-skills-"));
  db = openDatabase(join(root, "paws.db"));
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function tarball(files: Record<string, string>): Promise<Uint8Array> {
  const entries = Object.fromEntries(
    Object.entries(files).map(([path, text]) => [`package/${path}`, text]),
  );
  return new Bun.Archive(entries, { compress: "gzip" }).bytes();
}

/** A registry that serves `impeccable` at the given versions, the last one tagged latest. */
function npmRegistry(releases: Record<string, Uint8Array>) {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://registry.test/impeccable") {
      const versions = Object.fromEntries(
        Object.entries(releases).map(([version, bytes]) => [
          version,
          {
            dist: {
              tarball: `https://registry.test/impeccable/-/impeccable-${version}.tgz`,
              integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
            },
          },
        ]),
      );
      return Response.json({
        "dist-tags": { latest: Object.keys(releases).at(-1) },
        versions,
      });
    }
    const version = /impeccable-(.+)\.tgz$/.exec(url)?.[1];
    if (version && releases[version]) return new Response(releases[version]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function registry(resolver: SkillRegistry["resolver"], patch: Partial<SkillRegistry> = {}) {
  return { db, root: join(root, "skills"), resolver, now: 1, ...patch };
}

async function bundleFiles(path: string): Promise<Record<string, string>> {
  const files = await new Bun.Archive(readFileSync(path)).files();
  return Object.fromEntries(
    await Promise.all([...files].map(async ([name, file]) => [name, await file.text()] as const)),
  );
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function skillFiles(paths: Record<string, string>) {
  return new Map(
    Object.entries(paths).map(([path, text]) => [path, new TextEncoder().encode(text)]),
  );
}

function manifest(name: string) {
  return `---\nname: ${name}\ndescription: About ${name}\n---\nBody.\n`;
}

function impeccableRepo(): string {
  const repo = join(root, "impeccable");
  const write = (path: string, text: string) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  for (const folder of [".claude", ".agents", ".agent", ".cursor", "plugin"])
    write(`${folder}/skills/impeccable/SKILL.md`, SKILL);
  write(".claude/skills/impeccable/scripts/impeccable", "echo hook\n");
  write("tests/oracle/workspaces/ctx-pin/.claude/skills/audit/SKILL.md", manifest("audit"));
  write(".claude-plugin/plugin.json", JSON.stringify({ skills: "./.claude/skills/" }));
  write(
    ".claude-plugin/marketplace.json",
    JSON.stringify({ plugins: [{ name: "impeccable", source: "./plugin" }] }),
  );
  write(".claude/settings.json", "{}");
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "Add impeccable");
  return repo;
}

const paths = (found: { path: string }[]) => found.map((skill) => skill.path);

describe("finding skills in a repository", () => {
  test("finds a SKILL.md at the root and under each usual skills folder", () => {
    expect(skillFolders(skillFiles({ "SKILL.md": manifest("solo") }), "repo")).toEqual([
      { path: "", name: "solo", description: "About solo" },
    ]);
    const found = skillFolders(
      skillFiles({
        "skills/a/SKILL.md": manifest("a"),
        ".claude/skills/b/SKILL.md": manifest("b"),
        ".agents/skills/c/SKILL.md": manifest("c"),
        ".codex/skills/d/SKILL.md": manifest("d"),
        "docs/e/SKILL.md": manifest("e"),
        "README.md": "Not a skill.",
      }),
      "repo",
    );
    expect(found).toEqual([
      { path: "skills/a", name: "a", description: "About a" },
      { path: ".claude/skills/b", name: "b", description: "About b" },
      { path: ".agents/skills/c", name: "c", description: "About c" },
      { path: ".codex/skills/d", name: "d", description: "About d" },
    ]);
  });

  test("reads the skill paths declared in the plugin manifests", () => {
    const found = skillFolders(
      skillFiles({
        ".claude-plugin/plugin.json": JSON.stringify({ skills: ["./custom/"] }),
        ".claude-plugin/marketplace.json": JSON.stringify({
          plugins: [
            { name: "tools", source: "./plugins/tools", skills: "./extra" },
            { name: "docs", source: "./", skills: ["./documents/pdf"] },
            { name: "remote", source: { source: "github", repo: "o/r" } },
          ],
        }),
        "custom/x/SKILL.md": manifest("x"),
        "plugins/tools/extra/y/SKILL.md": manifest("y"),
        "documents/pdf/SKILL.md": manifest("pdf"),
      }),
      "repo",
    );
    expect(paths(found)).toEqual(["custom/x", "plugins/tools/extra/y", "documents/pdf"]);
    expect(skillFolders(skillFiles({ ".claude-plugin/plugin.json": "{not json" }), "repo")).toEqual(
      [],
    );
  });

  test("a SKILL.md higher up hides the ones nested below it", () => {
    const nested = skillFiles({
      "skills/a/SKILL.md": manifest("a"),
      "skills/a/examples/inner/SKILL.md": manifest("inner"),
    });
    expect(paths(skillFolders(nested, "repo"))).toEqual(["skills/a"]);
    const top = skillFiles({ "SKILL.md": manifest("top"), "skills/a/SKILL.md": manifest("a") });
    expect(paths(skillFolders(top, "repo"))).toEqual([""]);
  });

  test("looks at most three folder levels below each location", () => {
    const deep = skillFiles({
      "skills/one/two/three/SKILL.md": manifest("deep"),
      ".claude/skills/one/two/three/four/SKILL.md": manifest("deeper"),
    });
    expect(paths(skillFolders(deep, "repo"))).toEqual(["skills/one/two/three"]);
  });

  test("the first location wins when two folders hold a skill of the same name", () => {
    const twice = skillFiles({
      ".agents/skills/x/SKILL.md": manifest("same"),
      ".claude/skills/y/SKILL.md": manifest("same"),
    });
    expect(paths(skillFolders(twice, "repo"))).toEqual([".claude/skills/y"]);
  });

  test("names a skill after its folder when SKILL.md does not, and reads quoted and folded descriptions", () => {
    expect(
      skillFolders(
        skillFiles({
          "skills/review/SKILL.md": '---\ndescription: "Reviews: carefully"\n---\n',
          "skills/notes/SKILL.md": "---\nname: notes\ndescription: >\n  Takes\n  notes\n---\n",
        }),
        "repo",
      ),
    ).toEqual([
      { path: "skills/notes", name: "notes", description: "Takes notes" },
      { path: "skills/review", name: "review", description: "Reviews: carefully" },
    ]);
    expect(skillFolders(skillFiles({ "SKILL.md": "No front matter." }), "repo")).toEqual([
      { path: "", name: "repo", description: "" },
    ]);
  });

  test("the impeccable repository lists impeccable from .claude/skills/impeccable", async () => {
    const found = await findSkills(registry(createSkillResolver()), {
      kind: "git",
      url: impeccableRepo(),
    });
    expect(found).toEqual([
      {
        path: ".claude/skills/impeccable",
        name: "impeccable",
        description: "Design polish",
        added: false,
      },
    ]);
  });

  test("one repository adds several skills in one step, each pinned to its folder", async () => {
    const repo = join(root, "many");
    for (const name of ["lint", "review"]) {
      mkdirSync(join(repo, "skills", name), { recursive: true });
      writeFileSync(join(repo, "skills", name, "SKILL.md"), manifest(name));
    }
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "Add skills");
    const commit = git(repo, "rev-parse", "HEAD");
    const pins = registry(createSkillResolver());

    const added = await addSkills(
      pins,
      { kind: "git", url: repo },
      ["skills/lint", "skills/review"],
      { agents: ["claude"] },
    );

    expect(added).toMatchObject([
      {
        name: "lint",
        version: commit,
        source: { kind: "git", url: repo, subfolder: "skills/lint" },
      },
      {
        name: "review",
        version: commit,
        source: { kind: "git", url: repo, subfolder: "skills/review" },
      },
    ]);
    const bundle = join(root, "skills", "review", commit, SKILL_BUNDLE_FILE);
    expect(await bundleFiles(bundle)).toEqual({ "SKILL.md": manifest("review") });
    expect(await findSkills(pins, { kind: "git", url: repo })).toMatchObject([
      { name: "lint", added: true },
      { name: "review", added: true },
    ]);
    expect(addSkills(pins, { kind: "git", url: repo }, ["../outside"])).rejects.toThrow(
      "relative path",
    );
  });
});

describe("skill source text", () => {
  test("reads every common git form and fills the ref and subfolder from the URL", () => {
    expect(readSkillSource("pbakaus/impeccable")).toEqual({
      kind: "git",
      url: "https://github.com/pbakaus/impeccable",
    });
    expect(readSkillSource("https://github.com/pbakaus/impeccable")).toEqual({
      kind: "git",
      url: "https://github.com/pbakaus/impeccable",
    });
    expect(readSkillSource("https://github.com/pbakaus/impeccable.git")).toEqual({
      kind: "git",
      url: "https://github.com/pbakaus/impeccable.git",
    });
    expect(readSkillSource("https://github.com/pbakaus/impeccable/")).toEqual({
      kind: "git",
      url: "https://github.com/pbakaus/impeccable",
    });
    expect(
      readSkillSource("https://github.com/pbakaus/impeccable/tree/main/.claude/skills/impeccable/"),
    ).toEqual({
      kind: "git",
      url: "https://github.com/pbakaus/impeccable",
      path: "main/.claude/skills/impeccable",
    });
    expect(
      readSkillSource(
        "https://github.com/pbakaus/impeccable/blob/main/.claude/skills/impeccable/SKILL.md",
      ),
    ).toEqual({
      kind: "git",
      url: "https://github.com/pbakaus/impeccable",
      path: "main/.claude/skills/impeccable",
    });
    expect(readSkillSource("github.com/pmdroid/skills/tree/release/1.2/skills/x")).toEqual({
      kind: "git",
      url: "https://github.com/pmdroid/skills",
      path: "release/1.2/skills/x",
    });
    expect(readSkillSource("git@github.com:pmdroid/skills.git")).toEqual({
      kind: "git",
      url: "git@github.com:pmdroid/skills.git",
    });
    expect(readSkillSource("ssh://git@example.test/skills.git")).toEqual({
      kind: "git",
      url: "ssh://git@example.test/skills.git",
    });
  });

  test("npm packages keep working and a bare owner/repo is GitHub unless it says npm:", () => {
    expect(readSkillSource("impeccable")).toEqual({ kind: "npm", package: "impeccable" });
    expect(readSkillSource("@acme/skill@1.2.3")).toEqual({
      kind: "npm",
      package: "@acme/skill",
      version: "1.2.3",
    });
    expect(readSkillSource("npm:impeccable@2.4.1")).toEqual({
      kind: "npm",
      package: "impeccable",
      version: "2.4.1",
    });
    expect(() => readSkillSource("  ")).toThrow("Choose an npm package or a git URL.");
  });
});

describe("skill sources", () => {
  test("an npm package resolves to its exact latest version and a checksummed bundle", async () => {
    const npm = npmRegistry({
      "2.4.0": await tarball({ "SKILL.md": SKILL }),
      "2.4.1": await tarball({ "SKILL.md": SKILL, "reference/typography.md": "Use a scale." }),
    });
    const resolver = createSkillResolver({ fetch: npm.fetch, registry: "https://registry.test" });
    const skill = await addSkill(registry(resolver), { kind: "npm", package: "impeccable" });

    expect(skill).toMatchObject({
      name: "impeccable",
      version: "2.4.1",
      source: { kind: "npm", package: "impeccable" },
      agents: ["claude", "codex", "grok"],
      removedAt: null,
    });
    const bundle = join(root, "skills", "impeccable", "2.4.1", SKILL_BUNDLE_FILE);
    expect(skill.sha256).toBe(sha256(bundle));
    expect(skill.sizeBytes).toBe(readFileSync(bundle).byteLength);
    expect(await bundleFiles(bundle)).toEqual({
      "SKILL.md": SKILL,
      "reference/typography.md": "Use a scale.",
    });
  });

  test("an npm tarball that does not match its integrity is refused", async () => {
    const npm = npmRegistry({ "1.0.0": await tarball({ "SKILL.md": SKILL }) });
    const tampered = (async (input: string | URL | Request) =>
      String(input).endsWith(".tgz")
        ? new Response(await tarball({ "SKILL.md": "tampered" }))
        : npm.fetch(input)) as typeof fetch;
    const resolver = createSkillResolver({ fetch: tampered, registry: "https://registry.test" });
    expect(addSkill(registry(resolver), { kind: "npm", package: "impeccable" })).rejects.toThrow(
      "does not match its npm checksum",
    );
    expect(getSkill(db, "impeccable")).toBeNull();
  });

  test("a git URL with a ref and subfolder resolves to the commit", async () => {
    const repo = join(root, "skills-repo");
    mkdirSync(join(repo, "skills", "review-paws"), { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(repo, "skills", "review-paws", "SKILL.md"), "---\nname: review-paws\n---\n");
    writeFileSync(join(repo, "README.md"), "Not part of the skill.");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "Add review-paws");
    git(repo, "tag", "-a", "v1", "-m", "v1");
    const commit = git(repo, "rev-parse", "HEAD");
    writeFileSync(
      join(repo, "skills", "review-paws", "SKILL.md"),
      "---\nname: review-paws\n---\nv2",
    );
    git(repo, "commit", "--quiet", "-am", "Change review-paws");

    const pins = registry(createSkillResolver());
    const skill = await addSkill(
      pins,
      { kind: "git", url: repo, ref: "v1", subfolder: "skills/review-paws" },
      { agents: ["claude"] },
    );

    expect(skill).toMatchObject({
      name: "review-paws",
      version: commit,
      source: { kind: "git", url: repo, ref: "v1", subfolder: "skills/review-paws" },
      agents: ["claude"],
    });
    const bundle = join(root, "skills", "review-paws", commit, SKILL_BUNDLE_FILE);
    expect(skill.sha256).toBe(sha256(bundle));
    expect(await bundleFiles(bundle)).toEqual({ "SKILL.md": "---\nname: review-paws\n---\n" });
  });

  test("a ref with a slash in a tree URL resolves against the repository's refs", async () => {
    const repo = join(root, "release-repo");
    mkdirSync(join(repo, "skills", "x"), { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(repo, "README.md"), "main");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "Start");
    git(repo, "checkout", "--quiet", "-b", "release/1.2");
    writeFileSync(join(repo, "skills", "x", "SKILL.md"), "---\nname: x\n---\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "Add x");
    const commit = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "--quiet", "main");

    const skill = await addSkill(
      registry(createSkillResolver()),
      { kind: "git", url: repo, path: "release/1.2/skills/x" },
      { agents: ["claude"] },
    );

    expect(skill).toMatchObject({
      name: "x",
      version: commit,
      source: { kind: "git", url: repo, ref: "release/1.2", subfolder: "skills/x" },
    });
  });

  test("only the subfolder of a git source counts toward the limit", async () => {
    const repo = join(root, "large-repo");
    mkdirSync(join(repo, "skills", "review-paws"), { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(repo, "skills", "review-paws", "SKILL.md"), "---\nname: review-paws\n---\n");
    writeFileSync(join(repo, "site.bin"), "x".repeat(4096));
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "Add review-paws next to a large site");

    const pins = registry(createSkillResolver({ limit: 2048 }), { limit: 2048 });
    const skill = await addSkill(
      pins,
      { kind: "git", url: repo, subfolder: "skills/review-paws" },
      { agents: ["claude"] },
    );
    expect(skill.name).toBe("review-paws");

    mkdirSync(join(repo, "skills", "large-paws"));
    writeFileSync(join(repo, "skills", "large-paws", "SKILL.md"), "---\nname: large-paws\n---\n");
    writeFileSync(join(repo, "skills", "large-paws", "big.txt"), "x".repeat(4096));
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "Add large-paws");
    const refused = addSkill(
      pins,
      { kind: "git", url: repo, subfolder: "skills/large-paws" },
      { agents: ["claude"] },
    );
    expect(refused).rejects.toThrow("bundle limit");
  });

  test("a source without SKILL.md is refused", async () => {
    const npm = npmRegistry({ "1.0.0": await tarball({ "README.md": "No skill here." }) });
    const resolver = createSkillResolver({ fetch: npm.fetch, registry: "https://registry.test" });
    expect(addSkill(registry(resolver), { kind: "npm", package: "impeccable" })).rejects.toThrow(
      "no SKILL.md",
    );
    expect(getSkill(db, "impeccable")).toBeNull();
    expect(existsSync(join(root, "skills", "impeccable"))).toBe(false);
  });

  test("a bundle over the limit is refused", async () => {
    const npm = npmRegistry({
      "1.0.0": await tarball({ "SKILL.md": SKILL, "big.txt": "x".repeat(4096) }),
    });
    const resolver = createSkillResolver({ fetch: npm.fetch, registry: "https://registry.test" });
    const refused = addSkill(registry(resolver, { limit: 2048 }), {
      kind: "npm",
      package: "impeccable",
    });
    expect(refused).rejects.toThrow("bundle limit");
    expect(refused).rejects.toMatchObject({ status: 413 });
    expect(getSkill(db, "impeccable")).toBeNull();
  });
});

describe("skill pins", () => {
  test("Update resolves the newest version and replaces the pin", async () => {
    const releases: Record<string, Uint8Array> = { "2.4.0": await tarball({ "SKILL.md": SKILL }) };
    const npm = npmRegistry(releases);
    const resolver = createSkillResolver({ fetch: npm.fetch, registry: "https://registry.test" });
    const first = await addSkill(registry(resolver), { kind: "npm", package: "impeccable" });
    expect(first.version).toBe("2.4.0");

    // Nothing moves on its own: a newer release only lands through Update.
    releases["2.5.0"] = await tarball({ "SKILL.md": `${SKILL}\nNew rules.` });
    expect(getSkill(db, "impeccable")!.version).toBe("2.4.0");
    const { before, after } = await updateSkill(registry(resolver, { now: 2 }), "impeccable");

    expect(before.version).toBe("2.4.0");
    expect(after).toMatchObject({ version: "2.5.0", createdAt: 1, updatedAt: 2 });
    expect(after.sha256).not.toBe(first.sha256);
    expect(getSkill(db, "impeccable")).toEqual(after);
    expect(existsSync(join(root, "skills", "impeccable", "2.5.0", SKILL_BUNDLE_FILE))).toBe(true);
    expect(existsSync(join(root, "skills", "impeccable", "2.4.0"))).toBe(false);

    const again = await updateSkill(registry(resolver, { now: 3 }), "impeccable");
    expect(again.after).toEqual(after);
  });

  test("removing a skill marks it for removal on the runners", async () => {
    await addSkill(registry(fakeSkillResolver()), { kind: "npm", package: "impeccable" });
    const removed = removeSkill({ db, now: 5 }, "fake");
    expect(removed.removedAt).toBe(5);
    expect(() => removeSkill({ db, now: 6 }, "fake")).toThrow("No skill named fake");
  });

  test("a removed skill is forgotten once no runner reports it", async () => {
    await addSkill(registry(fakeSkillResolver()), { kind: "npm", package: "impeccable" });
    const userId = putWorkspaceUser(db, {
      id: "user-1",
      linearUserId: "user-linear",
      name: "Owner",
      email: "owner@example.invalid",
    });
    db.run("INSERT INTO workspace VALUES('ws-1','org-1','Workspace',1)");
    syncWorkspaceMember(db, {
      workspaceId: "ws-1",
      userId,
      role: "owner",
      active: true,
      teamIds: [],
      now: 1,
    });
    for (const id of ["runner-1", "runner-2"])
      db.run(
        "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,'ws-1',?,?,'active',1,1)",
        [id, userId, id],
      );
    const installed = [
      { name: "fake", version: "1.0.0", sha256: "a", status: "installed" as const },
    ];
    recordRunnerSkills(db, "runner-1", installed, 2);
    recordRunnerSkills(db, "runner-2", installed, 2);
    removeSkill({ db, now: 5 }, "fake");
    recordRunnerSkills(db, "runner-1", [], 6);
    expect(getSkill(db, "fake")?.removedAt).toBe(5);
    recordRunnerSkills(db, "runner-2", [], 7);
    expect(getSkill(db, "fake")).toBeNull();
  });
});

type Listing = {
  found?: { path: string; name: string; description: string; added: boolean }[];
  skills: { name: string; version: string; agents: string[]; removedAt: number | null }[];
  updates?: Record<string, string>;
  notice?: string;
  error?: string;
};

describe("skill settings API", () => {
  const audit: [string, string][] = [];
  const options = (patch: Partial<SkillSettingsOptions> = {}): SkillSettingsOptions => ({
    db,
    root: join(root, "skills"),
    resolver: fakeSkillResolver(),
    csrfToken: "csrf",
    audit: (action, subject) => audit.push([action, subject]),
    now: () => 10,
    ...patch,
  });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("http://127.0.0.1:8787/api/settings/skills", {
      method: "POST",
      headers: { "content-type": "application/json", "x-paws-csrf": "csrf", ...headers },
      body: JSON.stringify(body),
    });
  const read = async (response: Response | null) => (await response!.json()) as Listing;

  beforeEach(() => {
    audit.length = 0;
  });

  test("members and observers can neither read nor change skills", async () => {
    for (const role of ["member", "observer"]) {
      const list = await handleSkillSettingsRequest(
        new Request("http://127.0.0.1:8787/api/settings/skills"),
        options({ role }),
      );
      const add = await handleSkillSettingsRequest(
        post({ action: "add", source: { kind: "npm", package: "impeccable" } }),
        options({ role }),
      );
      expect([list!.status, add!.status]).toEqual([403, 403]);
    }
    expect(audit).toEqual([]);
  });

  test("owners and admins add, update, re-scope and remove, and each change is audited", async () => {
    const shared = options({ role: "admin" });
    const add = await handleSkillSettingsRequest(
      post({ action: "add", source: { kind: "npm", package: "impeccable" }, name: "impeccable" }),
      shared,
    );
    expect(add!.status).toBe(200);
    expect((await read(add)).skills).toMatchObject([{ name: "impeccable", version: "1.0.0" }]);
    const owner = { ...shared, role: "owner" };
    const update = await read(
      await handleSkillSettingsRequest(post({ action: "update", name: "impeccable" }), owner),
    );
    expect(update.skills[0]!.version).toBe("1.1.0");
    const agents = await read(
      await handleSkillSettingsRequest(
        post({ action: "agents", name: "impeccable", agents: ["codex", "claude"] }),
        shared,
      ),
    );
    expect(agents.skills[0]!.agents).toEqual(["claude", "codex"]);
    const removed = await read(
      await handleSkillSettingsRequest(post({ action: "remove", name: "impeccable" }), owner),
    );
    expect(removed.skills[0]!.removedAt).toBe(10);
    expect(audit).toEqual([
      [
        "settings.skill.add",
        "Added skill impeccable 1.0.0 from npm impeccable for Claude, Codex, Grok",
      ],
      ["settings.skill.update", "Updated skill impeccable 1.0.0 → 1.1.0"],
      ["settings.skill.agents", "Skill impeccable now applies to Claude, Codex"],
      ["settings.skill.remove", "Removed skill impeccable 1.1.0"],
    ]);
  });

  test("opening the section checks git refs; changes reuse the last check", async () => {
    const checked: string[] = [];
    const updates = createSkillUpdates({
      latest: async (url) => {
        checked.push(url);
        return "f".repeat(40);
      },
    });
    const shared = options({ updates });
    await handleSkillSettingsRequest(
      post({
        action: "add",
        source: { kind: "git", url: "https://github.com/pmdroid/review.git" },
      }),
      shared,
    );
    expect(checked).toEqual([]);
    const opened = await read(
      await handleSkillSettingsRequest(
        new Request("http://127.0.0.1:8787/api/settings/skills"),
        shared,
      ),
    );
    expect(checked).toEqual(["https://github.com/pmdroid/review.git"]);
    expect(opened.updates).toEqual({ fake: "f".repeat(40) });
    const updated = await read(
      await handleSkillSettingsRequest(post({ action: "update", name: "fake" }), shared),
    );
    expect(checked).toHaveLength(1);
    expect(updated.updates).toEqual({ fake: "f".repeat(40) });
  });

  test("the API reads a GitHub tree URL with no other input", async () => {
    const listing = await read(
      await handleSkillSettingsRequest(
        post({
          action: "add",
          source: "https://github.com/pbakaus/impeccable/tree/main/.claude/skills/impeccable",
        }),
        options(),
      ),
    );
    expect(listing.error).toBeUndefined();
    expect(getSkill(db, "fake")!.source).toEqual({
      kind: "git",
      url: "https://github.com/pbakaus/impeccable",
      ref: "main",
      subfolder: ".claude/skills/impeccable",
    });
  });

  test("the API reads git forms in the url field and an owner's ref or subfolder wins", async () => {
    const resolver = fakeSkillResolver();
    const add = (source: unknown) =>
      handleSkillSettingsRequest(post({ action: "add", source }), options({ resolver }));
    await add({ kind: "git", url: "pbakaus/impeccable" });
    await add({
      kind: "git",
      url: "https://github.com/pbakaus/impeccable/tree/main/.claude/skills/impeccable",
      ref: "v2",
      subfolder: "skills/impeccable",
    });
    expect(resolver.calls).toEqual([
      { kind: "git", url: "https://github.com/pbakaus/impeccable" },
      {
        kind: "git",
        url: "https://github.com/pbakaus/impeccable",
        ref: "v2",
        subfolder: "skills/impeccable",
      },
    ]);
  });

  test("the API finds the skills in a repository and adds the chosen ones", async () => {
    const resolver = fakeSkillResolver(() =>
      skillFiles({
        "skills/lint/SKILL.md": manifest("lint"),
        "skills/review/SKILL.md": manifest("review"),
      }),
    );
    const source = { kind: "git", url: "pbakaus/impeccable" };
    const found = await read(
      await handleSkillSettingsRequest(post({ action: "find", source }), options({ resolver })),
    );
    expect(found.found).toEqual([
      { path: "skills/lint", name: "lint", description: "About lint", added: false },
      { path: "skills/review", name: "review", description: "About review", added: false },
    ]);
    expect(getSkill(db, "lint")).toBeNull();

    const added = await read(
      await handleSkillSettingsRequest(
        post({ action: "add", source, paths: ["skills/lint", "skills/review"], agents: ["codex"] }),
        options({ resolver }),
      ),
    );
    expect(added.notice).toBe(`Added lint ${"2".repeat(7)}, review ${"2".repeat(7)}.`);
    expect(getSkill(db, "review")!.source).toEqual({
      kind: "git",
      url: "https://github.com/pbakaus/impeccable",
      subfolder: "skills/review",
    });
    expect(audit.map(([action]) => action)).toEqual(["settings.skill.add", "settings.skill.add"]);

    const none = await read(
      await handleSkillSettingsRequest(
        post({ action: "add", source, paths: [] }),
        options({ resolver }),
      ),
    );
    expect(none.error).toBe("Choose at least one skill to add.");
  });

  test("a change without the CSRF token is refused and not audited", async () => {
    const response = await handleSkillSettingsRequest(
      post(
        { action: "add", source: { kind: "npm", package: "impeccable" } },
        { "x-paws-csrf": "" },
      ),
      options({ role: "owner" }),
    );
    expect(response!.status).toBe(403);
    expect(audit).toEqual([]);
  });

  test("an uploaded folder is pinned to its content checksum", async () => {
    const form = new FormData();
    form.append("folder", "polish");
    form.append("agents", "codex");
    for (const [path, text] of [
      ["SKILL.md", "---\nname: polish\n---\n"],
      ["scripts/check.sh", "echo ok"],
    ] as const) {
      form.append("path", path);
      form.append("file", new File([text], path));
    }
    const body = new Response(form);
    const type = body.headers.get("content-type")!;
    const bytes = await body.arrayBuffer();
    const request = new Request("http://127.0.0.1:8787/api/settings/skills", {
      method: "POST",
      headers: {
        "content-type": type,
        "content-length": String(bytes.byteLength),
        "x-paws-csrf": "csrf",
      },
      body: bytes,
    });
    const listing = await read(await handleSkillSettingsRequest(request, options()));
    expect(listing.error).toBeUndefined();
    const skill = getSkill(db, "polish")!;
    expect(skill).toMatchObject({
      source: { kind: "upload", folder: "polish" },
      agents: ["codex"],
    });
    expect(skill.version).toMatch(/^[0-9a-f]{12}$/);
    const bundle = join(root, "skills", "polish", skill.version, SKILL_BUNDLE_FILE);
    expect(skill.sha256).toBe(sha256(bundle));
    expect(Object.keys(await bundleFiles(bundle)).sort()).toEqual(["SKILL.md", "scripts/check.sh"]);
    expect(audit).toEqual([
      ["settings.skill.add", `Added skill polish ${skill.version} from upload polish for Codex`],
    ]);
  });

  test("an upload without SKILL.md is refused", async () => {
    const form = new FormData();
    form.append("folder", "notes");
    form.append("path", "README.md");
    form.append("file", new File(["hi"], "README.md"));
    const body = new Response(form);
    const type = body.headers.get("content-type")!;
    const bytes = await body.arrayBuffer();
    const response = await handleSkillSettingsRequest(
      new Request("http://127.0.0.1:8787/api/settings/skills", {
        method: "POST",
        headers: {
          "content-type": type,
          "content-length": String(bytes.byteLength),
          "x-paws-csrf": "csrf",
        },
        body: bytes,
      }),
      options(),
    );
    expect(response!.status).toBe(400);
    expect((await read(response)).error).toContain("SKILL.md");
    expect(audit).toEqual([]);
  });
});
