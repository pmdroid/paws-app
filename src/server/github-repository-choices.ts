import type { ActiveGitHubApp } from "../auth";
import { createFetchGitHubClient, INSTALLATION_PERMISSIONS } from "../github";

export async function githubRepositoryChoices(
  app: ActiveGitHubApp,
  token: string,
  selected: string | null,
  signal: AbortSignal,
  http: typeof fetch,
) {
  const client = createFetchGitHubClient((url, init) =>
    http(String(url), { ...init, signal, redirect: "error" }),
  );
  async function pages(path: string, field: string) {
    const result: Record<string, unknown>[] = [];
    const seen = new Set<number>();
    let expected: number | undefined;
    for (let page = 1; page <= 100; page++) {
      const response = await client.request({
        method: "GET",
        path: `${path}?per_page=100&page=${page}`,
        token,
      });
      if (
        response.status !== 200 ||
        !record(response.body) ||
        !Array.isArray(response.body[field]) ||
        !Number.isSafeInteger(response.body.total_count)
      )
        throw new Error("GitHub repositories could not be read. Refresh and try again.");
      if (expected !== undefined && expected !== response.body.total_count)
        throw new Error("GitHub access changed. Refresh the repository list.");
      expected = Number(response.body.total_count);
      if (expected < 0) throw new Error("Invalid GitHub repository list.");
      const entries = response.body[field] as unknown[];
      for (const entry of entries) {
        if (
          !record(entry) ||
          !Number.isSafeInteger(entry.id) ||
          Number(entry.id) <= 0 ||
          seen.has(Number(entry.id))
        )
          throw new Error("GitHub pagination did not advance.");
        seen.add(Number(entry.id));
        result.push(entry);
      }
      if (result.length === expected) return result;
      if (!entries.length || result.length > expected)
        throw new Error("GitHub returned an incomplete repository list.");
    }
    throw new Error("GitHub repository pagination exceeded its limit.");
  }
  const installations = (await pages("/user/installations", "installations"))
    .filter((entry) => String(entry.app_id) === app.appId && entry.suspended_at == null)
    .map((entry) => {
      if (!record(entry.account) || typeof entry.account.login !== "string")
        throw new Error("GitHub account is unavailable.");
      return {
        id: String(entry.id),
        account: entry.account.login,
        missingPermissions: Object.entries(INSTALLATION_PERMISSIONS)
          .filter(([key, value]) => !record(entry.permissions) || entry.permissions[key] !== value)
          .map(([key]) => key),
      };
    });
  const installationId = selected ?? installations[0]?.id ?? null;
  if (installationId !== null && !installations.some((entry) => entry.id === installationId))
    throw new Error("Choose one of your GitHub App installations.");
  const repositories =
    installationId === null
      ? []
      : (await pages(`/user/installations/${installationId}/repositories`, "repositories"))
          .filter(
            (entry) =>
              record(entry.permissions) &&
              entry.permissions.admin === true &&
              entry.archived !== true &&
              entry.disabled !== true,
          )
          .map((entry) => {
            if (
              typeof entry.full_name !== "string" ||
              !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.full_name) ||
              entry.full_name.split("/").some((part) => part === "." || part === "..")
            )
              throw new Error("GitHub returned an invalid repository.");
            return { repository: entry.full_name.toLowerCase(), private: entry.private === true };
          });
  signal.throwIfAborted();
  const missingPermissions =
    installations.find((entry) => entry.id === installationId)?.missingPermissions ?? [];
  return { installations, installationId, repositories, missingPermissions };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
