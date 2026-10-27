import { isAbsolute, join } from "node:path";
import { loadEnv, loadRunnerControl } from "../config";

/** What `paws install` writes. An empty string leaves the value unset. */
export type InstallAnswers = {
  checkout: string;
  home: string;
  host: string;
  port: number;
  publicDashboard: boolean;
  publicUrl: string;
  runnerHost: string;
  runnerPort: number;
  linearTeam: string;
  githubRepos: string[];
};

export const ANSWER_KEYS = [
  "checkout",
  "paws_home",
  "paws_host",
  "paws_port",
  "paws_public_dashboard",
  "paws_public_url",
  "paws_runner_host",
  "paws_runner_port",
  "linear_team",
  "github_repos",
] as const;

export type AnswerKey = (typeof ANSWER_KEYS)[number];

export type RawAnswers = Partial<Record<AnswerKey, string>>;

/** Typed into a prompt to clear an optional value. */
export const NONE = "-";

type Field = {
  question: string;
  optional?: boolean;
  /** Returns the normalized value or throws with what to fix. */
  check(value: string, answers: RawAnswers, home: string): string;
};

export const FIELDS: Record<AnswerKey, Field> = {
  checkout: { question: "Paws checkout path", check: (value, _, home) => path(value, home) },
  paws_home: { question: "PAWS_HOME", check: (value, _, home) => path(value, home) },
  paws_host: { question: "PAWS_HOST", check: (value) => hostname(value, "PAWS_HOST") },
  paws_port: {
    question: "PAWS_PORT",
    check: (value) => String(loadEnv({ PAWS_PORT: value }).port),
  },
  paws_public_dashboard: { question: "PAWS_PUBLIC_DASHBOARD (yes/no)", check: yesNo },
  paws_public_url: {
    question: "PAWS_PUBLIC_URL",
    optional: true,
    check: (value, answers) => publicUrl(value, answers.paws_public_dashboard === "yes"),
  },
  paws_runner_host: {
    question: "PAWS_RUNNER_HOST",
    optional: true,
    check: (value) => (value === "" ? "" : hostname(value, "PAWS_RUNNER_HOST")),
  },
  paws_runner_port: {
    question: "PAWS_RUNNER_PORT",
    check: (value, answers) => {
      const control = loadRunnerControl(
        { PAWS_RUNNER_HOST: answers.paws_runner_host || "localhost", PAWS_RUNNER_PORT: value },
        loadEnv({}),
      );
      return String(control!.port);
    },
  },
  linear_team: { question: "Linear team key or id", optional: true, check: linearTeam },
  github_repos: {
    question: "GitHub repositories (owner/repo, comma-separated)",
    optional: true,
    check: (value) => repositories(value).join(", "),
  },
};

export function toAnswers(raw: Required<RawAnswers>): InstallAnswers {
  return {
    checkout: raw.checkout,
    home: raw.paws_home,
    host: raw.paws_host,
    port: Number(raw.paws_port),
    publicDashboard: raw.paws_public_dashboard === "yes",
    publicUrl: raw.paws_public_url,
    runnerHost: raw.paws_runner_host,
    runnerPort: Number(raw.paws_runner_port),
    linearTeam: raw.linear_team,
    githubRepos: repositories(raw.github_repos),
  };
}

/** Values from a TOML answers file, as the strings a person would type. */
export function parseAnswersFile(text: string): RawAnswers {
  const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  const raw: RawAnswers = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isAnswerKey(key)) throw new Error(`The answers file has an unknown key: ${key}`);
    if (typeof value === "string") raw[key] = value;
    else if (typeof value === "number") raw[key] = String(value);
    else if (typeof value === "boolean") raw[key] = value ? "yes" : "no";
    else if (Array.isArray(value) && value.every((item) => typeof item === "string"))
      raw[key] = value.join(", ");
    else throw new Error(`The answers file value for ${key} is not supported`);
  }
  return raw;
}

export function isAnswerKey(key: string): key is AnswerKey {
  return (ANSWER_KEYS as readonly string[]).includes(key);
}

export function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

function path(value: string, home: string): string {
  const expanded = expandHome(value.trim(), home);
  if (!isAbsolute(expanded)) throw new Error("Enter an absolute path or one starting with ~/.");
  if (/\s/.test(expanded)) throw new Error("The path cannot contain whitespace.");
  return expanded.length > 1 ? expanded.replace(/\/+$/, "") : expanded;
}

function hostname(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} cannot be empty.`);
  loadRunnerControl({ PAWS_RUNNER_HOST: trimmed }, loadEnv({}));
  return trimmed;
}

function yesNo(value: string): string {
  const lower = value.trim().toLowerCase();
  if (["y", "yes", "true", "on", "1"].includes(lower)) return "yes";
  if (["n", "no", "false", "off", "0"].includes(lower)) return "no";
  throw new Error("Answer yes or no.");
}

function publicUrl(value: string, dashboard: boolean): string {
  const trimmed = value.trim();
  if (!trimmed) {
    if (dashboard) throw new Error("The public dashboard needs PAWS_PUBLIC_URL.");
    return "";
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("PAWS_PUBLIC_URL must be a URL such as https://paws.example.com.");
  }
  if (url.protocol !== "https:" && (dashboard || url.protocol !== "http:"))
    throw new Error("PAWS_PUBLIC_URL must use https.");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("PAWS_PUBLIC_URL must be an origin with no path, query or credentials.");
  return url.origin;
}

function linearTeam(value: string): string {
  const trimmed = value.trim();
  if (trimmed && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed))
    throw new Error("Enter a Linear team key such as ENG.");
  return trimmed;
}

function repositories(value: string): string[] {
  const repos = value
    .split(",")
    .map((repo) => repo.trim().toLowerCase())
    .filter((repo) => repo.length > 0);
  for (const repo of repos)
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo))
      throw new Error(`${repo} is not an owner/repo name.`);
  return [...new Set(repos)];
}
