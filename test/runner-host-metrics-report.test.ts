import { afterEach, expect, test } from "bun:test";
import { createRunnerHostMetricsReporter, RunnerRequestError } from "../src/runner-daemon";
import { exporterDefaultsUrl } from "../src/runner-daemon/node-exporter";
import type { RunnerHostMetrics } from "../src/runner-protocol";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const FIRST = `# TYPE node_cpu_seconds_total counter
node_cpu_seconds_total{cpu="0",mode="idle"} 100
node_cpu_seconds_total{cpu="0",mode="user"} 50
node_cpu_seconds_total{cpu="0",mode="system"} 10
node_cpu_seconds_total{cpu="1",mode="idle"} 200
node_cpu_seconds_total{cpu="1",mode="user"} 30
node_cpu_seconds_total{cpu="1",mode="iowait"} 10
node_cpu_guest_seconds_total{cpu="0",mode="user"} 999
node_memory_MemTotal_bytes 8e+09
node_memory_MemAvailable_bytes 3e+09
node_filesystem_size_bytes{device="/dev/sda1",fstype="ext4",mountpoint="/"} 1e+11
node_filesystem_avail_bytes{device="/dev/sda1",fstype="ext4",mountpoint="/"} 4e+10
node_load1 1.5
node_network_receive_bytes_total{device="eth0"} 1000
node_network_transmit_bytes_total{device="eth0"} 500
node_network_transmit_bytes_total{device="wlan0"} 0
node_disk_io_time_seconds_total{device="sda"} 10
node_disk_io_time_seconds_total{device="nvme0n1"} 20
node_pressure_memory_waiting_seconds_total 5
`;

const SECOND = `node_cpu_seconds_total{cpu="0",mode="idle"} 106
node_cpu_seconds_total{cpu="0",mode="user"} 52
node_cpu_seconds_total{cpu="0",mode="system"} 12
node_cpu_seconds_total{cpu="1",mode="idle"} 206
node_cpu_seconds_total{cpu="1",mode="user"} 34
node_cpu_seconds_total{cpu="1",mode="iowait"} 10
node_memory_MemTotal_bytes 8e+09
node_memory_MemAvailable_bytes 2e+09
node_filesystem_size_bytes{device="/dev/sda1",fstype="ext4",mountpoint="/"} 1e+11
node_filesystem_avail_bytes{device="/dev/sda1",fstype="ext4",mountpoint="/"} 3e+10
node_load1 2.25
node_filesystem_size_bytes{device="/dev/sda2",fstype="ext4",mountpoint="/boot"} 1e+09
node_network_receive_bytes_total{device="eth0"} 21000
node_network_receive_bytes_total{device="lo"} 900000
node_network_receive_bytes_total{device="veth12ab"} 900000
node_network_receive_bytes_total{device="br-1f2e"} 900000
node_network_receive_bytes_total{device="pawsvm3"} 900000
node_network_receive_bytes_total{device="tailscale0"} 900000
node_network_transmit_bytes_total{device="eth0"} 5500
node_network_transmit_bytes_total{device="wlan0"} 5000
node_network_transmit_bytes_total{device="docker0"} 900000
node_disk_io_time_seconds_total{device="sda"} 14
node_disk_io_time_seconds_total{device="nvme0n1"} 22
node_pressure_memory_waiting_seconds_total 5.5
`;

function exporter(answer: () => Response | Promise<Response>) {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      hits += 1;
      return answer();
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/metrics`, hits: () => hits };
}

function fakePaws(
  answer: () => Promise<{ intervalMs: number }> = async () => ({ intervalMs: 30_000 }),
) {
  const posts: RunnerHostMetrics[] = [];
  return {
    posts,
    async postHostMetrics(report: RunnerHostMetrics) {
      posts.push(report);
      return answer();
    },
  };
}

function reporter(options: {
  exporterUrl: string;
  daemon: ReturnType<typeof fakePaws>;
  clock: { at: number };
  timeoutMs?: number;
}) {
  const hostMetrics = createRunnerHostMetricsReporter({
    ...options,
    defaultsFile: "/nonexistent/prometheus-node-exporter",
    now: () => options.clock.at,
  });
  cleanup.push(() => hostMetrics.stop());
  return {
    async tick() {
      hostMetrics.tick();
      await hostMetrics.running();
    },
  };
}

test("two scrapes give exact ratios, rates and bytes, and the first sends no rates", async () => {
  const scrapes = [FIRST, SECOND];
  const server = exporter(() => new Response(scrapes.shift()));
  const paws = fakePaws(async () => ({ intervalMs: 45_000 }));
  const clock = { at: 1_000_000 };
  const host = reporter({ exporterUrl: server.url, daemon: paws, clock });
  await host.tick();
  clock.at += 10_000;
  await host.tick();
  expect(server.hits()).toBe(1);
  clock.at += 35_000;
  await host.tick();
  expect(paws.posts).toEqual([
    {
      at: 1_000_000,
      cpuCount: 2,
      memoryUsedBytes: 5e9,
      memoryTotalBytes: 8e9,
      rootUsedBytes: 6e10,
      rootSizeBytes: 1e11,
      load1: 1.5,
    },
    {
      at: 1_045_000,
      cpuCount: 2,
      cpuBusyRatio: 1 - 12 / 20,
      diskBusyRatio: 3 / 45,
      memoryPressureRatio: 0.5 / 45,
      memoryUsedBytes: 6e9,
      memoryTotalBytes: 8e9,
      rootUsedBytes: 7e10,
      rootSizeBytes: 1e11,
      load1: 2.25,
      networkReceiveBytesPerSecond: 20_000 / 45,
      networkTransmitBytesPerSecond: 10_000 / 45,
    },
  ]);
});

test("an unreachable exporter sends nothing and is read again after ten minutes", async () => {
  const closed = exporter(() => new Response(FIRST));
  await cleanup.pop()!();
  let up = false;
  const server = exporter(() => (up ? new Response(FIRST) : new Response("down", { status: 503 })));
  const paws = fakePaws();
  const clock = { at: 1_000_000 };
  await reporter({ exporterUrl: closed.url, daemon: paws, clock }).tick();
  const host = reporter({ exporterUrl: server.url, daemon: paws, clock });
  await host.tick();
  up = true;
  clock.at += 10 * 60_000 - 1;
  await host.tick();
  expect([server.hits(), paws.posts.length]).toEqual([1, 0]);
  clock.at += 1;
  await host.tick();
  expect([server.hits(), paws.posts.length]).toEqual([2, 1]);
});

test("a 404 from Paws waits an hour, and another failure drops the report", async () => {
  const server = exporter(() => new Response(FIRST));
  const failures = [404, 500];
  const paws = fakePaws(async () => {
    const status = failures.shift();
    if (status !== undefined) throw new RunnerRequestError(status);
    return { intervalMs: 30_000 };
  });
  const clock = { at: 1_000_000 };
  const host = reporter({ exporterUrl: server.url, daemon: paws, clock });
  await host.tick();
  clock.at += 60 * 60_000 - 1;
  await host.tick();
  expect(server.hits()).toBe(1);
  clock.at += 1;
  await host.tick();
  clock.at += 30_000;
  await host.tick();
  expect(server.hits()).toBe(3);
  expect(paws.posts.map((post) => post.at)).toEqual([1_000_000, 4_600_000, 4_630_000]);
});

test("an oversized or slow exporter answer is dropped", async () => {
  const large = exporter(() => new Response(`node_load1 1\n${"#".repeat(4 * 1024 * 1024)}\n`));
  const stalled = exporter(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("node_load1 1\n"));
          },
        }),
      ),
  );
  const paws = fakePaws();
  const clock = { at: 1_000_000 };
  await reporter({ exporterUrl: large.url, daemon: paws, clock }).tick();
  await reporter({ exporterUrl: stalled.url, daemon: paws, clock, timeoutMs: 200 }).tick();
  expect([large.hits(), stalled.hits(), paws.posts]).toEqual([1, 1, []]);
});

test("the fallback address is an IPv4 listen address on port 9100 from ARGS", () => {
  expect(
    exporterDefaultsUrl('ARGS="--web.listen-address=100.64.1.2:9100 --collector.systemd"'),
  ).toBe("http://100.64.1.2:9100/metrics");
  expect(exporterDefaultsUrl("ARGS='--web.listen-address 10.0.0.5:9100'")).toBe(
    "http://10.0.0.5:9100/metrics",
  );
  expect(exporterDefaultsUrl('ARGS="--web.listen-address=10.0.0.5:9200"')).toBeUndefined();
  expect(exporterDefaultsUrl('# ARGS="--web.listen-address=10.0.0.5:9100"')).toBeUndefined();
});
