import { GENERATED_AT_HEADER } from "../contract";

export type ResourceRead<T> =
  | { kind: "loaded"; response: T }
  | { kind: "response"; response: Response };

type Parse<T> = (input: unknown) => { ok: true; response: T } | { ok: false; error: string };
type Fetch = (path: string, init: RequestInit) => Promise<Response>;

export interface ResourceReader<T> {
  read(): Promise<ResourceRead<T>>;
  forget(): void;
}

export function createResourceReader<T extends { generatedAt: string }>(
  path: string,
  parse: Parse<T>,
  fetcher: Fetch = (url, init) => fetch(url, init),
): ResourceReader<T> {
  let last: { etag: string; response: T } | null = null;
  return {
    forget() {
      last = null;
    },
    async read() {
      const previous = last;
      const response = await fetcher(path, {
        headers: {
          Accept: "application/json",
          ...(previous ? { "If-None-Match": previous.etag } : {}),
        },
        cache: "no-store",
      });
      if (response.status === 304 && previous) {
        const generatedAt = response.headers.get(GENERATED_AT_HEADER);
        const fresh =
          generatedAt && !Number.isNaN(Date.parse(generatedAt))
            ? { ...previous.response, generatedAt }
            : previous.response;
        last = { ...previous, response: fresh };
        return { kind: "loaded", response: fresh };
      }
      if (response.status !== 200) return { kind: "response", response };
      const parsed = parse(await response.json());
      if (!parsed.ok) throw new Error(parsed.error);
      const etag = response.headers.get("ETag");
      last = etag ? { etag, response: parsed.response } : null;
      return { kind: "loaded", response: parsed.response };
    },
  };
}
