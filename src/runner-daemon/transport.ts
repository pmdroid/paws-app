import { request } from "node:https";

export class RunnerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly method?: string,
    readonly path?: string,
    readonly durationMs?: number,
  ) {
    super(
      method === undefined
        ? `Runner request failed with HTTP ${status}.`
        : `Runner request ${method} ${path} failed with HTTP ${status} after ${durationMs} ms.`,
    );
    this.name = "RunnerRequestError";
  }
}

/**
 * A request that never got an HTTP response: DNS, connect, TLS or timeout. `host` is the endpoint's
 * `hostname:port` and `code` is the system or TLS error code (`ENOTFOUND`, `ECONNREFUSED`,
 * `ETIMEDOUT`, `CERT_HAS_EXPIRED`, ...), so a caller can say why without echoing a body or header.
 */
export class RunnerTransportError extends Error {
  constructor(
    message: string,
    readonly host: string,
    readonly code: string | undefined,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "RunnerTransportError";
  }
}

/** The `hostname:port` an HTTPS request to `url` connects to. */
export function endpointHost(url: URL): string {
  return `${url.hostname}:${url.port || "443"}`;
}

/** Wrap a request-level failure, keeping only a well-formed error code. */
export function transportFailure(
  error: unknown,
  url: URL,
  method: string,
  path: string,
  elapsedMs: number,
  timedOut = false,
): RunnerTransportError {
  const raw = (error as { code?: unknown } | null)?.code;
  const code = timedOut
    ? "ETIMEDOUT"
    : typeof raw === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(raw)
      ? raw
      : undefined;
  const detail = error instanceof Error ? error.message : String(error);
  return new RunnerTransportError(
    `Runner request ${method} ${path} failed after ${elapsedMs} ms: ${detail}`,
    endpointHost(url),
    code,
    error,
  );
}

export function httpsOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Runner endpoints require an HTTPS origin.");
  return url.origin;
}

type RunnerRequest = {
  origin: string;
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  serverCa?: string;
  identity?: { key: string; certificate: string };
  runGrant?: string;
};

export async function requestJson(input: RunnerRequest): Promise<unknown> {
  const bytes = await requestBytes(input, "application/json", 16 * 1024 * 1024);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Runner response is not valid JSON.");
  }
}

/**
 * Streams a response body to `onData` without holding it, refused once it passes `limit` bytes.
 * Resolves with the response headers once a 2xx body ends.
 */
export function requestStream(
  input: RunnerRequest,
  accept: string,
  limit: number,
  onData: (chunk: Buffer) => void,
  timeoutMs: number,
): Promise<Record<string, string | string[] | undefined>> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
    const url = new URL(input.path, input.origin);
    let timedOut = false;
    const req = request(
      url,
      {
        method: input.method,
        agent: false,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        ...(input.serverCa ? { ca: input.serverCa } : {}),
        ...(input.identity ? { key: input.identity.key, cert: input.identity.certificate } : {}),
        headers: {
          accept,
          ...(input.runGrant ? { authorization: `Bearer ${input.runGrant}` } : {}),
          ...(body ? { "content-type": "application/json", "content-length": body.length } : {}),
        },
      },
      (response) => {
        const ok = Boolean(
          response.statusCode && response.statusCode >= 200 && response.statusCode < 300,
        );
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          if (!ok) return;
          length += chunk.length;
          if (length > limit) {
            req.destroy(new Error("Runner response exceeds the allowed size."));
            return;
          }
          try {
            onData(chunk);
          } catch (error) {
            req.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        });
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("Runner response was cut off.")));
        response.on("end", () => {
          if (!ok) {
            reject(
              new RunnerRequestError(response.statusCode ?? 0, input.method, input.path, elapsed()),
            );
            return;
          }
          resolve(response.headers);
        });
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy(new Error("Runner request timed out."));
    }, timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (error) =>
      reject(transportFailure(error, url, input.method, input.path, elapsed(), timedOut)),
    );
    req.end(body);
  });
}

/** The raw response body, refused once it passes `limit` bytes. */
export function requestBytes(
  input: RunnerRequest,
  accept: string,
  limit: number,
  timeoutMs = 30_000,
): Promise<Buffer> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
    const url = new URL(input.path, input.origin);
    let timedOut = false;
    const req = request(
      url,
      {
        method: input.method,
        agent: false,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        ...(input.serverCa ? { ca: input.serverCa } : {}),
        ...(input.identity ? { key: input.identity.key, cert: input.identity.certificate } : {}),
        headers: {
          accept,
          ...(input.runGrant ? { authorization: `Bearer ${input.runGrant}` } : {}),
          ...(body ? { "content-type": "application/json", "content-length": body.length } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > limit) {
            req.destroy(new Error("Runner response exceeds the allowed size."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new RunnerRequestError(response.statusCode ?? 0, input.method, input.path, elapsed()),
            );
            return;
          }
          resolve(Buffer.concat(chunks));
        });
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy(new Error("Runner request timed out."));
    }, timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (error) =>
      reject(transportFailure(error, url, input.method, input.path, elapsed(), timedOut)),
    );
    req.end(body);
  });
}
