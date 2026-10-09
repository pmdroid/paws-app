/** A setup check failed. The message is one actionable line and contains no secrets. */
export class SetupStopped extends Error {
  readonly line: string;

  constructor(line: string) {
    const one = line.replace(/\s+/g, " ").trim();
    super(one);
    this.name = "SetupStopped";
    this.line = one;
  }
}

export function stop(line: string): never {
  throw new SetupStopped(line);
}
