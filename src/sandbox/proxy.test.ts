import { connect } from "node:net";
import { describe, expect, test } from "bun:test";
import { authorizeTunnel, isAllowedHost, startAllowProxy } from "./index";

describe("allow-list", () => {
  test("permits vendor APIs and package registries", () => {
    expect(isAllowedHost("api.anthropic.com")).toBe(true);
    expect(isAllowedHost("API.OPENAI.COM.")).toBe(true);
    expect(isAllowedHost("registry.npmjs.org")).toBe(true);
    expect(isAllowedHost("files.pythonhosted.org")).toBe(true);
    expect(isAllowedHost("static.crates.io")).toBe(true);
    expect(isAllowedHost("proxy.golang.org")).toBe(true);
    expect(isAllowedHost("codeload.github.com")).toBe(true);
    expect(isAllowedHost("ab.chatgpt.com")).toBe(true);
    expect(authorizeTunnel("api.anthropic.com", 443)).toBe(true);
    expect(authorizeTunnel("registry.npmjs.org", 80)).toBe(true);
  });

  test("rejects other hosts, addresses, and ports", () => {
    expect(isAllowedHost("example.com")).toBe(false);
    expect(isAllowedHost("api.anthropic.com.evil.com")).toBe(false);
    expect(isAllowedHost("evilapi.anthropic.com")).toBe(false);
    expect(isAllowedHost("127.0.0.1")).toBe(false);
    expect(isAllowedHost("169.254.169.254")).toBe(false);
    expect(isAllowedHost("localhost")).toBe(false);
    expect(isAllowedHost("")).toBe(false);
    expect(authorizeTunnel("github.com", 22)).toBe(false);
    expect(authorizeTunnel("api.openai.com", 8080)).toBe(false);
    expect(authorizeTunnel("1.2.3.4", 443)).toBe(false);
  });
});

describe("allow-list proxy", () => {
  test("rejects CONNECT to a host that is not on the list", async () => {
    const proxy = await startAllowProxy();
    try {
      const denied = await connectRequest(
        proxy.port,
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
      );
      expect(denied.startsWith("HTTP/1.1 403")).toBe(true);
      const ssh = await connectRequest(
        proxy.port,
        "CONNECT github.com:22 HTTP/1.1\r\nHost: github.com:22\r\n\r\n",
      );
      expect(ssh.startsWith("HTTP/1.1 403")).toBe(true);
    } finally {
      await proxy.close();
    }
  });
});

function connectRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(payload);
    });
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(text);
    };
    timer = setTimeout(() => {
      socket.destroy();
      done(new Error(`timed out waiting for the proxy: ${text}`));
    }, 2_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      text += chunk;
      socket.end();
    });
    socket.on("error", (error) => {
      if (text.length > 0) done();
      else done(error);
    });
    socket.on("close", () => done());
  });
}
