import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeGitHub } from "../src/github";
import { orderByBlocks } from "../src/intake";
import { createFakeTracker, type LinearClient } from "../src/linear";
import {
  DemoResetError,
  loadEpicSeed,
  resetDemo,
  seedMarker,
  type CommandResult,
  type CommandRunner,
  type EpicSeed,
} from "./demo-reset";

const templateDir = join(import.meta.dir, "../examples/paws-demo");
const TOKEN = "ghp_test_token_not_for_logs";

test("epic seed is a parent and three ordered sub-issues", () => {
  const seed = loadEpicSeed(join(templateDir, "epic/epic.json"));
  expect(seed.repo).toBe("pmdroid/paws-demo");
  expect(seed.teamKey).toBe("ENG");
  expect(seed.label).toBe("paws");
  expect(seed.children.map((child) => child.slug)).toEqual([
    "export-rows",
    "export-header",
    "archived-rows",
  ]);
  expect(seed.children[1]?.blockedBy).toEqual(["export-rows"]);
  expect(seed.children[2]?.blockedBy).toEqual(["export-header"]);
  expect(seed.children[0]?.title).toContain("src/export.ts");
  expect(seed.children[1]?.title).toContain("src/export.ts");
  expect(seed.children[2]?.description).toContain("ask_team");
  expect(seed.children[2]?.description).toContain("Include archived rows?");
  expect(seed.children[2]?.title).toContain("yes");
  expect(() => loadEpicSeed(writeSeed(cycle(seed)))).toThrow(DemoResetError);
});

test("seeded export test fails inside the demo package", () => {
  const proc = spawnSync(process.execPath, ["test"], {
    cwd: templateDir,
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(proc.status).toBe(1);
  const output = `${proc.stdout}\n${proc.stderr}`;
  expect(output).toContain("exportRows writes one id,name line per row");
  expect(output).toContain("1,Ada");
});

test("resetDemo creates and then resets the epic against the fakes", async () => {
  const seed = loadEpicSeed(join(templateDir, "epic/epic.json"));
  const linear = createMemoryLinear();
  const host = createMemoryHost();
  const tracker = createFakeTracker();
  const github = createFakeGitHub();
  tracker.progress.push({ sessionId: "s", kind: "thought", body: "stale" });
  tracker.questions.push({ sessionId: "s", body: "stale question" });

  const first = await resetDemo({
    seed,
    templateDir,
    linear: linear.client,
    run: host.run,
    confirm: true,
    tracker,
    github,
  });

  expect(first.repoCreated).toBe(true);
  expect(first.parent).toMatchObject({ identifier: "ENG-1", title: "Export rows" });
  expect(first.subIssues.map((issue) => issue.identifier)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
  expect(first.subIssues.map((issue) => issue.slug)).toEqual([
    "export-rows",
    "export-header",
    "archived-rows",
  ]);
  expect(first.commentsDeleted).toBe(0);
  expect(first.branchesDeleted).toEqual(["paws/ENG-8"]);
  expect(first.pullsClosed).toEqual([8]);
  expect(first.relations).toEqual([
    { blockerLinearIssueId: "issue-2", blockedLinearIssueId: "issue-3" },
    { blockerLinearIssueId: "issue-3", blockedLinearIssueId: "issue-4" },
  ]);
  expect(linear.ops.filter((name) => name === "DemoIssueCreate")).toHaveLength(4);
  expect(linear.ops.filter((name) => name === "DemoIssueUpdate")).toHaveLength(0);
  expect(linear.ops.filter((name) => name === "DemoLabelCreate")).toHaveLength(1);
  expect(linear.ops.filter((name) => name === "DemoRelationCreate")).toHaveLength(2);
  expect(linear.store.issues.map((issue) => issue.stateId)).toEqual([
    "state-todo",
    "state-todo",
    "state-todo",
    "state-todo",
  ]);
  expect(linear.store.issues.map((issue) => issue.sort)).toEqual([null, 0, 1, 2]);
  expect(linear.store.issues.every((issue) => issue.labelIds.includes("label-paws"))).toBe(true);
  expect(linear.store.issues[1]?.description).toContain(seedMarker("export-rows"));
  expect(linear.store.issues[3]?.description).toContain("ask_team");
  expect(linear.store.issues.every((issue) => issue.description.includes("Seed: paws-demo:"))).toBe(
    true,
  );
  expect(host.branches).toEqual(["main"]);
  expect(host.pulls.filter((pull) => pull.state === "open").map((pull) => pull.number)).toEqual([
    2,
  ]);
  expect(host.labels).toEqual(["paws"]);
  expect(host.copiedCloseout).toBe(true);
  expect(host.copiedNodeModules).toBe(false);
  expect(host.helperBody).toContain("PAWS_DEMO_GITHUB_TOKEN");
  expect(host.helperBody).not.toContain(TOKEN);
  expect(host.pushEnv?.["PAWS_DEMO_GITHUB_TOKEN"]).toBe(TOKEN);
  expect(host.pushEnv?.["GH_TOKEN"]).toBeUndefined();
  for (const call of host.calls) {
    expect(call.args.join(" ")).not.toContain(TOKEN);
  }

  const epic = await tracker.loadEpic(first.parent.id);
  expect(epic.subIssues.map((issue) => issue.identifier)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
  const deps = await tracker.listDeps(first.parent.id);
  expect(deps).toEqual(first.relations);
  const ordered = orderByBlocks(
    epic.subIssues.map((issue) => ({
      linearIssueId: issue.linearIssueId,
      identifier: issue.identifier,
      title: issue.title,
    })),
    deps,
  );
  expect(ordered.ok).toBe(true);
  if (ordered.ok) {
    expect(ordered.ordered.map((issue) => issue.identifier)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
  }
  expect(tracker.progress).toEqual([]);
  expect(tracker.questions).toEqual([]);
  expect(github.minted).toEqual([]);
  expect(github.opened).toEqual([]);
  expect(github.merged).toEqual([]);

  const parent = linear.store.issues[0];
  if (parent === undefined) throw new Error("missing parent");
  parent.title = "stale title";
  parent.stateId = "state-done";
  linear.store.comments.push({ id: "comment-9", issueId: parent.id });
  linear.store.relations.push({
    id: "rel-extra",
    type: "blocks",
    blockerId: "issue-4",
    blockedId: "issue-2",
  });
  host.branches.push("paws/ENG-99");
  host.pulls.push({ number: 11, head: "paws/ENG-99", state: "open" });
  const opsBefore = linear.ops.length;
  const callsBefore = host.calls.length;

  const second = await resetDemo({
    seed,
    templateDir,
    linear: linear.client,
    run: host.run,
    confirm: true,
    tracker,
    github,
  });

  expect(second.parent.id).toBe(first.parent.id);
  expect(second.repoCreated).toBe(false);
  expect(second.commentsDeleted).toBe(1);
  expect(second.branchesDeleted).toEqual(["paws/ENG-99"]);
  expect(second.pullsClosed).toEqual([11]);
  expect(second.relations).toEqual(first.relations);
  expect(linear.store.issues).toHaveLength(4);
  expect(linear.store.issues[0]?.title).toBe("Export rows");
  expect(linear.store.issues.every((issue) => issue.stateId === "state-todo")).toBe(true);
  expect(linear.store.comments).toEqual([]);
  expect(linear.store.relations.map((relation) => relation.id).sort()).toEqual(["rel-1", "rel-2"]);
  const again = linear.ops.slice(opsBefore);
  expect(again.filter((name) => name === "DemoIssueCreate")).toEqual([]);
  expect(again.filter((name) => name === "DemoLabelCreate")).toEqual([]);
  expect(again.filter((name) => name === "DemoRelationCreate")).toEqual([]);
  expect(again.filter((name) => name === "DemoIssueUpdate")).toHaveLength(4);
  expect(again.filter((name) => name === "DemoCommentDelete")).toEqual(["DemoCommentDelete"]);
  expect(again.filter((name) => name === "DemoRelationDelete")).toEqual(["DemoRelationDelete"]);
  expect(
    host.calls
      .slice(callsBefore)
      .some((call) => call.args[0] === "repo" && call.args[1] === "create"),
  ).toBe(false);
  expect(github.merged).toEqual([]);
});

test("reset refuses a missing confirm, a non-demo repo, and a used GitHub App", async () => {
  const seed = loadEpicSeed(join(templateDir, "epic/epic.json"));
  const linear: LinearClient = {
    async query() {
      throw new Error("linear was called");
    },
  };
  const run: CommandRunner = async () => {
    throw new Error("gh was called");
  };
  await expect(resetDemo({ seed, templateDir, linear, run, confirm: false })).rejects.toThrow(
    /confirm/,
  );
  await expect(
    resetDemo({ seed, templateDir, linear, run, confirm: true, repo: "acme/other" }),
  ).rejects.toThrow(/paws-demo/);
  const github = createFakeGitHub();
  await github.mintInstallationToken({
    installationId: "1",
    repository: "pmdroid/paws-demo",
  });
  await expect(
    resetDemo({ seed, templateDir, linear, run, confirm: true, github }),
  ).rejects.toThrow(/GitHub App/);
  const empty = mkdtempSync(join(tmpdir(), "paws-demo-empty-"));
  await expect(resetDemo({ seed, templateDir: empty, linear, run, confirm: true })).rejects.toThrow(
    /closeout.yaml/,
  );
});

function cycle(seed: EpicSeed): EpicSeed {
  const children = seed.children.map((child) => ({ ...child, blockedBy: [...child.blockedBy] }));
  const first = children[0];
  if (first === undefined) throw new Error("missing child");
  first.blockedBy = ["archived-rows"];
  return { ...seed, children };
}

function writeSeed(seed: EpicSeed): string {
  const dir = mkdtempSync(join(tmpdir(), "paws-seed-"));
  const path = join(dir, "epic.json");
  writeFileSync(path, JSON.stringify(seed));
  return path;
}

type StoreIssue = {
  id: string;
  identifier: string;
  teamId: string;
  title: string;
  description: string;
  parentId: string | null;
  stateId: string;
  labelIds: string[];
  sort: number | null;
};

type MemoryLinear = {
  client: LinearClient;
  ops: string[];
  store: {
    issues: StoreIssue[];
    comments: Array<{ id: string; issueId: string }>;
    relations: Array<{ id: string; type: string; blockerId: string; blockedId: string }>;
  };
};

function createMemoryLinear(): MemoryLinear {
  const issues: StoreIssue[] = [];
  const comments: Array<{ id: string; issueId: string }> = [];
  const relations: Array<{ id: string; type: string; blockerId: string; blockedId: string }> = [];
  const labels: Array<{ id: string; name: string; teamId: string }> = [];
  const ops: string[] = [];
  let issueSeq = 0;
  let relationSeq = 0;

  const client: LinearClient = {
    async query(query, variables) {
      const name = operationName(query);
      ops.push(name);
      const vars = variables ?? {};
      if (name === "DemoTeams") {
        return { teams: { nodes: [{ id: "team-eng", key: "ENG", name: "Engineering" }] } };
      }
      if (name === "DemoWorkflowStates") {
        expect(vars["teamId"]).toBe("team-eng");
        return {
          workflowStates: {
            nodes: [
              { id: "state-todo", name: "Todo", type: "unstarted" },
              { id: "state-started", name: "In Progress", type: "started" },
              { id: "state-done", name: "Done", type: "completed" },
            ],
          },
        };
      }
      if (name === "DemoLabelLookup") {
        const labelName = vars["name"];
        return {
          issueLabels: {
            nodes: labels
              .filter((label) => label.teamId === vars["teamId"] && label.name === labelName)
              .map((label) => ({ id: label.id, name: label.name })),
          },
        };
      }
      if (name === "DemoLabelCreate") {
        const input = record(vars["input"], "label input");
        const labelName = stringField(input, "name");
        if (labels.some((label) => label.name === labelName)) {
          throw new Error(`duplicate label ${labelName}`);
        }
        const label = { id: "label-paws", name: labelName, teamId: stringField(input, "teamId") };
        labels.push(label);
        return {
          issueLabelCreate: { success: true, issueLabel: { id: label.id, name: label.name } },
        };
      }
      if (name === "DemoIssues") {
        const teamId = vars["teamId"];
        const nodes = issues
          .filter(
            (issue) => issue.teamId === teamId && issue.description.includes("Seed: paws-demo:"),
          )
          .map((issue) => ({
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description,
            parent: issue.parentId === null ? null : { id: issue.parentId },
            relations: {
              nodes: relations
                .filter((relation) => relation.blockerId === issue.id)
                .map((relation) => ({
                  id: relation.id,
                  type: relation.type,
                  relatedIssue: { id: relation.blockedId },
                })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          }));
        return { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      if (name === "DemoIssueCreate") {
        const input = record(vars["input"], "issue input");
        issueSeq += 1;
        const parent = input["parentId"];
        const sort = input["subIssueSortOrder"];
        const issue: StoreIssue = {
          id: `issue-${issueSeq}`,
          identifier: `ENG-${issueSeq}`,
          teamId: stringField(input, "teamId"),
          title: stringField(input, "title"),
          description: stringField(input, "description"),
          parentId: typeof parent === "string" ? parent : null,
          stateId: stringField(input, "stateId"),
          labelIds: stringList(input["labelIds"]),
          sort: typeof sort === "number" ? sort : null,
        };
        issues.push(issue);
        return {
          issueCreate: {
            success: true,
            issue: {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              description: issue.description,
            },
          },
        };
      }
      if (name === "DemoIssueUpdate") {
        const issue = issues.find((item) => item.id === vars["id"]);
        if (issue === undefined) throw new Error(`unknown issue ${String(vars["id"])}`);
        const input = record(vars["input"], "issue update");
        issue.title = stringField(input, "title");
        issue.description = stringField(input, "description");
        issue.stateId = stringField(input, "stateId");
        issue.labelIds = stringList(input["labelIds"]);
        if ("parentId" in input) {
          issue.parentId = typeof input["parentId"] === "string" ? input["parentId"] : null;
        }
        if (typeof input["subIssueSortOrder"] === "number") issue.sort = input["subIssueSortOrder"];
        return {
          issueUpdate: { success: true, issue: { id: issue.id, identifier: issue.identifier } },
        };
      }
      if (name === "DemoIssueComments") {
        const id = vars["id"];
        const nodes =
          typeof vars["after"] === "string"
            ? []
            : comments
                .filter((comment) => comment.issueId === id)
                .map((comment) => ({ id: comment.id }));
        return {
          issue: {
            comments: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
          },
        };
      }
      if (name === "DemoCommentDelete") {
        const index = comments.findIndex((comment) => comment.id === vars["id"]);
        if (index === -1) throw new Error(`unknown comment ${String(vars["id"])}`);
        comments.splice(index, 1);
        return { commentDelete: { success: true } };
      }
      if (name === "DemoRelationCreate") {
        const input = record(vars["input"], "relation input");
        const blockerId = stringField(input, "issueId");
        const blockedId = stringField(input, "relatedIssueId");
        if (input["type"] !== "blocks") throw new Error("relation type must be blocks");
        if (
          relations.some(
            (relation) => relation.blockerId === blockerId && relation.blockedId === blockedId,
          )
        ) {
          throw new Error("relation already exists");
        }
        relationSeq += 1;
        const relation = { id: `rel-${relationSeq}`, type: "blocks", blockerId, blockedId };
        relations.push(relation);
        return { issueRelationCreate: { success: true, issueRelation: { id: relation.id } } };
      }
      if (name === "DemoRelationDelete") {
        const index = relations.findIndex((relation) => relation.id === vars["id"]);
        if (index === -1) throw new Error(`unknown relation ${String(vars["id"])}`);
        relations.splice(index, 1);
        return { issueRelationDelete: { success: true } };
      }
      throw new Error(`unexpected Linear operation ${name}`);
    },
  };

  return { client, ops, store: { issues, comments, relations } };
}

type HostPull = { number: number; head: string; state: "open" | "closed" };

function createMemoryHost(): {
  run: CommandRunner;
  calls: Array<{ command: string; args: string[] }>;
  branches: string[];
  pulls: HostPull[];
  labels: string[];
  helperBody: string;
  pushEnv: NodeJS.ProcessEnv | undefined;
  copiedCloseout: boolean;
  copiedNodeModules: boolean;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const branches = ["main", "paws/ENG-8"];
  const pulls: HostPull[] = [
    { number: 8, head: "paws/ENG-8", state: "open" },
    { number: 2, head: "docs", state: "open" },
  ];
  const labels: string[] = [];
  let repoExists = false;
  let helperBody = "";
  let pushEnv: NodeJS.ProcessEnv | undefined;
  let copiedCloseout = false;
  let copiedNodeModules = false;

  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args: [...args] });
    if (command === "git") {
      if (args[0] === "init" && options?.cwd !== undefined) {
        copiedCloseout = existsSync(join(options.cwd, ".agents/closeout.yaml"));
        copiedNodeModules = existsSync(join(options.cwd, "node_modules"));
      }
      if (args.includes("push")) {
        const helperArg = args.find((arg) => arg.startsWith("credential.helper=/"));
        if (helperArg !== undefined) {
          helperBody = readFileSync(helperArg.slice("credential.helper=".length), "utf8");
        }
        pushEnv = options?.env;
      }
      return ok("");
    }
    if (command !== "gh") return { stdout: "", stderr: "unknown command", exitCode: 1 };
    if (args[0] === "repo" && args[1] === "view") {
      if (!repoExists) return { stdout: "", stderr: "not found", exitCode: 1 };
      return ok('{"name":"paws-demo"}\n');
    }
    if (args[0] === "repo" && args[1] === "create") {
      repoExists = true;
      return ok("");
    }
    if (args[0] === "label" && args[1] === "create") {
      const name = args[2];
      if (name !== undefined && !labels.includes(name)) labels.push(name);
      return ok("");
    }
    if (args[0] === "api" && args.includes("--paginate")) {
      return ok(`${branches.join("\n")}\n`);
    }
    if (args[0] === "api" && args[1] === "--method" && args[2] === "DELETE") {
      const path = args[3] ?? "";
      const marker = "/git/refs/heads/";
      const branch = path.slice(path.indexOf(marker) + marker.length);
      const index = branches.indexOf(branch);
      if (index === -1) return { stdout: "", stderr: "branch not found", exitCode: 1 };
      branches.splice(index, 1);
      return ok("");
    }
    if (args[0] === "pr" && args[1] === "list") {
      const open = pulls
        .filter((pull) => pull.state === "open")
        .map((pull) => ({ number: pull.number, headRefName: pull.head }));
      return ok(JSON.stringify(open));
    }
    if (args[0] === "pr" && args[1] === "close") {
      const number = Number(args[2]);
      const pull = pulls.find((item) => item.number === number);
      if (pull === undefined) return { stdout: "", stderr: "pull not found", exitCode: 1 };
      pull.state = "closed";
      return ok("");
    }
    if (args[0] === "auth" && args[1] === "token") return ok(`${TOKEN}\n`);
    return { stdout: "", stderr: `unexpected gh ${args.join(" ")}`, exitCode: 1 };
  };

  return {
    run,
    calls,
    branches,
    pulls,
    labels,
    get helperBody() {
      return helperBody;
    },
    get pushEnv() {
      return pushEnv;
    },
    get copiedCloseout() {
      return copiedCloseout;
    },
    get copiedNodeModules() {
      return copiedNodeModules;
    },
  };
}

function ok(stdout: string): CommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function operationName(query: string): string {
  const match = /^\s*(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query);
  const name = match?.[1];
  if (name === undefined) throw new Error("query has no operation name");
  return name;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value;
}

function stringField(recordValue: Record<string, unknown>, key: string): string {
  const value = recordValue[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is invalid`);
  return value;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("expected a string list");
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("expected a string list");
    ids.push(item);
  }
  return ids;
}
