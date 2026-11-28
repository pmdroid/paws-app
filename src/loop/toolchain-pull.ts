import type { RepositoryBinding } from "../core";
import {
  createAppTokenProvider,
  openPullRequest,
  type GitHubBinding,
  type GitHubResponse,
} from "../github";
import { journal as defaultJournal } from "../journal";
import {
  parseToolchainQuestion,
  type ToolchainEntry,
  type ToolchainFile,
  type ToolchainQuestion,
} from "../runner-protocol";

export const TOOLCHAIN_BRANCH = "paws/toolchain";
const TOOLCHAIN_TITLE = "Declare the tools Paws runners need";

export function addToolchainEntries(
  file: ToolchainFile,
  current: string | null,
  entries: readonly ToolchainEntry[],
): string {
  const text = current ?? "";
  return file === "mise.toml" ? addMiseEntries(text, entries) : addToolVersions(text, entries);
}

function addMiseEntries(text: string, entries: readonly ToolchainEntry[]): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const header = lines.findIndex((line) => /^\s*\[tools\]\s*(#.*)?$/.test(line));
  if (header < 0) {
    const added = entries.map((entry) => `${entry.name} = "${entry.version}"`);
    const prefix = lines.length === 0 ? [] : [...lines, ""];
    return `${[...prefix, "[tools]", ...added].join("\n")}\n`;
  }
  let end = lines.findIndex((line, at) => at > header && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  const table = lines.slice(header + 1, end);
  const declared = (name: string) =>
    table.some((line) => new RegExp(`^\\s*"?${escape(name)}"?\\s*=`).test(line));
  const added = entries
    .filter((entry) => !declared(entry.name))
    .map((entry) => `${entry.name} = "${entry.version}"`);
  let at = end;
  while (at > header + 1 && lines[at - 1]!.trim() === "") at--;
  lines.splice(at, 0, ...added);
  return `${lines.join("\n")}\n`;
}

function addToolVersions(text: string, entries: readonly ToolchainEntry[]): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  for (const entry of entries) {
    const line = `${entry.name} ${entry.version}`;
    const at = lines.findIndex((row) => new RegExp(`^\\s*${escape(entry.name)}\\s`).test(row));
    if (at < 0) lines.push(line);
    else lines[at] = line;
  }
  return `${lines.join("\n")}\n`;
}

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

export type ToolchainPullInput = {
  question: string;
  item: { id: string; linearIdentifier: string };
  repository: RepositoryBinding | null;
  github: GitHubBinding | null;
  journal?: (line: string) => void;
};

export async function toolchainPullContext(input: ToolchainPullInput): Promise<string | null> {
  const parsed = parseToolchainQuestion(input.question);
  if (parsed === null) return null;
  const fail = (reason: string) => {
    (input.journal ?? defaultJournal)(
      `toolchain_pr_failed item=${input.item.id} reason=${JSON.stringify(reason)}`,
    );
    return null;
  };
  if (!input.repository || !input.github) return fail("the repository is unknown");
  try {
    const url = await openToolchainPull(parsed, input.item, input.repository, input.github);
    return `Paws opened ${url} with these entries. Merge it and this issue continues by itself.`;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function openToolchainPull(
  question: ToolchainQuestion,
  item: { linearIdentifier: string },
  repository: RepositoryBinding,
  github: GitHubBinding,
): Promise<string> {
  const { owner, repo } = repository;
  const provider =
    github.tokenProvider ??
    createAppTokenProvider({
      client: github.client,
      appId: github.appId,
      installationId: github.installationId,
      privateKeyPem: github.privateKeyPem,
      owner,
      repo,
    });
  const token = await provider.tokenFor("push");
  const call = async (method: "GET" | "POST" | "PATCH", suffix: string, body?: unknown) =>
    github.client.request({
      method,
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`,
      token,
      ...(body === undefined ? {} : { body }),
    });
  const ok = (response: GitHubResponse, statuses: number[], what: string) => {
    if (!statuses.includes(response.status))
      throw new Error(`${what} failed with status ${response.status}`);
    return (response.body ?? {}) as Record<string, unknown>;
  };
  const sha = (body: Record<string, unknown>, what: string) => {
    const value = (body.object as { sha?: unknown } | undefined)?.sha ?? body.sha;
    if (typeof value !== "string") throw new Error(`${what} has no sha`);
    return value;
  };
  const listed = ok(
    await call(
      "GET",
      `/pulls?head=${encodeURIComponent(`${owner}:${TOOLCHAIN_BRANCH}`)}&state=open`,
    ),
    [200],
    "listing open toolchain pull requests",
  );
  const open = Array.isArray(listed) ? (listed[0] as Record<string, unknown> | undefined) : null;
  const existing = open && typeof open.html_url === "string" ? open.html_url : null;
  const branchRead = await call("GET", `/git/ref/heads/${TOOLCHAIN_BRANCH}`);
  const branchTip =
    branchRead.status === 404
      ? null
      : sha(ok(branchRead, [200], `reading ${TOOLCHAIN_BRANCH}`), TOOLCHAIN_BRANCH);
  if (existing && branchTip === null) throw new Error(`${TOOLCHAIN_BRANCH} is missing`);
  const base =
    existing && branchTip
      ? branchTip
      : sha(ok(await call("GET", "/git/ref/heads/main"), [200], "reading main"), "main");
  const read = await call("GET", `/contents/${question.file}?ref=${encodeURIComponent(base)}`);
  const file = read.status === 404 ? null : ok(read, [200], `reading ${question.file}`);
  const current =
    file === null ? null : Buffer.from(String(file.content ?? ""), "base64").toString("utf8");
  const next = addToolchainEntries(question.file, current, question.entries);
  if (next !== current) {
    const commit = ok(await call("GET", `/git/commits/${base}`), [200], "reading the base");
    const tree = ok(
      await call("POST", "/git/trees", {
        base_tree: (commit.tree as { sha?: unknown } | undefined)?.sha,
        tree: [{ path: question.file, mode: "100644", type: "blob", content: next }],
      }),
      [201],
      "writing the tree",
    );
    const created = ok(
      await call("POST", "/git/commits", {
        message: `Declare the tools Paws runners need in ${question.file}`,
        tree: sha(tree, "tree"),
        parents: [base],
      }),
      [201],
      "writing the commit",
    );
    const head = sha(created, "commit");
    ok(
      branchTip === null
        ? await call("POST", "/git/refs", { ref: `refs/heads/${TOOLCHAIN_BRANCH}`, sha: head })
        : await call("PATCH", `/git/refs/heads/${TOOLCHAIN_BRANCH}`, {
            sha: head,
            force: !existing,
          }),
      [200, 201],
      `moving ${TOOLCHAIN_BRANCH}`,
    );
  } else if (!existing) throw new Error(`main already declares these entries in ${question.file}`);
  if (existing) return existing;
  const opened = await openPullRequest({
    issue: "toolchain",
    branchKey: "toolchain",
    owner,
    repo,
    title: TOOLCHAIN_TITLE,
    description: `Adds the tools that runners asked for to ${question.file} for ${item.linearIdentifier}. Runners install tools only from main, so the item waits until a person merges this.`,
    evidence: "",
    client: github.client,
    tokenProvider: provider,
  });
  if (!opened.url) throw new Error("the opened pull request has no URL");
  return opened.url;
}
