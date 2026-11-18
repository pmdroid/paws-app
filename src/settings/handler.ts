import { journalCaught } from "../journal";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_CI_FIX_ATTEMPTS,
  DEFAULT_QUEUE_START_TIMEOUT_HOURS,
  loadConfigFile,
  parseAgentSettings,
  parseMergeSettings,
  parseProjectMemorySettings,
  parseQueueSettings,
  readAgentSettings,
  readConfigText,
  readMergeSettings,
  readProjectMemorySettings,
  readQueueSettings,
  removeRetiredConfigSection,
  retiredConfigSections,
  storedMerge,
  writeAgentSettings,
  type ImplementerName,
  type ProjectMemorySettings,
  type QueueSettings,
  type StoredMerge,
} from "../config";
import { isWorkspaceAdmin } from "../workspace";
import { reviewerRunnerWarnings, type RunnerReadiness } from "./reviewer-runners";

export type AgentSettingsOptions = {
  trustedOrigin?: string;
  configPath: string;
  csrfToken: string;
  repos?: string[];
  role?: string;
  /** Replace idle run profile snapshots after saving. Runs executing a turn are excluded. */
  applyToWaiting?: () => Promise<number>;
  /** Records a changed workspace setting in the audit history. */
  audit?: (action: string, subject: string) => Promise<void>;
  runnerReadiness?: (agent: ImplementerName) => RunnerReadiness[] | Promise<RunnerReadiness[]>;
};

function settingsRevision(configPath: string): string {
  const text = readConfigText(configPath);
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

const SETTINGS_PATH = "/api/settings/agents";

export async function handleAgentSettingsRequest(
  request: Request,
  options: AgentSettingsOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Agent settings are only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can read or change agent settings." }, 403);
  if (request.method === "GET" && url.pathname === SETTINGS_PATH) {
    try {
      const config = loadConfigFile(options.configPath);
      return json({
        ...readAgentSettings(config),
        merge: { ciFixAttempts: readMergeSettings(config).ciFixAttempts },
        queue: readQueueSettings(config),
        projectMemory: readProjectMemorySettings(config),
        revision: settingsRevision(options.configPath),
        ...retired(options.configPath),
      });
    } catch (caughtError1) {
      journalCaught(caughtError1, "handler.handleAgentSettingsRequest.loadConfigFile", null);
      return json({ error: "Agent settings could not be read" }, 503);
    }
  }
  if (request.method !== "PUT" && request.method !== "DELETE")
    return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  if (request.method === "DELETE") return removeRetired(request, options);
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (caughtError2) {
    journalCaught(caughtError2, "handler.handleAgentSettingsRequest.readJson", null);
    return json({ error: "Expected a JSON body of at most 128 KiB" }, 400);
  }
  let settings;
  let mergeBody: unknown;
  let queueBody: unknown;
  let projectMemoryBody: unknown;
  let applyToWaiting = false;
  let expectedRevision: string | undefined;
  try {
    // The workspace merge, queue and project memory settings travel next to the agent profiles.
    const {
      merge,
      queue,
      projectMemory: memory,
      applyToWaiting: apply,
      revision,
      ...agents
    }: Record<string, unknown> = isRecord(body) ? body : {};
    if (apply !== undefined && typeof apply !== "boolean")
      throw new Error("applyToWaiting must be a boolean");
    if (revision !== undefined && typeof revision !== "string")
      throw new Error("revision must be a string");
    applyToWaiting = apply === true;
    expectedRevision = revision;
    settings = parseAgentSettings(isRecord(body) ? agents : body);
    mergeBody = merge;
    queueBody = queue;
    projectMemoryBody = memory;
  } catch (error) {
    journalCaught(error, "handler.handleAgentSettingsRequest.isRecord", null);
    return json({ error: error instanceof Error ? error.message : "Invalid agent settings" }, 400);
  }
  // A malformed saved file is repaired by this write, so its merge values fall back to defaults.
  let previous: StoredMerge = {};
  let previousQueue: QueueSettings | null = null;
  let previousMemory: ProjectMemorySettings = { workSummary: false, dream: false };
  try {
    const config = loadConfigFile(options.configPath);
    previous = storedMerge(config);
    previousQueue = readQueueSettings(config);
    previousMemory = readProjectMemorySettings(config);
  } catch (caughtError3) {
    journalCaught(caughtError3, "handler.handleAgentSettingsRequest.loadConfigFile", null);
  }
  let merge: StoredMerge | undefined;
  let queue: QueueSettings | undefined;
  let projectMemory: ProjectMemorySettings | undefined;
  try {
    if (mergeBody !== undefined) merge = { ...previous, ...parseMergeSettings(mergeBody) };
    if (queueBody !== undefined)
      queue = {
        ...(previousQueue ?? {
          startTimeoutHours: DEFAULT_QUEUE_START_TIMEOUT_HOURS,
          maxRunningPerOwner: null,
        }),
        ...parseQueueSettings(queueBody),
      };
    if (projectMemoryBody !== undefined)
      projectMemory = { ...previousMemory, ...parseProjectMemorySettings(projectMemoryBody) };
  } catch (error) {
    journalCaught(error, "handler.handleAgentSettingsRequest.parseMergeSettings", null);
    return json({ error: error instanceof Error ? error.message : "Invalid agent settings" }, 400);
  }
  if (expectedRevision !== undefined && expectedRevision !== settingsRevision(options.configPath))
    return json(
      {
        error: "Settings changed since they were loaded. Reload them and apply your change again.",
        revision: settingsRevision(options.configPath),
      },
      409,
    );
  let saved: number;
  let savedQueue: QueueSettings;
  let savedMemory: ProjectMemorySettings;
  let waitingRuns = 0;
  try {
    await writeAgentSettings(options.configPath, settings, merge, queue, projectMemory);
    const config = loadConfigFile(options.configPath);
    saved = readMergeSettings(config).ciFixAttempts;
    savedQueue = queue ?? readQueueSettings(config);
    savedMemory = readProjectMemorySettings(config);
    if (applyToWaiting) waitingRuns = (await options.applyToWaiting?.()) ?? 0;
  } catch (caughtError4) {
    journalCaught(caughtError4, "handler.handleAgentSettingsRequest.writeAgentSettings", null);
    return json({ error: "Agent settings could not be saved" }, 503);
  }
  const before = previous.ciFixAttempts ?? DEFAULT_CI_FIX_ATTEMPTS;
  if (merge?.ciFixAttempts !== undefined && merge.ciFixAttempts !== before)
    await options.audit?.(
      "settings.ci-fix-attempts",
      `CI fix attempts ${before} → ${merge.ciFixAttempts}`,
    );
  const hoursBefore = previousQueue?.startTimeoutHours ?? DEFAULT_QUEUE_START_TIMEOUT_HOURS;
  if (queue !== undefined && queue.startTimeoutHours !== hoursBefore)
    await options.audit?.(
      "settings.queue-start-timeout",
      `Queue start timeout ${hoursBefore} h → ${queue.startTimeoutHours} h`,
    );
  const capBefore = previousQueue?.maxRunningPerOwner ?? null;
  if (queue !== undefined && queue.maxRunningPerOwner !== capBefore)
    await options.audit?.(
      "settings.queue-owner-cap",
      `Running tasks per owner ${capBefore ?? "no cap"} → ${queue.maxRunningPerOwner ?? "no cap"}`,
    );
  for (const [key, label] of [
    ["workSummary", "Project memory work summaries"],
    ["dream", "Project memory dream"],
  ] as const)
    if (projectMemory !== undefined && projectMemory[key] !== previousMemory[key])
      await options.audit?.(
        "settings.project-memory",
        `${label} ${previousMemory[key] ? "on" : "off"} → ${projectMemory[key] ? "on" : "off"}`,
      );
  let warnings: string[] = [];
  try {
    if (options.runnerReadiness)
      warnings = await reviewerRunnerWarnings(settings, options.runnerReadiness);
  } catch (caughtError5) {
    journalCaught(caughtError5, "handler.handleAgentSettingsRequest.runnerReadiness", null);
  }
  return json({
    ...settings,
    merge: { ciFixAttempts: saved },
    queue: savedQueue,
    projectMemory: savedMemory,
    revision: settingsRevision(options.configPath),
    ...(applyToWaiting ? { waitingRuns } : {}),
    ...(warnings.length ? { warnings } : {}),
  });
}

function retired(configPath: string): { retiredSections?: string[] } {
  const sections = retiredConfigSections(configPath);
  return sections.length > 0 ? { retiredSections: sections } : {};
}

async function removeRetired(request: Request, options: AgentSettingsOptions): Promise<Response> {
  let section: unknown;
  try {
    const body = await readJson(request);
    section = isRecord(body) ? body.section : undefined;
  } catch (error) {
    journalCaught(error, "handler.removeRetired.readJson", null);
  }
  if (typeof section !== "string" || !retiredConfigSections(options.configPath).includes(section))
    return json({ error: "Expected the section of a retired saved setting" }, 400);
  try {
    await removeRetiredConfigSection(options.configPath, section);
  } catch (error) {
    journalCaught(error, "handler.removeRetired.removeRetiredConfigSection", null);
    return json({ error: "The saved setting could not be removed" }, 503);
  }
  await options.audit?.("settings.retired-section", `Removed saved settings [${section}]`);
  return json({ ...retired(options.configPath), revision: settingsRevision(options.configPath) });
}

export function localRequest(request: Request, trustedOrigin?: string): boolean {
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

export function sameToken(token: string | null, expected: string): boolean {
  if (token === null) return false;
  const actual = Buffer.from(token);
  const correct = Buffer.from(expected);
  return actual.length === correct.length && timingSafeEqual(actual, correct);
}

export async function readJson(request: Request): Promise<unknown> {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
