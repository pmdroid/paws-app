import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse } from "node:http2";
import { createSecureContext, type TLSSocket } from "node:tls";

export type RunnerPeer = { fingerprint: string; serial: string; notAfter: number };
export type RunnerTls = { key: string; cert: string; ca: string };
export type RunnerListener = {
  port: number;
  revoke(fingerprint: string): void;
  reload(tls: RunnerTls): Promise<void>;
  stop(): Promise<void>;
};

export async function startRunnerListener(options: {
  tls: RunnerTls;
  hostname?: string;
  port?: number;
  authorize(peer: RunnerPeer): boolean | Promise<boolean>;
  fetch(request: Request, peer: RunnerPeer): Promise<Response>;
  now?: () => number;
}): Promise<RunnerListener> {
  const now = options.now ?? Date.now;
  const connections = new Map<TLSSocket, string | null>();
  const revoked = new Set<string>();
  const pending = new Set<Promise<void>>();
  let stopped = false;
  let lifecycle = Promise.resolve();
  function createServer(tls: RunnerTls) {
    createSecureContext(tls);
    const server = createSecureServer({
      ...tls,
      requestCert: true,
      rejectUnauthorized: true,
      allowHTTP1: true,
      ALPNProtocols: ["http/1.1"],
      minVersion: "TLSv1.3",
    });
    server.on("connection", (socket) => {
      connections.set(socket as TLSSocket, null);
      socket.setTimeout(45_000, () => socket.destroy());
      socket.on("error", () => {});
      socket.once("close", () => connections.delete(socket as TLSSocket));
    });
    server.on("secureConnection", (socket: TLSSocket) => {
      try {
        const peer = readPeer(socket, now());
        connections.set(socket, peer.fingerprint);
        socket.once("close", () => connections.delete(socket));
        if (revoked.has(peer.fingerprint)) socket.destroy();
      } catch {
        socket.destroy();
      }
    });
    server.on("tlsClientError", () => {});
    server.on("request", (request, response) => {
      const operation = handle(request, response).finally(() => pending.delete(operation));
      pending.add(operation);
    });
    return server;
  }
  async function authorize(socket: TLSSocket): Promise<RunnerPeer> {
    const peer = readPeer(socket, now());
    if (revoked.has(peer.fingerprint) || !(await options.authorize(peer)))
      throw new Error("Runner authorization expired");
    readPeer(socket, now());
    if (revoked.has(peer.fingerprint)) throw new Error("Runner authorization expired");
    return peer;
  }
  async function handle(request: Http2ServerRequest, response: Http2ServerResponse) {
    const abort = new AbortController();
    let cancelBody: (() => Promise<void>) | null = null;
    response.once("close", () => {
      if (!response.writableEnded) {
        abort.abort();
        void cancelBody?.().catch(() => {});
      }
    });
    try {
      if (stopped) return reject(response, 503);
      if (request.httpVersion !== "1.1") return reject(response, 505);
      const peer = await authorize(request.socket as TLSSocket);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const data = Buffer.from(chunk);
        size += data.byteLength;
        if (size > 1024 * 1024) return reject(response, 413);
        chunks.push(data);
      }
      await authorize(request.socket as TLSSocket);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string" && !name.startsWith(":")) headers.set(name, value);
      }
      const url = new URL(request.url, "https://paws-runner.invalid");
      if (url.origin !== "https://paws-runner.invalid") return reject(response, 400);
      const input = new Request(url.href, {
        method: request.method,
        headers,
        signal: abort.signal,
        ...(size > 0 ? { body: new Uint8Array(Buffer.concat(chunks)) } : {}),
      });
      const result = await options.fetch(input, peer);
      const reader = result.body?.getReader();
      if (reader) cancelBody = () => reader.cancel();
      abort.signal.throwIfAborted();
      await authorize(request.socket as TLSSocket);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (reader) {
        while (true) {
          abort.signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          await authorize(request.socket as TLSSocket);
          if (!response.write(chunk.value)) await once(response, "drain", { signal: abort.signal });
        }
        reader.releaseLock();
        cancelBody = null;
      }
      response.end();
    } catch {
      abort.abort();
      void cancelBody?.().catch(() => {});
      if (!response.headersSent && !response.destroyed) reject(response, 403);
      else response.destroy();
    }
  }
  let server = createServer(options.tls);
  async function listen(port: number) {
    await new Promise<void>((resolve, fail) => {
      server.once("error", fail);
      server.listen(port, options.hostname ?? "127.0.0.1", () => {
        server.off("error", fail);
        resolve();
      });
    });
  }
  await listen(options.port ?? 0);
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Runner TLS listener did not start");
  async function closeServer() {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of connections.keys()) socket.destroy();
    await Promise.all([closed, ...pending]);
  }
  return {
    port: address.port,
    revoke(fingerprint) {
      revoked.add(fingerprint);
      for (const [socket, identity] of connections) if (identity === fingerprint) socket.destroy();
    },
    async reload(tls) {
      if (stopped) throw new Error("Runner listener is stopped");
      const operation = lifecycle.then(async () => {
        if (stopped) return;
        const replacement = createServer(tls);
        await closeServer();
        if (stopped) return;
        server = replacement;
        await listen(address.port);
      });
      lifecycle = operation.catch(() => {});
      await operation;
    },
    async stop() {
      stopped = true;
      for (const socket of connections.keys()) socket.destroy();
      await lifecycle;
      await closeServer();
    },
  };
}

function readPeer(socket: TLSSocket, now: number): RunnerPeer {
  if (!socket.authorized) throw new Error("Runner TLS peer is not verified");
  const raw = socket.getPeerCertificate().raw;
  if (!raw) throw new Error("Runner TLS certificate is missing");
  const certificate = new X509Certificate(raw);
  const notAfter = Date.parse(certificate.validTo);
  if (
    certificate.ca ||
    Date.parse(certificate.validFrom) > now ||
    notAfter <= now ||
    !certificate.keyUsage?.includes("1.3.6.1.5.5.7.3.2")
  )
    throw new Error("Runner TLS identity is invalid");
  return { fingerprint: certificate.fingerprint256, serial: certificate.serialNumber, notAfter };
}

function reject(response: Http2ServerResponse, status: number): void {
  response.writeHead(status, { "cache-control": "no-store", connection: "close" });
  response.end(() => response.destroy());
}
