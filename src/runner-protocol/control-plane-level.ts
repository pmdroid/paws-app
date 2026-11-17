import { z } from "zod";
import { MINIMUM_RUNNER_VERSION } from "./versions";

/** The level Paws reports on heartbeat. Released runners keep every result field at it. */
export const CONTROL_PLANE_PROTOCOL_LEVEL = MINIMUM_RUNNER_VERSION.join(".");

/** Refused paths by response. Held here, so no listener setup can send them to a runner. */
const rejectedFields = new WeakMap<Response, string>();

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
    rejectedFields.set(response, fields.slice(0, 8).join(","));
  }
  return response;
}

/** The listener's log text for `response`. */
export function takeRejectedFields(response: Response): string {
  const fields = rejectedFields.get(response);
  return fields ? ` rejected fields: ${fields}` : "";
}
