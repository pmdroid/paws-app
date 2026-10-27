import {
  GENERATED_AT_HEADER,
  parseStatusSnapshot,
  statusSlicesPath,
  type StatusSlice,
  type StatusSnapshot,
} from "../contract";

export const STATUS_POLL_MS = 5000;

export type StatusRead =
  | { kind: "loaded"; snapshot: StatusSnapshot }
  | { kind: "response"; response: Response };

type Fetch = (path: string, init: RequestInit) => Promise<Response>;

export function createStatusReader(
  fetcher: Fetch = (path, init) => fetch(path, init),
): (slices: readonly StatusSlice[]) => Promise<StatusRead> {
  let last: { path: string; etag: string; snapshot: StatusSnapshot } | null = null;
  return async (slices) => {
    const path = statusSlicesPath(slices);
    const previous = last?.path === path ? last : null;
    const response = await fetcher(path, {
      headers: {
        Accept: "application/json",
        ...(previous ? { "If-None-Match": previous.etag } : {}),
      },
      cache: "no-store",
    });
    if (response.status === 304 && previous) {
      const generatedAt = response.headers.get(GENERATED_AT_HEADER);
      const snapshot =
        generatedAt && !Number.isNaN(Date.parse(generatedAt))
          ? { ...previous.snapshot, generatedAt }
          : previous.snapshot;
      last = { ...previous, snapshot };
      return { kind: "loaded", snapshot };
    }
    if (response.status !== 200) return { kind: "response", response };
    const parsed = parseStatusSnapshot(await response.json());
    if (!parsed.ok) throw new Error(parsed.error);
    const etag = response.headers.get("ETag");
    last = etag ? { path, etag, snapshot: parsed.snapshot } : null;
    return { kind: "loaded", snapshot: parsed.snapshot };
  };
}
