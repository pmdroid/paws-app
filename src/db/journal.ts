let sink: (line: string) => void = (line) => console.error(line);

export function journal(line: string): void {
  sink(line);
}

export function setJournalSink(next: (line: string) => void): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}
