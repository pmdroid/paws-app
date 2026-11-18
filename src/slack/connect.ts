import {
  activeSlackTeamSteps,
  auditWorkspaceAccessSteps,
  claimSlackOAuthSteps,
  ensureSlackInstallationSteps,
  finishSlackOAuthSteps,
  insertSlackOAuthSteps,
  saveSlackInstallationSteps,
  slackInstallationSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Db,
  type Q,
  type SlackOAuthIntent,
  type Steps,
} from "../db";
import {
  isWorkspaceAdmin,
  requestWorkspaceSessionSteps,
  validWorkspaceCsrf,
  workspaceSecret,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../workspace";
import { deleteScopedCredentialSteps } from "../credentials";
import { dashboardUrl } from "../dashboard-links";
import { journalCaught } from "../journal";
import {
  readInstalledSlackTokenSteps,
  readSlackToken,
  requestSlackToken,
  resolveSlackApp,
  writeInstalledSlackTokenSteps,
  type SlackFetch,
  type SlackToken,
} from "./oauth";
import {
  SLACK_CALLBACK_PATH,
  SLACK_EVENTS_PATH,
  SLACK_INSTALL_SCOPES,
  slackAppManifest,
  slackCapabilities,
} from "./manifest";
import { dropSlackCredentialSteps, endSlackInstallationSteps } from "./installation";

const STATUS = "/api/workspaces/slack";
const CONNECT = "/api/workspaces/slack/connect";
const ADOPT = "/api/workspaces/slack/adopt";
const STATE_MS = 10 * 60_000;
const SLACK_ID = /^[A-Z0-9]{6,20}$/;
const INTENTS: readonly SlackOAuthIntent[] = ["install", "reconnect", "replace"];

type Outcome =
  | { ok: true; teamId: string; appId: string }
  | { ok: false; code: "different_team" | "team_taken" | "conflict" | "forbidden" | "failed" };

export function createSlackConnect(options: {
  store: Db;
  home: string;
  env: Record<string, string | undefined>;
  origin: string;
  fetch?: SlackFetch;
  now?: () => number;
}) {
  const { store, home } = options;
  const now = options.now ?? Date.now;
  const origin = new URL(options.origin).origin;
  const slackFetch = options.fetch ?? fetch;
  const redirectUri = origin + SLACK_CALLBACK_PATH;
  const integrations = (code: string) =>
    redirect(`${dashboardUrl(origin, "/workspace/integrations")}?slack=${code}`);

  function* adminSteps(q: Q, principal: WorkspacePrincipal): Steps<boolean> {
    const member = yield* workspaceMemberSteps(q, principal.workspaceId, principal.userId);
    return workspaceMemberUsable(member) && isWorkspaceAdmin(member.role);
  }
  const auditSteps = (q: Q, principal: WorkspacePrincipal, action: string, subject: string) =>
    auditWorkspaceAccessSteps(q, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action,
      subject,
      now: now(),
    });

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (![STATUS, CONNECT, ADOPT, SLACK_CALLBACK_PATH].includes(url.pathname)) return null;
    const access = await store.run((q) => requestWorkspaceSessionSteps(q, request, now()));
    if (url.pathname === SLACK_CALLBACK_PATH) return callback(url, access);
    const principal = access?.principal;
    const unsafe = request.method !== "GET";
    const allowed =
      principal !== undefined &&
      (await store.run((q) => adminSteps(q, principal))) &&
      (!unsafe ||
        (request.headers.get("origin") === origin && validWorkspaceCsrf(request, access!.session)));
    if (!allowed) {
      if (principal)
        await store.run((q) => auditSteps(q, principal, "access.denied", url.pathname));
      return json(
        { code: "admin_required", error: "Ask a workspace admin to connect Slack." },
        principal ? 403 : 401,
      );
    }
    const { workspaceId } = principal;
    if (url.pathname === STATUS && request.method === "GET") return json(await status(workspaceId));
    if (url.pathname === STATUS && request.method === "DELETE")
      return json(await disconnect(principal));
    if (url.pathname === CONNECT && request.method === "POST")
      return connect(request, principal, access!.session.tokenHash);
    if (url.pathname === ADOPT && request.method === "POST") return adopt(principal);
    return json({ error: "Method not allowed." }, 405);
  };

  async function status(workspaceId: string) {
    const installation = await store.run((q) => slackInstallationSteps(q, workspaceId));
    const cli = await readSlackToken(store, home).catch(() => null);
    const active = installation?.status === "active" ? installation : null;
    return {
      configured: resolveSlackApp(home, options.env) !== null,
      redirectUrl: redirectUri,
      eventsUrl: origin + SLACK_EVENTS_PATH,
      manifest: slackAppManifest(origin),
      connection: installation?.teamId
        ? {
            status: installation.status,
            teamId: installation.teamId,
            teamName: installation.teamName,
            appId: installation.appId,
            botUserId: installation.botUserId,
            source: installation.source,
            updatedAt: installation.updatedAt,
          }
        : null,
      capabilities: active ? slackCapabilities(active.scope) : null,
      cli: cli ? { teamId: cli.teamId, botUserId: cli.botUserId } : null,
    };
  }

  async function connect(request: Request, principal: WorkspacePrincipal, sessionHash: string) {
    const app = resolveSlackApp(home, options.env);
    if (!app)
      return json(
        { error: "Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET first." },
        409,
      );
    const body = (await request.json().catch(() => null)) as {
      intent?: unknown;
      returnTo?: { teamId?: unknown; channelId?: unknown };
    } | null;
    const intent = INTENTS.find((value) => value === body?.intent);
    const teamId = body?.returnTo?.teamId;
    const channelId = body?.returnTo?.channelId;
    if (
      !intent ||
      (teamId !== undefined && (typeof teamId !== "string" || !SLACK_ID.test(teamId))) ||
      (channelId !== undefined &&
        (typeof channelId !== "string" || !SLACK_ID.test(channelId) || teamId === undefined))
    )
      return json({ error: "Choose install, reconnect or replace." }, 400);
    const state = workspaceSecret();
    await store.transaction(function* (q) {
      yield* ensureSlackInstallationSteps(q, principal.workspaceId, now());
      const current = (yield* slackInstallationSteps(q, principal.workspaceId))!;
      yield* insertSlackOAuthSteps(q, {
        stateHash: workspaceTokenHash(state),
        workspaceId: principal.workspaceId,
        userId: principal.userId,
        sessionHash,
        intent,
        expectedGeneration: current.generation,
        returnTeamId: (teamId as string | undefined) ?? null,
        returnChannelId: (channelId as string | undefined) ?? null,
        expiresAt: now() + STATE_MS,
      });
      yield* auditSteps(q, principal, `slack.${intent}.started`, "slack");
    });
    const target = new URL("https://slack.com/oauth/v2/authorize");
    target.search = new URLSearchParams({
      client_id: app.clientId,
      scope: SLACK_INSTALL_SCOPES.join(","),
      state,
      redirect_uri: redirectUri,
      ...(typeof teamId === "string" ? { team: teamId } : {}),
    }).toString();
    return json({ url: target.href });
  }

  async function callback(
    url: URL,
    access: { principal: WorkspacePrincipal; session: { tokenHash: string } } | null,
  ): Promise<Response> {
    const state = url.searchParams.get("state");
    const claimed = state
      ? await store.run((q) => claimSlackOAuthSteps(q, workspaceTokenHash(state), now()))
      : undefined;
    if (!claimed) return integrations("expired");
    const principal = access?.principal;
    const fail = async (code: string, action = `slack.${claimed.intent}.failed`) => {
      await store.transaction(function* (q) {
        yield* finishSlackOAuthSteps(q, claimed.stateHash, "failed");
        if (principal) yield* auditSteps(q, principal, action, "slack");
      });
      return integrations(code);
    };
    const sameRequester = (q: Q) =>
      (function* () {
        return (
          principal !== undefined &&
          access!.session.tokenHash === claimed.sessionHash &&
          principal.workspaceId === claimed.workspaceId &&
          principal.userId === claimed.userId &&
          (yield* adminSteps(q, principal))
        );
      })();
    if (!(await store.run(sameRequester))) return fail("forbidden", "access.denied");
    if (url.searchParams.has("error")) return fail("denied", `slack.${claimed.intent}.denied`);
    const code = url.searchParams.get("code");
    const app = resolveSlackApp(home, options.env);
    if (!code || !app) return fail("failed");
    let token: SlackToken;
    try {
      token = await requestSlackToken(
        app,
        new URLSearchParams({ code, redirect_uri: redirectUri }),
        slackFetch,
        AbortSignal.timeout(15_000),
        undefined,
        [],
      );
      if (!token.appId || !(await verifyBot(token, slackFetch)))
        throw new Error("Slack returned an unverified bot.");
      if (options.env.SLACK_APP_ID && token.appId !== options.env.SLACK_APP_ID)
        throw new Error("Slack returned a different app.");
    } catch (caught) {
      journalCaught(caught, "slack.connect.exchange", null);
      return fail("failed");
    }
    const outcome = await store
      .transaction(function* (q): Steps<Outcome> {
        if (!(yield* sameRequester(q))) return { ok: false, code: "forbidden" };
        const current = (yield* slackInstallationSteps(q, claimed.workspaceId))!;
        if (current.generation !== claimed.expectedGeneration)
          return { ok: false, code: "conflict" };
        const elsewhere = yield* activeSlackTeamSteps(q, token.teamId);
        if (elsewhere && elsewhere.workspaceId !== claimed.workspaceId)
          return { ok: false, code: "team_taken" };
        const switching = current.status === "active" && current.teamId !== token.teamId;
        if (switching && claimed.intent !== "replace") return { ok: false, code: "different_team" };
        if (current.status === "active" && current.appId && current.appId !== token.appId)
          return { ok: false, code: "different_team" };
        const saved = yield* saveSlackInstallationSteps(q, {
          workspaceId: claimed.workspaceId,
          expectedGeneration: current.generation,
          status: "active",
          actorId: claimed.userId,
          now: now(),
          identity: { ...identityOf(token), source: "oauth" },
        });
        if (!saved) return { ok: false, code: "conflict" };
        if (switching) yield* dropSlackCredentialSteps(q, current);
        yield* writeInstalledSlackTokenSteps(
          q,
          home,
          { workspaceId: claimed.workspaceId, teamId: token.teamId },
          token,
        );
        yield* finishSlackOAuthSteps(q, claimed.stateHash, "complete");
        yield* auditSteps(
          q,
          principal!,
          `slack.${claimed.intent}.completed`,
          `slack:${token.teamId}`,
        );
        return { ok: true, teamId: token.teamId, appId: token.appId! };
      })
      .catch(taken);
    if (!outcome.ok) return fail(outcome.code);
    if (claimed.returnTeamId === outcome.teamId) {
      const target = new URL("https://slack.com/app_redirect");
      target.search = new URLSearchParams({
        team: outcome.teamId,
        ...(claimed.returnChannelId
          ? { channel: claimed.returnChannelId }
          : { app: outcome.appId }),
      }).toString();
      return redirect(target.href);
    }
    return integrations("connected");
  }

  async function disconnect(principal: WorkspacePrincipal) {
    const ended = await store.transaction(function* (q) {
      const current = yield* slackInstallationSteps(q, principal.workspaceId);
      if (current?.status !== "active" || !current.teamId) return null;
      const key = { workspaceId: principal.workspaceId, teamId: current.teamId };
      const token = yield* readInstalledSlackTokenSteps(q, home, key);
      yield* endSlackInstallationSteps(q, current, "disconnected", principal.userId, now());
      yield* auditSteps(q, principal, "slack.disconnected", `slack:${current.teamId}`);
      return token;
    });
    if (ended)
      await slackFetch("https://slack.com/api/auth.revoke", {
        method: "POST",
        headers: { authorization: `Bearer ${ended.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      }).catch((caught: unknown) => journalCaught(caught, "slack.connect.revoke", null));
    return { ok: true };
  }

  async function adopt(principal: WorkspacePrincipal) {
    const cli = await readSlackToken(store, home).catch(() => null);
    if (!cli) return json({ error: "No Slack connection from paws login slack was found." }, 404);
    if (!(await verifyBot(cli, slackFetch).catch(() => false)))
      return json({ error: "Slack no longer accepts the paws login slack connection." }, 409);
    const outcome = await store
      .transaction(function* (q): Steps<Outcome> {
        if (!(yield* adminSteps(q, principal))) return { ok: false, code: "forbidden" };
        yield* ensureSlackInstallationSteps(q, principal.workspaceId, now());
        const current = (yield* slackInstallationSteps(q, principal.workspaceId))!;
        const elsewhere = yield* activeSlackTeamSteps(q, cli.teamId);
        if (elsewhere && elsewhere.workspaceId !== principal.workspaceId)
          return { ok: false, code: "team_taken" };
        if (current.status === "active") return { ok: false, code: "different_team" };
        const saved = yield* saveSlackInstallationSteps(q, {
          workspaceId: principal.workspaceId,
          expectedGeneration: current.generation,
          status: "active",
          actorId: principal.userId,
          now: now(),
          identity: { ...identityOf(cli), source: "cli" },
        });
        if (!saved) return { ok: false, code: "conflict" };
        yield* writeInstalledSlackTokenSteps(
          q,
          home,
          { workspaceId: principal.workspaceId, teamId: cli.teamId },
          cli,
        );
        yield* deleteScopedCredentialSteps(q, { kind: "slack", workspace: "installation" });
        yield* auditSteps(q, principal, "slack.adopted", `slack:${cli.teamId}`);
        return { ok: true, teamId: cli.teamId, appId: cli.appId ?? "" };
      })
      .catch(taken);
    return outcome.ok
      ? json({ ok: true, teamId: outcome.teamId })
      : json({ code: outcome.code, error: "Disconnect the current Slack connection first." }, 409);
  }
}

// A concurrent install of the same team elsewhere trips the active-team unique index.
function taken(caught: unknown): Outcome {
  journalCaught(caught, "slack.connect.save", null);
  return { ok: false, code: "team_taken" };
}

function identityOf(token: SlackToken) {
  return {
    teamId: token.teamId,
    teamName: token.teamName ?? null,
    appId: token.appId ?? null,
    botUserId: token.botUserId,
    scope: token.scope,
  };
}

async function verifyBot(token: SlackToken, slackFetch: SlackFetch): Promise<boolean> {
  const response = await slackFetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${token.accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return data?.ok === true && data.team_id === token.teamId && data.user_id === token.botUserId;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
