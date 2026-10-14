import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validate } from "../closeout-spec";
import type { SetupIO } from "./io";
import { stop } from "./stop";

/** Starter `.agents/closeout.yaml`. A file that already exists is left alone. */
export const CLOSEOUT_STARTER = `specVersion: "0.1"
description: Starter Closeout policy written by paws setup. Replace these commands with the checks this repository should pass before a pull request.
retry:
  maxFailedAttemptsPerItem: 3
  scope: task
setup:
  - id: install
    exec: ["bun", "install", "--frozen-lockfile"]
    timeoutSeconds: 600
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "test"]
    timeoutSeconds: 120
`;

export async function ensureCloseoutPolicy(input: {
  checkout: string;
  policyRoot?: string;
  yes: boolean;
  io: SetupIO;
}): Promise<void> {
  if (input.policyRoot !== undefined) {
    const loaded = validate(input.checkout, undefined, input.policyRoot);
    if (!loaded.ok) stop(`Configured local Closeout policy is invalid: ${loaded.message}`);
    return;
  }
  const path = join(input.checkout, ".agents", "closeout.yaml");
  if (existsSync(path)) return;
  const offer = `Write a starter .agents/closeout.yaml in ${input.checkout}?`;
  if (!input.yes) {
    input.io.stdout(`${offer} [y/N]`);
    const answer = (await input.io.readLine())?.trim().toLowerCase() ?? "";
    if (answer !== "y" && answer !== "yes") {
      stop(`Create .agents/closeout.yaml in ${input.checkout} before running Paws.`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, CLOSEOUT_STARTER, { mode: 0o644 });
}
