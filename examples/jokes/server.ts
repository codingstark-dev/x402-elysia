/**
 * x402 Joke Generator — @x402/elysia fullstack example
 * ======================================================
 * A single-file Elysia app that demonstrates the complete x402 payment
 * protocol on Solana Devnet. Every joke costs $0.001 USDC.
 *
 * Architecture
 * ------------
 *   GET /            Serves the webpage (unprotected).
 *   GET /api/joke    Returns a random joke — protected by x402.
 *                    Requires a valid Solana payment-signature header.
 *   GET /get-joke    Unprotected proxy used by the webpage:
 *                    1. Probes /api/joke → receives 402 + payment requirements.
 *                    2. Builds a payment payload (signs with the .env key).
 *                    3. Re-fetches /api/joke with the payment header.
 *                    4. Returns the joke + payment receipt to the browser.
 *
 * This self-contained flow requires no browser wallet — ideal for demos.
 *
 * Setup
 * -----
 * 1. Install devnet-only deps (if not already present):
 *      bun add -d @x402/svm
 *
 * 2. Ensure .env exists in the project root:
 *      SVM_PRIVATE_KEY=<base58-encoded Solana private key>
 *      SVM_PAY_TO=<Solana address that receives payment>
 *      PORT=3402   # optional; defaults to 3402
 *
 *    Fund your wallet:
 *      - Devnet SOL:  https://faucet.solana.com
 *      - Devnet USDC: https://faucet.circle.com  (select "Solana Devnet")
 *
 * 3. Run:
 *      bun --env-file=.env run examples/jokes/server.ts
 *
 * 4. Open http://localhost:3402 in your browser.
 *
 * Network
 * -------
 * Solana Devnet (CAIP-2: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1)
 * USDC mint:  4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
 */

import { Elysia, file } from "elysia";
import { HTTPFacilitatorClient, paymentMiddleware, x402ResourceServer } from "../../src/index";
import type { RouteConfig } from "../../src/index";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SVM_PRIVATE_KEY = process.env.SVM_PRIVATE_KEY;
const SVM_PAY_TO = process.env.SVM_PAY_TO;
const PORT = Number(process.env.PORT ?? 3402);

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
const FACILITATOR_URL = "https://x402.org/facilitator";
const PRICE = "$0.001";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (!SVM_PRIVATE_KEY) {
  console.error("ERROR: SVM_PRIVATE_KEY environment variable is required.");
  console.error("  bun --env-file=.env run examples/jokes/server.ts");
  process.exit(1);
}

if (!SVM_PAY_TO) {
  console.error("ERROR: SVM_PAY_TO environment variable is required.");
  console.error("  bun --env-file=.env run examples/jokes/server.ts");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Jokes dataset
// ---------------------------------------------------------------------------

const JOKES = [
  { setup: "Why don't scientists trust atoms?", punchline: "Because they make up everything." },
  { setup: "Why did the scarecrow win an award?", punchline: "Because he was outstanding in his field." },
  { setup: "Why don't eggs tell jokes?", punchline: "They'd crack each other up." },
  { setup: "What do you call a fish without eyes?", punchline: "A fsh." },
  { setup: "Why can't you give Elsa a balloon?", punchline: "Because she'll let it go." },
  { setup: "What do you call cheese that isn't yours?", punchline: "Nacho cheese." },
  { setup: "Why did the math book look so sad?", punchline: "Because it had too many problems." },
  { setup: "What do you call a sleeping dinosaur?", punchline: "A dino-snore." },
  { setup: "Why don't skeletons fight each other?", punchline: "They don't have the guts." },
  { setup: "What do you call a belt made of watches?", punchline: "A waist of time." },
  { setup: "Why did the bicycle fall over?", punchline: "It was two-tired." },
  { setup: "What do you call a fake noodle?", punchline: "An impasta." },
  { setup: "Why can't a nose be 12 inches long?", punchline: "Because then it would be a foot." },
  { setup: "Why did the golfer bring extra pants?", punchline: "In case he got a hole in one." },
  { setup: "What do you call a factory that makes okay products?", punchline: "A satisfactory." },
  { setup: "Why did the invisible man turn down the job offer?", punchline: "He couldn't see himself doing it." },
  { setup: "What do you call a can opener that doesn't work?", punchline: "A can't opener." },
  { setup: "Why did the computer go to the doctor?", punchline: "Because it had a virus." },
  { setup: "What do you call a pony with a cough?", punchline: "A little horse." },
  { setup: "Why do programmers prefer dark mode?", punchline: "Because light attracts bugs." },
  { setup: "What does a house wear?", punchline: "Address." },
  { setup: "Why did the blockchain developer go broke?", punchline: "He kept losing his keys." },
  { setup: "What did the ocean say to the beach?", punchline: "Nothing, it just waved." },
  { setup: "Why don't programmers like nature?", punchline: "It has too many bugs and no documentation." },
  { setup: "What do you call a group of musical whales?", punchline: "An orca-stra." },
];

function randomJoke() {
  return JOKES[Math.floor(Math.random() * JOKES.length)];
}

// ---------------------------------------------------------------------------
// HTML webpage path (served at GET / via Elysia's file() helper)
// ---------------------------------------------------------------------------

const HTML_FILE = new URL("public/index.html", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Load devnet deps dynamically (not in package.json — devnet only)
// ---------------------------------------------------------------------------

async function loadDeps() {
  try {
    const [svmServerMod, svmClientMod, solanaKitMod, x402CoreClientMod, scureBaseMod] =
      await Promise.all([
        import("@x402/svm/exact/server"),
        import("@x402/svm/exact/client"),
        import("@solana/kit"),
        import("@x402/core/client"),
        import("@scure/base"),
      ]);
    return { svmServerMod, svmClientMod, solanaKitMod, x402CoreClientMod, scureBaseMod };
  } catch (err) {
    console.error(
      "ERROR: Missing devnet dependencies. Install them with:\n  bun add -d @x402/svm",
    );
    console.error(err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n=== x402 Joke Generator ===\n");
  console.log(`Network:     ${NETWORK}`);
  console.log(`Facilitator: ${FACILITATOR_URL}`);
  console.log(`Price:       ${PRICE} USDC per joke`);
  console.log(`Pay to:      ${SVM_PAY_TO}`);
  console.log(`Port:        ${PORT}\n`);

  const { svmServerMod, svmClientMod, solanaKitMod, x402CoreClientMod, scureBaseMod } =
    await loadDeps();

  // ------------------------------------------------------------------
  // Build the Solana signer from the base58 private key in .env
  // ------------------------------------------------------------------

  let svmSigner: Awaited<ReturnType<typeof solanaKitMod.createKeyPairSignerFromBytes>>;
  try {
    const keyBytes = scureBaseMod.base58.decode(SVM_PRIVATE_KEY!);
    svmSigner = await solanaKitMod.createKeyPairSignerFromBytes(keyBytes);
    console.log(`Wallet:      ${svmSigner.address}`);
    console.log(`Open:        http://localhost:${PORT}\n`);
  } catch (err) {
    console.error("ERROR: Failed to create Solana signer from SVM_PRIVATE_KEY:", err);
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // x402 plugin setup
  // ------------------------------------------------------------------

  const route: RouteConfig = {
    accepts: {
      scheme: "exact",
      network: NETWORK,
      payTo: SVM_PAY_TO!,
      price: PRICE,
    },
    description: "A random joke",
    mimeType: "application/json",
  };

  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator);

  // Register the Solana exact-payment scheme
  svmServerMod.registerExactSvmScheme(resourceServer, { networks: [NETWORK] });

  // ------------------------------------------------------------------
  // Build the Elysia app
  // ------------------------------------------------------------------

  const app = new Elysia()

    // ------------------------------------------------------------------
    // x402 payment middleware — protects /api/joke
    // ------------------------------------------------------------------
    .use(
      paymentMiddleware({ "GET /api/joke": route }, resourceServer, {
        appName: "x402 Joke Generator",
        testnet: true,
      }),
    )

    // ------------------------------------------------------------------
    // GET /api/joke — the protected resource
    // ------------------------------------------------------------------
    .get("/api/joke", () => randomJoke())

    // ------------------------------------------------------------------
    // GET /get-joke — server-side payment proxy used by the webpage
    //
    // Flow:
    //   1. Probe /api/joke without payment → get 402 + payment requirements.
    //   2. Build a Solana payment payload signed by the .env wallet.
    //   3. Re-fetch /api/joke with the payment-signature header.
    //   4. Return the joke + extracted transaction signature to the client.
    // ------------------------------------------------------------------
    .get("/get-joke", async () => {
      const BASE = `http://localhost:${PORT}`;

      // Step 1 — probe to retrieve payment requirements
      const probe = await fetch(`${BASE}/api/joke`);
      if (probe.status !== 402) {
        // Unexpected: /api/joke should always require payment
        const body = await probe.json();
        return new Response(JSON.stringify(body), {
          status: probe.status,
          headers: { "content-type": "application/json" },
        });
      }

      const paymentRequiredHeader = probe.headers.get("payment-required");
      if (!paymentRequiredHeader) {
        return new Response(
          JSON.stringify({ error: "No payment-required header from /api/joke" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      let paymentRequired: Record<string, unknown>;
      try {
        paymentRequired = JSON.parse(atob(paymentRequiredHeader));
      } catch {
        return new Response(
          JSON.stringify({ error: "Could not decode payment-required header" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      // Step 2 — build a Solana x402 payment payload using the server wallet
      const { x402Client } = x402CoreClientMod;
      const client = new x402Client();
      svmClientMod.registerExactSvmScheme(client, { signer: svmSigner });

      let paymentPayload: unknown;
      try {
        paymentPayload = await client.createPaymentPayload(
          paymentRequired as Parameters<typeof client.createPaymentPayload>[0],
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[jokes] Failed to create payment payload:", err);
        return new Response(
          JSON.stringify({
            error: "Failed to create payment — wallet may be missing SOL or USDC",
            details: msg,
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      const encodedPayment = btoa(JSON.stringify(paymentPayload));

      // Step 3 — send the paid request
      const paidRes = await fetch(`${BASE}/api/joke`, {
        headers: { "payment-signature": encodedPayment },
      });

      if (paidRes.status !== 200) {
        const errBody = await paidRes.json().catch(() => ({ error: "Unknown error" }));
        return new Response(JSON.stringify(errBody), {
          status: paidRes.status,
          headers: { "content-type": "application/json" },
        });
      }

      // Step 4 — extract the joke and transaction signature from the receipt
      const joke = (await paidRes.json()) as { setup: string; punchline: string };
      const paymentResponse = paidRes.headers.get("payment-response");

      let txSignature: string | null = null;
      if (paymentResponse) {
        try {
          const receipt = JSON.parse(atob(paymentResponse)) as Record<string, unknown>;
          // The settlement receipt includes the on-chain transaction signature
          txSignature =
            (receipt.transaction as string) ??
            (receipt.txSignature as string) ??
            null;
        } catch {
          // Non-critical — we still return the joke even without receipt details
        }
      }

      return {
        ...joke,
        ...(txSignature ? { txSignature } : {}),
      };
    })

    // ------------------------------------------------------------------
    // GET /prepare-joke-tx?wallet=<base58>
    //
    // Builds an unsigned Solana v0 transaction for a browser wallet to sign.
    //
    // Flow:
    //   1. Validate the wallet address format.
    //   2. Probe /api/joke → decode 402 payment requirements.
    //   3. Build the same transaction structure as ExactSvmScheme.createPaymentPayload
    //      but WITHOUT signing (user's browser wallet will sign it).
    //   4. Use compileTransaction() to get raw message bytes.
    //   5. Manually prepend the signature slots (all zero bytes) to produce
    //      valid wire-format bytes that @solana/web3.js can deserialize.
    //   6. Return { unsignedTxBase64, x402Version }.
    // ------------------------------------------------------------------
    .get("/prepare-joke-tx", async ({ query }) => {
      const walletAddress = query.wallet as string | undefined;

      // Validate wallet address
      const SVM_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      if (!walletAddress || !SVM_ADDRESS_REGEX.test(walletAddress)) {
        return new Response(
          JSON.stringify({ error: "Invalid or missing wallet address" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const BASE = `http://localhost:${PORT}`;

      // Step 1 — probe to get payment requirements
      const probe = await fetch(`${BASE}/api/joke`);
      if (probe.status !== 402) {
        return new Response(
          JSON.stringify({ error: "Expected 402 from /api/joke" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      const paymentRequiredHeader = probe.headers.get("payment-required");
      if (!paymentRequiredHeader) {
        return new Response(
          JSON.stringify({ error: "No payment-required header" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      let paymentRequired: Record<string, unknown>;
      try {
        paymentRequired = JSON.parse(atob(paymentRequiredHeader));
      } catch {
        return new Response(
          JSON.stringify({ error: "Could not decode payment-required header" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      // Find the exact+NETWORK entry in accepts[]
      const accepts = (paymentRequired.accepts as Array<Record<string, unknown>>) ?? [];
      const req = accepts.find(
        (a) => a.scheme === "exact" && a.network === NETWORK,
      );
      if (!req) {
        return new Response(
          JSON.stringify({ error: `No exact/${NETWORK} payment option found` }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }

      const x402Version = (paymentRequired.x402Version as number) ?? 1;

      // Step 2 — build the unsigned transaction
      const {
        getSetComputeUnitLimitInstruction,
        setTransactionMessageComputeUnitPrice,
      } = await import("@solana-program/compute-budget");
      const { findAssociatedTokenPda, fetchMint, getTransferCheckedInstruction } =
        await import("@solana-program/token-2022");

      const {
        appendTransactionMessageInstructions,
        compileTransaction,
        createTransactionMessage,
        createSolanaRpc,
        devnet,
        pipe,
        prependTransactionMessageInstruction,
        setTransactionMessageFeePayer,
        setTransactionMessageLifetimeUsingBlockhash,
        address,
      } = await import("@solana/kit");

      const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
      const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1;
      const DEFAULT_COMPUTE_UNIT_LIMIT = 20000;

      const rpc = createSolanaRpc(devnet("https://api.devnet.solana.com"));

      const assetAddress = address(req.asset as string);
      const tokenMint = await fetchMint(rpc, assetAddress);
      const tokenProgramAddress = tokenMint.programAddress;

      const userAddress = address(walletAddress);
      const payToAddress = address(req.payTo as string);
      const feePayerAddress = address((req.extra as Record<string, unknown>)?.feePayer as string);

      const [sourceATA] = await findAssociatedTokenPda({
        mint: assetAddress,
        owner: userAddress,
        tokenProgram: tokenProgramAddress,
      });
      const [destinationATA] = await findAssociatedTokenPda({
        mint: assetAddress,
        owner: payToAddress,
        tokenProgram: tokenProgramAddress,
      });

      // Wrap the user's address as a minimal TransactionPartialSigner so that
      // getTransferCheckedInstruction marks the authority account as READONLY_SIGNER
      // (isTransactionSigner checks `typeof value === "object"` and `signTransactions`).
      // The signTransactions method is never called — compileTransaction is used instead
      // of partiallySignTransactionMessageWithSigners, so no actual signing happens here.
      // The browser wallet fills in this signature slot.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userSigner = { address: userAddress, signTransactions: async () => [] } as any;

      const transferIx = getTransferCheckedInstruction(
        {
          source: sourceATA,
          mint: assetAddress,
          destination: destinationATA,
          authority: userSigner,
          amount: BigInt(req.amount as string),
          decimals: tokenMint.data.decimals,
        },
        { programAddress: tokenProgramAddress },
      );

      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

      const nonce = crypto.getRandomValues(new Uint8Array(16));
      const memoIx = {
        programAddress: address(MEMO_PROGRAM_ADDRESS),
        accounts: [] as [],
        data: new TextEncoder().encode(
          Array.from(nonce)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
        ),
      };

      const txMessage = pipe(
        createTransactionMessage({ version: 0 }),
        (tx) => setTransactionMessageComputeUnitPrice(DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS, tx),
        (tx) => setTransactionMessageFeePayer(feePayerAddress, tx),
        (tx) =>
          prependTransactionMessageInstruction(
            getSetComputeUnitLimitInstruction({ units: DEFAULT_COMPUTE_UNIT_LIMIT }),
            tx,
          ),
        (tx) => appendTransactionMessageInstructions([transferIx, memoIx], tx),
        (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      );

      // Step 3 — compile without signing, then manually build wire bytes
      // Wire format: [compact-u16 numSigners][64 * numSigners zero bytes][messageBytes]
      const compiled = compileTransaction(txMessage);

      // For v0 messages, byte index 1 of messageBytes is the number of required signers
      const numSigners = compiled.messageBytes[1];

      // Compact-u16 encoding for numSigners (all realistic values fit in 1 byte)
      const sigCountBytes =
        numSigners < 128
          ? new Uint8Array([numSigners])
          : new Uint8Array([(numSigners & 0x7f) | 0x80, numSigners >> 7]);

      const sigBytes = new Uint8Array(numSigners * 64); // zero-filled placeholder slots

      const wireBytes = new Uint8Array(
        sigCountBytes.length + sigBytes.length + compiled.messageBytes.length,
      );
      wireBytes.set(sigCountBytes, 0);
      wireBytes.set(sigBytes, sigCountBytes.length);
      wireBytes.set(compiled.messageBytes, sigCountBytes.length + sigBytes.length);

      const unsignedTxBase64 = Buffer.from(wireBytes).toString("base64");

      console.log(
        `[prepare-joke-tx] Built unsigned tx for ${walletAddress.slice(0, 8)}... blockhash=${latestBlockhash.blockhash.slice(0, 12)}... sigSlots=${numSigners}`,
      );

      // Return the selected payment requirements and resource so /wallet-joke
      // can construct a fully valid x402 v2 PaymentPayload (which requires
      // `accepted` = the exact requirements object, and `resource`).
      return {
        unsignedTxBase64,
        x402Version,
        paymentRequirements: req,
        resource: paymentRequired.resource ?? null,
      };
    })

    // ------------------------------------------------------------------
    // POST /wallet-joke
    //
    // Accepts a user-signed transaction (from the browser wallet) and
    // forwards it to /api/joke as an x402 payment.
    //
    // Body: { signedTxBase64: string, x402Version: number }
    // Returns: { setup, punchline, txSignature? }
    // ------------------------------------------------------------------
    .post("/wallet-joke", async ({ body }) => {
      const { signedTxBase64, x402Version, paymentRequirements, resource } = body as {
        signedTxBase64: string;
        x402Version: number;
        paymentRequirements?: Record<string, unknown>;
        resource?: Record<string, unknown> | null;
      };

      if (!signedTxBase64 || typeof x402Version !== "number") {
        return new Response(
          JSON.stringify({ error: "Missing signedTxBase64 or x402Version" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Build a complete x402 v2 PaymentPayload.
      //
      // For x402 v2, findMatchingRequirements does a deepEqual of
      // paymentPayload.accepted against each entry in accepts[].  Without the
      // `accepted` field the server returns "No matching payment requirements".
      //
      // `resource` is the URL/description/mimeType of the protected resource
      // — it's optional but mirrors what x402Client.createPaymentPayload builds.
      const paymentPayload: Record<string, unknown> = {
        x402Version,
        payload: { transaction: signedTxBase64 },
        ...(paymentRequirements ? { accepted: paymentRequirements } : {}),
        ...(resource ? { resource } : {}),
      };
      const encodedPayment = btoa(JSON.stringify(paymentPayload));

      const BASE = `http://localhost:${PORT}`;
      const paidRes = await fetch(`${BASE}/api/joke`, {
        headers: { "payment-signature": encodedPayment },
      });

      if (paidRes.status !== 200) {
        // Extract a meaningful error message from the x402 payment-required header.
        // When verification fails, the body is {} (empty object) but the actual
        // invalidReason is encoded in the payment-required header.
        let errorMessage = "Payment failed";
        let errorDetails: string | undefined;

        const paymentRequiredHeader = paidRes.headers.get("payment-required");
        if (paymentRequiredHeader) {
          try {
            const decoded = JSON.parse(atob(paymentRequiredHeader)) as Record<string, unknown>;
            if (decoded.error && typeof decoded.error === "string") {
              errorMessage = decoded.error;
            }
          } catch {
            // header not decodable
          }
        }

        // Also try to get any body content
        const rawBody = await paidRes.text().catch(() => "");
        if (rawBody && rawBody !== "{}") {
          try {
            const parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
            if (parsedBody.error && typeof parsedBody.error === "string") {
              errorMessage = parsedBody.error;
            }
            if (parsedBody.details && typeof parsedBody.details === "string") {
              errorDetails = parsedBody.details;
            }
          } catch {
            // body not JSON
          }
        }

        console.error(
          `[wallet-joke] Payment failed (HTTP ${paidRes.status}):`,
          errorMessage,
          errorDetails ?? "",
          "| payment-required header:", paymentRequiredHeader?.slice(0, 200),
        );

        return new Response(
          JSON.stringify({
            error: errorMessage,
            ...(errorDetails ? { details: errorDetails } : {}),
          }),
          {
            status: paidRes.status,
            headers: { "content-type": "application/json" },
          },
        );
      }

      const joke = (await paidRes.json()) as { setup: string; punchline: string };
      const paymentResponse = paidRes.headers.get("payment-response");

      let txSignature: string | null = null;
      if (paymentResponse) {
        try {
          const receipt = JSON.parse(atob(paymentResponse)) as Record<string, unknown>;
          txSignature =
            (receipt.transaction as string) ?? (receipt.txSignature as string) ?? null;
        } catch {
          // Non-critical
        }
      }

      return {
        ...joke,
        ...(txSignature ? { txSignature } : {}),
      };
    })

    // ------------------------------------------------------------------
    // GET / — serve the webpage using Elysia's file() helper
    // ------------------------------------------------------------------
    .get("/", () => file(HTML_FILE))

    .listen(PORT);

  console.log(`Server ready at http://localhost:${PORT}`);

  // Graceful shutdown
  process.on("SIGINT", () => {
    app.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    app.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
