import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  compareReceipts,
  formatShadowReport,
  parseRulecheckReceipt,
  readCloseoutReceipt,
  type ShadowComparison,
  type ShadowSide,
} from "../src/rulecheck-shadow";

const USAGE =
  "Usage: bun scripts/rulecheck-shadow.ts --head SHA --ci rulecheck-evidence.json (--evidence DIR [--item rulecheck] | --paws receipt.json) [--merge-group --pull-head SHA] [--json]";
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const EXIT = { agree: 0, disagree: 1, incomplete: 2 } as const;

export function runShadow(argv: readonly string[]): { exitCode: number; output: string } {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      head: { type: "string" },
      ci: { type: "string" },
      evidence: { type: "string" },
      item: { type: "string", default: "rulecheck" },
      paws: { type: "string" },
      "merge-group": { type: "boolean", default: false },
      "pull-head": { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const head = values.head;
  const pullHead = values["pull-head"];
  if (
    head === undefined ||
    !SHA.test(head) ||
    values.ci === undefined ||
    (values.evidence === undefined) === (values.paws === undefined) ||
    (values["merge-group"] && (pullHead === undefined || !SHA.test(pullHead)))
  )
    return { exitCode: 64, output: `${USAGE}\n` };
  const comparison = compareReceipts({
    head,
    ci: fileSide(values.ci, "CI artifact"),
    paws:
      values.paws !== undefined
        ? fileSide(values.paws, "Paws receipt")
        : readCloseoutReceipt({ evidenceDir: values.evidence!, itemId: values.item, head }),
    ...(values["merge-group"] ? { mergeGroup: { pullHead: pullHead! } } : {}),
  });
  return { exitCode: EXIT[comparison.status], output: render(comparison, values.json) };
}

function fileSide(path: string, label: string): ShadowSide {
  const source = `${label} ${path}`;
  if (!existsSync(path)) return { receipt: null, source, reason: `${path} does not exist.` };
  const parsed = parseRulecheckReceipt(readFileSync(path, "utf8"));
  return parsed.ok
    ? { receipt: parsed.receipt, source }
    : { receipt: null, source, reason: parsed.reason };
}

function render(comparison: ShadowComparison, json: boolean): string {
  return json ? `${JSON.stringify(comparison, null, 2)}\n` : formatShadowReport(comparison);
}

if (import.meta.main) {
  const { exitCode, output } = runShadow(process.argv.slice(2));
  (exitCode === 64 ? process.stderr : process.stdout).write(output);
  process.exitCode = exitCode;
}
