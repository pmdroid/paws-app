import {
  clearRepositoryDescriptionSteps,
  listWorkspaceRepositoryNamesSteps,
  repositoryDescriptionsSteps,
  writeRepositoryDescriptionSteps,
  type Db,
} from "../db";
import { journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { isRecord, json, localRequest, readJson, sameToken } from "./handler";

export const REPOSITORY_DESCRIPTIONS_PATH = "/api/settings/repository-descriptions";

export type RepositoryDescriptionSettingsOptions = {
  store: Db;
  csrfToken: string;
  workspaceId: string;
  trustedOrigin?: string;
  role?: string;
  audit: (action: string, subject: string) => Promise<void>;
  now?: () => number;
};

export async function handleRepositoryDescriptionSettingsRequest(
  request: Request,
  options: RepositoryDescriptionSettingsOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== REPOSITORY_DESCRIPTIONS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json(
      { error: "Repository descriptions are only available on the local Paws origin" },
      403,
    );
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json(
      { error: "Only workspace admins can read or change repository descriptions." },
      403,
    );
  try {
    if (request.method === "GET") return json({ repositories: await listing(options) });
    if (request.method !== "PUT" && request.method !== "DELETE")
      return json({ error: "Method not allowed" }, 405);
    return await change(request, options);
  } catch (error) {
    journalCaught(error, "repository-descriptions.handleRequest", null);
    return json({ error: "Repository descriptions could not be read or saved" }, 503);
  }
}

async function listing(options: RepositoryDescriptionSettingsOptions) {
  return options.store.run(function* (q) {
    const names = yield* listWorkspaceRepositoryNamesSteps(q, options.workspaceId);
    const stored = new Map(
      (yield* repositoryDescriptionsSteps(q, options.workspaceId, names)).map((row) => [
        row.repository,
        row,
      ]),
    );
    return names.map((repository) => {
      const row = stored.get(repository.toLowerCase());
      return {
        repository,
        text: row?.text ?? null,
        source: row?.source ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  });
}

async function change(
  request: Request,
  options: RepositoryDescriptionSettingsOptions,
): Promise<Response> {
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    journalCaught(error, "repository-descriptions.readJson", null);
    return json({ error: "Expected a JSON body of at most 128 KiB" }, 400);
  }
  if (!isRecord(body) || typeof body.repository !== "string")
    return json({ error: "Send the repository as owner/repo." }, 400);
  const wanted = body.repository.toLowerCase();
  const names = await options.store.run((q) =>
    listWorkspaceRepositoryNamesSteps(q, options.workspaceId),
  );
  const repository = names.find((name) => name.toLowerCase() === wanted);
  if (repository === undefined)
    return json({ error: `${body.repository} is not in this workspace's repositories.` }, 404);
  if (request.method === "DELETE") {
    await options.store.transaction((q) =>
      clearRepositoryDescriptionSteps(q, options.workspaceId, repository),
    );
    await options.audit(
      "settings.repository-description",
      `Cleared the description of ${repository}`,
    );
    return json({ repositories: await listing(options) });
  }
  if (typeof body.text !== "string") return json({ error: "Send the description as text." }, 400);
  const text = body.text;
  try {
    await options.store.transaction((q) =>
      writeRepositoryDescriptionSteps(q, {
        workspaceId: options.workspaceId,
        repository,
        text,
        source: "admin",
        contentHash: null,
        now: (options.now ?? Date.now)(),
      }),
    );
  } catch (error) {
    if (error instanceof RangeError)
      return json({ error: "A repository description must be 1 to 300 characters." }, 400);
    throw error;
  }
  await options.audit("settings.repository-description", `Saved the description of ${repository}`);
  return json({ repositories: await listing(options) });
}
