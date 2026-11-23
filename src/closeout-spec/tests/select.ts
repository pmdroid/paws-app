import type { TestSelect } from "../types";
import { cargoAdapter, cargoExecError } from "./cargo";
import { goExecError, goTestAdapter } from "./go";
import { pytestExecError, pytestTestAdapter } from "./pytest";
import { isJavaScript, JAVASCRIPT, javascriptRunnerError } from "./runners";
import type { TestAdapter } from "./types";

export function adapterFor(runner: TestSelect["runner"]): TestAdapter {
  if (isJavaScript(runner)) return JAVASCRIPT[runner].adapter;
  if (runner === "pytest") return pytestTestAdapter;
  return runner === "go" ? goTestAdapter : cargoAdapter(runner);
}

export function selectExecError(
  runner: TestSelect["runner"],
  exec: readonly string[],
): string | undefined {
  if (isJavaScript(runner)) return javascriptRunnerError(runner, exec);
  if (runner === "pytest") return pytestExecError(exec);
  return runner === "go" ? goExecError(exec) : cargoExecError(runner, exec);
}
