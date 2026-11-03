import {
  parseStatusSnapshot,
  statusSlicesPath,
  type StatusSlice,
  type StatusSnapshot,
} from "../contract";
import { createResourceReader, type ResourceReader } from "./resource-reader";

export const STATUS_POLL_MS = 5000;

export type StatusRead =
  | { kind: "loaded"; snapshot: StatusSnapshot }
  | { kind: "response"; response: Response };

type Fetch = (path: string, init: RequestInit) => Promise<Response>;

function parseSnapshot(input: unknown) {
  const parsed = parseStatusSnapshot(input);
  return parsed.ok ? { ok: true as const, body: parsed.snapshot } : parsed;
}

export function createStatusReader(
  fetcher: Fetch | ResourceReader = (path, init) => fetch(path, init),
): (slices: readonly StatusSlice[], reader?: string) => Promise<StatusRead> {
  const resources = typeof fetcher === "function" ? createResourceReader(fetcher) : fetcher;
  return async (slices, reader = "") => {
    const read = await resources.read(statusSlicesPath(slices), reader, parseSnapshot);
    return read.kind === "loaded" ? { kind: "loaded", snapshot: read.body } : read;
  };
}
