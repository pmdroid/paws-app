import type {
  ContextNamespace,
  ContextRestriction,
  ContextScopeKind,
  ContextSourceRef,
} from "../db";

export const CONTEXT_AUDIENCES = {
  project_members: { version: 1, scopeKind: "linear_project" },
  channel_members: { version: 1, scopeKind: "slack_channel" },
  private_user: { version: 1, scopeKind: "user_private" },
} as const satisfies Record<string, { version: number; scopeKind: ContextScopeKind }>;

export type ContextAudience = keyof typeof CONTEXT_AUDIENCES;

const SOURCE_KINDS: Record<ContextScopeKind, readonly string[]> = {
  linear_project: ["linear_project_description", "linear_project_document", "paws_work_item"],
  slack_channel: ["slack_channel_message"],
  user_private: ["slack_direct_message"],
};

export type ContextDestination = {
  readonly audience: string;
  readonly userId?: string;
  readonly channelId?: string;
};

export type ContextRequester = { readonly workspaceId: string; readonly userId: string };

export type ContextRequesterAccess = {
  readonly userId: string;
  readonly teamIds: readonly string[];
  readonly repositories: readonly string[];
  readonly channelIds: readonly string[];
};

export type ContextAccess = {
  currentAccess(requester: ContextRequester): Promise<ContextRequesterAccess | null>;
};

export function validNamespace(namespace: ContextNamespace): boolean {
  return (
    Object.hasOwn(SOURCE_KINDS, namespace.scopeKind) &&
    namespace.workspaceId.trim() !== "" &&
    namespace.scopeId.trim() !== ""
  );
}

export function audienceFor(namespace: ContextNamespace): ContextAudience {
  const found = Object.entries(CONTEXT_AUDIENCES).find(
    ([, policy]) => policy.scopeKind === namespace.scopeKind,
  );
  return found![0] as ContextAudience;
}

export function audienceLineage(audience: ContextAudience): string {
  return `${audience}@${CONTEXT_AUDIENCES[audience].version}`;
}

export function sourceAllowed(namespace: ContextNamespace, source: ContextSourceRef): boolean {
  return (
    validNamespace(namespace) &&
    SOURCE_KINDS[namespace.scopeKind].includes(source.kind) &&
    source.id.trim() !== ""
  );
}

export function destinationAllowed(
  namespace: ContextNamespace,
  requester: ContextRequester,
  destination: ContextDestination,
): destination is ContextDestination & { audience: ContextAudience } {
  if (!validNamespace(namespace) || requester.workspaceId !== namespace.workspaceId) return false;
  if (!Object.hasOwn(CONTEXT_AUDIENCES, destination.audience)) return false;
  const audience = destination.audience as ContextAudience;
  if (CONTEXT_AUDIENCES[audience].scopeKind !== namespace.scopeKind) return false;
  if (audience === "private_user")
    return destination.userId === namespace.scopeId && requester.userId === namespace.scopeId;
  if (audience === "channel_members") return destination.channelId === namespace.scopeId;
  return true;
}

export function canSee(access: ContextRequesterAccess, restriction: ContextRestriction): boolean {
  const checks: boolean[] = [];
  if (restriction.teamIds !== undefined)
    checks.push(restriction.teamIds.some((teamId) => access.teamIds.includes(teamId)));
  if (restriction.repository !== undefined)
    checks.push(access.repositories.includes(restriction.repository));
  if (restriction.userId !== undefined) checks.push(access.userId === restriction.userId);
  if (restriction.channelId !== undefined)
    checks.push(access.channelIds.includes(restriction.channelId));
  return checks.length > 0 && checks.every(Boolean);
}

export async function requesterAccess(
  access: ContextAccess,
  requester: ContextRequester,
): Promise<ContextRequesterAccess | null> {
  try {
    const current = await access.currentAccess(requester);
    return current?.userId === requester.userId ? current : null;
  } catch {
    return null;
  }
}

export type FakeContextAccess = ContextAccess & {
  readonly grants: Map<string, ContextRequesterAccess | Error>;
  readonly calls: ContextRequester[];
  grant(requester: ContextRequester, access: Omit<ContextRequesterAccess, "userId">): void;
};

export function createFakeContextAccess(): FakeContextAccess {
  const grants = new Map<string, ContextRequesterAccess | Error>();
  const calls: ContextRequester[] = [];
  const key = (requester: ContextRequester) => `${requester.workspaceId}\0${requester.userId}`;
  return {
    grants,
    calls,
    grant(requester, access) {
      grants.set(key(requester), { userId: requester.userId, ...access });
    },
    async currentAccess(requester) {
      calls.push({ ...requester });
      const found = grants.get(key(requester));
      if (found instanceof Error) throw found;
      return found ?? null;
    },
  };
}
