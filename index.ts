import * as path from "node:path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import { TurnkeyClient } from "@turnkey/http";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { performance } from "node:perf_hooks";
import https from "node:https";

const PAYLOAD =  "hello from Turnkey !";

const REQUIRED = [
  "TURNKEY_API_PRIVATE_KEY",
  "TURNKEY_API_PUBLIC_KEY",
  "TURNKEY_ORGANIZATION_ID",
  "TURNKEY_SIGN_WITH",
] as const;

for (const name of REQUIRED) {
  if (!process.env[name]) {
    console.error(`Missing required env var: ${name}\n`);
    console.error("Required:");
    REQUIRED.forEach((n) => console.error(`  ${n}`));
    console.error("\nOptional:");
    console.error("  ITERATIONS             (default: 10)");
    process.exit(1);
  }
}

const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY!;
const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY!;
const organizationId = process.env.TURNKEY_ORGANIZATION_ID!;
const signWith = process.env.TURNKEY_SIGN_WITH!;
const iterations = parseInt(process.env.ITERATIONS || "10", 10);
const baseUrl = "https://api.turnkey.com";

// Detect curve from signWith format:
//   0x-prefixed address → Ethereum/secp256k1 → HASH_FUNCTION_SHA256 (Turnkey hashes for us)
//   anything else       → Ed25519 (Solana)   → HASH_FUNCTION_NOT_APPLICABLE
const hashFunction = signWith.startsWith("0x")
  ? ("HASH_FUNCTION_SHA256" as const)
  : ("HASH_FUNCTION_NOT_APPLICABLE" as const);

interface HttpTiming {
  dns?: number;
  tcp?: number;
  tls?: number;
  ttfb?: number;
  total?: number;
  status?: number;
}

async function main(): Promise<void> {
  console.log("Turnkey Signature Latency Test");
  console.log("=".repeat(50));
  console.log(`  Target:     ${baseUrl}`);
  console.log(`  Org:        ${organizationId}`);
  console.log(`  Sign with:  ${signWith}`);
  console.log(`  Curve:      ${hashFunction === "HASH_FUNCTION_SHA256" ? "secp256k1/P-256 (ECDSA)" : "Ed25519"}`);
  console.log(`  Iterations: ${iterations}`);
  console.log();

  const client = new TurnkeyClient(
    { baseUrl },
    new ApiKeyStamper({ apiPublicKey, apiPrivateKey }),
  );

  const signParams = () => ({
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2" as const,
    timestampMs: String(Date.now()),
    organizationId,
    parameters: {
      signWith,
      payload: PAYLOAD,
      encoding: "PAYLOAD_ENCODING_TEXT_UTF8" as const,
      hashFunction,
    },
  });

  // --- Warmup ---
  const warmTs = new Date().toISOString();
  process.stdout.write(`Warmup... ${warmTs}  `);
  const warmStart = performance.now();
  await client.signRawPayload(signParams());
  console.log(`${(performance.now() - warmStart).toFixed(0)}ms\n`);

  // --- SDK benchmark ---
  console.log(`Benchmark (${iterations} runs):\n`);
  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const ts = new Date().toISOString();
    const start = performance.now();
    await client.signRawPayload(signParams());
    const elapsed = performance.now() - start;
    times.push(elapsed);
    console.log(`  #${String(i + 1).padStart(2)}  ${elapsed.toFixed(0)}ms  ${ts}`);
  }

  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);

  console.log(`\n${"─".repeat(50)}`);
  console.log("Results:\n");
  console.log(`  Min:  ${times[0].toFixed(0)}ms`);
  console.log(`  Max:  ${times[times.length - 1].toFixed(0)}ms`);
  console.log(`  Avg:  ${(sum / times.length).toFixed(0)}ms`);
  console.log(`  P50:  ${pct(times, 50).toFixed(0)}ms`);
  console.log(`  P95:  ${pct(times, 95).toFixed(0)}ms`);

  // --- Detailed HTTP timing (fresh connection) ---
  console.log(`\n${"─".repeat(50)}`);
  console.log("HTTP timing breakdown (fresh connection):\n");

  const t = await rawHttpTiming();

  const dnsTime = t.dns ?? 0;
  const tcpHandshake = (t.tcp ?? 0) - dnsTime;
  const tlsHandshake = (t.tls ?? 0) - (t.tcp ?? 0);
  const networkOverhead = t.tls ?? 0;
  const serverProcessing = (t.ttfb ?? 0) - networkOverhead;
  const rtt = tcpHandshake; // TCP handshake = 1 RTT

  console.log(`  DNS lookup:     ${fmt(dnsTime)}`);
  console.log(`  TCP connect:    ${fmt(t.tcp)}  (handshake: ${fmt(tcpHandshake)})`);
  console.log(`  TLS handshake:  ${fmt(t.tls)}  (handshake: ${fmt(tlsHandshake)})`);
  console.log(`  TTFB:           ${fmt(t.ttfb)}`);
  console.log(`  Total:          ${fmt(t.total)}`);
  console.log(`  HTTP status:    ${t.status}`);

  console.log(`\n${"─".repeat(50)}`);
  console.log("Latency breakdown:\n");
  console.log(`  Network RTT:        ~${fmt(rtt)}  (derived from TCP handshake)`);
  console.log(`  Network overhead:   ${fmt(networkOverhead)}  (DNS + TCP + TLS, ${pctOf(networkOverhead, t.ttfb ?? 0)} of TTFB)`);
  console.log(`  API response time:  ${fmt(serverProcessing)}  (TTFB - network, ${pctOf(serverProcessing, t.ttfb ?? 0)} of TTFB)`);
  console.log();
}

function pct(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function fmt(ms: number | undefined): string {
  return ms !== undefined ? `${ms.toFixed(0)}ms` : "—";
}

function pctOf(part: number, total: number): string {
  if (total === 0) return "—";
  return `${Math.round((part / total) * 100)}%`;
}

async function rawHttpTiming(): Promise<HttpTiming> {
  const body = JSON.stringify({
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    timestampMs: String(Date.now()),
    organizationId,
    parameters: {
      signWith,
      payload: PAYLOAD,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
    },
  });

  const stamper = new ApiKeyStamper({
    apiPublicKey,
    apiPrivateKey,
  });
  const stamp = await stamper.stamp(body);

  const url = new URL("/public/v1/submit/sign_raw_payload", baseUrl);

  return new Promise<HttpTiming>((resolve, reject) => {
    const timing: HttpTiming = {};
    const start = performance.now();

    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [stamp.stampHeaderName]: stamp.stampHeaderValue,
        },
        agent: new https.Agent({ keepAlive: false }),
      },
      (res) => {
        timing.ttfb = performance.now() - start;
        timing.status = res.statusCode;

        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          timing.total = performance.now() - start;
          resolve(timing);
        });
      }
    );

    req.on("socket", (socket) => {
      socket.on("lookup", () => {
        timing.dns = performance.now() - start;
      });
      socket.on("connect", () => {
        timing.tcp = performance.now() - start;
      });
      socket.on("secureConnect", () => {
        timing.tls = performance.now() - start;
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

main().catch((err: Error) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
