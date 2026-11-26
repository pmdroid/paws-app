import { expect, test } from "bun:test";
import { startServer } from "../src/server";

const CHECKS = [
  { name: "git", ok: true, detail: "/usr/bin/git" },
  { name: "linear", ok: false, detail: "not connected", fix: "Open Paws and connect Linear." },
  { name: "database", ok: true, detail: "held", note: true },
];

test("GET /api/settings/doctor returns the doctor's checks", async () => {
  let calls = 0;
  const server = startServer({
    hostname: "127.0.0.1",
    port: 0,
    webhooks: false,
    doctor: async () => {
      calls++;
      return CHECKS;
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const read = await fetch(`${base}/api/settings/doctor`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ checks: CHECKS });
    const posted = await fetch(`${base}/api/settings/doctor`, {
      method: "POST",
      headers: { origin: base },
    });
    expect(posted.status).not.toBe(200);
    expect(calls).toBe(1);
  } finally {
    server.stop(true);
  }
});
