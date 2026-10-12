import { doctorChecks, realProbe } from "../../src/doctor";
import { detectCandidates, runSetup, selectImplementer } from "../../src/setup";

globalThis.fetch = Object.assign(
  async (input: string | URL | Request): Promise<Response> => {
    throw new Error(`Unexpected network request: ${String(input)}`);
  },
  { preconnect: () => {} },
);

const candidates = detectCandidates({
  env: process.env,
  which: (bin) => Bun.which(bin, { PATH: process.env.PATH ?? "" }),
});
const output: string[] = [];
const selected = await selectImplementer({
  candidates,
  choice: process.env.PAWS_TEST_IMPLEMENTER,
  write: (text) => output.push(text),
});
let reads = 0;
const setupCode = await runSetup(["--tracker", "linear"], {
  env: process.env,
  stdout: (line) => output.push(line),
  stderr: (line) => output.push(line),
  readLine: async () => (reads++ === 0 ? (process.env.PAWS_TEST_IMPLEMENTER ?? null) : null),
  github: {
    store: {
      backend: "file",
      warning: null,
      load: async () => ({
        accessToken: "fixture-access",
        refreshToken: null,
        expiresAtMs: null,
        scope: "repo read:org",
        login: "local-user",
        id: 7,
        invalid: false,
      }),
      save: async () => {},
      update: async (change) => change(null) !== null,
      markInvalid: async () => {},
      delete: async () => {},
    },
  },
  fetch: async (url) => {
    throw new Error(`Unexpected network request: ${url}`);
  },
});
const probe = await realProbe(process.env);
const checks = doctorChecks(probe, {
  config: {
    agents: {
      implementer: process.env.PAWS_TEST_IMPLEMENTER === "codex" ? "codex" : "claude",
      grok: { path: null, allowApiKey: false },
    },
  },
});
console.log(JSON.stringify({ candidates, output, selected, setupCode, checks }));
