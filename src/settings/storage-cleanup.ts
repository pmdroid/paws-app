import { journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";

export const STORAGE_CLEANUP_PATH = "/api/settings/storage-cleanup";

type Reply = { status: number; body: unknown };

export type StorageCleanupSettingsOptions = {
  cleanup: {
    settings(): Promise<unknown>;
    save(body: unknown): Promise<Reply>;
    preview(body: unknown): Promise<Reply>;
    run(body: unknown, actor: string): Promise<Reply>;
    history(): Promise<Reply>;
  };
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  actor?: string;
};

const ROUTES: Record<string, string> = {
  "/api/settings/storage-cleanup": "GET PUT",
  "/api/settings/storage-cleanup/preview": "POST",
  "/api/settings/storage-cleanup/run": "POST",
  "/api/settings/storage-cleanup/history": "GET",
};

export async function handleStorageCleanupRequest(
  request: Request,
  options: StorageCleanupSettingsOptions,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const methods = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
  const action = path.slice(STORAGE_CLEANUP_PATH.length);
  if (methods === undefined) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Storage cleanup is only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can clean up storage." }, 403);
  if (!methods.split(" ").includes(request.method))
    return json({ error: "Method not allowed" }, 405);
  try {
    if (request.method === "GET")
      return action === ""
        ? json(await options.cleanup.settings())
        : reply(await options.cleanup.history());
    if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
      return json({ error: "CSRF token missing" }, 403);
    let body: unknown;
    try {
      body = await readJson(request);
    } catch {
      return json({ error: "Expected a JSON body of at most 128 KiB" }, 400);
    }
    if (action === "") return reply(await options.cleanup.save(body));
    if (action === "/preview") return reply(await options.cleanup.preview(body));
    return reply(await options.cleanup.run(body, options.actor ?? "local"));
  } catch (error) {
    journalCaught(error, "storage-cleanup.request", null);
    return json({ error: "Storage cleanup failed" }, 503);
  }
}

function reply({ status, body }: Reply): Response {
  return json(body, status);
}
