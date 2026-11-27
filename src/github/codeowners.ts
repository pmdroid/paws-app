import { repoApiPath } from "./client";
import { compareChangedPaths, repositoryGet } from "./compare";
import type { GitHubClient } from "./types";

const LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

type Rule = { pattern: RegExp; owners: string[] };

export function parseCodeowners(text: string): Rule[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const content = line.replace(/(^|\s)#.*$/, "").trim();
    if (!content) return [];
    const [raw, ...owners] = content.split(/\s+/);
    if (raw!.startsWith("!") || /[[\]]/.test(raw!) || raw!.startsWith("\\#"))
      throw new Error(`CODEOWNERS line ${index + 1} uses an unsupported pattern: ${raw}`);
    return [{ pattern: patternRegex(raw!), owners: owners.map((owner) => owner.toLowerCase()) }];
  });
}

export function ownsAnyPath(rules: Rule[], login: string, paths: readonly string[]): boolean {
  const owner = `@${login.toLowerCase()}`;
  return paths.some(
    (path) => rules.findLast((rule) => rule.pattern.test(path))?.owners.includes(owner) ?? false,
  );
}

function patternRegex(raw: string): RegExp {
  const directory = raw.endsWith("/");
  const trimmed = directory ? raw.slice(0, -1) : raw;
  const anchored = trimmed.includes("/");
  const pattern = trimmed.replace(/^\//, "");
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      const slash = pattern[index + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  const last = pattern.slice(pattern.lastIndexOf("/") + 1);
  const end = directory ? "/" : last.includes("*") ? "$" : "(?:/|$)";
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${source}${end}`);
}

export async function memberOwnsChangedPath(input: {
  client: GitHubClient;
  token: string;
  owner: string;
  repo: string;
  head: string;
  login: string;
}): Promise<boolean> {
  let text: string | null = null;
  for (const location of LOCATIONS) {
    const read = await input.client.request({
      method: "GET",
      path: `${repoApiPath(input.owner, input.repo, `/contents/${location}`)}?ref=${encodeURIComponent(input.head)}`,
      token: input.token,
    });
    if (read.status === 404) continue;
    const body = read.body as { content?: unknown; encoding?: unknown } | null;
    if (read.status !== 200 || typeof body?.content !== "string" || body.encoding !== "base64")
      throw new Error(`GitHub answered ${read.status} reading ${location}`);
    text = Buffer.from(body.content, "base64").toString("utf8");
    break;
  }
  if (text === null) return false;
  const rules = parseCodeowners(text);
  const { paths } = await compareChangedPaths(repositoryGet(input), "main", input.head);
  return ownsAnyPath(rules, input.login, paths);
}
