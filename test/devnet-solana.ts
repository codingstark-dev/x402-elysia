/**
 * @codingstark/x402-elysia — Live Solana Devnet Integration Test
 * ===================================================
 * Tests the full x402 payment flow against Solana Devnet using the public
 * x402.org facilitator. No real money is spent.
 *
 * SETUP
 * -----
 * 1. Install extra deps (not in package.json — devnet only):
 *      bun add -d @x402/svm
 *
 * 2. Create a .env file in the project root (or export vars):
 *      SVM_PRIVATE_KEY=<base58-encoded Solana private key>
 *      SVM_PAY_TO=<Solana address that will receive payment>
 *      PORT=3401    # Optional; defaults to 3401
 *
 *    Fund your wallet with:
 *      - Devnet SOL:  https://faucet.solana.com  (or: solana airdrop 1 <ADDRESS> --url devnet)
 *      - Devnet USDC: https://faucet.circle.com  (select "Solana Devnet")
 *
 * 3. Run:
 *      bun --env-file=.env run test/devnet-solana.ts
 *
 * WHAT IT TESTS
 * -------------
 *  ✓ Server starts with x402 plugin on /api/weather (costs $0.001 USDC)
 *  ✓ GET /api/weather without payment → 402 + PAYMENT-REQUIRED header
 *  ✓ GET /api/weather from browser → 402 HTML paywall
 *  ✓ GET /api/weather with valid Solana x402 payment → 200 + PAYMENT-RESPONSE header
 *  ✓ PAYMENT-RESPONSE header can be decoded to verify settlement
 *  ✓ GET /health (unprotected) → 200 always
 *
 * NETWORK
 * -------
 * Solana Devnet (CAIP-2: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1)
 * USDC mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
 */

import { Elysia } from "elysia";
import {
  HTTPFacilitatorClient,
  type RouteConfig,
} from "../src/index";

// ---------------------------------------------------------------------------
// Config — read from environment
// ---------------------------------------------------------------------------

const SVM_PRIVATE_KEY = process.env.SVM_PRIVATE_KEY;
const SVM_PAY_TO = process.env.SVM_PAY_TO;
const PORT = Number(process.env.PORT ?? 3401);

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
const FACILITATOR_URL = "https://x402.org/facilitator";
const PRICE = "$0.001";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (!SVM_PRIVATE_KEY) {
  console.error("ERROR: SVM_PRIVATE_KEY environment variable is required.");
  console.error("  Export a base58-encoded Solana private key: export SVM_PRIVATE_KEY=<base58>");
  process.exit(1);
}

if (!SVM_PAY_TO) {
  console.error("ERROR: SVM_PAY_TO environment variable is required.");
  console.error("  Export the recipient Solana address: export SVM_PAY_TO=<address>");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Dynamically import @x402/svm and @solana/kit (devnet-only deps)
// ---------------------------------------------------------------------------

async function loadDeps() {
  try {
    const [svmServerMod, svmClientMod, solanaKitMod, x402CoreClientMod, scureBaseMod] = await Promise.all([
      import("@x402/svm/exact/server"),
      import("@x402/svm/exact/client"),
      import("@solana/kit"),
      import("@x402/core/client"),
      import("@scure/base"),
    ]);
    return { svmServerMod, svmClientMod, solanaKitMod, x402CoreClientMod, scureBaseMod };
  } catch (err) {
    console.error(
      "ERROR: Missing devnet dependencies. Run:\n  bun add -d @x402/svm",
    );
    console.error(err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n=== @codingstark/x402-elysia Solana Devnet Integration Test ===\n");
  console.log(`Network:     ${NETWORK}`);
  console.log(`Facilitator: ${FACILITATOR_URL}`);
  console.log(`Price:       ${PRICE} USDC per request`);
  console.log(`Pay to:      ${SVM_PAY_TO}`);
  console.log(`Port:        ${PORT}\n`);

  const deps = await loadDeps();
  const { svmServerMod, svmClientMod, solanaKitMod, x402CoreClientMod, scureBaseMod } = deps;

  // ------------------------------------------------------------------
  // Build the client-side signer from the base58 private key
  // ------------------------------------------------------------------

  let svmSigner: Awaited<ReturnType<typeof solanaKitMod.createKeyPairSignerFromBytes>>;
  try {
    // @scure/base decodes base58 string → Uint8Array
    const keyBytes = scureBaseMod.base58.decode(SVM_PRIVATE_KEY!);
    svmSigner = await solanaKitMod.createKeyPairSignerFromBytes(keyBytes);
    console.log(`Wallet:      ${svmSigner.address}\n`);
  } catch (err) {
    console.error("ERROR: Failed to create Solana signer from SVM_PRIVATE_KEY:", err);
    console.error("  Ensure SVM_PRIVATE_KEY is a valid base58-encoded Solana private key.");
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // 1. Build and start the server
  // ------------------------------------------------------------------

  const route: RouteConfig = {
    accepts: {
      scheme: "exact",
      network: NETWORK,
      payTo: SVM_PAY_TO!,
      price: PRICE,
    },
    description: "Current weather data (Solana devnet test)",
    mimeType: "application/json",
  };

  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

  console.log("Starting Elysia server with x402 plugin…");

  const { x402ResourceServer } = await import("../src/index");
  const resourceServer = new x402ResourceServer(facilitator);

  // Register SVM scheme onto the resource server
  svmServerMod.registerExactSvmScheme(resourceServer, { networks: [NETWORK] });

  const { paymentMiddleware } = await import("../src/index");

  const app = new Elysia()
    .use(
      paymentMiddleware({ "GET /api/weather": route }, resourceServer, {
        appName: "x402-elysia solana devnet test",
        testnet: true,
      }),
    )
    .get("/api/weather", () => ({
      temperature: 68,
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
      try {
        const decoded = JSON.parse(atob(paymentRequired));
        console.log(
          "    Payment requirements:",
          JSON.stringify(decoded, null, 2).replace(/\n/g, "\n    "),
        );
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
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
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
  // TEST 4: Protected route WITH a valid Solana x402 payment
  // ------------------------------------------------------------------
  console.log("\nTEST 4: Protected /api/weather WITH valid Solana payment (real devnet)");
  {
    // First fetch without payment to get the PAYMENT-REQUIRED header
    const unpaidRes = await fetch(`${BASE_URL}/api/weather`);
    const paymentRequiredHeader = unpaidRes.headers.get("payment-required");
    if (!paymentRequiredHeader) {
      fail("No PAYMENT-REQUIRED header to build payment from");
      app.stop();
      printSummary();
      return;
    }

    let paymentRequired: Record<string, unknown>;
    try {
      paymentRequired = JSON.parse(atob(paymentRequiredHeader));
    } catch {
      fail("Could not decode PAYMENT-REQUIRED header");
      app.stop();
      printSummary();
      return;
    }

    // Build an x402Client and register the SVM scheme onto it
    const { x402Client } = x402CoreClientMod;
    const client = new x402Client();
    svmClientMod.registerExactSvmScheme(client, { signer: svmSigner });

    // Create the payment payload using the SVM client scheme
    let paymentPayload: unknown;
    try {
      paymentPayload = await client.createPaymentPayload(
        paymentRequired as Parameters<typeof client.createPaymentPayload>[0],
      );
      pass("Payment payload created via SVM client");
    } catch (err) {
      fail("Failed to create payment payload", err);
      console.log(
        "\n  NOTE: Ensure your wallet has devnet SOL (for fees) and devnet USDC.",
      );
      console.log("  Devnet SOL:  https://faucet.solana.com");
      console.log("  Devnet USDC: https://faucet.circle.com (select 'Solana Devnet')");
      app.stop();
      printSummary();
      return;
    }

    // Encode the payment payload as base64 for the payment-signature header
    const encodedPayment = btoa(JSON.stringify(paymentPayload));

    // Log what we're sending for diagnosis
    console.log("  Payment payload:");
    console.log(
      "  " + JSON.stringify(paymentPayload, null, 2).replace(/\n/g, "\n  "),
    );

    // Send the paid request
    console.log("  Sending paid request to facilitator…");
    const paidRes = await fetch(`${BASE_URL}/api/weather`, {
      headers: {
        "payment-signature": encodedPayment,
      },
    });

    if (paidRes.status === 200) {
      pass("Paid request → 200");
    } else {
      // Try to decode the error — could be JSON or a 402 with payment-required
      const errText = await paidRes.text();
      let errDetail = errText;
      try { errDetail = JSON.stringify(JSON.parse(errText), null, 2); } catch { /* raw text is fine */ }
      fail(`Expected 200, got ${paidRes.status}`);
      console.log("    Response body:", errDetail);

      // If the server re-issued a 402, show why (facilitator rejection reason)
      const retryHeader = paidRes.headers.get("payment-required");
      if (retryHeader) {
        try {
          const retryDecoded = JSON.parse(atob(retryHeader));
          console.log(
            "    Re-issued payment-required:",
            JSON.stringify(retryDecoded, null, 2).replace(/\n/g, "\n    "),
          );
        } catch { /* non-critical */ }
      }

      // Also try hitting the facilitator /verify endpoint directly for more info
      try {
        const verifyRes = await fetch(`${FACILITATOR_URL}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            x402Version: 2,
            paymentPayload,
            paymentRequirements: (paymentRequired as { accepts: unknown[] }).accepts[0],
          }),
        });
        const verifyBody = await verifyRes.text();
        console.log(`    Facilitator /verify (${verifyRes.status}):`, verifyBody);
      } catch (e) {
        console.log("    Could not reach facilitator /verify:", e);
      }
    }

    const paymentResponse = paidRes.headers.get("payment-response");
    if (paymentResponse) {
      pass("Response has PAYMENT-RESPONSE header");
      try {
        const receipt = JSON.parse(atob(paymentResponse));
        console.log(
          "    Settlement receipt:",
          JSON.stringify(receipt, null, 2).replace(/\n/g, "\n    "),
        );
      } catch {
        // non-critical
      }
    } else {
      fail("Missing PAYMENT-RESPONSE header — settlement may have failed");
    }

    if (paidRes.status === 200) {
      const paidBody = (await paidRes.json()) as Record<string, unknown>;
      if (paidBody.temperature !== undefined) {
        pass("Protected body returned correctly");
        console.log(`    Weather data: ${JSON.stringify(paidBody)}`);
      } else {
        fail("Protected body missing expected 'temperature' field");
      }
    }
  }

  // ------------------------------------------------------------------
  // Shutdown
  // ------------------------------------------------------------------
  app.stop();

  printSummary();

  function printSummary() {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.log("Some tests failed. See output above for details.");
      process.exit(1);
    } else {
      console.log("All tests passed!");
    }
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
