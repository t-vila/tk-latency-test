# Turnkey Signature Latency Test

Measures end-to-end latency of Turnkey `signRawPayload` requests with a detailed HTTP timing breakdown.

## Setup

```bash
pnpm install
```

Create a `.env.local` file:

```
TURNKEY_API_PRIVATE_KEY=...
TURNKEY_API_PUBLIC_KEY=...
TURNKEY_ORGANIZATION_ID=...
TURNKEY_SIGN_WITH=0x...
```

## Run

```bash
pnpm start
```

## Optional env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `ITERATIONS` | `10` | Number of benchmark runs |

## Output

- **Benchmark**: runs `signRawPayload` N times via the SDK, reports min/max/avg/p50/p95
- **HTTP breakdown**: single request on a fresh connection showing DNS, TCP, TLS, TTFB

## Understanding the results

### Warmup

A single throw-away request before the benchmark starts. It primes connections and any server-side caches. This run is excluded from the results.


### Results summary

| Metric | What it means |
|--------|---------------|
| **Min** | Fastest observed request — your best-case hot-path latency |
| **Max** | Slowest observed request |
| **Avg** | Mean across all runs; pulled up by slow outliers |
| **P50** | Median — what a typical request experiences |
| **P95** | 95th percentile — worst-case with small sample sizes this is usually one slow run |

A large gap between P50 and P95 indicates cold-path variance on the server side, not a network issue.

### HTTP timing breakdown

Measured on a single fresh connection (no keep-alive), so it includes all connection setup costs:

| Field | What it means |
|-------|---------------|
| **DNS lookup** | Time to resolve `api.turnkey.com` to an IP |
| **TCP connect** | Time to establish a TCP connection (half of this ≈ your network RTT) |
| **TLS handshake** | Time to negotiate TLS on top of the TCP connection |
| **TTFB** | Time to first byte — starts after the request is sent, ends when the first byte of the response arrives. Includes server processing time. |
| **Total** | Full request duration on a fresh connection |

Keep-alive connections (as used in the benchmark runs) skip DNS, TCP, and TLS — their latency will be closer to TTFB alone.

### Latency breakdown

| Field | What it means |
|-------|---------------|
| **Network RTT** | Estimated round-trip time to the Cloudflare edge, derived from the TCP handshake |
| **Network overhead** | Connection setup cost (DNS + TCP + TLS) — paid once on the first request, skipped on keep-alive |
| **API response time** | TTFB minus connection setup — includes transit to Turnkey's backend and server processing |
