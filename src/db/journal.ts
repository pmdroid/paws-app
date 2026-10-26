// Keep existing database callers and sinks on the shared, dependency-free journal.
export { journal, setJournalSink } from "../journal";
