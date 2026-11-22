import { existsSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import type { TestSelect } from "../types";
import { javascriptAdapter, javascriptExecError, type JavaScriptRunner } from "./javascript";
import type { Snapshot } from "./types";

function preloads(snapshot: Snapshot): string[] {
  const text = snapshot.read("bunfig.toml");
  if (text === undefined) return [];
  const config = Bun.TOML.parse(text) as { preload?: unknown; test?: { preload?: unknown } };
  return [config.preload, config.test?.preload]
    .flat()
    .filter((path): path is string => typeof path === "string")
    .map((path) => normalize(path));
}

const bunRunner: JavaScriptRunner = {
  name: "bun",
  commands: [["bun", "test"]],
  config: /^bunfig\.toml$/,
  preloads,
  invocation(context, files = []) {
    const outfile = join(context.reportDir, "junit.xml");
    return {
      invocations: [
        {
          cwd: context.cwd,
          argv: [
            ...context.item.exec,
            "--reporter=junit",
            `--reporter-outfile=${outfile}`,
            ...files.map((file) => `./${file}`),
          ],
        },
      ],
      report: { kind: "junit", paths: [outfile] },
    };
  },
};

export const bunTestAdapter = javascriptAdapter(bunRunner);

const vitestRunner: JavaScriptRunner = {
  name: "vitest",
  commands: [
    ["vitest", "run"],
    ["npx", "vitest", "run"],
    ["bunx", "vitest", "run"],
  ],
  config: /^(vitest|vite)\.config\.[^/]+$/,
  invocation(context, files = []) {
    const outfile = join(context.reportDir, "junit.xml");
    return {
      invocations: [
        {
          cwd: context.cwd,
          argv: [
            ...context.item.exec,
            "--reporter=default",
            "--reporter=junit",
            `--outputFile=${outfile}`,
            ...files.map((file) => `./${file}`),
          ],
        },
      ],
      report: { kind: "junit", paths: [outfile], classnameIsFile: true },
    };
  },
};

export const vitestTestAdapter = javascriptAdapter(vitestRunner);

const REPORTER_ENV = [
  "JEST_JUNIT_ADD_FILE_ATTRIBUTE=true",
  "JEST_JUNIT_CLASSNAME={classname}",
  "JEST_JUNIT_TITLE={title}",
  "JEST_JUNIT_ANCESTOR_SEPARATOR= > ",
  "JEST_JUNIT_REPORT_TEST_SUITE_ERRORS=true",
  "JEST_JUNIT_OUTPUT_NAME=junit.xml",
];

function installed(root: string): boolean {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", "jest-junit", "package.json"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

const jestRunner: JavaScriptRunner = {
  name: "jest",
  commands: [["jest"], ["npx", "jest"], ["bunx", "jest"]],
  config: /^(jest|babel)\.config\.[^/]+$/,
  invocation(context, files) {
    if (!installed(context.cwd)) {
      return { invocations: [], report: { kind: "none" }, problem: "jest-junit is not installed" };
    }
    return {
      invocations: [
        {
          cwd: context.cwd,
          argv: [
            "env",
            `JEST_JUNIT_OUTPUT_DIR=${context.reportDir}`,
            ...REPORTER_ENV,
            ...context.item.exec,
            "--reporters=default",
            "--reporters=jest-junit",
            ...(files === undefined ? [] : ["--runTestsByPath", ...files]),
          ],
        },
      ],
      report: { kind: "junit", paths: [join(context.reportDir, "junit.xml")] },
    };
  },
};

export const jestTestAdapter = javascriptAdapter(jestRunner);

export const JAVASCRIPT = {
  bun: { runner: bunRunner, adapter: bunTestAdapter },
  vitest: { runner: vitestRunner, adapter: vitestTestAdapter },
  jest: { runner: jestRunner, adapter: jestTestAdapter },
} as const;

export function isJavaScript(runner: TestSelect["runner"]): runner is keyof typeof JAVASCRIPT {
  return runner in JAVASCRIPT;
}

export function javascriptRunnerError(
  runner: keyof typeof JAVASCRIPT,
  exec: readonly string[],
): string | undefined {
  return javascriptExecError(JAVASCRIPT[runner].runner, exec);
}
