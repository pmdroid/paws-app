import { probeRunnerPlacement } from "../local/runner-placement";
import { eq } from "drizzle-orm";
import { seed } from "../pglite-fixtures";
import * as data from "../../src/db";
import { createRunnerPlacement } from "../../src/runner-placement";
import { workspaceWithRunners, REPOSITORY, NOW } from "../runner-slot-fixture";
import type { Proof } from "./harness";
export default {
  covers: ["src/runner-placement/**", "src/db/agent-account*.ts", "src/runner-backend/**"],
  summary: "Bound accounts place work and recover from temporary health failures.",
  agent: () => [],
  async run({ store: db, expect }) {
    const { pair, queue, workspace } = await workspaceWithRunners(db);
    const runnerId = await pair("bound", 1, [REPOSITORY]);
    await queue("bound-work");
    await seed(db, (q) =>
      q.orm.delete(q.t.runnerAgentPolicy).where(eq(q.t.runnerAgentPolicy.runnerId, runnerId)),
    );
    const placement = createRunnerPlacement({ store: db, now: () => NOW });
    const request = {
      itemId: "bound-work",
      role: "implementer" as const,
      purpose: "work" as const,
      profile: { agent: "claude" as const },
    };
    const binding = (await data.listAgentBindings(db, workspace.id)).find(
      (b) => b.runnerId === runnerId && !b.legacy,
    )!;
    await probeRunnerPlacement(process.env.TMPDIR!, expect);
    const at = { workspaceId: workspace.id, now: NOW };
    const a = await data.createAgentAccount(db, { ...at, agent: "claude", label: "alternate" });
    const alternate = await data.bindAgentAccount(db, { ...at, runnerId, accountId: a.id });
    const [next] = await placement.candidates({ ...request, excludeRunnerIds: [binding.id] });
    expect("failover chooses the alternate binding", next?.account?.bindingId === alternate.id);
  },
} satisfies Proof;
