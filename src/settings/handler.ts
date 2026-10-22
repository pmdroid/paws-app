import { timingSafeEqual } from "node:crypto";
import {
  DEFAULT_CI_FIX_ATTEMPTS,
  DEFAULT_QUEUE_START_TIMEOUT_HOURS,
  formatQueueTimeout,
  loadConfigFile,
  parseAgentSettings,
  parseMergeSettings,
  parseQueueSettings,
  readAgentSettings,
  readMergeSettings,
  readQueueSettings,
  writeAgentSettings,
  type MergeSettings,
  type QueueSettings,
} from "../config";

export type AgentSettingsOptions = {
  trustedOrigin?: string;
  configPath: string;
  csrfToken: string;
  repos?: string[];
  /** Records a changed workspace setting in the audit history. */
  audit?: (action: string, subject: string) => void;
};

const SETTINGS_PATH = "/api/settings/agents";

export async function handleAgentSettingsRequest(
  request: Request,
  options: AgentSettingsOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
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
      return json({
        ...settings,
        projects: [...projects.values()],
        merge: readMergeSettings(config),
        queue: readQueueSettings(config),
      });
    } catch {
      return json({ error: "Agent settings could not be read" }, 503);
    }
  }
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return json({ error: "Expected a JSON body of at most 128 KiB" }, 400);
  }
  let settings;
  let mergeBody: unknown;
  let queue: QueueSettings | undefined;
  try {
    // The workspace merge and queue settings travel next to the agent profiles.
    const {
      merge,
      queue: queueBody,
      ...agents
    }: Record<string, unknown> = isRecord(body) ? body : {};
    settings = parseAgentSettings(isRecord(body) ? agents : body);
    mergeBody = merge;
    if (queueBody !== undefined) queue = parseQueueSettings(queueBody);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid agent settings" }, 400);
  }
  // A malformed saved file is repaired by this write, so its merge values fall back to defaults.
  let previous: MergeSettings | null = null;
  let previousQueue: QueueSettings | null = null;
  try {
    const config = loadConfigFile(options.configPath);
    previous = readMergeSettings(config);
    previousQueue = readQueueSettings(config);
  } catch {}
  let merge: MergeSettings | undefined;
  try {
    if (mergeBody !== undefined)
      merge = {
        ...(previous ?? { closeoutAfterUpdate: false, ciFixAttempts: DEFAULT_CI_FIX_ATTEMPTS }),
        ...parseMergeSettings(mergeBody),
      };
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid agent settings" }, 400);
  }
  let saved: MergeSettings;
  let savedQueue: QueueSettings;
  try {
    writeAgentSettings(options.configPath, settings, merge, queue);
    const config = loadConfigFile(options.configPath);
    saved = merge ?? readMergeSettings(config);
    savedQueue = queue ?? readQueueSettings(config);
  } catch {
    return json({ error: "Agent settings could not be saved" }, 503);
  }
  const before = previous?.ciFixAttempts ?? DEFAULT_CI_FIX_ATTEMPTS;
  if (merge !== undefined && merge.ciFixAttempts !== before)
    options.audit?.(
      "settings.ci-fix-attempts",
      `CI fix attempts ${before} → ${merge.ciFixAttempts}`,
    );
  const timeoutBefore = previousQueue?.startTimeoutHours ?? DEFAULT_QUEUE_START_TIMEOUT_HOURS;
  if (queue !== undefined && queue.startTimeoutHours !== timeoutBefore)
    options.audit?.(
      "settings.queue-start-timeout",
      `Queue start timeout ${formatQueueTimeout(timeoutBefore)} → ${formatQueueTimeout(queue.startTimeoutHours)}`,
    );
  return json({ ...settings, merge: saved, queue: savedQueue });
}

function localRequest(request: Request, trustedOrigin?: string): boolean {
  const url = new URL(request.url);
  if (
    trustedOrigin === undefined
      ? !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      : url.origin !== trustedOrigin
  )
    return false;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
