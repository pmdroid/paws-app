import { z } from "zod";
import { runnerVersionAtLeast } from "./policy-keys";
import * as versions from "./versions";
import type { RunnerVersion } from "./versions";

function newest(left: RunnerVersion, right: RunnerVersion): RunnerVersion {
  return runnerVersionAtLeast(left.join("."), right) ? left : right;
}

/**
 * The newest runner release this control plane knows about. A field and its entry in
 * `versions.ts` land together, so a control plane at this level accepts every field up to it.
 */
export const CONTROL_PLANE_PROTOCOL_LEVEL = Object.values(versions)
  .reduce<RunnerVersion>(newest, [0, 0, 0])
  .join(".");

/** Result fields a control plane's strict schema refuses below the release that added them. */
const RESULT_FIELD_MINIMUMS = {
  interrupted: versions.INTERRUPT_RECOVERY_RUNNER_VERSION,
  replies: versions.CONVERSATION_RUNNER_VERSION,
  startWork: versions.CONVERSATION_RUNNER_VERSION,
} as const;

/**
 * `result` without the fields the control plane at `level` does not know. No level means a control
 * plane from before levels were reported, which may not know any of them.
 */
export function resultForControlPlane<Result extends object>(
  result: Result,
  level: string | undefined,
): Result {
  const known = Object.entries(result).filter(([field]) => {
    const minimum = RESULT_FIELD_MINIMUMS[field as keyof typeof RESULT_FIELD_MINIMUMS];
    return minimum === undefined || (level !== undefined && runnerVersionAtLeast(level, minimum));
  });
  return Object.fromEntries(known) as Result;
}

const REJECTED_FIELDS_HEADER = "x-paws-rejected-fields";

// Field names come from the request body, so only a bounded, plain form reaches the log.
function fieldName(path: readonly PropertyKey[]): string {
  const name = path.join(".").replace(/[^\w.-]/g, "?");
  return name.slice(0, 128) || "(root)";
}

/** `response` marked with the schema paths that made `error` refuse the body, if it did. */
export function withRejectedFields(response: Response, error: unknown): Response {
  if (error instanceof z.ZodError) {
    const fields = error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => fieldName([...issue.path, key]))
        : [fieldName(issue.path)],
    );
    response.headers.set(REJECTED_FIELDS_HEADER, fields.slice(0, 8).join(","));
  }
  return response;
}

/** The listener's log text for `response`. Removes the marker, so the runner never gets it. */
export function takeRejectedFields(response: Response): string {
  const fields = response.headers.get(REJECTED_FIELDS_HEADER);
  if (!fields) return "";
  response.headers.delete(REJECTED_FIELDS_HEADER);
  return ` rejected fields: ${fields}`;
}
