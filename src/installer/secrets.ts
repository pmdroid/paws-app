import { pawsPaths } from "../config";
import { setupLink } from "../onboarding";
import type { Prompter } from "./prompt";

export const SETUP_LINK_HINT = "Start Paws, then run paws setup-link to get the setup link.";

export const BROWSER_SETUP_LINE =
  "GitHub, Linear, Slack and the runner VM keys are set up in the browser.";

export type SecretsStepInput = {
  home: string;
  prompter: Prompter;
  publicUrl: string | null;
};

export function runSecretsStep(input: SecretsStepInput): void {
  const { prompter: io } = input;
  const publicUrl = input.publicUrl?.replace(/\/+$/, "") || null;
  const link = setupLink(pawsPaths(input.home).secretsDir, publicUrl);
  io.say(`Public URL: ${publicUrl ?? "not set"}`);
  io.say(link.includes("/setup?token=") ? link : SETUP_LINK_HINT);
  io.say(BROWSER_SETUP_LINE);
}
