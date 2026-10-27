import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree, ensureBareMirror } from "../src/acp";
import {
  FULL_CHECKOUT_LABEL,
  checkoutExclusionsFor,
  parseCheckoutProjects,
  renderCheckoutProjects,
} from "../src/config";
import { hiddenPathsPrompt, implementPrompt } from "../src/loop";
import { startServer } from "../src/server";
import { handleCheckoutSettingsRequest } from "../src/settings";
import { checkoutPatterns, exclusionMatcher, exclusionPatterns } from "../src/worktree-checkout";
import { tempDb } from "./helpers";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "paws-checkout-"));
  roots.push(root);
  return root;
}

function git(tree: string, ...args: string[]): string {
  return execFileSync("git", ["-C", tree, ...args], { encoding: "utf8" }).trim();
}

test("config accepts globs, refuses .git and .., and round-trips exclude_from_checks", () => {
  const text = `[checkout.projects."Acme/Demo"]\nexclude = ["docs/archive/", "**/*.snap"]\nexclude_from_checks = ["test/fixtures/large/**"]\n`;
  const projects = parseCheckoutProjects(text);
  expect(projects).toEqual({
    "acme/demo": {
      exclude: ["docs/archive/", "**/*.snap"],
      excludeFromChecks: ["test/fixtures/large/**"],
    },
  });
  expect(parseCheckoutProjects(renderCheckoutProjects(projects))).toEqual(projects);
  for (const path of [".git", "a/.git/", "..", "a/../b", "**", "*/*"])
    expect(() =>
      parseCheckoutProjects(
        `[checkout.projects."acme/demo"]\nexclude = ${JSON.stringify([path])}\n`,
      ),
    ).toThrow();
});

test("the agent loses both lists, checks only exclude_from_checks, the label neither", () => {
  const projects = parseCheckoutProjects(
    `[checkout.projects."acme/demo"]\nexclude = ["docs/"]\nexclude_from_checks = ["large/**"]\n`,
  );
  expect(checkoutExclusionsFor(projects, "Acme/Demo")).toEqual({
    agent: ["docs/", "large/**"],
    checks: ["large/**"],
  });
  expect(checkoutExclusionsFor(projects, "acme/demo", ["Bug", FULL_CHECKOUT_LABEL])).toEqual({
    agent: [],
    checks: [],
  });
  expect(checkoutExclusionsFor(projects, "acme/other")).toEqual({ agent: [], checks: [] });
});

test("globs match within a segment, across folders with **, and cover folders", () => {
  const hides = exclusionMatcher(["**/*.snap", "fixtures/large/**", "docs/archive/", "a?c"]);
  expect(hides("src/deep/view.snap")).toBe(true);
  expect(hides("top.snap")).toBe(true);
  expect(hides("fixtures/large/x/y.bin")).toBe(true);
  expect(hides("fixtures/small/y.bin")).toBe(false);
  expect(hides("docs/archive/old.md")).toBe(true);
  expect(hides("docs/archived.md")).toBe(false);
  expect(hides("abc/file")).toBe(true);
  expect(hides("src/view.snapshot")).toBe(false);
});

test("the agent checkout leaves paths out; a check checkout keeps agent-only paths", async () => {
  const root = await tempRoot();
  const source = join(root, "source");
  const pawsRoot = join(root, "paws");
  await mkdir(source);
  git(source, "init", "-b", "main");
  for (const file of ["docs/guide.md", "large/blob.bin", "src/a.snap", "src/a.ts"]) {
    await mkdir(join(source, file, ".."), { recursive: true });
    await writeFile(join(source, file), file);
  }
  git(source, "add", ".");
  git(source, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-m", "seed");
  await ensureBareMirror({ remoteUrl: source, owner: "acme", repo: "demo", pawsRoot });
  await writeFile(
    join(pawsRoot, "config.toml"),
    `[checkout.projects."acme/demo"]\nexclude = ["docs/", "**/*.snap"]\nexclude_from_checks = ["large/"]\n`,
  );
  const exclusions = checkoutExclusionsFor(
    parseCheckoutProjects(await readFile(join(pawsRoot, "config.toml"), "utf8")),
    "acme/demo",
  );
  const tree = await createWorktree({ owner: "acme", repo: "demo", pawsRoot, itemId: "ONE" });
  expect(existsSync(join(tree.path, "docs"))).toBe(false);
  expect(existsSync(join(tree.path, "src/a.snap"))).toBe(false);
  expect(existsSync(join(tree.path, "large"))).toBe(false);
  expect(existsSync(join(tree.path, "src/a.ts"))).toBe(true);
  expect(git(tree.path, "status", "--porcelain")).toBe("");

  const checks = join(root, "checks");
  git(tree.path, "worktree", "add", "--no-checkout", "--detach", checks, "HEAD");
  await checkoutPatterns(checks, exclusionPatterns(exclusions.checks));
  expect(existsSync(join(checks, "docs/guide.md"))).toBe(true);
  expect(existsSync(join(checks, "src/a.snap"))).toBe(true);
  expect(existsSync(join(checks, "large"))).toBe(false);
});

test("the hidden-paths prompt line appears exactly when paths are hidden", () => {
  const line = "Not checked out in this run: docs/archive/, **/*.snap.";
  expect(hiddenPathsPrompt(["docs/archive/", "**/*.snap"])).toBe(
    `${line}\nAsk in the session if the task needs one of them.`,
  );
  const base = { identifier: "ENG-1", title: "Fix" };
  expect(implementPrompt({ ...base, hiddenPaths: ["docs/archive/", "**/*.snap"] })).toContain(line);
  expect(implementPrompt(base)).not.toContain("Not checked out");
  expect(implementPrompt({ ...base, hiddenPaths: [] })).not.toContain("Not checked out");
});

test("settings save round-trips through config.toml and warns about check paths", async () => {
  const root = await tempRoot();
  const configPath = join(root, "config.toml");
  await writeFile(configPath, `# kept\n[merge]\nmain_moved = "closeout"\n`);
  const audit: string[] = [];
  const options = {
    configPath,
    csrfToken: "token",
    repos: ["acme/demo"],
    audit: (_action: string, subject: string) => audit.push(subject),
    inspect: async () => ({
      files: ["docs/index.md", "docs/archive/old.md", "src/a.ts"],
      checks: [{ id: "links", paths: ["docs/"] }],
    }),
  };
  const put = (body: unknown) =>
    handleCheckoutSettingsRequest(
      new Request("http://127.0.0.1/api/settings/checkout", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-paws-csrf": "token" },
        body: JSON.stringify(body),
      }),
      options,
    );
  const saved = await put({
    repositories: [
      {
        repo: "acme/demo",
        paths: [
          { path: "docs/archive/", hideFrom: "checks" },
          { path: "**/*.snap", hideFrom: "agent" },
        ],
      },
    ],
  });
  expect(saved?.status).toBe(200);
  const body = (await saved!.json()) as {
    warnings?: string[];
    repositories: Array<{ repo: string; paths: Array<{ path: string; usedBy: string[] }> }>;
  };
  expect(body.warnings).toEqual([
    "acme/demo: docs/archive/ is used by the Closeout check links and is hidden from checks.",
  ]);
  const text = await readFile(configPath, "utf8");
  expect(text).toContain("# kept");
  expect(text).toContain('main_moved = "closeout"');
  expect(parseCheckoutProjects(text)).toEqual({
    "acme/demo": { exclude: ["**/*.snap"], excludeFromChecks: ["docs/archive/"] },
  });
  expect(audit).toHaveLength(1);

  const agentOnly = await put({
    repositories: [{ repo: "acme/demo", paths: [{ path: "docs/archive/", hideFrom: "agent" }] }],
  });
  expect(((await agentOnly!.json()) as { warnings?: string[] }).warnings).toBeUndefined();

  const refused = await put({
    repositories: [{ repo: "acme/demo", paths: [{ path: "../outside", hideFrom: "agent" }] }],
  });
  expect(refused?.status).toBe(400);

  const listed = await handleCheckoutSettingsRequest(
    new Request("http://127.0.0.1/api/settings/checkout"),
    options,
  );
  const view = (await listed!.json()) as {
    label: string;
    repositories: Array<{ repo: string; files?: { total: number; agent: number } }>;
  };
  expect(view.label).toBe(FULL_CHECKOUT_LABEL);
  expect(view.repositories).toContainEqual(
    expect.objectContaining({ repo: "acme/demo", files: { total: 3, agent: 2 } }),
  );
});

test("settings list the workspace's GitHub-connected and team-mapped repositories once", async () => {
  const root = await tempRoot();
  const configPath = join(root, "config.toml");
  const db = tempDb();
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('ws','org','Workspace',0)",
  );
  for (const repository of ["pmdroid/barkvisor", "pmdroid/kyotoagent", "pmdroid/paws-app"])
    db.run(
      "INSERT INTO workspace_repository(workspace_id,repository,team_id) VALUES('ws',?,'team')",
      [repository],
    );
  db.run(
    `INSERT INTO workspace_github_connection(workspace_id,generation,secret_id,installation_id,repositories)
     VALUES('ws',1,'secret-1','42','["pmdroid/barkvisor","PMDroid/Kyotoagent","pmdroid/paws-app"]')`,
  );
  const server = startServer({
    hostname: "127.0.0.1",
    port: 0,
    webhooks: false,
    db,
    agentSettings: { configPath, repos: ["PMDroid/Paws-App"] },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const repos = async () =>
      (
        (await (await fetch(`${base}/api/settings/checkout`)).json()) as {
          repositories: Array<{ repo: string; paths: unknown[] }>;
        }
      ).repositories;
    expect((await repos()).map((repository) => repository.repo).sort()).toEqual([
      "pmdroid/barkvisor",
      "pmdroid/kyotoagent",
      "pmdroid/paws-app",
    ]);

    const page = await (await fetch(`${base}/status`)).text();
    const token = /name="paws-csrf" content="([^"]+)"/.exec(page)?.[1];
    const saved = await fetch(`${base}/api/settings/checkout`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-paws-csrf": token!, origin: base },
      body: JSON.stringify({
        repositories: [{ repo: "pmdroid/kyotoagent", paths: [{ path: "docs/archive/" }] }],
      }),
    });
    expect(saved.status).toBe(200);
    expect(parseCheckoutProjects(await readFile(configPath, "utf8"))).toEqual({
      "pmdroid/kyotoagent": { exclude: ["docs/archive/"] },
    });
    const listed = await repos();
    expect(listed).toHaveLength(3);
    expect(listed.find((repository) => repository.repo === "pmdroid/kyotoagent")?.paths).toEqual([
      { path: "docs/archive/", hideFrom: "agent", usedBy: [] },
    ]);
  } finally {
    server.stop(true);
    db.close();
  }
});
