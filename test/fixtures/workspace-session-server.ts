import { openPawsStore } from "../../src/db";
import { requestWorkspaceSession } from "../../src/workspace";

const opened = await openPawsStore({ url: null, pgliteDir: process.argv[2]! });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const access = await requestWorkspaceSession(opened.store, request);
    return access === null
      ? Response.json({ error: "Unauthorized" }, { status: 401 })
      : Response.json(access.principal);
  },
});
console.log(JSON.stringify({ origin: `http://127.0.0.1:${server.port}` }));
async function stop() {
  await server.stop(true);
  await opened.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
