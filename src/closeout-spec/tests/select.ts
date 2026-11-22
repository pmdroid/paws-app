import type { TestSelect } from "../types";
import { bunExecError, bunTestAdapter } from "./bun";
import { cargoAdapter, cargoExecError } from "./cargo";
import { goExecError, goTestAdapter } from "./go";
import type { TestAdapter } from "./types";

export function adapterFor(runner: TestSelect["runner"]): TestAdapter {
  if (runner === "bun") return bunTestAdapter;
  return runner === "go" ? goTestAdapter : cargoAdapter(runner);
}

export function selectExecError(
  runner: TestSelect["runner"],
  exec: readonly string[],
): string | undefined {
  if (runner === "bun") return bunExecError(exec);
  return runner === "go" ? goExecError(exec) : cargoExecError(runner, exec);
}
