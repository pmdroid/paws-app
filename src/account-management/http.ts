import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { journalCaught } from "../journal";
import {
  workspaceMemberUsable,
  AgentAccountError,
  auditWorkspaceAccess,
  bindAgentAccount,
  createAgentAccount,
  getAgentAccount,
  getAgentBinding,
  immediate,
  removeAgentAccount,
  removeAgentBinding,
  renameAgentAccount,
  setAgentAccountConcurrency,
  setAgentAccountEnabled,
  workspaceMember,
} from "../db";
import type { AccountPolicy, AgentProfiles } from "../config";
import { RUNNER_CODING_AGENTS } from "../runner-protocol";
import { isWorkspaceAdmin, type WorkspacePrincipal } from "../workspace";
import { accountsRevision, listAccounts, previewEligibility, type PreviewRole } from "./read";

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const ID = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const ROUTE = new RegExp(
  `^/api/runners/accounts(?:/(preview)|/(${ID})(?:/(remove)|/bindings(?:/(${ID})/(remove))?)?)?$`,
);
const REPOSITORY = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\/[a-zA-Z0-9_.-]{1,200}$/;
const revision = z.string().min(1).max(64);
const createInput = z.strictObject({
  revision,
  agent: z.enum(RUNNER_CODING_AGENTS),
  label: z.string().max(200),
});
const updateInput = z
  .strictObject({
    revision,
    label: z.string().max(200).optional(),
    enabled: z.boolean().optional(),
    concurrency: z.number().int().min(1).max(64).nullable().optional(),
  })
  .refine(
    (value) =>
      value.label !== undefined || value.enabled !== undefined || value.concurrency !== undefined,
    "Choose a change to save.",
  );
const revisionInput = z.strictObject({ revision });
const bindInput = z.strictObject({ revision, runnerId: z.string().regex(new RegExp(`^${ULID}$`)) });

export type AccountManagementOptions = {
  db: Database;
  now?: () => number;
  settings: (repository: string | null) => {
    profiles: AgentProfiles;
    policy: AccountPolicy | null;
  };
};

class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly current?: string,
  ) {
    super(message);
  }
}

export function createAccountManagement(options: AccountManagementOptions) {
  const { db } = options;
  const now = options.now ?? Date.now;
  function member(principal: WorkspacePrincipal) {
    const current = workspaceMember(db, principal.workspaceId, principal.userId);
    if (!workspaceMemberUsable(current)) throw new Refused("Workspace access is unavailable.", 403);
    return current;
  }
  function list(principal: WorkspacePrincipal, admin: boolean) {
    return listAccounts(db, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      canManage: admin,
      now: now(),
    });
  }
  function fresh(principal: WorkspacePrincipal, expected: string) {
    const current = accountsRevision(db, principal.workspaceId);
    if (current !== expected)
      throw new Refused(
        "Agent accounts changed since this page loaded. Review the current accounts and try again.",
        409,
        current,
      );
  }
  function audit(principal: WorkspacePrincipal, action: string, subject: string) {
    auditWorkspaceAccess(db, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action,
      subject,
      now: now(),
    });
  }
  function mutate(
    principal: WorkspacePrincipal,
    expected: string,
    allowed: (admin: boolean) => boolean,
    change: () => void,
  ) {
    immediate(db, () => {
      const current = member(principal);
      if (!allowed(isWorkspaceAdmin(current.role)))
        throw new Refused("Only a workspace admin can change agent accounts.", 403);
      fresh(principal, expected);
      change();
    });
  }
  function ownsRunner(principal: WorkspacePrincipal, runnerId: string) {
    return (
      db
        .query("SELECT 1 FROM runner WHERE id=? AND workspace_id=? AND owner_user_id=?")
        .get(runnerId, principal.workspaceId, principal.userId) !== null
    );
  }
  function named(principal: WorkspacePrincipal, accountId: string) {
    const account = getAgentAccount(db, principal.workspaceId, accountId);
    if (account.legacy)
      throw new Refused("The default sign-in is managed on each runner's sign-in.", 409);
    return account;
  }
  return async function browser(
    request: Request,
    principal: WorkspacePrincipal,
  ): Promise<Response | null> {
    const url = new URL(request.url);
    const match = ROUTE.exec(url.pathname);
    if (!match) return null;
    const [, preview, accountId, removeAccount, bindingId, removeBinding] = match;
    try {
      if (request.method === "GET") {
        if (accountId) return json({ error: "Use GET /api/runners/accounts." }, 405);
        const current = member(principal);
        const admin = isWorkspaceAdmin(current.role);
        if (preview) {
          const role = url.searchParams.get("role") ?? "implementer";
          if (!["implementer", "reviewer", "reviewerFallback"].includes(role))
            throw new Refused("Choose implementer, reviewer or reviewerFallback.", 400);
          const repository = url.searchParams.get("repository")?.trim().toLowerCase() || null;
          if (repository !== null && !REPOSITORY.test(repository))
            throw new Refused("Enter a repository as owner/repository.", 400);
          const settings = options.settings(repository);
          const result = previewEligibility(db, {
            workspaceId: principal.workspaceId,
            userId: principal.userId,
            role: role as PreviewRole,
            repository,
            profiles: settings.profiles,
            policy: settings.policy,
            now: now(),
          });
          if (!result) throw new Refused("No reviewer fallback profile is configured.", 404);
          return resource(request, result);
        }
        return resource(request, list(principal, admin));
      }
      if (request.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      const body = await readBody(request);
      if (preview) return json({ error: "Use GET." }, 405);
      if (!accountId) {
        const input = createInput.parse(body);
        mutate(
          principal,
          input.revision,
          (admin) => admin,
          () => {
            const account = createAgentAccount(db, {
              workspaceId: principal.workspaceId,
              agent: input.agent,
              label: input.label,
              now: now(),
            });
            audit(principal, "agent_account.created", `${account.agent}/${account.id}`);
          },
        );
      } else if (removeAccount) {
        const input = revisionInput.parse(body);
        mutate(
          principal,
          input.revision,
          (admin) => admin,
          () => {
            const account = named(principal, accountId);
            removeAgentAccount(db, {
              workspaceId: principal.workspaceId,
              accountId: account.id,
              now: now(),
            });
            audit(principal, "agent_account.removed", `${account.agent}/${account.id}`);
          },
        );
      } else if (bindingId && removeBinding) {
        const input = revisionInput.parse(body);
        const binding = getAgentBinding(db, principal.workspaceId, bindingId);
        if (binding.accountId !== accountId) throw new Refused("Binding is unavailable.", 404);
        mutate(
          principal,
          input.revision,
          (admin) => admin || ownsRunner(principal, binding.runnerId),
          () => {
            named(principal, accountId);
            removeAgentBinding(db, { workspaceId: principal.workspaceId, bindingId, now: now() });
            audit(
              principal,
              "agent_account.binding_removed",
              `${binding.agent}/${accountId}/${binding.runnerId}`,
            );
          },
        );
      } else if (url.pathname.endsWith("/bindings")) {
        const input = bindInput.parse(body);
        mutate(
          principal,
          input.revision,
          (admin) => admin || ownsRunner(principal, input.runnerId),
          () => {
            const account = named(principal, accountId);
            bindAgentAccount(db, {
              workspaceId: principal.workspaceId,
              accountId: account.id,
              runnerId: input.runnerId,
              now: now(),
            });
            audit(
              principal,
              "agent_account.binding_added",
              `${account.agent}/${account.id}/${input.runnerId}`,
            );
          },
        );
      } else {
        const input = updateInput.parse(body);
        mutate(
          principal,
          input.revision,
          (admin) => admin,
          () => {
            const account = named(principal, accountId);
            const at = now();
            const target = { workspaceId: principal.workspaceId, accountId: account.id, now: at };
            const subject = `${account.agent}/${account.id}`;
            if (input.label !== undefined && input.label.trim() !== account.label) {
              renameAgentAccount(db, { ...target, label: input.label });
              audit(principal, "agent_account.renamed", subject);
            }
            if (input.enabled !== undefined && input.enabled !== account.enabled) {
              setAgentAccountEnabled(db, { ...target, enabled: input.enabled });
              audit(
                principal,
                input.enabled ? "agent_account.enabled" : "agent_account.disabled",
                subject,
              );
            }
            if (input.concurrency !== undefined) {
              setAgentAccountConcurrency(db, { ...target, concurrency: input.concurrency });
              audit(
                principal,
                "agent_account.concurrency",
                `${subject} ${input.concurrency ?? "no limit"}`,
              );
            }
          },
        );
      }
      const current = member(principal);
      return json(list(principal, isWorkspaceAdmin(current.role)));
    } catch (error) {
      journalCaught(error, "account-management.browser", null);
      return failure(error);
    }
  };
}

function failure(error: unknown): Response {
  if (error instanceof Refused)
    return json(
      { error: error.message, ...(error.current ? { revision: error.current } : {}) },
      error.status,
    );
  if (error instanceof z.ZodError)
    return json({ error: error.issues[0]?.message ?? "Check the account fields." }, 400);
  if (error instanceof SyntaxError) return json({ error: "Send a JSON body." }, 400);
  if (error instanceof AgentAccountError) {
    const status =
      error.code === "not_found" || error.code === "foreign_workspace"
        ? 404
        : error.code === "invalid"
          ? 400
          : 409;
    return json(
      { error: status === 404 ? "Agent account or runner is unavailable." : error.message },
      status,
    );
  }
  return json({ error: "Agent accounts are unavailable. Refresh and try again." }, 503);
}

function resource(request: Request, value: unknown): Response {
  const body = JSON.stringify(value);
  const tag = `W/"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  const headers = {
    "cache-control": "no-store",
    "content-type": "application/json",
    etag: tag,
    "paws-generated-at": new Date().toISOString(),
  };
  if (request.headers.get("if-none-match") === tag)
    return new Response(null, { status: 304, headers });
  return new Response(body, { status: 200, headers });
}

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new SyntaxError("JSON is required");
  const text = await request.text();
  if (text.length > 8192) throw new Refused("The request is too large.", 413);
  return JSON.parse(text);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
