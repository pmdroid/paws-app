import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { runnerDetailMarkup, runnerRuntimesMarkup, type Runner } from "./runners";
import { themedMarkup } from "./theme";

const now = 1_000_000_000;
const failure =
  "Paws could not install the runtime python@3.99: mise exited with code 1: mise ERROR no version of python matches 3.99";
const runtimes: NonNullable<Runner["runtimes"]> = [
  { tool: "aqua:cli/cli", version: "2.62.0", status: "installed", error: null, reportedAt: now },
  { tool: "node", version: "22", status: "installed", error: null, reportedAt: now },
  { tool: "python", version: "3.99", status: "failed", error: failure, reportedAt: now },
];
const runner: Runner = {
  id: "01JRUNNER0000000000000000A",
  name: "goldbox",
  ownerUserId: "owner",
  status: "active",
  metrics: null,
  os: null,
  version: "1.2.0",
  idle: true,
  runtimes,
};
const view = { now, serverVersion: null, policy: null, userId: null, role: null, busy: false };

describe("runner card runtimes", () => {
  test("lists each installed runtime with its version", () => {
    const html = runnerRuntimesMarkup(runtimes);
    expect(html).toContain('aria-label="Installed runtimes"');
    expect(html).toContain(
      '<li class="runner-skill" data-runtime-status="installed"><span class="runner-skill-name"><b>node</b><span class="mono">22</span></span><span class="tag ok">Installed</span></li>',
    );
    expect(html).toContain("<b>aqua:cli/cli</b>");
  });

  test("a failed install shows its error", () => {
    const html = runnerRuntimesMarkup(runtimes);
    expect(html).toContain(
      `<b>python</b><span class="mono">3.99</span></span><span class="tag bad">Install failed</span><p class="runner-skill-error" role="note">${failure}</p>`,
    );
    expect(runnerRuntimesMarkup([{ ...runtimes[2]!, error: null }])).toContain(
      "The runner did not report why.",
    );
  });

  test("the runner card has a Runtimes block with a count", () => {
    const detail = runnerDetailMarkup(runner, view);
    expect(detail).toContain('<h3 id="runner-01JRUNNER0000000000000000A-runtimes">Runtimes</h3>');
    expect(detail).toContain('<span class="muted">2 installed, 1 failed</span>');
    expect(detail).toContain(runnerRuntimesMarkup(runtimes));
    const themed = renderToStaticMarkup(<>{themedMarkup(detail)}</>);
    expect(themed).toContain("Install failed");
  });

  test("a runner with none says so, and an older Paws without the field shows no block", () => {
    expect(runnerDetailMarkup({ ...runner, runtimes: [] }, view)).toContain(
      "No runtimes installed yet.",
    );
    const { runtimes: _, ...older } = runner;
    expect(runnerDetailMarkup(older, view)).not.toContain("-runtimes");
    expect(runnerDetailMarkup({ ...runner, status: "revoked" }, view)).not.toContain("-runtimes");
  });
});
