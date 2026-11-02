export interface RunnerBrokerClient {
  start(executionId: string): Promise<{ alreadyAdmitted: boolean }>;
  /** Resolves only after the worker and its owned processes have terminated. Rejection is unconfirmed cleanup. */
  stop(executionId: string): Promise<void>;
  alive?(executionId: string): boolean;
  log?(executionId: string): string;
  resume?(executionId: string): Promise<void>;
  /** Stops processes of executions that have no running worker. Returns how many it found. */
  sweep?(): Promise<number>;
}
