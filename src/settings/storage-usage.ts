import { journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, sameToken } from "./handler";

export const STORAGE_USAGE_PATH = "/api/settings/storage-usage";
export const STORAGE_USAGE_REFRESH_PATH = "/api/settings/storage-usage/refresh";

export type StorageUsageSettingsOptions = {
  usage: {
    read(): Promise<unknown>;
    refresh(): Promise<void> | null;
    refreshMachine?(machine: string): Promise<"started" | "busy" | "unavailable">;
  };
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
};

export async function handleStorageUsageRequest(
  request: Request,
  options: StorageUsageSettingsOptions,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== STORAGE_USAGE_PATH && path !== STORAGE_USAGE_REFRESH_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Storage usage is only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can see storage usage." }, 403);
  const method = path === STORAGE_USAGE_PATH ? "GET" : "POST";
  if (request.method !== method) return json({ error: "Method not allowed" }, 405);
  if (method === "GET") {
    try {
      return json(await options.usage.read());
    } catch (error) {
      journalCaught(error, "storage-usage.read", null);
      return json({ error: "Storage usage could not be read" }, 503);
    }
  }
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let machine: unknown;
  try {
    const text = await request.text();
    machine = text.trim() === "" ? undefined : (JSON.parse(text) as { machine?: unknown }).machine;
  } catch {
    return json({ error: "The request body must be JSON." }, 400);
  }
  if (machine !== undefined && (typeof machine !== "string" || !options.usage.refreshMachine))
    return json({ error: "machine must name the server or a runner." }, 400);
  const outcome =
    machine === undefined
      ? options.usage.refresh() === null
        ? "busy"
        : "started"
      : await options.usage.refreshMachine!(machine);
  if (outcome === "busy") return json({ error: "A storage scan is already running." }, 409);
  if (outcome === "unavailable")
    return json({ error: "That runner is offline or too old to report its storage." }, 404);
  return json({ started: true }, 202);
}
