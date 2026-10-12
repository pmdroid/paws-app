import type { Database } from "bun:sqlite";
import type { LinearMembershipReads } from "../linear";
import { createWorkspaceAccess } from "./access";
import { issueWorkspaceBootstrap } from "./session";

export async function createWorkspaceAccessFromLinear(options: {
  db: Database;
  publicUrl: string;
  clientId: string;
  memberships: LinearMembershipReads;
  verifyTeam?: (id: string, signal: AbortSignal) => Promise<boolean>;
}) {
  const installedOrganization = await options.memberships.installation(AbortSignal.timeout(10_000));
  return createWorkspaceAccess({ ...options, installedOrganization });
}

export async function issueVerifiedWorkspaceBootstrap(
  db: Database,
  memberships: LinearMembershipReads,
) {
  const installation = await memberships.installation(AbortSignal.timeout(10_000));
  return { code: issueWorkspaceBootstrap(db, installation.id), organization: installation };
}
