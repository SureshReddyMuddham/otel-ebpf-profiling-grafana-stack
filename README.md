# OpenTelemetry 4-Signal Observability with eBPF Profiling

POC demonstrating all **4 OpenTelemetry signals** (traces, metrics, logs, profiles) using the Grafana stack and the OTel eBPF Profiler.

## Architecture

```
┌──────────────┐  ┌─────────────────┐
│  orders-api  │  │ payment-service │   OTel SDK (traces, metrics, logs)
│  (Node.js)   │  │   (Node.js)     │   OTel Logs API (structured logs)
└──────┬───────┘  └────────┬────────┘
       │  OTLP HTTP        │  OTLP HTTP
       └────────┬──────────┘
                ▼
     ┌─────────────────────┐
     │    OTel Collector    │   docker_stats receiver (container metrics)
     │   (contrib v0.149)   │   OTLP receiver (traces, metrics, logs, profiles)
     └──┬─────┬─────────┬──┘
        │     │         │
        ▼     ▼         ▼
   ┌────────┐ ┌────┐ ┌──────────┐
   │Grafana │ │Loki│ │Pyroscope │
   │ LGTM   │ │    │ │          │
   │Tempo   │ └────┘ └────▲─────┘
   │Prom    │              │  OTLP gRPC (profiles)
   └────────┘       ┌──────┴───────┐
                    │eBPF Profiler  │  zero-instrumentation CPU profiling
                    │(kernel-level) │  profiles ALL processes via eBPF
                    └───────────────┘
```

### Signal Flow

| Signal | Source | Pipeline | Backend |
|--------|--------|----------|---------|
| **Traces** | OTel SDK (auto-instrumentation) | App → Collector → Tempo | Grafana Tempo |
| **Metrics** | OTel SDK (custom) + docker_stats | App → Collector → Prometheus | Prometheus |
| **Logs** | OTel Logs API | App → Collector → Loki | Loki |
| **Profiles** | OTel eBPF Profiler (zero-code) | eBPF → Collector → Pyroscope | Pyroscope |
| **Container Metrics** | docker_stats receiver | Collector → Prometheus | Prometheus |

## Quick Start

```bash
# Build and start all services
docker compose up -d --build

# Generate traffic
curl -X POST http://localhost:3000/api/simulate \
  -H "Content-Type: application/json" -d '{"count": 50}'

curl -X POST http://localhost:3002/api/simulate-payments \
  -H "Content-Type: application/json" -d '{"count": 50}'
```

### Access

| Service | URL | Credentials |
|---------|-----|-------------|
| Grafana | http://localhost:3001 | admin / admin |
| Prometheus | http://localhost:9090 | - |
| Pyroscope | http://localhost:4040 | - |
| Orders API | http://localhost:3000 | - |
| Payment Service | http://localhost:3002 | - |

## Project Structure

```
├── app/                           # Orders API (Node.js)
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── instrumentation.js     # OTel SDK: traces, metrics, logs
│       └── server.js              # Express API with OTel Logs API
├── payment-service/               # Payment Service (Node.js)
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── instrumentation.js     # OTel SDK: traces, metrics, logs
│       └── server.js              # Express API with OTel Logs API
├── docker-compose.yaml            # 6 containers: 2 apps + collector + profiler + Pyroscope + LGTM
├── otel-collector-config.yaml     # Collector: OTLP + docker_stats → LGTM + Loki + Pyroscope
├── ebpf-profiler-config.yaml      # eBPF Profiler → Collector (OTLP gRPC)
└── pyroscope-config.yaml          # Pyroscope: service name relabeling
```

## Services

### Orders API (port 3000)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/orders` | List all orders |
| POST | `/api/orders` | Create an order |
| PUT | `/api/orders/:id` | Update order status |
| DELETE | `/api/orders/:id` | Delete an order |
| POST | `/api/simulate` | Generate bulk test orders |

**Custom metrics**: `orders_total`, `order_value_dollars`, `active_orders`

### Payment Service (port 3002)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| POST | `/api/charge` | Process a payment |
| GET | `/api/transactions` | List transactions |
| POST | `/api/refund/:id` | Refund a payment |
| POST | `/api/simulate-payments` | Generate bulk test payments |

**Custom metrics**: `payments_total`, `payment_amount_dollars`, `payments_failed_total`, `payment_processing_ms`

## OTel Collector Configuration

The collector handles **all 4 signals** as the central telemetry hub:

```yaml
receivers:
  otlp:           # Traces, metrics, logs from apps + profiles from eBPF
  docker_stats:   # Container CPU, memory, network, disk metrics

pipelines:
  traces:   [otlp]         → [Grafana Tempo]
  metrics:  [otlp, docker] → [Prometheus]
  logs:     [otlp]         → [Loki]
  profiles: [otlp]         → [Pyroscope]
```

## eBPF Profiler

The [OTel eBPF Profiler](https://github.com/open-telemetry/opentelemetry-ebpf-profiler) runs as a privileged container that profiles **all processes** at the kernel level via eBPF — no code changes needed.

- Supports: Node.js (V8), Go, Python, Java, C/C++, Rust, Ruby, .NET, Erlang/Elixir
- Sends CPU profiles via OTLP to the OTel Collector → Pyroscope
- Requires: `privileged: true`, `pid: host`, `/proc` and `/sys` mounts

Service name resolution uses Pyroscope [ingestion relabeling](https://grafana.com/docs/pyroscope/latest/configure-client/opentelemetry/ebpf-profiler/):
```yaml
limits:
  ingestion_relabeling_rules:
    - action: labelmap
      regex: ^process\.executable\.name$
      replacement: service_name
```

## Grafana Dashboard

A pre-built dashboard covers all signals:

- **Metrics**: Request rates, latency p95, order/payment totals, container CPU/memory/network
- **Traces**: Recent requests table from Tempo
- **Logs**: Orders API + Payment Service structured logs from Loki
- **Profiles**: CPU flamegraph from eBPF Profiler via Pyroscope

<img width="1720" height="1066" alt="image" src="https://github.com/user-attachments/assets/5c0493ad-fd15-448b-993d-3465df73567f" />
<img width="1713" height="1092" alt="image" src="https://github.com/user-attachments/assets/5672504f-b5ec-4ea9-9d47-69e150f2518d" />



## References

- [OTel Profiles Alpha Announcement](https://opentelemetry.io/blog/2026/profiles-alpha/)
- [OTel eBPF Profiler](https://github.com/open-telemetry/opentelemetry-ebpf-profiler)
- [Grafana Pyroscope + eBPF Profiler](https://grafana.com/docs/pyroscope/latest/configure-client/opentelemetry/ebpf-profiler/)
- [OTel Collector Contrib](https://github.com/open-telemetry/opentelemetry-collector-contrib)

## Tech Stack

- **Runtime**: Node.js 20, Express.js
- **Telemetry**: OpenTelemetry SDK, OTel Collector Contrib v0.149.0
- **Profiling**: OTel eBPF Profiler v0.149.0 (kernel-level, zero-instrumentation)
- **Backends**: Grafana LGTM (Tempo + Prometheus + Loki), Pyroscope
- **Container Metrics**: docker_stats receiver
