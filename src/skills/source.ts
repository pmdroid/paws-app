import { SkillError } from "./bundle";
import type { SkillRequest } from "./resolve";

type GitRequest = Extract<SkillRequest, { kind: "git" }>;

const GIT = /^(?:https?|ssh|git|file):\/\/|^[\w.-]+@[\w.-]+:|^\/|\.git\/*$/;
const HOSTED = /^(?:github\.com|gitlab\.com|bitbucket\.org)\//;
const SHORTHAND = /^\w[\w.-]*\/\w[\w.-]*$/;
const GITHUB = /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/(tree|blob)\/(.+)$/;

export function readSkillSource(text: string): SkillRequest {
  const value = text.trim();
  if (!value) throw new SkillError("Choose an npm package or a git URL.");
  if (value.startsWith("npm:")) return npmSource(value.slice(4).trim());
  if (GIT.test(value) || HOSTED.test(value) || SHORTHAND.test(value)) return gitSource(value);
  return npmSource(value);
}

export function gitSource(text: string): GitRequest {
  const value = text.trim().replace(/(?<=[^/])\/+$/, "");
  if (SHORTHAND.test(value)) return { kind: "git", url: `https://github.com/${value}` };
  const tree = GITHUB.exec(value);
  if (tree) {
    const [, owner, repo, kind, rest] = tree;
    const path = kind === "blob" ? rest!.split("/").slice(0, -1).join("/") : rest!;
    return { kind: "git", url: `https://github.com/${owner}/${repo}`, ...(path ? { path } : {}) };
  }
  return { kind: "git", url: HOSTED.test(value) ? `https://${value}` : value };
}

function npmSource(value: string): SkillRequest {
  const at = value.lastIndexOf("@");
  return at > 0
    ? { kind: "npm", package: value.slice(0, at), version: value.slice(at + 1) }
    : { kind: "npm", package: value };
}
