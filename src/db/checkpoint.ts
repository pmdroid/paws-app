import type { Checkpoint } from "../core";

export function readCheckpoint(raw: string): Checkpoint {
  return JSON.parse(raw) as Checkpoint;
}
