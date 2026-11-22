import type { TestSelect } from "../types";
import { cargoAdapter, cargoExecError } from "./cargo";
import { goExecError, goTestAdapter } from "./go";
import { isJavaScript, JAVASCRIPT, javascriptRunnerError } from "./runners";
import type { TestAdapter } from "./types";

export function adapterFor(runner: TestSelect["runner"]): TestAdapter {
  if (isJavaScript(runner)) return JAVASCRIPT[runner].adapter;
  return runner === "go" ? goTestAdapter : cargoAdapter(runner);
}

export function selectExecError(
  runner: TestSelect["runner"],
  exec: readonly string[],
): string | undefined {
  if (isJavaScript(runner)) return javascriptRunnerError(runner, exec);
  return runner === "go" ? goExecError(exec) : cargoExecError(runner, exec);
}
