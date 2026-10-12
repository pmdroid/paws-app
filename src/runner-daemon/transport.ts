import { request } from "node:https";

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

export function requestJson(input: {
  origin: string;
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  serverCa?: string;
  identity?: { key: string; certificate: string };
}): Promise<unknown> {
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
          accept: "application/json",
          ...(body ? { "content-type": "application/json", "content-length": body.length } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 16 * 1024 * 1024) {
            req.destroy(new Error("Runner response exceeds the allowed size."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Runner request failed with HTTP ${response.statusCode ?? 0}.`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("Runner response is not valid JSON."));
          }
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("Runner request timed out.")), 30_000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => reject(new Error("Runner HTTPS request failed.")));
    req.end(body);
  });
}
