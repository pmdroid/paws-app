import {
  auditWorkspaceAccessSteps,
  listWorkspaceMembersSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Db,
} from "../db";
import { isWorkspaceAdmin, requestWorkspaceSessionSteps, validWorkspaceCsrf } from "../workspace";
import {
  SLACK_DISCLOSURES,
  setSlackDisclosureSteps,
  slackDisclosuresSteps,
  slackRepositoryKey,
  type SlackDisclosure,
} from "./disclosure";
import { installedSlackTokenSteps } from "./oauth";
import { currentSlackLinksSteps, unlinkSlackMemberSteps } from "./threads";

const OWN = "/api/workspaces/slack/link";
const ALL = "/api/workspaces/slack/links";
const DISCLOSURE = "/api/workspaces/slack/disclosure";
const SLACK_USER = /^[A-Z0-9]{2,32}$/;

export function createSlackLinks(options: {
  store: Db;
  home: string;
  origin: string;
  now?: () => number;
}) {
  const { store, home } = options;
  const now = options.now ?? Date.now;
  const origin = new URL(options.origin).origin;

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (![OWN, ALL, DISCLOSURE].includes(url.pathname)) return null;
    const write = url.pathname === DISCLOSURE ? "PUT" : "DELETE";
    if (request.method !== "GET" && request.method !== write)
      return json({ error: "Method not allowed." }, 405);
    const access = await store.run((q) => requestWorkspaceSessionSteps(q, request, now()));
    if (!access) return json({ error: "Sign in to Paws." }, 401);
    const { workspaceId, userId } = access.principal;
    const member = await store.run((q) => workspaceMemberSteps(q, workspaceId, userId));
    const admin = workspaceMemberUsable(member) && isWorkspaceAdmin(member.role);
    const unsafe = request.method === write;
    if (
      !workspaceMemberUsable(member) ||
      (url.pathname !== OWN && !admin) ||
      (unsafe &&
        (request.headers.get("origin") !== origin || !validWorkspaceCsrf(request, access.session)))
    ) {
      await store.run((q) =>
        auditWorkspaceAccessSteps(q, {
          workspaceId,
          userId,
          action: "access.denied",
          subject: url.pathname,
          now: now(),
        }),
      );
      return json({ error: "You can't change these Slack settings." }, 403);
    }
    if (url.pathname === DISCLOSURE && !unsafe)
      return json({ repositories: await store.run((q) => slackDisclosuresSteps(q, workspaceId)) });
    if (url.pathname === DISCLOSURE) {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const repository = slackRepositoryKey(String(body?.repository ?? ""));
      const level = body?.level as SlackDisclosure;
      if (!repository || !SLACK_DISCLOSURES.includes(level))
        return json({ error: "Name a repository as owner/name and a level." }, 400);
      const repositories = await store.transaction(function* (q) {
        yield* setSlackDisclosureSteps(q, workspaceId, repository, level, now());
        yield* auditWorkspaceAccessSteps(q, {
          workspaceId,
          userId,
          action: "slack.disclosure_changed",
          subject: `${repository}:${level}`,
          now: now(),
        });
        return yield* slackDisclosuresSteps(q, workspaceId);
      });
      return json({ repositories });
    }
    if (url.pathname === OWN && !unsafe) {
      const { connected, links } = await store.run(function* (q) {
        const install = yield* installedSlackTokenSteps(q, home, workspaceId);
        return { connected: !!install, links: yield* currentSlackLinksSteps(q, home, workspaceId) };
      });
      const own = links.find((link) => link.userId === userId);
      return json({
        connected,
        link: own
          ? { teamId: own.teamId, channelId: own.channelId, slackUserId: own.slackUserId }
          : null,
      });
    }
    if (url.pathname === ALL && !unsafe) {
      const links = await store.run(function* (q) {
        const current = yield* currentSlackLinksSteps(q, home, workspaceId);
        const members = yield* listWorkspaceMembersSteps(q, workspaceId);
        return current.map((link) => {
          const person = members.find((entry) => entry.id === link.userId);
          return {
            teamId: link.teamId,
            channelId: link.channelId,
            slackUserId: link.slackUserId,
            userId: link.userId,
            name: person?.name ?? null,
            active: workspaceMemberUsable(person),
          };
        });
      });
      return json({ links });
    }
    const slackUserId = url.searchParams.get("user") ?? "";
    if (url.pathname === ALL && !SLACK_USER.test(slackUserId))
      return json({ error: "Name the Slack user to revoke." }, 400);
    const removed = await store.transaction((q) =>
      unlinkSlackMemberSteps(
        q,
        url.pathname === OWN
          ? { workspaceId, userId, actorId: userId, action: "slack.member_unlinked", now: now() }
          : {
              workspaceId,
              slackUserId,
              actorId: userId,
              action: "slack.member_revoked",
              now: now(),
            },
      ),
    );
    return json({ removed });
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
