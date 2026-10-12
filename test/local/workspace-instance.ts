import { probeWorkspaceRuntime } from "./workspace-runtime";
import { probeWorkspaceIdentityLinks } from "./workspace-identity-links";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeWorkspaceAccess } from "./workspace-access";
import { probeWorkspaceBrowser } from "./workspace-browser";
import { probeWorkspaceRefresh } from "./workspace-refresh";
import { probeWorkspaceAuthorization } from "./workspace-authorization";

const root = process.env.PAWS_VERIFY_ROOT;
if (root === undefined) throw new Error("Use scripts/verify-local.ts workspace.");
const observations: { name: string; passed: boolean; observed: unknown }[] = [];
try {
  await probeWorkspaceAccess(join(root, "workspace-access"), (name, passed, observed) => {
    observations.push({ name, passed, observed });
    console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(observed)}`);
  });
  await probeWorkspaceBrowser(join(root, "workspace-browser"), (name, passed, observed) => {
    observations.push({ name, passed, observed });
    console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(observed)}`);
  });
  await probeWorkspaceRefresh(join(root, "workspace-refresh"), (name, passed, observed) => {
    observations.push({ name, passed, observed });
    console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(observed)}`);
  });
  await probeWorkspaceAuthorization(
    join(root, "workspace-authorization"),
    (name, passed, observed) => {
      observations.push({ name, passed, observed });
      console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(observed)}`);
    },
  );
  await probeWorkspaceIdentityLinks(
    join(root, "workspace-identity-links"),
    (name, passed, observed) => {
      observations.push({ name, passed, observed });
      console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(observed)}`);
    },
  );
  await probeWorkspaceRuntime(join(root, "workspace-runtime"), (name, passed, observed) => {
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
