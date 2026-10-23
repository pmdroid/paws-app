import { request } from "node:https";

export class RunnerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly method?: string,
    readonly path?: string,
    readonly durationMs?: number,
  ) {
    super(`Runner request failed with HTTP ${status}.`);
    this.name = "RunnerRequestError";
  }
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

/** The raw response body, refused once it passes `limit` bytes. */
export function requestBytes(
  input: RunnerRequest,
  accept: string,
  limit: number,
  timeoutMs = 30_000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
    const req = request(
      new URL(input.path, input.origin),
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
            reject(new RunnerRequestError(response.statusCode ?? 0));
            return;
          }
          resolve(Buffer.concat(chunks));
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("Runner request timed out.")), timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => reject(new Error("Runner HTTPS request failed.")));
    req.end(body);
  });
}
