import { isWorkspaceAdmin } from "../workspace";
import { journalCaught } from "../journal";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  HOOK_AGENTS,
  HOOK_EVENT_LABELS,
  HOOK_EVENTS,
  HOOK_TIMEOUT_DEFAULT_SECONDS,
  WORKSPACE_HOOK_LIMIT,
  workspaceHookProblem,
  type HookAgent,
  type HookEvent,
  type WorkspaceHook,
} from "../core";
import { deleteHook, listHooks, listSkills, saveHook } from "../db";
import {
  addUploadedSkill,
  SKILL_BUNDLE_LIMIT,
  SkillError,
  skillFile,
  type SkillResolver,
} from "../skills";
import { isRecord, json, localRequest, readJson, sameToken } from "./handler";
import { readSkillUpload } from "./upload";

export const HOOK_SETTINGS_PATH = "/api/settings/hooks";

export type HookSettingsOptions = {
  db: Database;
  csrfToken: string;
  trustedOrigin?: string;
  /** The signed-in member's workspace role. Absent on a local Paws without workspaces. */
  role?: string;
  /** Records every hook change in the audit history. */
  audit: (action: string, subject: string) => void;
  root?: string;
  resolver?: SkillResolver;
  limit?: number;
  now?: () => number;
};

const AGENT_NAMES: Record<HookAgent, string> = { claude: "Claude", codex: "Codex" };

type UploadedHook = { skill: string; path: string; command: string };

/** `GET` lists the hooks; `POST` adds or removes one. */
export async function handleHookSettingsRequest(
  request: Request,
  options: HookSettingsOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== HOOK_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Hook settings are only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can change hooks." }, 403);
  const skills = () =>
    listSkills(options.db)
      .filter((skill) => skill.removedAt === null)
      .map((skill) => ({ name: skill.name, agents: skill.agents }));
  const listing = (notice?: string, uploaded?: UploadedHook) =>
    json({
      hooks: listHooks(options.db),
      events: HOOK_EVENTS.map((id) => ({ id, label: HOOK_EVENT_LABELS[id] })),
      agents: HOOK_AGENTS,
      skills: skills(),
      limit: WORKSPACE_HOOK_LIMIT,
      limitBytes: options.limit ?? SKILL_BUNDLE_LIMIT,
      ...(notice ? { notice } : {}),
      ...(uploaded ? { uploaded } : {}),
    });
  if (request.method === "GET") return listing();
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  const type = request.headers.get("content-type")?.split(";")[0]?.trim();
  if (type === "multipart/form-data") {
    try {
      const uploaded = await uploadHook(request, options);
      options.audit(
        "settings.skill.add",
        `Uploaded hook ${uploaded.path} as skill ${uploaded.skill}`,
      );
      return listing(
        `Uploaded ${uploaded.skill}. Review the prefilled script path and command, then add the hook.`,
        uploaded,
      );
    } catch (error) {
      journalCaught(error, "hooks.handleHookSettingsRequest.upload", null);
      if (error instanceof SkillError) return json({ error: error.message }, error.status);
      return json({ error: "The hook could not be uploaded" }, 503);
    }
  }
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (caughtError1) {
    journalCaught(caughtError1, "hooks.handleHookSettingsRequest.readJson", null);
    return json({ error: "Expected a JSON body of at most 128 KiB" }, 400);
  }
  if (!isRecord(body)) return json({ error: "Expected a JSON object" }, 400);
  if (body.action === "remove") {
    const removed = typeof body.id === "string" ? deleteHook(options.db, body.id) : null;
    if (!removed) return json({ error: "That hook is already gone." }, 404);
    options.audit("settings.hook.remove", `Removed hook ${describeHook(removed)}`);
    return listing("Removed the hook. Runs that already started keep it until they end.");
  }
  if (body.action !== "add") return json({ error: "Unknown hook action" }, 400);
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const hook: WorkspaceHook = {
    id: `hook_${randomUUID().replaceAll("-", "")}`,
    event: text(body.event) as HookEvent,
    matcher: text(body.matcher) || null,
    command: text(body.command),
    timeoutSeconds:
      body.timeoutSeconds === undefined || body.timeoutSeconds === ""
        ? HOOK_TIMEOUT_DEFAULT_SECONDS
        : Number(body.timeoutSeconds),
    agents: Array.isArray(body.agents)
      ? (body.agents.filter((agent) => typeof agent === "string") as HookAgent[])
      : [...HOOK_AGENTS],
    skill: text(body.skill) || null,
  };
  const problem = workspaceHookProblem(hook);
  if (problem) return json({ error: problem }, 400);
  if (hook.skill !== null) {
    const skill = skills().find((entry) => entry.name === hook.skill);
    if (!skill) return json({ error: `No registered skill is named ${hook.skill}.` }, 400);
    const missing = hook.agents.filter((agent) => !(skill.agents as string[]).includes(agent));
    if (missing.length)
      return json(
        { error: `${hook.skill} is not installed for ${names(missing)}. Pick its agents.` },
        400,
      );
  }
  if (listHooks(options.db).length >= WORKSPACE_HOOK_LIMIT)
    return json(
      { error: `Paws runs at most ${WORKSPACE_HOOK_LIMIT} hooks. Remove one first.` },
      409,
    );
  saveHook(options.db, hook, (options.now ?? Date.now)());
  options.audit("settings.hook.add", `Added hook ${describeHook(hook)}`);
  return listing(`Added the hook. Runs that start from now on get it.`);
}

async function uploadHook(request: Request, options: HookSettingsOptions): Promise<UploadedHook> {
  if (!options.root || !options.resolver)
    throw new SkillError("Hook uploads are not configured on this Paws server.", 503);
  const upload = await readSkillUpload(request, options.limit ?? SKILL_BUNDLE_LIMIT);
  if (upload.files.size !== 1) throw new SkillError("Choose one hook script to upload.");
  const [sourcePath, bytes] = upload.files.entries().next().value!;
  const path = `hooks/${sourcePath}`;
  if (/[\r\n]/.test(path)) throw new SkillError("The hook file name must stay on one line.");
  const command = `"$PAWS_SKILL_DIR/${path.replace(/[\\"$`]/g, (character) => `\\${character}`)}"`;
  if (command.length > 4096) throw new SkillError("The hook file name is too long.");
  const agents = upload.agents ?? [...HOOK_AGENTS];
  if (agents.some((agent) => !(HOOK_AGENTS as readonly string[]).includes(agent)))
    throw new SkillError("Hook scripts run only for Claude and Codex.");
  const manifest = new TextEncoder().encode(
    "---\ndescription: Workspace hook uploaded in Paws settings.\n---\n",
  );
  const skill = await addUploadedSkill(
    {
      db: options.db,
      root: options.root,
      resolver: options.resolver,
      now: (options.now ?? Date.now)(),
      signal: request.signal,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    },
    upload.folder,
    new Map([
      ["SKILL.md", manifest as Uint8Array & { executable?: true }],
      [path, skillFile(bytes, 0o700)],
    ]),
    {
      ...(upload.name ? { name: upload.name } : {}),
      agents,
    },
  );
  return { skill: skill.name, path, command };
}

export function describeHook(hook: WorkspaceHook): string {
  const matcher = hook.matcher ? ` matching ${hook.matcher}` : "";
  const skill = hook.skill ? ` from skill ${hook.skill}` : "";
  return `${HOOK_EVENT_LABELS[hook.event].toLowerCase()}${matcher}: ${hook.command}${skill} for ${names(hook.agents)}`;
}

function names(agents: readonly HookAgent[]): string {
  return agents.map((agent) => AGENT_NAMES[agent] ?? agent).join(", ");
}
