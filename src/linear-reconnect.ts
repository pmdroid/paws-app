import { createHash } from "node:crypto";
import { pawsPaths } from "./config";
import {
  immediate,
  listLinearInstallationRevocations,
  migrate,
  openDatabase,
  restoreLinearInstallation,
} from "./db";
import {
  linearTokenPath,
  readStoredToken,
  writeStoredToken,
  type FetchLike,
  type StoredLinearToken,
} from "./linear";
import type { LinearReconnect } from "./setup";

export function createLinearReconnect(options?: {
  fetch?: FetchLike;
  now?: () => number;
}): LinearReconnect {
  return (home) => {
    const paths = pawsPaths(home);
    const path = linearTokenPath(paths.secretsDir);
    const read = () => fingerprint(readStoredToken(path));
    const previous = read();
    const grantStartedAtMs = (options?.now ?? Date.now)();
    const db = openDatabase(paths.db);
    let snapshots;
    try {
      migrate(db);
      snapshots = listLinearInstallationRevocations(db);
    } finally {
      db.close();
    }
    return {
      async complete(input) {
        const candidates = snapshots.filter((row) => row.oauthClientId === input.clientId);
        if (candidates.length === 0) return false;
        const next = fingerprint(input.token)!;
        if (next === previous) throw new Error("Reconnect Linear with a new authorization grant.");
        const response = await (options?.fetch ?? fetch)("https://api.linear.app/graphql", {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.token.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: "query PawsReconnect { viewer { id app organization { id } } }",
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error("The new Linear authorization could not be verified.");
        const json = (await response.json()) as {
          errors?: unknown[];
          data?: { viewer?: { id?: unknown; app?: unknown; organization?: { id?: unknown } } };
        };
        const viewer = json.data?.viewer;
        if (
          json.errors !== undefined ||
          typeof viewer?.id !== "string" ||
          viewer.id.trim() === "" ||
          viewer.app !== true ||
          typeof viewer.organization?.id !== "string" ||
          viewer.organization.id.trim() === ""
        )
          throw new Error("The new Linear app installation could not be verified.");
        const snapshot = candidates.find((row) => row.organizationId === viewer.organization!.id);
        if (snapshot === undefined) return false;
        if (!snapshot.appUserIds.includes(viewer.id))
          throw new Error(
            "The Linear app user must match a verified installation before reconnection.",
          );
        const current = openDatabase(paths.db);
        try {
          migrate(current);
          immediate(current, () => {
            if (read() !== previous)
              throw new Error("The stored Linear authorization changed during reconnection.");
            if (
              !restoreLinearInstallation(current, {
                organizationId: snapshot.organizationId,
                oauthClientId: input.clientId,
                appUserId: viewer.id as string,
                generation: snapshot.generation,
                grantStartedAtMs,
                credentialFingerprint: next,
              })
            )
              throw new Error("Linear access changed during reconnection. Reconnect again.");
            writeStoredToken(path, input.token);
          });
          return true;
        } finally {
          current.close();
        }
      },
    };
  };
}

function fingerprint(token: StoredLinearToken | null): string | null {
  return token === null
    ? null
    : createHash("sha256")
        .update(JSON.stringify([token.accessToken, token.refreshToken]))
        .digest("hex");
}
