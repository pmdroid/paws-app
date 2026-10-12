import { createInterface } from "node:readline";
import type { GitHubTokenStore } from "../auth";
import type { StoredLinearToken } from "../linear";

export type LinearReconnect = (home: string) => {
  complete(input: { clientId: string; token: StoredLinearToken }): Promise<boolean>;
};

export type SetupGitHubHooks = {
  port?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => Promise<void>;
  store?: GitHubTokenStore;
  now?: () => number;
};

export type SetupLinearHooks = {
  port?: number;
  timeoutMs?: number;
  onAuthorize?: (url: string) => void | Promise<void>;
};

/** Enough of `fetch` for Linear. */
export type SetupFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type SetupIO = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetch?: SetupFetch;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readLine: () => Promise<string | null>;
  github?: SetupGitHubHooks;
  linear?: SetupLinearHooks;
  linearReconnect?: LinearReconnect;
};

export type SetupOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetch?: SetupFetch;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  readLine?: () => Promise<string | null>;
  github?: SetupGitHubHooks;
  linear?: SetupLinearHooks;
  linearReconnect?: LinearReconnect;
};

export function createIO(options?: SetupOptions): SetupIO {
  return {
    env: options?.env ?? process.env,
    cwd: options?.cwd ?? process.cwd(),
    ...(options?.fetch ? { fetch: options.fetch } : {}),
    stdout: options?.stdout ?? ((line) => console.log(line)),
    stderr: options?.stderr ?? ((line) => console.error(line)),
    readLine: options?.readLine ?? readStdinLine,
    ...(options?.github ? { github: options.github } : {}),
    ...(options?.linear ? { linear: options.linear } : {}),
    ...(options?.linearReconnect ? { linearReconnect: options.linearReconnect } : {}),
  };
}

export function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** `acp` git and `inferGitHubRepository` spawn `git` from `process.env`. */
export async function withProcessPath<T>(
  pathValue: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (pathValue === undefined || pathValue === process.env.PATH) return fn();
  const previous = process.env.PATH;
  process.env.PATH = pathValue;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

async function readStdinLine(): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  try {
    for await (const line of rl) {
      return line;
    }
    return null;
  } finally {
    rl.close();
  }
}
