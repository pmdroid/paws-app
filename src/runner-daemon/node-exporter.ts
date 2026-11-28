import { journalCaught } from "../journal";
import { RunnerHostMetricsSchema, type RunnerHostMetrics } from "../runner-protocol";
import { RunnerRequestError } from "./transport";

const LOCAL_EXPORTER = "http://127.0.0.1:9100/metrics";
const EXPORTER_DEFAULTS = "/etc/default/prometheus-node-exporter";
const FIRST_INTERVAL_MS = 30_000;
const UNREACHABLE_RETRY_MS = 10 * 60_000;
const MISSING_ROUTE_RETRY_MS = 60 * 60_000;
const SCRAPE_TIMEOUT_MS = 5_000;
const SCRAPE_MAX_BYTES = 4 * 1024 * 1024;

const SKIPPED_DEVICES = /^(lo$|veth|docker|br-|pawsvm|tailscale)/;

export type NodeExporterSample = {
  cpuCount?: number;
  cpuIdleSeconds?: number;
  cpuTotalSeconds?: number;
  memoryTotalBytes?: number;
  memoryAvailableBytes?: number;
  rootSizeBytes?: number;
  rootAvailableBytes?: number;
  load1?: number;
  networkReceiveBytes?: number;
  networkTransmitBytes?: number;
  diskIoSeconds?: number;
  memoryWaitingSeconds?: number;
};

type Labels = Record<string, string>;
type Family = { field: keyof NodeExporterSample; sum?: true; when?: (labels: Labels) => boolean };
const root = (labels: Labels) => labels.mountpoint === "/";
const counted = (labels: Labels) => !SKIPPED_DEVICES.test(labels.device ?? "");

const FAMILIES = new Map<string, Family>([
  ["node_cpu_seconds_total", { field: "cpuTotalSeconds", sum: true }],
  ["node_memory_MemTotal_bytes", { field: "memoryTotalBytes" }],
  ["node_memory_MemAvailable_bytes", { field: "memoryAvailableBytes" }],
  ["node_filesystem_size_bytes", { field: "rootSizeBytes", when: root }],
  ["node_filesystem_avail_bytes", { field: "rootAvailableBytes", when: root }],
  ["node_load1", { field: "load1" }],
  ["node_network_receive_bytes_total", { field: "networkReceiveBytes", sum: true, when: counted }],
  [
    "node_network_transmit_bytes_total",
    { field: "networkTransmitBytes", sum: true, when: counted },
  ],
  ["node_disk_io_time_seconds_total", { field: "diskIoSeconds", sum: true }],
  ["node_pressure_memory_waiting_seconds_total", { field: "memoryWaitingSeconds" }],
]);

export function parseNodeExporter(text: string): NodeExporterSample {
  const sample: NodeExporterSample = {};
  const cpus = new Set<string>();
  const disks = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    const family = match && FAMILIES.get(match[1]!);
    const value = Number(match?.[3]);
    if (!family || !Number.isFinite(value)) continue;
    const labels: Labels = {};
    for (const label of (match[2] ?? "").matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g))
      labels[label[1]!] = label[2]!;
    if (family.when && !family.when(labels)) continue;
    if (family.field === "cpuTotalSeconds") {
      cpus.add(labels.cpu ?? "");
      if (labels.mode === "idle") sample.cpuIdleSeconds = (sample.cpuIdleSeconds ?? 0) + value;
    }
    if (family.field === "diskIoSeconds") disks.add(labels.device ?? "");
    sample[family.field] = family.sum
      ? (sample[family.field] ?? 0) + value
      : (sample[family.field] ?? value);
  }
  if (cpus.size > 0) sample.cpuCount = cpus.size;
  if (sample.diskIoSeconds !== undefined) sample.diskIoSeconds /= disks.size;
  return sample;
}

export function hostMetricsReport(
  at: number,
  current: NodeExporterSample,
  previous?: { at: number; sample: NodeExporterSample },
): RunnerHostMetrics {
  const seconds = previous ? (at - previous.at) / 1000 : 0;
  const perSecond = (field: keyof NodeExporterSample) => {
    const now = current[field];
    const before = previous?.sample[field];
    if (now === undefined || before === undefined || seconds <= 0 || now < before) return undefined;
    return (now - before) / seconds;
  };
  const share = (field: keyof NodeExporterSample) => {
    const value = perSecond(field);
    return value === undefined ? undefined : Math.min(1, value);
  };
  const minus = (a?: number, b?: number) =>
    a === undefined || b === undefined ? undefined : Math.max(0, a - b);
  const idle = perSecond("cpuIdleSeconds");
  const total = perSecond("cpuTotalSeconds");
  const fields: Record<string, number | undefined> = {
    cpuCount: current.cpuCount,
    cpuBusyRatio:
      idle === undefined || !total ? undefined : Math.min(1, Math.max(0, 1 - idle / total)),
    diskBusyRatio: share("diskIoSeconds"),
    memoryPressureRatio: share("memoryWaitingSeconds"),
    memoryUsedBytes: minus(current.memoryTotalBytes, current.memoryAvailableBytes),
    memoryTotalBytes: current.memoryTotalBytes,
    rootUsedBytes: minus(current.rootSizeBytes, current.rootAvailableBytes),
    rootSizeBytes: current.rootSizeBytes,
    load1: current.load1,
    networkReceiveBytesPerSecond: perSecond("networkReceiveBytes"),
    networkTransmitBytesPerSecond: perSecond("networkTransmitBytes"),
  };
  const report: Record<string, number> = { at };
  for (const [name, value] of Object.entries(fields)) {
    const field = RunnerHostMetricsSchema.shape[name as keyof typeof RunnerHostMetricsSchema.shape];
    if (value !== undefined && field.safeParse(value).success) report[name] = value;
  }
  return report as RunnerHostMetrics;
}

export function exporterDefaultsUrl(defaults: string): string | undefined {
  const args = /^\s*ARGS=(?:"([^"]*)"|'([^']*)'|(\S*))/m.exec(defaults);
  const listen = /--web\.listen-address[=\s]+["']?([^\s"']+)/.exec(
    args?.[1] ?? args?.[2] ?? args?.[3] ?? "",
  );
  const address = listen?.[1];
  if (!address || !/^(\d{1,3}\.){3}\d{1,3}:9100$/.test(address)) return undefined;
  return `http://${address}/metrics`;
}

async function scrape(url: string, timeoutMs: number): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: abort.signal, redirect: "error" });
    if (!response.ok || !response.body)
      throw new Error(`Node exporter answered ${response.status}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > SCRAPE_MAX_BYTES) throw new Error("Node exporter answer is too large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

export function createRunnerHostMetricsReporter(options: {
  daemon: { postHostMetrics(report: RunnerHostMetrics): Promise<{ intervalMs: number }> };
  exporterUrl?: string;
  defaultsFile?: string;
  now?: () => number;
  timeoutMs?: number;
}) {
  const now = options.now ?? Date.now;
  let intervalMs = FIRST_INTERVAL_MS;
  let nextAt = 0;
  let previous: { at: number; sample: NodeExporterSample } | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const read = async () => {
    const timeoutMs = options.timeoutMs ?? SCRAPE_TIMEOUT_MS;
    const primary = options.exporterUrl ?? LOCAL_EXPORTER;
    try {
      return await scrape(primary, timeoutMs);
    } catch (error) {
      const defaults = Bun.file(options.defaultsFile ?? EXPORTER_DEFAULTS);
      const fallback = exporterDefaultsUrl(await defaults.text().catch(() => ""));
      if (fallback === undefined || fallback === primary) throw error;
      return await scrape(fallback, timeoutMs);
    }
  };
  const report = async () => {
    let text: string;
    try {
      text = await read();
    } catch (error) {
      journalCaught(error, "runner-daemon.node-exporter.scrape", null);
      nextAt = now() + UNREACHABLE_RETRY_MS;
      return;
    }
    const at = now();
    const sample = parseNodeExporter(text);
    const body = hostMetricsReport(at, sample, previous);
    previous = { at, sample };
    nextAt = at + intervalMs;
    if (stopped) return;
    try {
      intervalMs = (await options.daemon.postHostMetrics(body)).intervalMs;
      nextAt = at + intervalMs;
    } catch (error) {
      if (error instanceof RunnerRequestError && error.status === 404)
        nextAt = at + MISSING_ROUTE_RETRY_MS;
      else journalCaught(error, "runner-daemon.node-exporter.post", null);
    }
  };
  return {
    tick() {
      if (stopped || running || now() < nextAt) return;
      running = report().finally(() => {
        running = undefined;
      });
    },
    running: () => running ?? null,
    async stop() {
      stopped = true;
      await running;
    },
  };
}
