/**
 * Create or reset the paws-demo Linear epic and GitHub repo.
 *
 * Live runs use a Linear API key and the `gh` CLI. Tests pass a LinearClient
 * and a command runner, then read the epic back through the fake tracker.
 * Reset does not mint, open, or merge through the GitHub App.
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { FakeGitHub } from "../src/github";
import {
  createLinearClient,
  type DependencyEdge,
  type EpicSnapshot,
  type FakeTracker,
  type LinearClient,
} from "../src/linear";

const exec = promisify(execFile);

const REPO_NAME = /^[A-Za-z0-9._-]+\/paws-demo$/;
const TEAM_KEY = /^[A-Za-z0-9_-]{1,32}$/;
const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const PAWS_BRANCH = /^paws(?:\/[A-Za-z0-9._-]+)+$/;

const CREDENTIAL_HELPER = `#!/bin/sh
if [ "$1" = "get" ]; then
  printf 'username=x-access-token\\n'
  printf 'password=%s\\n' "$PAWS_DEMO_GITHUB_TOKEN"
fi
`;

export class DemoResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoResetError";
  }
}

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export type EpicNodeSeed = {
  slug: string;
  title: string;
  description: string;
};

export type EpicChildSeed = EpicNodeSeed & {
  blockedBy: readonly string[];
};

export type EpicSeed = {
  teamKey: string;
  repo: string;
  label: string;
  parent: EpicNodeSeed;
  children: readonly EpicChildSeed[];
};

export type ResetReport = {
  repo: string;
  teamKey: string;
  parent: { id: string; identifier: string; title: string };
  subIssues: Array<{ id: string; identifier: string; slug: string; title: string }>;
  label: string;
  commentsDeleted: number;
  branchesDeleted: string[];
  pullsClosed: number[];
  repoCreated: boolean;
  relations: DependencyEdge[];
};

export type ResetDemoInput = {
  seed: EpicSeed;
  templateDir: string;
  linear: LinearClient;
  run: CommandRunner;
  confirm: boolean;
  repo?: string;
  teamKey?: string;
  /** When set, the epic and blocks edges are written here for intake. */
  tracker?: FakeTracker;
  /**
   * GitHub App fake. Reset refuses a fake that already minted, opened, or
   * merged, and it never calls those methods. Branch and label changes go
   * through `gh`.
   */
  github?: FakeGitHub;
};

type IssueNode = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  parentId: string | null;
  relations: Array<{ id: string; type: string; relatedId: string }>;
};

type TeamNode = { id: string; key: string };
type StateNode = { id: string; name: string; type: string };
type LabelNode = { id: string; name: string };

export function seedMarker(slug: string): string {
  return `Seed: paws-demo:${slug}`;
}

export function loadEpicSeed(path: string): EpicSeed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DemoResetError(`could not read epic seed: ${message}`);
  }
  return parseSeed(parsed);
}

export async function resetDemo(input: ResetDemoInput): Promise<ResetReport> {
  if (!input.confirm) {
    throw new DemoResetError("Refusing to reset without confirm. Pass --yes.");
  }
  const repo = input.repo ?? input.seed.repo;
  const teamKey = input.teamKey ?? input.seed.teamKey;
  if (!REPO_NAME.test(repo)) {
    throw new DemoResetError(`Refusing to reset ${repo}. The repo name must be paws-demo.`);
  }
  if (!TEAM_KEY.test(teamKey)) throw new DemoResetError("team key is invalid");
  if (input.github !== undefined) assertGithubIdle(input.github);
  assertTemplate(input.templateDir);

  const team = await loadTeam(input.linear, teamKey);
  const state = await loadUnstartedState(input.linear, team.id);
  const label = await ensureLinearLabel(input.linear, team.id, input.seed.label);
  await upsertIssues(input.linear, input.seed, team.id, state.id, label.id);
  const issues = await listDemoIssues(input.linear, team.id);
  const parent = requireIssue(issues, input.seed.parent.slug);
  const children = input.seed.children.map((child) => requireIssue(issues, child.slug));
  const commentsDeleted = await deleteComments(input.linear, [parent, ...children]);
  const relations = await syncRelations(input.linear, input.seed, parent, children, issues);

  const repoCreated = await ensureGithubRepo(input.run, repo);
  await gh(input.run, [
    "label",
    "create",
    input.seed.label,
    "--repo",
    repo,
    "--color",
    "6E56CF",
    "--description",
    "Delegated to Paws",
    "--force",
  ]);
  const pullsClosed = await closePawsPulls(input.run, repo);
  const branchesDeleted = await deletePawsBranches(input.run, repo);
  const token = await githubToken(input.run);
  await publishTemplate({
    run: input.run,
    templateDir: input.templateDir,
    repo,
    token,
  });

  if (input.tracker !== undefined) remember(input.tracker, parent, children, relations);

  return {
    repo,
    teamKey,
    parent: { id: parent.id, identifier: parent.identifier, title: parent.title },
    subIssues: children.map((child, index) => ({
      id: child.id,
      identifier: child.identifier,
      slug: input.seed.children[index]?.slug ?? child.identifier,
      title: child.title,
    })),
    label: input.seed.label,
    commentsDeleted,
    branchesDeleted,
    pullsClosed,
    repoCreated,
    relations,
  };
}

async function upsertIssues(
  linear: LinearClient,
  seed: EpicSeed,
  teamId: string,
  stateId: string,
  labelId: string,
): Promise<void> {
  const existing = await listDemoIssues(linear, teamId);
  const parentId = await upsertIssue(linear, existing, seed.parent, {
    teamId,
    stateId,
    labelId,
    parentId: null,
    sort: null,
  });
  for (const [index, child] of seed.children.entries()) {
    await upsertIssue(linear, existing, child, {
      teamId,
      stateId,
      labelId,
      parentId,
      sort: index,
    });
  }
}

async function upsertIssue(
  linear: LinearClient,
  existing: readonly IssueNode[],
  spec: EpicNodeSeed,
  link: {
    teamId: string;
    stateId: string;
    labelId: string;
    parentId: string | null;
    sort: number | null;
  },
): Promise<string> {
  const description = withMarker(spec.description, spec.slug);
  const fields: Record<string, unknown> = {
    title: spec.title,
    description,
    stateId: link.stateId,
    labelIds: [link.labelId],
  };
  if (link.sort !== null) fields["subIssueSortOrder"] = link.sort;
  const found = findByMarker(existing, spec.slug);
  if (found !== undefined) {
    requirePayload(
      requireRecord(
        await linear.query(ISSUE_UPDATE, {
          id: found.id,
          input: { ...fields, parentId: link.parentId },
        }),
        "issueUpdate",
      ),
      "issueUpdate",
    );
    return found.id;
  }
  const input: Record<string, unknown> = { ...fields, teamId: link.teamId };
  if (link.parentId !== null) input["parentId"] = link.parentId;
  const created = requirePayload(
    requireRecord(await linear.query(ISSUE_CREATE, { input }), "issueCreate"),
    "issueCreate",
  );
  const issue = requireRecord(created["issue"], "issue");
  const id = readString(issue, "id");
  if (id === null) throw new DemoResetError("Linear did not return an issue id");
  return id;
}

async function syncRelations(
  linear: LinearClient,
  seed: EpicSeed,
  parent: IssueNode,
  children: readonly IssueNode[],
  issues: readonly IssueNode[],
): Promise<DependencyEdge[]> {
  const bySlug = new Map<string, IssueNode>([[seed.parent.slug, parent]]);
  for (const [index, child] of seed.children.entries()) {
    const node = children[index];
    if (node === undefined) throw new DemoResetError(`missing ${child.slug}`);
    bySlug.set(child.slug, node);
  }
  const desired: DependencyEdge[] = [];
  for (const child of seed.children) {
    const blocked = bySlug.get(child.slug);
    if (blocked === undefined) throw new DemoResetError(`missing ${child.slug}`);
    for (const blockerSlug of child.blockedBy) {
      const blocker = bySlug.get(blockerSlug);
      if (blocker === undefined) throw new DemoResetError(`missing blocker ${blockerSlug}`);
      desired.push({
        blockerLinearIssueId: blocker.id,
        blockedLinearIssueId: blocked.id,
      });
    }
  }
  const managed = new Set([parent.id, ...children.map((child) => child.id)]);
  const existing: Array<{ id: string; key: string }> = [];
  for (const issue of issues) {
    if (!managed.has(issue.id)) continue;
    for (const relation of issue.relations) {
      if (relation.type !== "blocks" || !managed.has(relation.relatedId)) continue;
      existing.push({
        id: relation.id,
        key: edgeKey(issue.id, relation.relatedId),
      });
    }
  }
  const desiredKeys = new Set(
    desired.map((edge) => edgeKey(edge.blockerLinearIssueId, edge.blockedLinearIssueId)),
  );
  const seen = new Set<string>();
  for (const relation of existing) {
    if (!desiredKeys.has(relation.key) || seen.has(relation.key)) {
      requirePayload(
        requireRecord(await linear.query(RELATION_DELETE, { id: relation.id }), "relationDelete"),
        "issueRelationDelete",
      );
      continue;
    }
    seen.add(relation.key);
  }
  for (const edge of desired) {
    const key = edgeKey(edge.blockerLinearIssueId, edge.blockedLinearIssueId);
    if (seen.has(key)) continue;
    requirePayload(
      requireRecord(
        await linear.query(RELATION_CREATE, {
          input: {
            issueId: edge.blockerLinearIssueId,
            relatedIssueId: edge.blockedLinearIssueId,
            type: "blocks",
          },
        }),
        "relationCreate",
      ),
      "issueRelationCreate",
    );
  }
  return desired;
}

async function deleteComments(linear: LinearClient, issues: readonly IssueNode[]): Promise<number> {
  let deleted = 0;
  for (const issue of issues) {
    const ids = await commentIds(linear, issue.id);
    for (const id of ids) {
      requirePayload(
        requireRecord(await linear.query(COMMENT_DELETE, { id }), "commentDelete"),
        "commentDelete",
      );
      deleted += 1;
    }
  }
  return deleted;
}

async function commentIds(linear: LinearClient, issueId: string): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data = requireRecord(
      await linear.query(COMMENTS_QUERY, { id: issueId, after }),
      "comments",
    );
    const issue = data["issue"];
    if (issue === null) return ids;
    const connection = readConnection(requireRecord(issue, "issue")["comments"]);
    for (const node of connection.nodes) {
      const id = readString(node, "id");
      if (id !== null) ids.push(id);
    }
    if (!connection.hasNextPage) return ids;
    if (connection.endCursor === null) throw new DemoResetError("comment page has no cursor");
    after = connection.endCursor;
  }
  throw new DemoResetError(`too many comments on ${issueId}`);
}

async function loadTeam(linear: LinearClient, teamKey: string): Promise<TeamNode> {
  const data = requireRecord(await linear.query(TEAMS_QUERY), "teams");
  const teams = readConnection(requireRecord(data, "teams")["teams"]);
  for (const node of teams.nodes) {
    const id = readString(node, "id");
    const key = readString(node, "key");
    if (id !== null && key === teamKey) return { id, key };
  }
  throw new DemoResetError(`Linear team ${teamKey} was not found`);
}

async function loadUnstartedState(linear: LinearClient, teamId: string): Promise<StateNode> {
  const data = requireRecord(await linear.query(STATES_QUERY, { teamId }), "states");
  const states = readConnection(requireRecord(data, "states")["workflowStates"]);
  const parsed: StateNode[] = [];
  for (const node of states.nodes) {
    const id = readString(node, "id");
    const name = readString(node, "name");
    const type = readString(node, "type");
    if (id === null || name === null || type === null) continue;
    parsed.push({ id, name, type });
  }
  const todo = parsed.find((state) => state.type === "unstarted" && state.name === "Todo");
  if (todo !== undefined) return todo;
  const unstarted = parsed.find((state) => state.type === "unstarted");
  if (unstarted !== undefined) return unstarted;
  const backlog = parsed.find((state) => state.type === "backlog");
  if (backlog !== undefined) return backlog;
  throw new DemoResetError("Linear team has no unstarted or backlog state");
}

async function ensureLinearLabel(
  linear: LinearClient,
  teamId: string,
  name: string,
): Promise<LabelNode> {
  const data = requireRecord(await linear.query(LABEL_LOOKUP, { teamId, name }), "labels");
  const labels = readConnection(requireRecord(data, "labels")["issueLabels"]);
  for (const node of labels.nodes) {
    const id = readString(node, "id");
    const labelName = readString(node, "name");
    if (id !== null && labelName === name) return { id, name: labelName };
  }
  const created = requirePayload(
    requireRecord(
      await linear.query(LABEL_CREATE, {
        input: { name, teamId, color: "#6E56CF" },
      }),
      "labelCreate",
    ),
    "issueLabelCreate",
  );
  const label = requireRecord(created["issueLabel"], "issueLabel");
  const id = readString(label, "id");
  const labelName = readString(label, "name");
  if (id === null || labelName === null) throw new DemoResetError("Linear did not return a label");
  return { id, name: labelName };
}

async function listDemoIssues(linear: LinearClient, teamId: string): Promise<IssueNode[]> {
  const data = requireRecord(await linear.query(ISSUES_QUERY, { teamId }), "issues");
  const connection = readConnection(requireRecord(data, "issues")["issues"]);
  if (connection.hasNextPage) {
    throw new DemoResetError("demo issue page is larger than 50");
  }
  const issues: IssueNode[] = [];
  for (const node of connection.nodes) {
    const id = readString(node, "id");
    const identifier = readString(node, "identifier");
    const title = readString(node, "title");
    const description = typeof node["description"] === "string" ? node["description"] : "";
    if (id === null || identifier === null || title === null) continue;
    const parent = node["parent"];
    const parentId =
      parent === null || parent === undefined
        ? null
        : readString(requireRecord(parent, "parent"), "id");
    const relations = readConnection(node["relations"]);
    if (relations.hasNextPage) throw new DemoResetError(`too many relations on ${identifier}`);
    const edges: IssueNode["relations"] = [];
    for (const relation of relations.nodes) {
      const relationId = readString(relation, "id");
      const type = readString(relation, "type");
      const related = relation["relatedIssue"];
      if (relationId === null || type === null || related === null || related === undefined)
        continue;
      const relatedId = readString(requireRecord(related, "relatedIssue"), "id");
      if (relatedId === null) continue;
      edges.push({ id: relationId, type, relatedId });
    }
    issues.push({ id, identifier, title, description, parentId, relations: edges });
  }
  return issues;
}

async function ensureGithubRepo(run: CommandRunner, repo: string): Promise<boolean> {
  const view = await run("gh", ["repo", "view", repo, "--json", "name"]);
  if (view.exitCode === 0) return false;
  if (view.exitCode !== 1) {
    throw new DemoResetError(`gh repo view failed: ${view.stderr.trim() || view.stdout.trim()}`);
  }
  await gh(run, [
    "repo",
    "create",
    repo,
    "--private",
    "--description",
    "Smoke demo for Paws",
    "--disable-wiki",
  ]);
  return true;
}

async function closePawsPulls(run: CommandRunner, repo: string): Promise<number[]> {
  const listed = await gh(run, [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number,headRefName",
  ]);
  const closed: number[] = [];
  for (const pull of readPulls(listed.stdout)) {
    if (!isPawsBranch(pull.head)) continue;
    await gh(run, ["pr", "close", String(pull.number), "--repo", repo]);
    closed.push(pull.number);
  }
  return closed;
}

async function deletePawsBranches(run: CommandRunner, repo: string): Promise<string[]> {
  const listed = await gh(run, ["api", "--paginate", `repos/${repo}/branches`, "--jq", ".[].name"]);
  const deleted: string[] = [];
  for (const name of listed.stdout.split("\n")) {
    const branch = name.trim();
    if (branch.length === 0 || !isPawsBranch(branch)) continue;
    if (!PAWS_BRANCH.test(branch)) throw new DemoResetError(`refusing to delete branch ${branch}`);
    await gh(run, ["api", "--method", "DELETE", `repos/${repo}/git/refs/heads/${branch}`]);
    deleted.push(branch);
  }
  return deleted;
}

async function githubToken(run: CommandRunner): Promise<string> {
  const result = await gh(run, ["auth", "token"]);
  const token = result.stdout.trim();
  if (token.length === 0 || /\s/.test(token)) throw new DemoResetError("gh auth token was empty");
  return token;
}

async function publishTemplate(input: {
  run: CommandRunner;
  templateDir: string;
  repo: string;
  token: string;
}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "paws-demo-"));
  try {
    copyTemplate(input.templateDir, dir);
    await git(input.run, dir, ["init", "-b", "main"], undefined, input.token);
    await git(input.run, dir, ["add", "-A"], undefined, input.token);
    await git(
      input.run,
      dir,
      [
        "-c",
        "user.name=Paws Demo",
        "-c",
        "user.email=paws-demo@users.noreply.github.com",
        "commit",
        "-m",
        "Reset the paws demo template",
      ],
      undefined,
      input.token,
    );
    const helper = join(dir, "cred.sh");
    writeFileSync(helper, CREDENTIAL_HELPER, { mode: 0o700 });
    chmodSync(helper, 0o700);
    const url = `https://github.com/${input.repo}.git`;
    await git(
      input.run,
      dir,
      [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${helper}`,
        "push",
        "--force",
        url,
        "HEAD:main",
      ],
      pushEnv(input.token),
      input.token,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function git(
  run: CommandRunner,
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  secret: string,
): Promise<void> {
  const result = await run("git", args, env === undefined ? { cwd } : { cwd, env });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw redact(`git failed: ${detail}`, secret);
  }
}

async function gh(run: CommandRunner, args: readonly string[]): Promise<CommandResult> {
  const result = await run("gh", args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new DemoResetError(`gh ${args[0] ?? "command"} failed: ${detail}`);
  }
  return result;
}

function pushEnv(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  env.GIT_TERMINAL_PROMPT = "0";
  env.PAWS_DEMO_GITHUB_TOKEN = token;
  return env;
}

function copyTemplate(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (skipped(entry.name)) continue;
    cpSync(join(from, entry.name), join(to, entry.name), {
      recursive: true,
      filter: (source) => !skipped(basename(source)),
    });
  }
}

function remember(
  tracker: FakeTracker,
  parent: IssueNode,
  children: readonly IssueNode[],
  relations: readonly DependencyEdge[],
): void {
  const snapshot: EpicSnapshot = {
    linearIssueId: parent.id,
    identifier: parent.identifier,
    title: parent.title,
    description: parent.description,
    subIssues: children.map((child) => ({
      linearIssueId: child.id,
      identifier: child.identifier,
      title: child.title,
    })),
  };
  tracker.epics.set(snapshot.linearIssueId, snapshot);
  const ids = [parent.id, ...children.map((child) => child.id)];
  for (const id of ids) tracker.deps.set(id, relations);
  tracker.progress.splice(0, tracker.progress.length);
  tracker.questions.splice(0, tracker.questions.length);
}

function assertGithubIdle(github: FakeGitHub): void {
  if (github.minted.length > 0 || github.opened.length > 0 || github.merged.length > 0) {
    throw new DemoResetError("demo reset does not use the GitHub App");
  }
}

function assertTemplate(dir: string): void {
  for (const rel of [
    ".agents/closeout.yaml",
    "package.json",
    "epic/epic.json",
    "src/export.ts",
    "src/export.test.ts",
  ]) {
    if (!existsSync(join(dir, rel))) throw new DemoResetError(`template is missing ${rel}`);
  }
}

function withMarker(description: string, slug: string): string {
  const body = description.trim();
  const marker = seedMarker(slug);
  if (body.includes(marker)) return `${body}\n`;
  return `${body}\n\n${marker}\n`;
}

function findByMarker(issues: readonly IssueNode[], slug: string): IssueNode | undefined {
  const marker = seedMarker(slug);
  const matches = issues.filter((issue) => issue.description.includes(marker));
  if (matches.length > 1) throw new DemoResetError(`duplicate ${marker}`);
  return matches[0];
}

function requireIssue(issues: readonly IssueNode[], slug: string): IssueNode {
  const found = findByMarker(issues, slug);
  if (found === undefined) throw new DemoResetError(`missing ${seedMarker(slug)} after upsert`);
  return found;
}

function isPawsBranch(name: string): boolean {
  return name === "paws" || name.startsWith("paws/");
}

function edgeKey(blockerId: string, blockedId: string): string {
  return `${blockerId}|${blockedId}`;
}

function readPulls(stdout: string): Array<{ number: number; head: string }> {
  let parsed: unknown;
  try {
    parsed = stdout.trim() === "" ? [] : JSON.parse(stdout);
  } catch {
    throw new DemoResetError("gh pr list did not return JSON");
  }
  if (!Array.isArray(parsed)) throw new DemoResetError("gh pr list did not return a list");
  const pulls: Array<{ number: number; head: string }> = [];
  for (const entry of parsed) {
    const record = requireRecord(entry, "pull request");
    const number = record["number"];
    const head = record["headRefName"];
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
      throw new DemoResetError("pull request number is invalid");
    }
    if (typeof head !== "string" || head.length === 0) {
      throw new DemoResetError("pull request head is invalid");
    }
    pulls.push({ number, head });
  }
  return pulls;
}

function parseSeed(value: unknown): EpicSeed {
  const record = requireRecord(value, "epic seed");
  const teamKey = readString(record, "teamKey");
  const repo = readString(record, "repo");
  const label = readString(record, "label");
  if (teamKey === null || !TEAM_KEY.test(teamKey))
    throw new DemoResetError("seed teamKey is invalid");
  if (repo === null || !REPO_NAME.test(repo))
    throw new DemoResetError("seed repo must be owner/paws-demo");
  if (label === null || !SLUG.test(label)) throw new DemoResetError("seed label is invalid");
  const parent = parseNode(record["parent"], "parent");
  const childrenValue = record["children"];
  if (!Array.isArray(childrenValue) || childrenValue.length !== 3) {
    throw new DemoResetError("seed needs exactly 3 sub-issues");
  }
  const children = childrenValue.map((child, index) => parseChild(child, index));
  const slugs = new Set<string>([parent.slug]);
  for (const child of children) {
    if (slugs.has(child.slug)) throw new DemoResetError(`duplicate slug ${child.slug}`);
    slugs.add(child.slug);
  }
  for (const child of children) {
    for (const blocker of child.blockedBy) {
      if (!children.some((item) => item.slug === blocker)) {
        throw new DemoResetError(`${child.slug} is blocked by unknown ${blocker}`);
      }
      if (blocker === child.slug) throw new DemoResetError(`${child.slug} blocks itself`);
    }
  }
  assertAcyclic(children);
  return { teamKey, repo, label, parent, children };
}

function parseNode(value: unknown, label: string): EpicNodeSeed {
  const record = requireRecord(value, label);
  const slug = readString(record, "slug");
  const title = readString(record, "title");
  const description = readString(record, "description");
  if (slug === null || !SLUG.test(slug)) throw new DemoResetError(`${label} slug is invalid`);
  if (title === null || title.length > 255) throw new DemoResetError(`${label} title is invalid`);
  if (description === null) throw new DemoResetError(`${label} description is invalid`);
  return { slug, title, description };
}

function parseChild(value: unknown, index: number): EpicChildSeed {
  const node = parseNode(value, `child ${index}`);
  const record = requireRecord(value, `child ${index}`);
  const blockedByValue = record["blockedBy"];
  if (!Array.isArray(blockedByValue)) throw new DemoResetError(`${node.slug} blockedBy is invalid`);
  const blockedBy: string[] = [];
  for (const blocker of blockedByValue) {
    if (typeof blocker !== "string" || !SLUG.test(blocker)) {
      throw new DemoResetError(`${node.slug} blockedBy is invalid`);
    }
    blockedBy.push(blocker);
  }
  return { ...node, blockedBy };
}

function assertAcyclic(children: readonly EpicChildSeed[]): void {
  const bySlug = new Map(children.map((child) => [child.slug, child]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (slug: string): void => {
    const mark = state.get(slug);
    if (mark === "done") return;
    if (mark === "visiting") throw new DemoResetError(`cycle in blockedBy at ${slug}`);
    state.set(slug, "visiting");
    const child = bySlug.get(slug);
    if (child !== undefined) {
      for (const blocker of child.blockedBy) visit(blocker);
    }
    state.set(slug, "done");
  };
  for (const child of children) visit(child.slug);
}

function requirePayload(data: Record<string, unknown>, field: string): Record<string, unknown> {
  const payload = requireRecord(data[field], field);
  if (payload["success"] !== true) throw new DemoResetError(`${field} was not successful`);
  return payload;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DemoResetError(`${label} was not an object`);
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readConnection(value: unknown): {
  nodes: Record<string, unknown>[];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { nodes: [], hasNextPage: false, endCursor: null };
  }
  const record = value;
  const nodes = Array.isArray(record["nodes"])
    ? record["nodes"].filter(
        (node): node is Record<string, unknown> =>
          typeof node === "object" && node !== null && !Array.isArray(node),
      )
    : [];
  const pageInfo =
    typeof record["pageInfo"] === "object" &&
    record["pageInfo"] !== null &&
    !Array.isArray(record["pageInfo"])
      ? record["pageInfo"]
      : null;
  return {
    nodes,
    hasNextPage: pageInfo?.["hasNextPage"] === true,
    endCursor: pageInfo === null ? null : readString(pageInfo, "endCursor"),
  };
}

function redact(message: string, secret: string): DemoResetError {
  if (secret.length < 8) return new DemoResetError(message);
  return new DemoResetError(message.split(secret).join("[redacted]"));
}

const TEAMS_QUERY = `query DemoTeams {
  teams { nodes { id key name } }
}`;

const STATES_QUERY = `query DemoWorkflowStates($teamId: String!) {
  workflowStates(filter: { team: { id: { eq: $teamId } } }) {
    nodes { id name type }
  }
}`;

const LABEL_LOOKUP = `query DemoLabelLookup($teamId: String!, $name: String!) {
  issueLabels(filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) {
    nodes { id name }
  }
}`;

const LABEL_CREATE = `mutation DemoLabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id name } }
}`;

const ISSUES_QUERY = `query DemoIssues($teamId: String!) {
  issues(first: 50, filter: { team: { id: { eq: $teamId } }, description: { contains: "Seed: paws-demo:" } }) {
    nodes {
      id
      identifier
      title
      description
      parent { id }
      relations(first: 50) {
        nodes { id type relatedIssue { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ISSUE_CREATE = `mutation DemoIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier title description } }
}`;

const ISSUE_UPDATE = `mutation DemoIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id identifier } }
}`;

const COMMENTS_QUERY = `query DemoIssueComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 50, after: $after) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const COMMENT_DELETE = `mutation DemoCommentDelete($id: String!) {
  commentDelete(id: $id) { success }
}`;

const RELATION_CREATE = `mutation DemoRelationCreate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success issueRelation { id } }
}`;

const RELATION_DELETE = `mutation DemoRelationDelete($id: String!) {
  issueRelationDelete(id: $id) { success }
}`;

async function defaultCommandRunner(
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await exec(command, [...args], {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
  } catch (error) {
    const stdout =
      typeof error === "object" && error !== null && "stdout" in error
        ? String(error.stdout ?? "")
        : "";
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr ?? "")
        : "";
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return { stdout, stderr, exitCode: typeof code === "number" ? code : 1 };
  }
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new DemoResetError(`${name} needs a value`);
  }
  return value;
}

function formatReport(report: ResetReport): string {
  const lines = [
    `repo ${report.repo}`,
    `team ${report.teamKey}`,
    `parent ${report.parent.identifier} ${report.parent.title}`,
    ...report.subIssues.map((issue) => `sub-issue ${issue.identifier} ${issue.slug}`),
    `label ${report.label}`,
    `comments deleted ${report.commentsDeleted}`,
    `branches deleted ${report.branchesDeleted.join(", ") || "none"}`,
    `pulls closed ${report.pullsClosed.join(", ") || "none"}`,
    report.repoCreated ? "github repo created" : "github repo updated",
    "main pushed",
  ];
  return lines.join("\n");
}

function skipped(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === ".closeout";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--yes")) {
    console.error(
      "Refusing to reset without --yes. This force-pushes main on the paws-demo repo and rewrites its Linear issues.",
    );
    process.exitCode = 2;
    return;
  }
  const key = process.env["LINEAR_API_KEY"] ?? process.env["LINEAR_ACCESS_TOKEN"];
  if (key === undefined || key.length === 0) {
    console.error("Set LINEAR_API_KEY.");
    process.exitCode = 2;
    return;
  }
  const templateDir =
    process.env["PAWS_DEMO_TEMPLATE"] ?? join(import.meta.dir, "../examples/paws-demo");
  const seed = loadEpicSeed(join(templateDir, "epic/epic.json"));
  const report = await resetDemo({
    seed,
    templateDir,
    linear: createLinearClient({
      auth: {
        hasToken: () => true,
        ensureFresh: async () => key,
        forceRefresh: async () => {
          throw new DemoResetError("Linear API key was rejected");
        },
      },
    }),
    run: defaultCommandRunner,
    confirm: true,
    repo: flag(args, "--repo") ?? process.env["PAWS_DEMO_REPO"],
    teamKey: flag(args, "--team") ?? process.env["PAWS_DEMO_TEAM"],
  });
  console.log(formatReport(report));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
