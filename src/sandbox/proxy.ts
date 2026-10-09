import { createServer, type Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { authorizeTunnel } from "./allow";

export interface AllowProxy {
  /** Bind address, for example `http://127.0.0.1:12345`. */
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * CONNECT proxy that dials only allow-listed vendor APIs and package registries.
 * It binds `127.0.0.1` unless `host` is set. Nothing is opened at import time.
 */
export function startAllowProxy(options?: { host?: string; port?: number }): Promise<AllowProxy> {
  const host = options?.host ?? "127.0.0.1";
  const server = createServer((_req, res) => {
    res.writeHead(405);
    res.end("use CONNECT");
  });
  server.on("connect", (req, socket, head) => {
    const client = socket as Socket;
    const target = parseConnect(req.url ?? "");
    if (!target || !authorizeTunnel(target.host, target.port)) {
      client.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      client.destroy();
      return;
    }
    const upstream = netConnect(target.port, target.host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const fail = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on("error", fail);
    client.on("error", fail);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options?.port ?? 0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("allow-list proxy did not bind a port"));
        return;
      }
      resolve({
        url: `http://${host}:${address.port}`,
        port: address.port,
        close: () => closeServer(server),
      });
    });
  });
}

function parseConnect(value: string): { host: string; port: number } | undefined {
  const parts = value.split(":");
  if (parts.length !== 2) return undefined;
  const host = parts[0];
  const port = Number(parts[1]);
  if (!host || !Number.isInteger(port)) return undefined;
  return { host, port };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
