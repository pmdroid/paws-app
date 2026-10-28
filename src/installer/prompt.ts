/** Terminal prompts for `paws install`. Secret input is never echoed. */
export type Prompter = {
  /** One line of guidance on stdout. Never pass a secret here. */
  say(text: string): void;
  /** A visible answer, such as a file path or a choice. Trimmed. */
  ask(question: string): Promise<string>;
  /** A hidden answer. Trimmed. Empty means keep the current value. */
  secret(question: string): Promise<string>;
  /**
   * Show a generated secret once on the controlling terminal, not on stdout,
   * so it does not reach logs or redirected output. False when there is no terminal.
   */
  reveal(text: string): boolean;
};

export type PromptInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  readableEnded?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

export type PromptOutput = { write(text: string): unknown };

/** Reads answers from `input`. Prompts go to `output`; `terminal` receives revealed secrets. */
export function terminalPrompter(
  input: PromptInput,
  output: PromptOutput,
  terminal: PromptOutput | null,
): Prompter {
  const reader = lineReader(input);
  return {
    say(text) {
      output.write(`${text}\n`);
    },
    async ask(question) {
      output.write(question);
      return (await reader.line(false)).trim();
    },
    async secret(question) {
      output.write(question);
      const raw = input.isTTY === true && typeof input.setRawMode === "function";
      const value = await reader.line(raw);
      if (raw) output.write("\n");
      return value.trim();
    },
    reveal(text) {
      if (terminal === null) return false;
      terminal.write(`${text}\n`);
      return true;
    },
  };
}

/** Lines from a stream. In raw mode the terminal echoes nothing and this reads keystrokes. */
function lineReader(input: PromptInput): { line(raw: boolean): Promise<string> } {
  let buffer = "";
  let ended = false;
  let wake: (() => void) | null = null;
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    wake?.();
  };
  const onEnd = () => {
    ended = true;
    wake?.();
  };
  return {
    async line(raw) {
      if (input.readableEnded === true) ended = true;
      input.on("data", onData);
      input.on("end", onEnd);
      if (raw) input.setRawMode!(true);
      input.resume();
      try {
        for (;;) {
          const parsed = raw ? takeKeystrokes() : takeLine();
          if (parsed !== null) return parsed;
          if (ended) throw new Error("Input ended before an answer was given.");
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
        }
      } finally {
        if (raw) input.setRawMode!(false);
        input.pause();
        input.off("data", onData);
        input.off("end", onEnd);
      }
    },
  };

  function takeLine(): string | null {
    const end = buffer.indexOf("\n");
    if (end === -1) return ended && buffer.length > 0 ? take(buffer.length, 0) : null;
    return take(end, 1).replace(/\r$/, "");
  }

  function takeKeystrokes(): string | null {
    let value = "";
    for (let index = 0; index < buffer.length; index++) {
      const char = buffer[index]!;
      if (char === "\r" || char === "\n") {
        buffer = buffer.slice(index + 1);
        return value;
      }
      if (char === "\u0003") {
        buffer = "";
        throw new Error("Interrupted.");
      }
      if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
      else value += char;
    }
    return null;
  }

  function take(length: number, skip: number): string {
    const value = buffer.slice(0, length);
    buffer = buffer.slice(length + skip);
    return value;
  }
}
