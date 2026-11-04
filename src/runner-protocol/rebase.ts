import { z } from "zod";
import { runnerVersionAtLeast } from "./policy-keys";
import { REMOTE_REBASE_RUNNER_VERSION } from "./versions";

export const RUNNER_REBASE_LIFETIME_MS = 600_000;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const identityText = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) =>
    [...value].every((char) => char >= " " && char !== "\x7f" && !"<>".includes(char)),
  );

export const RunnerRebaseCommandSchema = z
  .strictObject({
    id,
    runnerId: id,
    workspaceId: id,
    issuedAt: time,
    expiresAt: time,
    type: z.literal("rebase"),
    itemId: id,
    repository: z
      .string()
      .max(512)
      .regex(
        /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}\.git$/,
      ),
    branch: z
      .string()
      .max(256)
      .regex(/^paws\/[A-Za-z0-9][A-Za-z0-9._/-]*$/)
      .refine((branch) => !branch.includes("..") && !branch.endsWith(".lock")),
    head: sha,
    main: sha,
    committer: z.strictObject({ name: identityText, email: identityText }),
  })
  .refine((command) => command.expiresAt > command.issuedAt)
  .refine((command) => command.expiresAt - command.issuedAt <= RUNNER_REBASE_LIFETIME_MS)
  .refine((command) => command.head !== command.main);

export const RunnerRebaseResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("rebased"), head: sha }),
  z.strictObject({
    outcome: z.literal("conflict"),
    files: z.array(z.string().min(1).max(4096)).max(100),
  }),
  z.strictObject({ outcome: z.literal("failed"), reason: z.string().min(1).max(4096) }),
]);

export type RunnerRebaseCommand = z.infer<typeof RunnerRebaseCommandSchema>;
export type RunnerRebaseResult = z.infer<typeof RunnerRebaseResultSchema>;

export function runnerAcceptsRebase(version: string | null | undefined): boolean {
  return version != null && runnerVersionAtLeast(version, REMOTE_REBASE_RUNNER_VERSION);
}
