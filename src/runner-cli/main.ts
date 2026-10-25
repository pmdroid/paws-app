import { runRunnerCli } from "./index";

/**
 * Entry the packaged runner runs on its bundled Bun: `/opt/paws-runner/bin/paws-runner` executes
 * this file, so `paws-runner runner <enroll|pair|daemon|worker> ...` keeps the command line the systemd
 * units and the worker supervisor already use. It loads only the runner, not the control plane.
 */
if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "runner") {
    console.error("usage: paws-runner runner <enroll|pair|daemon|worker> ...");
    process.exit(2);
  }
  process.exit(await runRunnerCli(args));
}
