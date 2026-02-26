/**
 * @x402/elysia — Live Devnet Integration Test
 * ============================================
 * Tests the full x402 payment flow against Base Sepolia (testnet) using the
 * public x402.org facilitator. No real money is spent.
 *
 * SETUP
 * -----
 * 1. Install extra deps (not in package.json — devnet only):
 *      bun add -d @x402/evm viem
 *
 * 2. Create a .env file in this directory (or export vars):
 *      PRIVATE_KEY=0x...        # EVM private key with Base Sepolia ETH + USDC
 *      PAY_TO=0x...             # Address that will receive the payment
 *      PORT=3400                # Optional; defaults to 3400
 *
 *    Get free Base Sepolia USDC from: https://faucet.circle.com/
 *    Get free Base Sepolia ETH from: https://docs.base.org/docs/tools/network-faucets
 *
 * 3. Run:
 *      bun run test/devnet.ts
 *
 * WHAT IT TESTS
 * -------------
 *  ✓ Server starts with x402 plugin on /api/weather (costs $0.001 USDC)
 *  ✓ GET /api/weather without payment → 402 + PAYMENT-REQUIRED header
 *  ✓ GET /api/weather with browser Accept → 402 HTML paywall
 *  ✓ GET /api/weather with valid x402 payment → 200 + PAYMENT-RESPONSE header
 *  ✓ PAYMENT-RESPONSE header can be decoded to verify settlement
 *  ✓ GET /health (unprotected) → 200 always
 *
 * NETWORK
 * -------
 * Base Sepolia (chain ID 84532), USDC contract: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
 */

import { Elysia } from "elysia";
import {
  HTTPFacilitatorClient,
  paymentMiddleware,
  x402ResourceServer,
  type RouteConfig,
} from "../src/index";

// ---------------------------------------------------------------------------
// Config — read from environment
// ---------------------------------------------------------------------------

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;
const PAY_TO = process.env.PAY_TO as `0x${string}` | undefined;
const PORT = Number(process.env.PORT ?? 3400);

const NETWORK = "eip155:84532" as const;
const FACILITATOR_URL = "https://x402.org/facilitator";
const PRICE = "$0.001";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (!PRIVATE_KEY) {
  console.error("ERROR: PRIVATE_KEY environment variable is required.");
  console.error("  Export a hex private key: export PRIVATE_KEY=0x...");
  process.exit(1);
}

if (!PAY_TO) {
  console.error("ERROR: PAY_TO environment variable is required.");
  console.error("  Export the recipient address: export PAY_TO=0x...");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Dynamically import @x402/evm and viem (devnet-only deps)
// ---------------------------------------------------------------------------

async function loadDeps() {
  try {
    const [evmMod, viemMod] = await Promise.all([
      import("@x402/evm/exact/client"),
      import("viem"),
    ]);
    return { evmMod, viemMod };
  } catch {
    console.error(
      "ERROR: Missing devnet dependencies. Run:\n  bun add -d @x402/evm viem",
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n=== @x402/elysia Devnet Integration Test ===\n");
  console.log(`Network:     ${NETWORK}`);
  console.log(`Facilitator: ${FACILITATOR_URL}`);
  console.log(`Price:       ${PRICE} USDC per request`);
  console.log(`Pay to:      ${PAY_TO}`);
  console.log(`Port:        ${PORT}\n`);

  // ------------------------------------------------------------------
  // 1. Build and start the server
  // ------------------------------------------------------------------

  const route: RouteConfig = {
    accepts: {
      scheme: "exact",
      network: NETWORK,
      payTo: PAY_TO!,
      price: PRICE,
    },
    description: "Current weather data (devnet test)",
    mimeType: "application/json",
  };

  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

  console.log("Starting Elysia server with x402 plugin…");

  // We must dynamically import @x402/evm so the server scheme is registered
  const { evmMod, viemMod } = await loadDeps();
  const ExactEvmScheme = evmMod.ExactEvmScheme ?? (evmMod as Record<string, unknown>)["ExactEvmScheme"];

  const resourceServer = new x402ResourceServer(facilitator).register(
    NETWORK,
    // @ts-ignore — ExactEvmScheme type varies by version
    new ExactEvmScheme(),
  );

  const app = new Elysia()
    .use(
      paymentMiddleware({ "GET /api/weather": route }, resourceServer, {
        appName: "x402-elysia devnet test",
        testnet: true,
      }),
    )
    .get("/api/weather", () => ({
      temperature: 72,
      unit: "F",
      location: "San Francisco",
      timestamp: new Date().toISOString(),
    }))
    .get("/health", () => ({ status: "ok", time: new Date().toISOString() }))
    .listen(PORT);

  console.log(`Server listening on http://localhost:${PORT}\n`);

  const BASE_URL = `http://localhost:${PORT}`;

  // Give server a tick to fully bind
  await new Promise((r) => setTimeout(r, 100));

  let passed = 0;
  let failed = 0;

  function pass(label: string) {
    console.log(`  ✓ ${label}`);
    passed++;
  }

  function fail(label: string, detail?: unknown) {
    console.error(`  ✗ ${label}`);
    if (detail !== undefined) console.error("    ", detail);
    failed++;
  }

  // ------------------------------------------------------------------
  // TEST 1: Unprotected route
  // ------------------------------------------------------------------
  console.log("TEST 1: Unprotected /health route");
  {
    const res = await fetch(`${BASE_URL}/health`);
    if (res.status === 200) {
      pass("GET /health → 200");
    } else {
      fail(`GET /health expected 200, got ${res.status}`);
    }
  }

  // ------------------------------------------------------------------
  // TEST 2: Protected route without payment → 402 JSON
  // ------------------------------------------------------------------
  console.log("\nTEST 2: Protected /api/weather without payment");
  {
    const res = await fetch(`${BASE_URL}/api/weather`);
    await res.json(); // consume body
    if (res.status === 402) {
      pass("GET /api/weather without payment → 402");
    } else {
      fail(`Expected 402, got ${res.status}`);
    }

    const paymentRequired = res.headers.get("payment-required");
    if (paymentRequired) {
      pass("Response has PAYMENT-REQUIRED header");
      // Decode and display the payment requirements
      try {
        const decoded = JSON.parse(atob(paymentRequired));
        console.log("    Payment requirements:", JSON.stringify(decoded, null, 2).replace(/\n/g, "\n    "));
      } catch {
        // non-critical
      }
    } else {
      fail("Missing PAYMENT-REQUIRED header");
    }

    const contentType = res.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      pass("Content-Type is application/json");
    } else {
      fail(`Expected application/json, got ${contentType}`);
    }
  }

  // ------------------------------------------------------------------
  // TEST 3: Protected route from browser → 402 HTML paywall
  // ------------------------------------------------------------------
  console.log("\nTEST 3: Protected /api/weather from browser (HTML paywall)");
  {
    const res = await fetch(`${BASE_URL}/api/weather`, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });
    if (res.status === 402) {
      pass("Browser request → 402");
    } else {
      fail(`Expected 402, got ${res.status}`);
    }
    const ct = res.headers.get("content-type");
    if (ct?.includes("text/html")) {
      pass("Browser response Content-Type is text/html");
    } else {
      fail(`Expected text/html, got ${ct}`);
    }
    const html = await res.text();
    if (html.includes("Payment Required") || html.includes("pay")) {
      pass("HTML body contains paywall content");
    } else {
      fail("HTML body does not look like a paywall");
    }
  }

  // ------------------------------------------------------------------
  // TEST 4: Protected route WITH a valid x402 payment
  // ------------------------------------------------------------------
  console.log("\nTEST 4: Protected /api/weather WITH valid payment (real devnet)");
  {
    const { createWalletClient, createPublicClient, http } = viemMod;

    // Build a viem wallet from the private key
    const chain = {
      id: 84532,
      name: "Base Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
    };

    let walletClient: ReturnType<typeof createWalletClient>;
    // @ts-ignore — dynamic import, privateKeyToAccount present at runtime
    let account: ReturnType<typeof viemMod.privateKeyToAccount>;
    try {
      // @ts-ignore — dynamic import, privateKeyToAccount present at runtime
      account = viemMod.privateKeyToAccount(PRIVATE_KEY!);
      walletClient = createWalletClient({
        account,
        chain,
        transport: http(),
      });
    } catch (err) {
      fail("Failed to create viem wallet client", err);
      console.log("\n  Skipping payment test (wallet setup failed).");
      printSummary();
      return;
    }

    // First fetch without payment to get the PAYMENT-REQUIRED header
    const unpaidRes = await fetch(`${BASE_URL}/api/weather`);
    const paymentRequiredHeader = unpaidRes.headers.get("payment-required");
    if (!paymentRequiredHeader) {
      fail("No PAYMENT-REQUIRED header to build payment from");
      printSummary();
      return;
    }

    let paymentRequired: Record<string, unknown>;
    try {
      paymentRequired = JSON.parse(atob(paymentRequiredHeader));
    } catch {
      fail("Could not decode PAYMENT-REQUIRED header");
      printSummary();
      return;
    }

    // Use ExactEvmScheme client to create the payment signature
    let paymentPayload: unknown;
    try {
      const clientScheme = evmMod.ExactEvmScheme ?? (evmMod as Record<string, unknown>)["ExactEvmScheme"];
      // @ts-ignore — dynamic import, types vary
      const client = new clientScheme({ walletClient, publicClient: createPublicClient({ chain, transport: http() }) });
      const accepts = (paymentRequired as { accepts: unknown[] }).accepts;
      // @ts-ignore — dynamic import, createPayment present at runtime
      paymentPayload = await client.createPayment(paymentRequired, accepts[0]);
      pass("Payment payload created via ExactEvmScheme client");
    } catch (err) {
      fail("Failed to create payment payload", err);
      console.log("\n  NOTE: If this fails with 'insufficient allowance', run the Permit2 approval first.");
      printSummary();
      return;
    }

    // Encode the payment payload as base64 for the PAYMENT-SIGNATURE header
    const encodedPayment = btoa(JSON.stringify(paymentPayload));

    // Send the paid request
    console.log("  Sending paid request…");
    const paidRes = await fetch(`${BASE_URL}/api/weather`, {
      headers: {
        "payment-signature": encodedPayment,
      },
    });

    if (paidRes.status === 200) {
      pass("Paid request → 200");
    } else {
      const errBody = await paidRes.text();
      fail(`Expected 200, got ${paidRes.status}: ${errBody}`);
    }

    const paymentResponse = paidRes.headers.get("payment-response");
    if (paymentResponse) {
      pass("Response has PAYMENT-RESPONSE header");
      try {
        const receipt = JSON.parse(atob(paymentResponse));
        console.log("    Settlement receipt:", JSON.stringify(receipt, null, 2).replace(/\n/g, "\n    "));
      } catch {
        // non-critical
      }
    } else {
      fail("Missing PAYMENT-RESPONSE header — settlement may have failed");
    }

    const paidBody = await paidRes.json() as Record<string, unknown>;
    if (paidBody.temperature !== undefined) {
      pass("Protected body returned correctly");
      console.log(`    Weather data: ${JSON.stringify(paidBody)}`);
    } else {
      fail("Protected body missing expected 'temperature' field");
    }
  }

  // ------------------------------------------------------------------
  // Shutdown
  // ------------------------------------------------------------------
  app.stop();

  printSummary();

  function printSummary() {
    console.log(`\n${"─".repeat(44)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.log("Some tests failed. See output above for details.");
      process.exit(1);
    } else {
      console.log("All tests passed! 🎉");
    }
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
