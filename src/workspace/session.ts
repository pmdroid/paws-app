import {
  workspaceMemberUsable,
  auditWorkspaceAccessSteps,
  WORKSPACE_REVOKED_SIGN_IN,
  createWorkspaceBootstrap,
  deleteWorkspaceSessionSteps,
  readWorkspaceSessionSteps,
  saveWorkspaceSession,
  workspaceMemberSteps,
  type Db,
  type Q,
  type Steps,
  type WorkspaceRole,
  type WorkspaceSession,
} from "../db";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type WorkspacePrincipal = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  authenticatedAt: number;
  teamIds: readonly string[];
};

export const WORKSPACE_COOKIE = "__Host-paws-session";
export const WORKSPACE_SESSION_MS = 30 * 24 * 60 * 60_000;

export function workspaceSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function workspaceTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function workspaceId(now = Date.now()): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = BigInt(now);
  let id = "";
  for (let index = 0; index < 10; index++) {
    id = alphabet[Number(value & 31n)]! + id;
    value >>= 5n;
  }
  value = BigInt(`0x${randomBytes(10).toString("hex")}`);
  let suffix = "";
  for (let index = 0; index < 16; index++) {
    suffix = alphabet[Number(value & 31n)]! + suffix;
    value >>= 5n;
  }
  return id + suffix;
}

export async function issueWorkspaceBootstrap(
  store: Db,
  organizationId: string,
  now = Date.now(),
): Promise<string> {
  const token = workspaceSecret();
  await createWorkspaceBootstrap(store, {
    tokenHash: workspaceTokenHash(token),
    organizationId,
    expiresAt: now + 10 * 60_000,
  });
  return token;
}

export class WorkspaceAccessRevoked extends Error {
  constructor() {
    super(WORKSPACE_REVOKED_SIGN_IN);
    this.name = "WorkspaceAccessRevoked";
  }
}

export async function issueWorkspaceSession(
  store: Db,
  input: { userId: string; workspaceId: string; now: number },
): Promise<{ token: string; session: WorkspaceSession }> {
  const member = await store.run((q) => workspaceMemberSteps(q, input.workspaceId, input.userId));
  if (member?.revokedAt != null) throw new WorkspaceAccessRevoked();
  if (!workspaceMemberUsable(member)) throw new Error("Workspace membership is required.");
  const token = workspaceSecret();
  const session: WorkspaceSession = {
    tokenHash: workspaceTokenHash(token),
    userId: input.userId,
    workspaceId: input.workspaceId,
    csrfToken: workspaceSecret(),
    authenticatedAt: input.now,
    lastSeenAt: input.now,
    expiresAt: input.now + WORKSPACE_SESSION_MS,
  };
  await saveWorkspaceSession(store, session);
  await store.run((q) =>
    auditWorkspaceAccessSteps(q, {
      ...input,
      action: "session.created",
      subject: input.userId,
    }),
  );
  return { token, session };
}

type RequestedWorkspaceSession = { principal: WorkspacePrincipal; session: WorkspaceSession };

export function* requestWorkspaceSessionSteps(
  q: Q,
  request: Request,
  now = Date.now(),
): Steps<RequestedWorkspaceSession | null> {
  const token = cookieValue(request, WORKSPACE_COOKIE);
  if (token === null || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const session = yield* q.transaction((tx) =>
    readWorkspaceSessionSteps(tx, workspaceTokenHash(token), now, WORKSPACE_SESSION_MS),
  );
  if (session === null) return null;
  const member = yield* workspaceMemberSteps(q, session.workspaceId, session.userId);
  if (!workspaceMemberUsable(member)) {
    yield* deleteWorkspaceSessionSteps(q, session.tokenHash);
    return null;
  }
  return {
    session,
    principal: {
      workspaceId: member.workspaceId,
      userId: member.userId,
      role: member.role,
      teamIds: member.teamIds,
      authenticatedAt: session.authenticatedAt,
    },
  };
}

export function requestWorkspaceSession(
  store: Db,
  request: Request,
  now = Date.now(),
): Promise<RequestedWorkspaceSession | null> {
  return store.run((q) => requestWorkspaceSessionSteps(q, request, now));
}

export function workspaceSessionCookie(token: string): string {
  return `${WORKSPACE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=34560000`;
}

export function clearWorkspaceSessionCookie(): string {
  return `${WORKSPACE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function cookieValue(request: Request, name: string): string | null {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : null;
}

export function validWorkspaceCsrf(request: Request, session: WorkspaceSession): boolean {
  const received = Buffer.from(request.headers.get("x-paws-csrf") ?? "");
  const expected = Buffer.from(session.csrfToken);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
