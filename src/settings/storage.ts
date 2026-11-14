import { journalCaught } from "../journal";
import {
  checkRunnerStorageSettings,
  RunnerStorageSettingsError,
  runnerStorageSettings,
  saveRunnerStorageSettings,
} from "../runner-transcript-config";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";

export const STORAGE_SETTINGS_PATH = "/api/settings/storage";
export const STORAGE_CHECK_PATH = "/api/settings/storage/check";

export type StorageSettingsOptions = {
  home: string;
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  audit: (action: string, subject: string) => Promise<void>;
  objects?: Parameters<typeof checkRunnerStorageSettings>[2];
};

export async function handleStorageSettingsRequest(
  request: Request,
  options: StorageSettingsOptions,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== STORAGE_SETTINGS_PATH && path !== STORAGE_CHECK_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Storage settings are only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can manage storage." }, 403);
  const method = path === STORAGE_CHECK_PATH ? "POST" : request.method === "GET" ? "GET" : "PUT";
  if (request.method !== method) return json({ error: "Method not allowed" }, 405);
  let before: ReturnType<typeof runnerStorageSettings>;
  try {
    before = runnerStorageSettings(options.home);
  } catch (error) {
    journalCaught(error, "storage.handleStorageSettingsRequest.read", null);
    return json({ error: "Storage settings could not be read" }, 503);
  }
  if (method === "GET") return json(before);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  if (method === "PUT" && before.source === "environment")
    return json({ error: "Storage is set by PAWS_S3_* environment variables on this host." }, 409);
  let body: unknown;
  try {
    body =
      method === "POST" && request.headers.get("content-type") === null
        ? undefined
        : await readJson(request);
  } catch (error) {
    journalCaught(error, "storage.handleStorageSettingsRequest.body", null);
    return json({ error: "Expected a JSON body of at most 128 KiB" }, 400);
  }
  let restartRequired: boolean;
  try {
    if (method === "POST") {
      await checkRunnerStorageSettings(options.home, body, options.objects);
      return json({ ok: true });
    }
    restartRequired = await saveRunnerStorageSettings(options.home, body);
  } catch (error) {
    if (error instanceof RunnerStorageSettingsError) return json({ error: error.message }, 400);
    journalCaught(error, "storage.handleStorageSettingsRequest.apply", null);
    if (method === "POST")
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    return json({ error: "Storage settings could not be saved" }, 503);
  }
  const after = runnerStorageSettings(options.home);
  const secret = (body as { secretAccessKey?: unknown }).secretAccessKey;
  await options.audit(
    "settings.storage",
    after.kind === "local"
      ? "Set storage: local"
      : `Set storage: S3 bucket ${after.bucket} at ${after.endpoint} (${after.region}), secret access key ${secret === undefined ? "kept" : "replaced"}`,
  );
  return json({ ...after, restartRequired });
}
