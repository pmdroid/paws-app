import { journalCaught } from "../../journal";
import { checkoutPatterns, exclusionPatterns } from "../../worktree-checkout";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOutput, gitRun } from "./git";

/**
 * Detached checkout of `head` for one review session.
 * The reviewer reads this tree. The caller removes it when the session ends.
 */
export async function createCandidateCheckout(
  repo: string,
  head: string,
  checkoutExclusions: readonly string[] = [],
): Promise<{ path: string; remove: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "paws-review-"));
  try {
    await gitOutput(repo, ["worktree", "add", "--no-checkout", "--detach", path, head]);
    await checkoutPatterns(path, exclusionPatterns(checkoutExclusions));
  } catch (error) {
    await gitRun(repo, ["worktree", "remove", "--force", path]);
    await rm(path, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    async remove() {
      await gitRun(repo, ["worktree", "remove", "--force", path]);
      await rm(path, { recursive: true, force: true }).catch((caughtError1) => {
        journalCaught(caughtError1, "checkout.remove.rm", null, "optional file may be absent");
        return undefined;
      });
    },
  };
}
