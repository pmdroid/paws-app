import { isWorkspaceAdmin } from "../workspace";
import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { listSkills, SKILL_AGENTS, skillRollouts, type SkillPin, type SkillSource } from "../db";
import {
  addSkill,
  addSkills,
  addUploadedSkill,
  changeSkillAgents,
  findSkills,
  gitSource,
  readSkillSource,
  removeSkill,
  SKILL_BUNDLE_LIMIT,
  SkillError,
  skillPath,
  updateSkill,
  type FoundSkill,
  type SkillFiles,
  type SkillRequest,
  type SkillResolver,
  type SkillUpdates,
} from "../skills";
import { isRecord, json, localRequest, readJson, sameToken } from "./handler";
import { describeHook } from "./hooks";

export const SKILL_SETTINGS_PATH = "/api/settings/skills";

export type SkillSettingsOptions = {
  db: Database;
  /** `~/.paws/skills`. */
  root: string;
  resolver: SkillResolver;
  updates?: SkillUpdates;
  csrfToken: string;
  trustedOrigin?: string;
  /** The signed-in member's workspace role. Absent on a local Paws without workspaces. */
  role?: string;
  /** Records every skill change in the audit history. */
  audit: (action: string, subject: string) => void;
  limit?: number;
  now?: () => number;
};

const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };

/** `GET` lists the pins; `POST` adds (JSON or an uploaded folder), updates, re-scopes, or removes. */
export async function handleSkillSettingsRequest(
  request: Request,
  options: SkillSettingsOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== SKILL_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Skill settings are only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can change skills." }, 403);
  const listing = (notice?: string, found?: FoundSkill[]) => {
    const skills = listSkills(options.db);
    return json({
      skills,
      rollouts: skillRollouts(options.db, skills),
      ...(options.updates ? { updates: options.updates.available(skills) } : {}),
      agents: SKILL_AGENTS,
      limitBytes: options.limit ?? SKILL_BUNDLE_LIMIT,
      ...(notice ? { notice } : {}),
      ...(found ? { found } : {}),
    });
  };
  if (request.method === "GET") {
    await options.updates?.check(listSkills(options.db));
    return listing();
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  const registry = {
    db: options.db,
    root: options.root,
    resolver: options.resolver,
    now: (options.now ?? Date.now)(),
    signal: request.signal,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  };
  try {
    const type = request.headers.get("content-type")?.split(";")[0]?.trim();
    if (type === "multipart/form-data") {
      const upload = await readUpload(request, options.limit ?? SKILL_BUNDLE_LIMIT);
      const skill = await addUploadedSkill(registry, upload.folder, upload.files, upload);
      options.audit("settings.skill.add", added(skill));
      return listing(`Added ${skill.name} ${shortVersion(skill)}.`);
    }
    let body: unknown;
    try {
      body = await readJson(request);
    } catch (caughtError1) {
      journalCaught(caughtError1, "skills.handleSkillSettingsRequest.readJson", null);
      return json({ error: "Expected a JSON body of at most 128 KiB" }, 400);
    }
    if (!isRecord(body)) return json({ error: "Expected a JSON object" }, 400);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const agents = stringList(body.agents);
    switch (body.action) {
      case "find":
        return listing(undefined, await findSkills(registry, parseSource(body.source)));
      case "add": {
        const paths = stringList(body.paths);
        if (paths) {
          const source = parseSource(body.source);
          const { skills, hooks } = await addSkills(registry, source, paths, {
            ...(agents ? { agents } : {}),
            hooks: stringList(body.hooks) ?? [],
          });
          for (const skill of skills) options.audit("settings.skill.add", added(skill));
          for (const hook of hooks)
            options.audit("settings.hook.add", `Added hook ${describeHook(hook)}`);
          const hookCount = hooks.length
            ? ` and ${hooks.length} hook${hooks.length === 1 ? "" : "s"}`
            : "";
          return listing(
            `Added ${skills.map((skill) => `${skill.name} ${shortVersion(skill)}`).join(", ")}${hookCount}.`,
          );
        }
        const skill = await addSkill(registry, parseSource(body.source), {
          ...(name ? { name } : {}),
          ...(agents ? { agents } : {}),
        });
        options.audit("settings.skill.add", added(skill));
        return listing(`Added ${skill.name} ${shortVersion(skill)}.`);
      }
      case "update": {
        const { before, after } = await updateSkill(registry, name);
        if (before.version === after.version)
          return listing(`${name} is already at the newest version, ${shortVersion(after)}.`);
        options.audit(
          "settings.skill.update",
          `Updated skill ${name} ${shortVersion(before)} → ${shortVersion(after)}`,
        );
        return listing(`Updated ${name} to ${shortVersion(after)}.`);
      }
      case "agents": {
        if (agents === undefined) return json({ error: "Choose the agents for this skill." }, 400);
        const { after } = changeSkillAgents(registry, name, agents);
        options.audit(
          "settings.skill.agents",
          `Skill ${name} now applies to ${agentList(after.agents)}`,
        );
        return listing(`${name} now applies to ${agentList(after.agents)}.`);
      }
      case "remove": {
        const skill = removeSkill(registry, name);
        options.audit("settings.skill.remove", `Removed skill ${name} ${shortVersion(skill)}`);
        return listing(`Removed ${name}. Runners uninstall it before their next run.`);
      }
      default:
        return json({ error: "Unknown skill action" }, 400);
    }
  } catch (error) {
    journalCaught(error, "skills.handleSkillSettingsRequest.trim", null);
    if (error instanceof SkillError) return json({ error: error.message }, error.status);
    return json({ error: "The skill could not be saved" }, 503);
  }
}

function parseSource(value: unknown): SkillRequest {
  if (typeof value === "string") return readSkillSource(value);
  if (!isRecord(value)) throw new SkillError("Choose an npm package or a git URL.");
  const text = (key: string) => {
    const field = value[key];
    return typeof field === "string" && field.trim() ? field.trim() : undefined;
  };
  const subfolder = text("subfolder");
  if (value.kind === "npm") {
    const name = text("package");
    if (name === undefined) throw new SkillError("Enter an npm package name.");
    const version = text("version");
    return {
      kind: "npm",
      package: name,
      ...(version ? { version } : {}),
      ...(subfolder ? { subfolder } : {}),
    };
  }
  if (value.kind === "git") {
    const url = text("url");
    if (url === undefined) throw new SkillError("Enter a git URL.");
    const ref = text("ref");
    const { path, ...source } = gitSource(url);
    return {
      ...source,
      ...(ref ? { ref } : path ? { path } : {}),
      ...(subfolder ? { subfolder } : {}),
    };
  }
  throw new SkillError("Choose an npm package or a git URL.");
}

async function readUpload(
  request: Request,
  limit: number,
): Promise<{ folder: string; files: SkillFiles; name?: string; agents?: string[] }> {
  const length = Number(request.headers.get("content-length"));
  // Multipart framing adds a little per file on top of the skill's own bytes.
  if (!Number.isFinite(length) || length <= 0)
    throw new SkillError("Upload the folder with a Content-Length.", 411);
  if (length > limit + 4 * 1024 * 1024)
    throw new SkillError(`This skill is over the ${megabytes(limit)} MB bundle limit.`, 413);
  let form: Awaited<ReturnType<Request["formData"]>>;
  try {
    form = await request.formData();
  } catch {
    throw new SkillError("The uploaded folder could not be read.");
  }
  const folder = form.get("folder");
  if (typeof folder !== "string" || skillPath(folder) === null || folder.includes("/"))
    throw new SkillError("Name the uploaded folder.");
  const paths = form.getAll("path");
  const uploads = form.getAll("file");
  if (uploads.length === 0 || paths.length !== uploads.length)
    throw new SkillError("Choose a folder to upload.");
  const files: SkillFiles = new Map();
  for (const [index, upload] of uploads.entries()) {
    const path = paths[index];
    const safe = typeof path === "string" ? skillPath(path) : null;
    if (safe === null || typeof upload === "string")
      throw new SkillError("The uploaded folder has a file outside it.");
    files.set(safe, new Uint8Array(await upload.arrayBuffer()));
  }
  const name = form.get("name");
  const agents = form.getAll("agents").filter((value) => typeof value === "string");
  return {
    folder,
    files,
    ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
    ...(agents.length ? { agents } : {}),
  };
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : undefined;
}

function added(skill: SkillPin): string {
  return `Added skill ${skill.name} ${shortVersion(skill)} from ${describeSource(skill.source)} for ${agentList(skill.agents)}`;
}

export function describeSource(source: SkillSource): string {
  if (source.kind === "npm")
    return `npm ${source.package}${source.subfolder ? `/${source.subfolder}` : ""}`;
  if (source.kind === "git")
    return `${source.url}${source.ref ? `#${source.ref}` : ""}${source.subfolder ? ` /${source.subfolder}` : ""}`;
  return `upload ${source.folder}`;
}

function shortVersion(skill: SkillPin): string {
  return skill.source.kind === "git" ? skill.version.slice(0, 7) : skill.version;
}

function agentList(agents: readonly string[]): string {
  return agents.map((agent) => AGENT_NAMES[agent] ?? agent).join(", ");
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
