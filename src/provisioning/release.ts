import { journalCaught } from "../journal";
import type { ExeDevFetch } from "./client";

export const LATEST_RUNNER_RELEASE_URL =
  "https://api.github.com/repos/pmdroid/paws-app/releases/latest";

export async function latestRunnerRelease(
  fetcher: ExeDevFetch = (url, init) => fetch(url, init),
): Promise<string | null> {
  try {
    const response = await fetcher(LATEST_RUNNER_RELEASE_URL, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const tag =
      typeof body === "object" && body !== null && "tag_name" in body ? body.tag_name : null;
    const match = typeof tag === "string" ? /^v(\d+\.\d+\.\d+)$/.exec(tag) : null;
    return match?.[1] ?? null;
  } catch (caughtError1) {
    journalCaught(caughtError1, "release.latestRunnerRelease.fetcher", null);
    return null;
  }
}
