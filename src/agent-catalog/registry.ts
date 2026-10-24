import { z } from "zod";
import type { NpmVersionMetadata } from "../db";

export const NPM_REGISTRY_URL = "https://registry.npmjs.org";

export type NpmFetchResult =
  | { status: "not-modified" }
  | { status: "not-found" }
  | { status: "ok"; etag: string | null; versions: Record<string, NpmVersionMetadata> };

/** Reads npm package documents. `etag` makes the request conditional. */
export type NpmRegistry = {
  fetchPackage(name: string, etag: string | null, signal?: AbortSignal): Promise<NpmFetchResult>;
};

export type RegistryFetch = (url: string, init: RequestInit) => Promise<Response>;

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024;

const strings = z.record(z.string(), z.unknown()).catch({});
const versionDocument = z
  .object({
    dist: z.object({ integrity: z.string().optional() }).passthrough().optional().catch(undefined),
    deprecated: z.unknown().optional(),
    dependencies: strings.optional(),
    optionalDependencies: strings.optional(),
  })
  .passthrough();
const packageDocument = z
  .object({
    versions: z.record(z.string(), z.unknown()).catch({}),
    time: z.record(z.string(), z.unknown()).catch({}),
  })
  .passthrough();

/** The npm registry over HTTP, with `If-None-Match` so an unchanged package answers 304. */
export function createNpmRegistry(
  options: { fetch?: RegistryFetch; baseUrl?: string; timeoutMs?: number } = {},
): NpmRegistry {
  const request = options.fetch ?? ((url, init) => fetch(url, init));
  const base = (options.baseUrl ?? NPM_REGISTRY_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 120_000;
  return {
    async fetchPackage(name, etag, signal) {
      if (!PACKAGE_NAME.test(name)) throw new Error(`Invalid npm package name ${name}`);
      const headers: Record<string, string> = { accept: "application/json" };
      if (etag !== null) headers["if-none-match"] = etag;
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await request(`${base}/${name.replace("/", "%2F")}`, {
        headers,
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (response.status === 304) {
        await response.body?.cancel();
        return { status: "not-modified" };
      }
      if (response.status === 404) {
        await response.body?.cancel();
        return { status: "not-found" };
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`npm registry answered ${response.status} for ${name}`);
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_DOCUMENT_BYTES) throw new Error(`npm document for ${name} is too large`);
      const text = await response.text();
      if (text.length > MAX_DOCUMENT_BYTES)
        throw new Error(`npm document for ${name} is too large`);
      return {
        status: "ok",
        etag: response.headers.get("etag"),
        versions: parsePackageDocument(JSON.parse(text)),
      };
    },
  };
}

/** Keep `time[<version>]`, `dist.integrity`, `deprecated`, and the dependency pins of each version. */
export function parsePackageDocument(value: unknown): Record<string, NpmVersionMetadata> {
  const document = packageDocument.parse(value);
  const versions: Record<string, NpmVersionMetadata> = {};
  for (const [version, raw] of Object.entries(document.versions)) {
    const parsed = versionDocument.safeParse(raw);
    if (!parsed.success) continue;
    const time = document.time[version];
    const publishedAt = typeof time === "string" ? Date.parse(time) : Number.NaN;
    const deprecated = parsed.data.deprecated;
    versions[version] = {
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      integrity: parsed.data.dist?.integrity ?? null,
      // npm "undeprecates" by setting an empty message.
      deprecated: typeof deprecated === "string" && deprecated.length > 0 ? deprecated : null,
      dependencies: onlyStrings(parsed.data.dependencies),
      optionalDependencies: onlyStrings(parsed.data.optionalDependencies),
    };
  }
  return versions;
}

function onlyStrings(value: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value ?? {}))
    if (typeof entry === "string") out[key] = entry;
  return out;
}

export type FakeNpmVersion = {
  publishedAt: number;
  integrity: string;
  deprecated?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export type FakeNpmRequest = { package: string; ifNoneMatch: string | null; status: number };

/** An in-memory npm registry. Every change gets a new ETag; `requests` records each read. */
export function createFakeNpmRegistry() {
  const packages = new Map<string, { revision: number; versions: Map<string, FakeNpmVersion> }>();
  const requests: FakeNpmRequest[] = [];
  let revision = 0;
  const entry = (name: string) => {
    let found = packages.get(name);
    if (!found) packages.set(name, (found = { revision: 0, versions: new Map() }));
    return found;
  };
  const change = (name: string, update: (versions: Map<string, FakeNpmVersion>) => void) => {
    const found = entry(name);
    update(found.versions);
    found.revision = ++revision;
  };
  const fetchFake: RegistryFetch = async (url, init) => {
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    const headers = new Headers(init.headers);
    const ifNoneMatch = headers.get("if-none-match");
    const found = packages.get(name);
    const respond = (status: number, body?: unknown, etag?: string) => {
      requests.push({ package: name, ifNoneMatch, status });
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: etag ? { etag } : {},
      });
    };
    if (!found) return respond(404, { error: "Not found" });
    const etag = `"${name}-${found.revision}"`;
    if (ifNoneMatch === etag) return respond(304, undefined, etag);
    const versions: Record<string, unknown> = {};
    const time: Record<string, string> = { created: new Date(0).toISOString() };
    for (const [version, value] of found.versions) {
      versions[version] = {
        name,
        version,
        dist: { integrity: value.integrity, tarball: `${url}/-/${version}.tgz` },
        ...(value.deprecated ? { deprecated: value.deprecated } : {}),
        ...(value.dependencies ? { dependencies: value.dependencies } : {}),
        ...(value.optionalDependencies ? { optionalDependencies: value.optionalDependencies } : {}),
      };
      time[version] = new Date(value.publishedAt).toISOString();
    }
    return respond(200, { name, versions, time }, etag);
  };
  return {
    requests,
    fetch: fetchFake,
    registry: createNpmRegistry({ fetch: fetchFake, baseUrl: "https://registry.test" }),
    publish(name: string, version: string, value: FakeNpmVersion) {
      change(name, (versions) => versions.set(version, value));
    },
    deprecate(name: string, version: string, message: string) {
      change(name, (versions) => {
        const found = versions.get(version);
        if (found) found.deprecated = message;
      });
    },
    /** What a compromised or replaced tarball looks like from the metadata. */
    replaceIntegrity(name: string, version: string, integrity: string) {
      change(name, (versions) => {
        const found = versions.get(version);
        if (found) found.integrity = integrity;
      });
    },
    unpublish(name: string, version: string) {
      change(name, (versions) => versions.delete(version));
    },
  };
}

export type FakeNpmRegistry = ReturnType<typeof createFakeNpmRegistry>;
