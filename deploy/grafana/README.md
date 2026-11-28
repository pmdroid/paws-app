# Grafana dashboards for Paws

Two dashboards for the OpenTelemetry data Paws exports (Workspace › Telemetry):

- `paws-overview.json`: item moves, merged and failed items, questions, waiting jobs and outbox, event-loop lag, job run and wait times, memory, CPU, and a log of the latest item moves.
- `paws-runner-fleet.json`: every runner side by side from the `runner-node` scrape job: a table of vCPUs, memory, CPU, memory and root disk use and uptime, then CPU, memory, load per vCPU, root disk, network, disk I/O and memory pressure over time.
- `paws-integrations.json`: Linear and GitHub rate limits, GitHub and Linear call times, runner API requests by status and route, outbox wait and delivery, and database transactions.

Metrics are read from Prometheus. Item moves are read from Loki as `paws.item.transition` log events.

## Run a Grafana stack next to Paws

The all-in-one `grafana/otel-lgtm` image has Grafana, Prometheus, Loki, Tempo and an OTLP collector. Paws sends counters as deltas, so start Prometheus with delta support:

```sh
docker run -d --name grafana-lgtm --restart unless-stopped \
  -e PROMETHEUS_EXTRA_ARGS=--enable-feature=otlp-deltatocumulative \
  -e GF_AUTH_ANONYMOUS_ENABLED=false \
  -e GF_SECURITY_ADMIN_PASSWORD="<choose one>" \
  -v grafana-lgtm:/data \
  -p 127.0.0.1:4317:4317 -p 127.0.0.1:4318:4318 -p 127.0.0.1:3000:3000 \
  grafana/otel-lgtm:0.40.0
```

The OTLP ports listen only on the local machine. Publish port 3000 only on an address you trust, such as a Tailscale address.

## Scrape runner machine metrics

Install the node exporter on each runner and let it listen only on the runner's Tailscale address, never on all interfaces:

```sh
ip=$(tailscale ip -4 | head -1)
echo "ARGS=\"--web.listen-address=$ip:9100\"" | sudo tee /etc/default/prometheus-node-exporter
sudo apt-get install -y -o Dpkg::Options::=--force-confold prometheus-node-exporter
sudo systemctl restart prometheus-node-exporter
```

Writing `/etc/default/prometheus-node-exporter` before installing keeps the package from starting on `0.0.0.0`.

Add the runners to a copy of the stack's Prometheus configuration (`docker exec grafana-lgtm cat /otel-lgtm/prometheus.yaml > prometheus.yaml`), appending:

```yaml
scrape_configs:
  - job_name: runner-node
    scrape_interval: 30s
    static_configs:
      - targets: ["<runner Tailscale IP>:9100"]
        labels: { runner: <runner name> }
```

Then start the stack with `-v "$PWD/prometheus.yaml:/otel-lgtm/prometheus.yaml:ro"` added to the `docker run` command. Import the community "Node Exporter Full" dashboard (grafana.com ID 1860) for per-runner CPU, memory, disk and network.

## Connect Paws

In the dashboard, open Workspace › Telemetry, set the endpoint to `http://127.0.0.1:4318`, choose OTLP/HTTP protobuf, leave the header empty, turn export on and send a test.

## Import the dashboards

In Grafana, open Dashboards › New › Import, upload a JSON file, and pick your Prometheus and Loki data sources.
