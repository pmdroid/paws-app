import { existsSync } from "node:fs";
import { join } from "node:path";
import { pawsPaths, type EnvSource } from "../config";
import { formatDoctor } from "../doctor";
import { initializeRunnerCoordinator } from "../runner-coordinator";
import type { InstallAnswers } from "./answers";
import type { InstallHostDeps } from "./install";

/** Final setup after the env file, config and TLS have been written. */
export async function finishInstall(input: {
  answers: InstallAnswers;
  env: EnvSource;
  deps: InstallHostDeps;
  consent(): Promise<string>;
}): Promise<number> {
  const { answers, deps } = input;
  if (answers.runnerHost) {
    const root = join(pawsPaths(answers.home).secretsDir, "runner-identity");
    if (existsSync(root)) deps.out("Keeping the existing runner authority.");
    else {
      await initializeRunnerCoordinator(root);
      deps.out("Runner authority initialized.");
    }
  }

  deps.out(formatDoctor(await deps.doctor(input.env)));
  const host = ["0.0.0.0", "::"].includes(answers.host) ? "127.0.0.1" : answers.host;
  const localUrl = `http://${host.includes(":") ? `[${host}]` : host}:${answers.port}`;
  const publicUrl = (answers.publicUrl || localUrl).replace(/\/$/, "");
  deps.out(
    [
      "Next steps:",
      `  Sign in to Linear: ${publicUrl}/auth/linear/install`,
      `  Connect GitHub in Integrations: ${publicUrl}/status/settings/integrations`,
      `  Pair the first runner, or choose Create VM on Runners: ${publicUrl}/status/runners`,
    ].join("\n"),
  );

  if ((await input.consent()) !== "yes") {
    deps.out("Service start skipped. Run paws install --start-service yes when ready.");
    return 0;
  }
  const linger = await deps.loginctl(["enable-linger"]);
  if (linger !== 0) {
    deps.out(`loginctl enable-linger exited ${linger}. Enable linger for this user and retry.`);
    return 1;
  }
  const start = await deps.systemctl(["--user", "enable", "--now", "paws.service"]);
  if (start !== 0) {
    deps.out(
      `systemctl --user enable --now paws.service exited ${start}. Check journalctl --user -u paws.service.`,
    );
    return 1;
  }
  const healthUrl = `${answers.publicDashboard ? publicUrl : localUrl}/health`;
  deps.out(`Waiting for ${healthUrl} ...`);
  if (!(await deps.waitForHealth(healthUrl))) {
    deps.out(
      `Paws did not become healthy at ${healthUrl}. Check journalctl --user -u paws.service and run paws doctor.`,
    );
    return 1;
  }
  deps.out(`Paws is healthy at ${healthUrl}.`);
  return 0;
}
