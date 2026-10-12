import type { S3Client } from "bun";

export interface RunnerTranscriptObjects {
  write(key: string, bytes: Blob | ReadableStream<Uint8Array>): Promise<void>;
  read(key: string): ReadableStream<Uint8Array>;
  uri(key: string): string;
}

export function createS3RunnerTranscriptObjects(options: {
  client: S3Client;
  bucket: string;
}): RunnerTranscriptObjects {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket))
    throw new Error("Invalid transcript bucket");
  return {
    async write(key, bytes) {
      await options.client.file(key).write(bytes instanceof Blob ? bytes : new Response(bytes), {
        type: "application/x-ndjson",
        queueSize: 1,
        partSize: 5_242_880,
        retry: 1,
      });
    },
    read: (key) => options.client.file(key).stream(),
    uri: (key) => `s3://${options.bucket}/${key}`,
  };
}

export function createFakeRunnerTranscriptObjects() {
  const objects = new Map<string, Uint8Array>();
  const writes: string[] = [];
  return {
    objects,
    writes,
    async write(key: string, bytes: Blob | ReadableStream<Uint8Array>) {
      objects.set(key, new Uint8Array(await new Response(bytes).arrayBuffer()));
      writes.push(key);
    },
    read(key: string) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("Transcript object missing");
      return new Blob([bytes]).stream();
    },
    uri: (key: string) => `s3://fixture-transcripts/${key}`,
  } satisfies RunnerTranscriptObjects & {
    objects: Map<string, Uint8Array>;
    writes: string[];
  };
}
