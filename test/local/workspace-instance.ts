import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeWorkspaceAccess } from "./workspace-access";

const root = process.env.PAWS_VERIFY_ROOT;
if (root === undefined) throw new Error("Use scripts/verify-local.ts workspace.");
const observations: { name: string; passed: boolean; observed: unknown }[] = [];
try {
  await probeWorkspaceAccess(join(root, "workspace-access"), (name, passed, observed) => {
    observations.push({ name, passed, observed });
    console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(observed)}`);
  });
} catch (error) {
  observations.push({
    name: "Workspace verification completed",
    passed: false,
    observed: String(error),
  });
} finally {
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
}
process.exitCode = observations.some((entry) => !entry.passed) ? 1 : 0;
