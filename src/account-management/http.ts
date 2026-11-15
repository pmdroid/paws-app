import { z } from "zod";
import {
  AgentAccountError,
  getAgentAccountSteps,
  agentAccountOverviewSteps,
  centralSignInTargetSteps,
  createAgentAccountSteps,
  orderAgentAccountsSteps,
  setAgentAccountExtraUsageSteps,
  signOutAgentAccountSteps,
  type Db,
} from "../db";
import { journalCaught } from "../journal";
import { readAgentCredentialSteps } from "../credentials";
import {
  ClaudeOAuthTokenSchema,
  claudeTokenHealth,
  RUNNER_CODING_AGENTS,
} from "../runner-protocol";
import { type WorkspacePrincipal } from "../workspace";

const RETIRED = /^\/api\/runners\/accounts(?:\/.*)?$/;
const CENTRAL =
  /^\/api\/runners\/agent-accounts(?:\/(order)|\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(extra-usage|sign-in|credential|device))?$/;

export const AGENT_ACCOUNTS_RETIRED = "This route was replaced by /api/runners/agent-accounts.";

const agent = z.enum(RUNNER_CODING_AGENTS);
const Create = z.strictObject({ agent, label: z.string().trim().min(1).max(80) });
const Order = z.strictObject({ agent, ids: z.array(z.string().min(1).max(128)).max(64) });
const ExtraUsage = z.strictObject({ extraUsage: z.boolean() });

const STATUS: Record<string, number> = {
  "not-your-account": 403,
  "not-your-runner": 403,
  not_found: 404,
  foreign_workspace: 404,
  removed: 404,
  duplicate: 409,
  runner_unsupported: 409,
};

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export function createAccountManagement(
  options: {
    store?: Db;
    secretsDir?: string;
    now?: () => number;
    agentAuth?: { device(workspaceId: string, id: string, start: boolean): Promise<unknown> };
  } = {},
) {
  const now = options.now ?? Date.now;
  return async function browser(
    request: Request,
    principal: WorkspacePrincipal,
  ): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (RETIRED.test(path)) return json({ error: AGENT_ACCOUNTS_RETIRED }, 410);
    const match = CENTRAL.exec(path);
    if (!match || !options.store) return null;
    const { store } = options;
    const { workspaceId } = principal;
    const [, order, accountId, action] = match;
    const method = request.method;
    const userId = principal.userId;
    try {
      const requireOwner = async (id: string) => {
        const account = await store.run((q) => getAgentAccountSteps(q, workspaceId, id));
        if (account.ownerUserId !== userId)
          throw new AgentAccountError(
            "not-your-account",
            "Agent account belongs to another member",
          );
      };
      if (accountId) await requireOwner(accountId);
      if (!order && !accountId && method === "GET") {
        const accounts = await store.run((q) =>
          agentAccountOverviewSteps(q, workspaceId, now(), userId),
        );
        const metadata = await store.run(function* (q) {
          const result = [];
          for (const account of accounts) {
            const stored =
              options.secretsDir && account.agent === "claude"
                ? yield* readAgentCredentialSteps(q, options.secretsDir, account.id)
                : null;
            const files = stored?.blob ? JSON.parse(stored.blob) : [];
            const file = files.find(
              (entry: { path: string }) => entry.path === ".claude/paws-oauth.json",
            );
            const token = file
              ? ClaudeOAuthTokenSchema.parse(
                  JSON.parse(Buffer.from(file.data, "base64").toString("utf8")),
                )
              : null;
            result.push({
              ...account,
              ...(token
                ? {
                    health: claudeTokenHealth(token.expiresAt, now()),
                    credential: { ...account.credential, expiresAt: token.expiresAt },
                  }
                : {}),
            });
          }
          return result;
        });
        return json({ canManage: true, accounts: metadata });
      }
      if (action === "device" && (method === "POST" || method === "GET")) {
        if (!options.agentAuth) return json({ error: "Device sign-in is unavailable." }, 503);
        return json(await options.agentAuth.device(workspaceId, accountId!, method === "POST"));
      }
      if (method === "GET") return json({ error: "Unsupported agent account request." }, 405);
      if (!order && !accountId && method === "POST") {
        const input = Create.parse(await request.json());
        const account = await store.transaction((q) =>
          createAgentAccountSteps(q, { workspaceId, ownerUserId: userId, ...input, now: now() }),
        );
        return json({ id: account.id, agent: account.agent, label: account.label }, 201);
      }
      if (order && method === "PUT") {
        const input = Order.parse(await request.json());
        for (const id of input.ids) await requireOwner(id);
        await store.transaction((q) =>
          orderAgentAccountsSteps(q, { workspaceId, ...input, now: now() }),
        );
        return json({ ok: true });
      }
      if (action === "extra-usage" && method === "PUT") {
        const { extraUsage } = ExtraUsage.parse(await request.json());
        await store.transaction((q) =>
          setAgentAccountExtraUsageSteps(q, {
            workspaceId,
            accountId: accountId!,
            extraUsage,
            now: now(),
          }),
        );
        return json({ ok: true });
      }
      if (action === "sign-in" && method === "POST")
        return json(
          await store.transaction((q) =>
            centralSignInTargetSteps(q, {
              workspaceId,
              userId: principal.userId,
              accountId: accountId!,
              now: now(),
            }),
          ),
        );
      if (action === "credential" && method === "DELETE") {
        await store.transaction((q) =>
          signOutAgentAccountSteps(q, { workspaceId, accountId: accountId!, now: now() }),
        );
        return json({ ok: true });
      }
      return json({ error: "Unsupported agent account request." }, 405);
    } catch (error) {
      if (error instanceof AgentAccountError)
        return json({ error: error.message }, STATUS[error.code] ?? 400);
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return json({ error: "The agent account request is invalid." }, 400);
      journalCaught(error, "account-management.browser", null);
      return json({ error: "Agent accounts are unavailable. Refresh to try again." }, 500);
    }
  };
}
