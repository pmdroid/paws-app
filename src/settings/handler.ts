import { timingSafeEqual } from "node:crypto";
import {
  loadConfigFile,
  parseAgentProfile,
  parseAgentSettings,
  readAgentSettings,
  writeAgentSettings,
  type AgentProfile,
} from "../config";

export type AgentConnectionResult = {
  ok: boolean;
  agent: AgentProfile["agent"];
  model: string | null;
  models: { id: string; name: string }[];
  effort?: string | null;
  efforts?: { id: string; name: string }[];
  message: string;
};

export type AgentSettingsOptions = {
  configPath: string;
  csrfToken: string;
  probe: (profile: AgentProfile) => Promise<AgentConnectionResult>;
  repos?: string[];
};

const SETTINGS_PATH = "/api/settings/agents";
const TEST_PATH = `${SETTINGS_PATH}/test`;

export async function handleAgentSettingsRequest(
  request: Request,
  options: AgentSettingsOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== SETTINGS_PATH && url.pathname !== TEST_PATH) return null;
  if (!localRequest(request))
    return json({ error: "Agent settings are only available on the local Paws origin" }, 403);
  if (request.method === "GET" && url.pathname === SETTINGS_PATH) {
    try {
      const config = loadConfigFile(options.configPath);
      const settings = readAgentSettings(config);
      const projects = new Map(settings.projects.map((project) => [project.repo, project]));
      for (const repo of [config.repo, ...config.githubRepos, ...(options.repos ?? [])]) {
        if (repo === null) continue;
        const key = repo.toLowerCase();
        if (!projects.has(key)) projects.set(key, { repo: key });
      }
      return json({ ...settings, projects: [...projects.values()] });
    } catch {
      return json({ error: "Agent settings could not be read" }, 503);
    }
  }
  const write = request.method === "PUT" && url.pathname === SETTINGS_PATH;
  const probe = request.method === "POST" && url.pathname === TEST_PATH;
  if (!write && !probe) return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return json({ error: "Expected a JSON body of at most 128 KiB" }, 400);
  }
  if (write) {
    let settings;
    try {
      settings = parseAgentSettings(body);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Invalid agent settings" },
        400,
      );
    }
    try {
      writeAgentSettings(options.configPath, settings);
      return json(settings);
    } catch {
      return json({ error: "Agent settings could not be saved" }, 503);
    }
  }
  let profile;
  try {
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("profile" in body)
    )
      throw new Error("Expected one agent profile");
    profile = parseAgentProfile(body.profile);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid agent profile" }, 400);
  }
  try {
    return json(await options.probe(profile));
  } catch {
    return json({
      ok: false,
      agent: profile.agent,
      model: profile.model,
      models: [],
      message: "The local agent connection failed. Check its vendor login and try again.",
    });
  }
}

function localRequest(request: Request): boolean {
  const url = new URL(request.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
  const host = request.headers.get("host");
  if (host !== null && host.toLowerCase() !== url.host.toLowerCase()) return false;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return false;
  return request.headers.get("sec-fetch-site") !== "cross-site";
}

function sameToken(token: string | null, expected: string): boolean {
  if (token === null) return false;
  const actual = Buffer.from(token);
  const correct = Buffer.from(expected);
  return actual.length === correct.length && timingSafeEqual(actual, correct);
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    throw new Error("Expected JSON");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 128 * 1024) {
        await reader.cancel();
        throw new Error("Body too large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
