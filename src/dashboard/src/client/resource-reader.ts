import { GENERATED_AT_HEADER } from "../contract";

export type ResourceRead<T> =
  | { kind: "loaded"; body: T }
  | { kind: "response"; response: Response };

export type ResourceParse<T> = (
  input: unknown,
) => { ok: true; body: T } | { ok: false; error: string };

type Fetch = (path: string, init: RequestInit) => Promise<Response>;

const KEPT_BODIES = 16;

export interface ResourceReader {
  read<T extends { generatedAt: string }>(
    path: string,
    reader: string,
    parse: ResourceParse<T>,
    signal?: AbortSignal,
  ): Promise<ResourceRead<T>>;
  clear(): void;
}

export function createResourceReader(
  fetcher: Fetch = (path, init) => fetch(path, init),
): ResourceReader {
  const kept = new Map<string, { etag: string; body: { generatedAt: string } }>();
  let era = 0;
  return {
    async read<T extends { generatedAt: string }>(
      path: string,
      reader: string,
      parse: ResourceParse<T>,
      signal?: AbortSignal,
    ): Promise<ResourceRead<T>> {
      const key = JSON.stringify([reader, path]);
      const started = era;
      const previous = kept.get(key) as { etag: string; body: T } | undefined;
      const response = await fetcher(path, {
        headers: {
          Accept: "application/json",
          ...(previous ? { "If-None-Match": previous.etag } : {}),
        },
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
      if (response.status === 304 && previous) {
        const generatedAt = response.headers.get(GENERATED_AT_HEADER);
        const body =
          generatedAt && !Number.isNaN(Date.parse(generatedAt))
            ? { ...previous.body, generatedAt }
            : previous.body;
        if (started === era) keep(key, { etag: previous.etag, body });
        return { kind: "loaded", body };
      }
      if (response.status !== 200) return { kind: "response", response };
      const parsed = parse(await response.json());
      if (!parsed.ok) throw new Error(parsed.error);
      const etag = response.headers.get("ETag");
      if (started === era) {
        if (etag) keep(key, { etag, body: parsed.body });
        else kept.delete(key);
      }
      return { kind: "loaded", body: parsed.body };
    },
    clear() {
      era += 1;
      kept.clear();
    },
  };

  function keep(key: string, entry: { etag: string; body: { generatedAt: string } }): void {
    kept.delete(key);
    kept.set(key, entry);
    for (const oldest of kept.keys()) {
      if (kept.size <= KEPT_BODIES) break;
      kept.delete(oldest);
    }
  }
}
