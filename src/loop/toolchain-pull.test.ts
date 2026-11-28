import { expect, test } from "bun:test";
import type { GitHubBinding, GitHubResponse } from "../github";
import { formatToolchainQuestion, type ToolchainFile } from "../runner-protocol";
import { addToolchainEntries, toolchainPullContext } from "./toolchain-pull";

const repository = { owner: "acme", repo: "app", remoteUrl: "https://github.com/acme/app.git" };

function fakeRepository(files: Record<string, string> = {}) {
  const commits = new Map<string, Record<string, string>>([["main1", files]]);
  const refs = new Map<string, string>([["main", "main1"]]);
  const pulls: { number: number; html_url: string; body: string; title: string }[] = [];
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const trees = new Map<string, Record<string, string>>();
  let fail = false;
  const respond = (method: string, path: string, body: Record<string, unknown>): GitHubResponse => {
    if (fail) return { status: 500, body: { message: "synthetic failure" } };
    const route = path.replace("/repos/acme/app", "");
    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(route);
    if (method === "GET" && ref) {
      const tip = refs.get(ref[1]!);
      return tip ? { status: 200, body: { object: { sha: tip } } } : { status: 404, body: {} };
    }
    if (method === "GET" && route.startsWith("/pulls?"))
      return { status: 200, body: refs.has("paws/toolchain") ? pulls : [] };
    const content = /^\/contents\/([^?]+)\?ref=(.+)$/.exec(route);
    if (method === "GET" && content) {
      const text = commits.get(content[2]!)?.[content[1]!];
      return text === undefined
        ? { status: 404, body: {} }
        : { status: 200, body: { content: Buffer.from(text).toString("base64") } };
    }
    const commit = /^\/git\/commits\/(.+)$/.exec(route);
    if (method === "GET" && commit) return { status: 200, body: { tree: { sha: commit[1] } } };
    if (method === "POST" && route === "/git/trees") {
      const id = `tree${trees.size + 1}`;
      const entries = body.tree as { path: string; content: string }[];
      trees.set(id, {
        ...commits.get(String(body.base_tree)),
        ...Object.fromEntries(entries.map((entry) => [entry.path, entry.content])),
      });
      return { status: 201, body: { sha: id } };
    }
    if (method === "POST" && route === "/git/commits") {
      const id = `commit${commits.size + 1}`;
      commits.set(id, trees.get(String(body.tree))!);
      return { status: 201, body: { sha: id } };
    }
    if (method === "POST" && route === "/git/refs") {
      refs.set(String(body.ref).replace("refs/heads/", ""), String(body.sha));
      return { status: 201, body: {} };
    }
    const moved = /^\/git\/refs\/heads\/(.+)$/.exec(route);
    if (method === "PATCH" && moved) {
      refs.set(moved[1]!, String(body.sha));
      return { status: 200, body: {} };
    }
    if (method === "POST" && route === "/pulls") {
      const pull = {
        number: pulls.length + 1,
        html_url: `https://github.com/acme/app/pull/${pulls.length + 1}`,
        body: String(body.body),
        title: String(body.title),
      };
      pulls.push(pull);
      return { status: 201, body: pull };
    }
    return { status: 404, body: { message: `unexpected ${method} ${route}` } };
  };
  const github: GitHubBinding = {
    appId: "1",
    installationId: "2",
    privateKeyPem: "unused",
    tokenProvider: { mode: "token", tokenFor: async () => "fake-token" },
    client: {
      request: async (request) => {
        calls.push({ method: request.method, path: request.path, body: request.body });
        return respond(
          request.method,
          request.path,
          (request.body ?? {}) as Record<string, unknown>,
        );
      },
    },
  };
  return {
    github,
    calls,
    pulls,
    branchFile: (file: string) => commits.get(refs.get("paws/toolchain") ?? "")?.[file],
    mainTip: () => refs.get("main"),
    failAll: () => (fail = true),
  };
}

function question(entries: { name: string; version: string }[], file: ToolchainFile = "mise.toml") {
  return formatToolchainQuestion({
    descriptions: ["package.json needs node, which isn't installed on the runner."],
    file,
    entries,
  });
}

const item = (n: number) => ({ id: `item${n}`, linearIdentifier: `PAS-${n}` });

test("a toolchain question without mise.toml opens one pull request with exactly the entries", async () => {
  const fake = fakeRepository();
  const lines: string[] = [];
  const context = await toolchainPullContext({
    question: question([
      { name: "node", version: "22" },
      { name: "rust", version: "1.86" },
    ]),
    item: item(1),
    repository,
    github: fake.github,
    journal: (line) => lines.push(line),
  });
  expect(context).toBe(
    "Paws opened https://github.com/acme/app/pull/1 with these entries. Merge it and this issue continues by itself.",
  );
  expect(fake.branchFile("mise.toml")).toBe('[tools]\nnode = "22"\nrust = "1.86"\n');
  expect(fake.pulls).toHaveLength(1);
  expect(fake.pulls[0]!.title).toBe("Declare the tools Paws runners need");
  expect(fake.pulls[0]!.body).toContain("mise.toml");
  expect(fake.pulls[0]!.body).toContain("PAS-1");
  expect(fake.mainTip()).toBe("main1");
  expect(fake.calls.some((call) => call.path.includes("/merge"))).toBe(false);
  expect(lines).toEqual([]);
});

test("entries go under the existing [tools] table and a second item reuses the pull request", async () => {
  const fake = fakeRepository({
    "mise.toml": '[env]\nA = "1"\n\n[tools]\nbun = "1.4"\n\n[tasks.x]\nrun = "y"\n',
  });
  const first = await toolchainPullContext({
    question: question([{ name: "node", version: "22" }]),
    item: item(1),
    repository,
    github: fake.github,
  });
  expect(fake.branchFile("mise.toml")).toBe(
    '[env]\nA = "1"\n\n[tools]\nbun = "1.4"\nnode = "22"\n\n[tasks.x]\nrun = "y"\n',
  );
  const second = await toolchainPullContext({
    question: question([
      { name: "node", version: "22" },
      { name: "go", version: "1.24" },
    ]),
    item: item(2),
    repository,
    github: fake.github,
  });
  expect(second).toBe(first);
  expect(fake.pulls).toHaveLength(1);
  expect(fake.branchFile("mise.toml")).toBe(
    '[env]\nA = "1"\n\n[tools]\nbun = "1.4"\nnode = "22"\ngo = "1.24"\n\n[tasks.x]\nrun = "y"\n',
  );
  expect(fake.mainTip()).toBe("main1");
});

test("a .tool-versions question replaces the tool's line or adds one", async () => {
  const fake = fakeRepository({ ".tool-versions": "node 18\nbun 1.4\n" });
  await toolchainPullContext({
    question: question(
      [
        { name: "node", version: "22" },
        { name: "go", version: "1.24" },
      ],
      ".tool-versions",
    ),
    item: item(1),
    repository,
    github: fake.github,
  });
  expect(fake.branchFile(".tool-versions")).toBe("node 22\nbun 1.4\ngo 1.24\n");
});

test("a failing GitHub or an unknown repository leaves the question unchanged and journals", async () => {
  const fake = fakeRepository();
  fake.failAll();
  const lines: string[] = [];
  const asked = question([{ name: "node", version: "22" }]);
  expect(
    await toolchainPullContext({
      question: asked,
      item: item(1),
      repository,
      github: fake.github,
      journal: (line) => lines.push(line),
    }),
  ).toBeNull();
  expect(
    await toolchainPullContext({
      question: asked,
      item: item(2),
      repository: null,
      github: null,
      journal: (line) => lines.push(line),
    }),
  ).toBeNull();
  expect(lines).toEqual([
    'toolchain_pr_failed item=item1 reason="listing open toolchain pull requests failed with status 500"',
    'toolchain_pr_failed item=item2 reason="the repository is unknown"',
  ]);
});

test("an ordinary agent question opens nothing", async () => {
  const fake = fakeRepository();
  const lines: string[] = [];
  expect(
    await toolchainPullContext({
      question: "Which database should the new table use?",
      item: item(1),
      repository,
      github: fake.github,
      journal: (line) => lines.push(line),
    }),
  ).toBeNull();
  expect(fake.calls).toEqual([]);
  expect(lines).toEqual([]);
});

test("addToolchainEntries never adds a second [tools] header", () => {
  expect(
    addToolchainEntries("mise.toml", '[env]\nA = "1"\n', [{ name: "node", version: "22" }]),
  ).toBe('[env]\nA = "1"\n\n[tools]\nnode = "22"\n');
  expect(
    addToolchainEntries("mise.toml", '[tools]\nnode = "20"\n', [{ name: "node", version: "22" }]),
  ).toBe('[tools]\nnode = "20"\n');
});
