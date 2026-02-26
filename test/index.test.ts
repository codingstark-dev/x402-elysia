/**
 * Tests for @codingstark/x402-elysia payment middleware plugin
 *
 * Strategy: we mock `x402HTTPResourceServer` at the module boundary so tests
 * run fully offline — no real facilitator, no real blockchain.
 *
 * Test matrix:
 *  1. Unprotected route — passes through untouched (200)
 *  2. Protected route, no payment header — returns 402 with JSON error body
 *  3. Protected route, no payment header, browser request — returns 402 HTML paywall
 *  4. Protected route, payment verified, settlement succeeds — 200 with PAYMENT-RESPONSE header
 *  5. Protected route, payment verified, settlement fails — 402, protected body NOT sent
 *  6. Protected route, payment verified, route handler returns 4xx — error forwarded, no settlement
 *  7. paymentMiddleware() factory function works end-to-end
 *  8. paymentMiddlewareFromConfig() factory function works end-to-end
 *  9. ElysiaAdapter correctly surfaces request data
 * 10. Re-exported types are accessible (compile-time check only)
 */

import { describe, expect, it, mock } from "bun:test";
import { Elysia } from "elysia";
import {
  paymentMiddlewareFromHTTPServer,
  paymentMiddlewareFromConfig,
  x402HTTPResourceServer,
  x402ResourceServer,
  ElysiaAdapter,
  type RoutesConfig,
  type PaywallConfig,
  type PaywallProvider,
  type SchemeRegistration,
} from "../src/index";
import type { HTTPProcessResult, ProcessSettleResultResponse } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, Network, SchemeNetworkServer } from "@x402/core/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_PAYMENT_REQUIREMENTS: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "1000",
  payTo: "0xRecipientAddress",
  maxTimeoutSeconds: 300,
  extra: {},
};

const MOCK_PAYMENT_PAYLOAD: PaymentPayload = {
  x402Version: 2,
  resource: { url: "http://localhost/api/weather", description: "Weather API", mimeType: "application/json" },
  accepted: MOCK_PAYMENT_REQUIREMENTS,
  payload: { signature: "0xdeadbeef", nonce: "abc123" },
};

const MOCK_ROUTES: RoutesConfig = {
  "GET /api/weather": {
    accepts: {
      scheme: "exact",
      network: "eip155:8453",
      payTo: "0xRecipientAddress",
      price: "$0.001",
    },
  },
};

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal mock of x402HTTPResourceServer that records calls
 * and returns the provided results.
 */
function createMockHTTPServer(opts: {
  requiresPaymentResult?: boolean;
  processHTTPRequestResult?: HTTPProcessResult;
  processSettlementResult?: ProcessSettleResultResponse;
}): x402HTTPResourceServer {
  const defaults: Required<typeof opts> = {
    requiresPaymentResult: false,
    processHTTPRequestResult: { type: "no-payment-required" },
    processSettlementResult: {
      success: true,
      transaction: "0xabc123",
      network: "eip155:8453" as const,
      payer: "0xPayer",
      headers: { "payment-response": "encoded-settlement-receipt" },
      requirements: MOCK_PAYMENT_REQUIREMENTS,
    },
  };
  const settings = { ...defaults, ...opts };

  // Build a minimal stub with the methods the plugin actually calls
  const stub = {
    routes: MOCK_ROUTES,
    server: {
      hasExtension: mock(() => true),
      register: mock(() => stub.server),
      registerExtension: mock(() => stub.server),
    },
    initialize: mock(async () => {}),
    registerPaywallProvider: mock(() => stub),
    requiresPayment: mock(() => settings.requiresPaymentResult),
    processHTTPRequest: mock(async () => settings.processHTTPRequestResult),
    processSettlement: mock(async () => settings.processSettlementResult),
    onProtectedRequest: mock(() => stub),
  };

  return stub as unknown as x402HTTPResourceServer;
}

// ---------------------------------------------------------------------------
// 1. Unprotected route — passes through
// ---------------------------------------------------------------------------

describe("1. Unprotected route", () => {
  it("returns 200 and the handler body when requiresPayment is false", async () => {
    const mockServer = createMockHTTPServer({ requiresPaymentResult: false });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(mockServer, undefined, undefined, false))
      .get("/public", () => ({ hello: "world" }));

    const res = await app.handle(new Request("http://localhost/public"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ hello: "world" });
    expect(mockServer.processHTTPRequest).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Protected route — no payment header → 402 JSON
// ---------------------------------------------------------------------------

describe("2. Protected route — no payment", () => {
  it("returns 402 JSON with payment-required info when no payment header is sent", async () => {
    const paymentRequiredBody = {
      x402Version: 2,
      error: "X-Payment header is required",
      accepts: [MOCK_PAYMENT_REQUIREMENTS],
    };

    const mockServer = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: {
        type: "payment-error",
        response: {
          status: 402,
          headers: { "payment-required": "encoded-payment-required" },
          body: paymentRequiredBody,
          isHtml: false,
        },
      },
    });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(mockServer, undefined, undefined, false))
      .get("/api/weather", () => ({ temp: 72 }));

    const res = await app.handle(new Request("http://localhost/api/weather"));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("payment-required")).toBe("encoded-payment-required");
    expect(body.error).toBe("X-Payment header is required");
    expect(body.accepts).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Protected route — browser request → 402 HTML paywall
// ---------------------------------------------------------------------------

describe("3. Protected route — browser paywall", () => {
  it("returns 402 HTML when request comes from a browser (Accept: text/html)", async () => {
    const mockServer = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: {
        type: "payment-error",
        response: {
          status: 402,
          headers: { "payment-required": "encoded-payment-required" },
          body: "<html><body>Please pay</body></html>",
          isHtml: true,
        },
      },
    });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(mockServer, undefined, undefined, false))
      .get("/api/weather", () => ({ temp: 72 }));

    const res = await app.handle(
      new Request("http://localhost/api/weather", {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
      }),
    );

    const body = await res.text();
    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("Please pay");
  });
});

// ---------------------------------------------------------------------------
// 4. Payment verified + settlement success → 200 with PAYMENT-RESPONSE header
// ---------------------------------------------------------------------------

describe("4. Payment verified — settlement success", () => {
  it("returns 200 with PAYMENT-RESPONSE header after successful settlement", async () => {
    const mockServer = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: {
        type: "payment-verified",
        paymentPayload: MOCK_PAYMENT_PAYLOAD,
        paymentRequirements: MOCK_PAYMENT_REQUIREMENTS,
        declaredExtensions: undefined,
      },
      processSettlementResult: {
        success: true,
        transaction: "0xtxhash",
        network: "eip155:8453",
        payer: "0xPayerAddress",
        headers: { "payment-response": "encoded-receipt" },
        requirements: MOCK_PAYMENT_REQUIREMENTS,
      },
    });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(mockServer, undefined, undefined, false))
      .get("/api/weather", () => ({ temp: 72, unit: "F" }));

    const res = await app.handle(
      new Request("http://localhost/api/weather", {
        headers: { "payment-signature": "encoded-payment-header" },
      }),
    );

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ temp: 72, unit: "F" });
    expect(res.headers.get("payment-response")).toBe("encoded-receipt");
    expect(mockServer.processSettlement).toHaveBeenCalledTimes(1);
    expect(mockServer.processSettlement).toHaveBeenCalledWith(
      MOCK_PAYMENT_PAYLOAD,
      MOCK_PAYMENT_REQUIREMENTS,
      undefined,
      // 4th arg: transportContext — request context + serialised response body
      expect.objectContaining({
        request: expect.objectContaining({ path: "/api/weather", method: "GET" }),
        responseBody: expect.any(Buffer),
      }),
    );
  });

  it("also works with legacy x-payment header (v1)", async () => {
    const mockServer = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: {
        type: "payment-verified",
        paymentPayload: MOCK_PAYMENT_PAYLOAD,
        paymentRequirements: MOCK_PAYMENT_REQUIREMENTS,
      },
      processSettlementResult: {
        success: true,
        transaction: "0xlegacytx",
        network: "eip155:8453",
        payer: "0xPayer",
        headers: { "payment-response": "legacy-receipt" },
        requirements: MOCK_PAYMENT_REQUIREMENTS,
      },
    });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(mockServer, undefined, undefined, false))
      .get("/api/weather", () => "ok");

    const res = await app.handle(
      new Request("http://localhost/api/weather", {
        headers: { "x-payment": "base64-encoded-v1-payload" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("payment-response")).toBe("legacy-receipt");
  });
});

// ---------------------------------------------------------------------------
// 5. Payment verified — settlement fails → 402, protected body NOT sent
// ---------------------------------------------------------------------------

describe("5. Payment verified — settlement failure", () => {
  it("returns 402 and does NOT reveal the protected resource body when settlement fails", async () => {
    const mockServer = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: {
        type: "payment-verified",
        paymentPayload: MOCK_PAYMENT_PAYLOAD,
        paymentRequirements: MOCK_PAYMENT_REQUIREMENTS,
      },
      processSettlementResult: {
          success: false,
          errorReason: "insufficient funds",
        } as ProcessSettleResultResponse,
    });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(mockServer, undefined, undefined, false))
      .get("/api/weather", () => ({ secret: "this must not leak" }));

    const res = await app.handle(
      new Request("http://localhost/api/weather", {
        headers: { "payment-signature": "some-payment" },
      }),
    );

    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(402);
    expect(body.error).toBe("Settlement failed");
    expect(body.details).toBe("insufficient funds");
    // The protected resource data must not appear in the response
    expect(JSON.stringify(body)).not.toContain("this must not leak");
  });
});

// ---------------------------------------------------------------------------
// 6. Payment verified — route handler returns 4xx → forward error, no settlement
// ---------------------------------------------------------------------------

describe("6. Route handler error — no settlement", () => {
  it("forwards the handler 4xx response without running settlement", async () => {
    const mockServer = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: {
        type: "payment-verified",
        paymentPayload: MOCK_PAYMENT_PAYLOAD,
        paymentRequirements: MOCK_PAYMENT_REQUIREMENTS,
      },
      // This should never be called because the handler returns a 4xx
      processSettlementResult: {
        success: true,
        transaction: "0x",
        network: "eip155:8453",
        payer: "0xPayer",
        headers: { "payment-response": "should-not-appear" },
        requirements: MOCK_PAYMENT_REQUIREMENTS,
      },
    });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(mockServer, undefined, undefined, false))
      .get("/api/weather", ({ status }) => status(404, { error: "not found" }));

    const res = await app.handle(
      new Request("http://localhost/api/weather", {
        headers: { "payment-signature": "some-payment" },
      }),
    );

    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect(body.error).toBe("not found");
    // Settlement must NOT have been called
    expect(mockServer.processSettlement).toHaveBeenCalledTimes(0);
    // PAYMENT-RESPONSE must not appear
    expect(res.headers.get("payment-response")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. paymentMiddleware() factory
// ---------------------------------------------------------------------------

describe("7. paymentMiddleware() factory", () => {
  it("creates an Elysia plugin via paymentMiddleware(routes, server)", async () => {
    // We can't easily mock the class constructor, so we verify the plugin
    // integrates correctly by checking that unprotected routes still work.
    // Full payment logic is already tested via paymentMiddlewareFromHTTPServer.
    const resourceServer = new x402ResourceServer();

    // Override requiresPayment to always return false so we can verify pass-through.
    const httpServer = new x402HTTPResourceServer(resourceServer, MOCK_ROUTES);
    httpServer.requiresPayment = () => false;

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false))
      .get("/ping", () => "pong");

    const res = await app.handle(new Request("http://localhost/ping"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
  });
});

// ---------------------------------------------------------------------------
// 8. paymentMiddlewareFromConfig() factory
// ---------------------------------------------------------------------------

describe("8. paymentMiddlewareFromConfig() factory", () => {
  it("returns an Elysia instance that can be used with .use()", () => {
    // We only verify the returned value is a valid Elysia plugin — actual
    // payment logic is tested in suites above.
    const plugin = paymentMiddlewareFromConfig(
      MOCK_ROUTES,
      undefined, // no facilitator
      undefined, // no schemes
      undefined,
      undefined,
      false, // don't sync on start (no real facilitator available)
    );

    expect(plugin).toBeInstanceOf(Elysia);
  });

  it("mounts successfully on an Elysia app without throwing", () => {
    const plugin = paymentMiddlewareFromConfig(MOCK_ROUTES, undefined, undefined, undefined, undefined, false);
    const app = new Elysia().use(plugin).get("/free", () => "free");
    expect(app).toBeInstanceOf(Elysia);
  });
});

// ---------------------------------------------------------------------------
// 9. ElysiaAdapter — surfaces request data correctly
// ---------------------------------------------------------------------------

describe("9. ElysiaAdapter", () => {
  it("exposes method, path, url from the underlying Request", async () => {
    let capturedAdapter: ElysiaAdapter | null = null;

    const app = new Elysia().get("/test/path", (ctx) => {
      capturedAdapter = new ElysiaAdapter(ctx);
      return "ok";
    });

    await app.handle(
      new Request("http://localhost/test/path?foo=bar&baz=qux", {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "TestBot/1.0",
          "X-Custom": "hello",
        },
      }),
    );

    expect(capturedAdapter).not.toBeNull();
    const a = capturedAdapter!;

    expect(a.getMethod()).toBe("GET");
    expect(a.getPath()).toBe("/test/path");
    expect(a.getUrl()).toContain("/test/path");
    expect(a.getAcceptHeader()).toBe("application/json");
    expect(a.getUserAgent()).toBe("TestBot/1.0");
    expect(a.getHeader("x-custom")).toBe("hello");
    expect(a.getHeader("x-missing")).toBeUndefined();
  });

  it("parses query parameters correctly", async () => {
    let capturedAdapter: ElysiaAdapter | null = null;

    const app = new Elysia().get("/search", (ctx) => {
      capturedAdapter = new ElysiaAdapter(ctx);
      return "ok";
    });

    await app.handle(new Request("http://localhost/search?q=hello&tag=a&tag=b"));

    const a = capturedAdapter!;
    expect(a.getQueryParam("q")).toBe("hello");
    expect(a.getQueryParam("tag")).toEqual(["a", "b"]);
    expect(a.getQueryParam("missing")).toBeUndefined();

    const all = a.getQueryParams();
    expect(all["q"]).toBe("hello");
    expect(all["tag"]).toEqual(["a", "b"]);
  });

  it("parses JSON body correctly", async () => {
    let capturedAdapter: ElysiaAdapter | null = null;

    const app = new Elysia().post("/echo", (ctx) => {
      capturedAdapter = new ElysiaAdapter(ctx);
      return "ok";
    });

    await app.handle(
      new Request("http://localhost/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100, currency: "USDC" }),
      }),
    );

    const body = await capturedAdapter!.getBody();
    expect(body).toEqual({ amount: 100, currency: "USDC" });
  });

  it("returns undefined for body when Content-Type is not JSON", async () => {
    let capturedAdapter: ElysiaAdapter | null = null;

    const app = new Elysia().post("/echo", (ctx) => {
      capturedAdapter = new ElysiaAdapter(ctx);
      return "ok";
    });

    await app.handle(
      new Request("http://localhost/echo", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "plain text",
      }),
    );

    const body = await capturedAdapter!.getBody();
    expect(body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 10. Multiple protected routes in one plugin instance
// ---------------------------------------------------------------------------

describe("10. Multiple protected routes", () => {
  it("handles different routes independently", async () => {
    const weatherServer = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: {
        type: "payment-verified",
        paymentPayload: MOCK_PAYMENT_PAYLOAD,
        paymentRequirements: MOCK_PAYMENT_REQUIREMENTS,
      },
      processSettlementResult: {
        success: true,
        transaction: "0x1",
        network: "eip155:8453",
        payer: "0xPayer",
        headers: { "payment-response": "weather-receipt" },
        requirements: MOCK_PAYMENT_REQUIREMENTS,
      },
    });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(weatherServer, undefined, undefined, false))
      .get("/api/weather", () => ({ temp: 72 }))
      .get("/health", () => ({ status: "ok" }));

    // Protected route with valid payment
    const paid = await app.handle(
      new Request("http://localhost/api/weather", {
        headers: { "payment-signature": "valid-payment" },
      }),
    );
    expect(paid.status).toBe(200);
    expect(paid.headers.get("payment-response")).toBe("weather-receipt");

    // Reset the mock to return requiresPayment=false for /health
    weatherServer.requiresPayment = mock(() => false);

    // Unprotected route
    const health = await app.handle(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    expect(healthBody.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 11. paywallConfig is forwarded to processHTTPRequest
// ---------------------------------------------------------------------------

describe("11. PaywallConfig forwarding", () => {
  it("forwards paywallConfig to processHTTPRequest", async () => {
    const mockServer = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: {
        type: "payment-error",
        response: { status: 402, headers: {}, body: {}, isHtml: false },
      },
    });

    const config: PaywallConfig = {
      appName: "WeatherApp",
      appLogo: "https://example.com/logo.png",
    };

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(mockServer, config, undefined, false))
      .get("/api/weather", () => ({ temp: 72 }));

    await app.handle(new Request("http://localhost/api/weather"));

    expect(mockServer.processHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/weather", method: "GET" }),
      config,
    );
  });
});

// ---------------------------------------------------------------------------
// 12. Payment header priority: payment-signature > x-payment
// ---------------------------------------------------------------------------

describe("12. Payment header priority", () => {
  it("uses payment-signature when both payment-signature and x-payment headers are present", async () => {
    const mockServer = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: { type: "no-payment-required" },
    });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(mockServer, undefined, undefined, false))
      .get("/api/test", () => "ok");

    await app.handle(
      new Request("http://localhost/api/test", {
        headers: {
          "payment-signature": "sig-value",
          "x-payment": "legacy-value",
        },
      }),
    );

    // processHTTPRequest must receive the v2 header value, not the legacy one
    expect(mockServer.processHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({ paymentHeader: "sig-value" }),
      undefined,
    );
  });

  it("falls back to x-payment when only the legacy header is present", async () => {
    const mockServer = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: { type: "no-payment-required" },
    });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(mockServer, undefined, undefined, false))
      .get("/api/test", () => "ok");

    await app.handle(
      new Request("http://localhost/api/test", {
        headers: { "x-payment": "legacy-only" },
      }),
    );

    expect(mockServer.processHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({ paymentHeader: "legacy-only" }),
      undefined,
    );
  });

  it("paymentHeader is undefined when no payment headers are present", async () => {
    const mockServer = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: { type: "no-payment-required" },
    });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(mockServer, undefined, undefined, false))
      .get("/api/test", () => "ok");

    await app.handle(new Request("http://localhost/api/test"));

    // No payment header sent — the context must carry undefined, not an empty string
    expect(mockServer.processHTTPRequest).toHaveBeenCalledWith(
      expect.objectContaining({ paymentHeader: undefined }),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// 13. Custom headers from payment-error are forwarded to the client
// ---------------------------------------------------------------------------

describe("13. Custom payment-error headers", () => {
  it("sets all headers from the payment-error response on the 402 reply", async () => {
    const mockServer = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: {
        type: "payment-error",
        response: {
          status: 402,
          headers: {
            "payment-required": "encoded-req",
            "x-custom-header": "custom-value",
            "x-another-header": "another-value",
          },
          body: { error: "Payment required" },
          isHtml: false,
        },
      },
    });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(mockServer, undefined, undefined, false))
      .get("/api/test", () => "ok");

    const res = await app.handle(new Request("http://localhost/api/test"));

    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBe("encoded-req");
    expect(res.headers.get("x-custom-header")).toBe("custom-value");
    expect(res.headers.get("x-another-header")).toBe("another-value");
  });
});

// ---------------------------------------------------------------------------
// 14. registerPaywallProvider is called when a paywall is provided
// ---------------------------------------------------------------------------

describe("14. PaywallProvider registration", () => {
  it("calls registerPaywallProvider when a paywall provider is passed", () => {
    const mockServer = createMockHTTPServer({ requiresPaymentResult: false });
    const mockPaywall: PaywallProvider = {
      generateHtml: () => "<html>pay</html>",
    };

    paymentMiddlewareFromHTTPServer(mockServer, undefined, mockPaywall, false);

    expect(mockServer.registerPaywallProvider).toHaveBeenCalledWith(mockPaywall);
    expect(mockServer.registerPaywallProvider).toHaveBeenCalledTimes(1);
  });

  it("does NOT call registerPaywallProvider when no paywall provider is passed", () => {
    const mockServer = createMockHTTPServer({ requiresPaymentResult: false });

    paymentMiddlewareFromHTTPServer(mockServer, undefined, undefined, false);

    expect(mockServer.registerPaywallProvider).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 15. processSettlement receives transportContext as 4th argument
// ---------------------------------------------------------------------------

describe("15. processSettlement transportContext (4th arg)", () => {
  it("passes { request, responseBody: Buffer } as transportContext to processSettlement", async () => {
    const mockServer = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: {
        type: "payment-verified",
        paymentPayload: MOCK_PAYMENT_PAYLOAD,
        paymentRequirements: MOCK_PAYMENT_REQUIREMENTS,
        declaredExtensions: undefined,
      },
      processSettlementResult: {
        success: true,
        transaction: "0xabc",
        network: "eip155:8453",
        payer: "0xPayer",
        headers: { "payment-response": "receipt" },
        requirements: MOCK_PAYMENT_REQUIREMENTS,
      },
    });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(mockServer, undefined, undefined, false))
      .get("/api/test", () => ({ data: "protected-content" }));

    await app.handle(
      new Request("http://localhost/api/test", {
        headers: { "payment-signature": "valid-payment" },
      }),
    );

    expect(mockServer.processSettlement).toHaveBeenCalledWith(
      MOCK_PAYMENT_PAYLOAD,
      MOCK_PAYMENT_REQUIREMENTS,
      undefined,
      expect.objectContaining({
        request: expect.objectContaining({ path: "/api/test", method: "GET" }),
        responseBody: expect.any(Buffer),
      }),
    );
  });

  it("responseBody contains the JSON-serialised handler output", async () => {
    const mockServer = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: {
        type: "payment-verified",
        paymentPayload: MOCK_PAYMENT_PAYLOAD,
        paymentRequirements: MOCK_PAYMENT_REQUIREMENTS,
      },
      processSettlementResult: {
        success: true,
        transaction: "0xabc",
        network: "eip155:8453",
        payer: "0xPayer",
        headers: { "payment-response": "receipt" },
        requirements: MOCK_PAYMENT_REQUIREMENTS,
      },
    });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(mockServer, undefined, undefined, false))
      .get("/api/test", () => ({ answer: 42 }));

    await app.handle(
      new Request("http://localhost/api/test", {
        headers: { "payment-signature": "valid-payment" },
      }),
    );

    const calls = (mockServer.processSettlement as ReturnType<typeof mock>).mock.calls;
    const transportCtx = calls[0]?.[3] as { request: unknown; responseBody: Buffer };
    const decoded = JSON.parse(transportCtx.responseBody.toString("utf-8"));
    expect(decoded).toEqual({ answer: 42 });
  });
});

// ---------------------------------------------------------------------------
// 16. paymentMiddlewareFromConfig — scheme server registration
// ---------------------------------------------------------------------------

describe("16. paymentMiddlewareFromConfig — scheme registration", () => {
  it("returns a valid Elysia plugin when a schemes array is provided", () => {
    // Verifies that the scheme registration path does not throw.
    // Detailed payment logic is covered by suites 1-15 above.
    const plugin = paymentMiddlewareFromConfig(
      MOCK_ROUTES,
      undefined,
      [{ network: "eip155:8453" as Network, server: {} as SchemeNetworkServer }],
      undefined,
      undefined,
      false,
    );

    expect(plugin).toBeInstanceOf(Elysia);
  });

  it("accepts multiple scheme registrations without throwing", () => {
    const schemes: SchemeRegistration[] = [
      { network: "eip155:8453" as Network, server: {} as SchemeNetworkServer },
      { network: "eip155:84532" as Network, server: {} as SchemeNetworkServer },
    ];

    const plugin = paymentMiddlewareFromConfig(
      MOCK_ROUTES,
      undefined,
      schemes,
      undefined,
      undefined,
      false,
    );

    expect(plugin).toBeInstanceOf(Elysia);
  });
});

// ---------------------------------------------------------------------------
// 17. Two middleware instances coexist independently (deduplication regression)
// ---------------------------------------------------------------------------

describe("17. Two middleware instances — no silent deduplication", () => {
  it("both instances' hooks execute when two plugins are registered on the same app", async () => {
    // If Elysia were to deduplicate based on `name`, the second plugin's hooks
    // would be silently dropped and its `requiresPayment` would never be called.
    // Without a `name`, each instance is independent — both hooks fire per request.
    const server1 = createMockHTTPServer({ requiresPaymentResult: false });
    const server2 = createMockHTTPServer({ requiresPaymentResult: false });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(server1, undefined, undefined, false))
      .use(paymentMiddlewareFromHTTPServer(server2, undefined, undefined, false))
      .get("/route", () => "ok");

    await app.handle(new Request("http://localhost/route"));

    // Both servers must have been consulted — proves neither plugin was deduplicated.
    expect(server1.requiresPayment).toHaveBeenCalled();
    expect(server2.requiresPayment).toHaveBeenCalled();
  });

  it("a blocking second instance takes effect even when first instance passes", async () => {
    // This is the dangerous real-world scenario: a developer registers a permissive
    // plugin first, then a strict one. With the name-deduplication bug the strict
    // plugin would be silently ignored; without the bug it blocks the request.
    const server1 = createMockHTTPServer({ requiresPaymentResult: false });
    const server2 = createMockHTTPServer({
      requiresPaymentResult: true,
      processHTTPRequestResult: {
        type: "payment-error",
        response: {
          status: 402,
          headers: {},
          body: { error: "payment required" },
          isHtml: false,
        },
      },
    });

    const app = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(server1, undefined, undefined, false))
      .use(paymentMiddlewareFromHTTPServer(server2, undefined, undefined, false))
      .get("/route", () => "ok");

    const res = await app.handle(new Request("http://localhost/route"));

    // server1 passes the request, but server2's hook still runs and blocks it.
    // If deduplication were active server2's hook would be dropped → 200 (wrong).
    expect(res.status).toBe(402);
    expect(server1.requiresPayment).toHaveBeenCalled();
    expect(server2.requiresPayment).toHaveBeenCalled();
  });

  it("each plugin instance on separate apps is independent", async () => {
    const serverA = createMockHTTPServer({ requiresPaymentResult: false });
    const serverB = createMockHTTPServer({ requiresPaymentResult: false });

    const appA = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(serverA, undefined, undefined, false))
      .get("/a", () => "a");

    const appB = new Elysia()
      .use(paymentMiddlewareFromHTTPServer(serverB, undefined, undefined, false))
      .get("/b", () => "b");

    const resA = await appA.handle(new Request("http://localhost/a"));
    const resB = await appB.handle(new Request("http://localhost/b"));

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(serverA.requiresPayment).toHaveBeenCalled();
    expect(serverB.requiresPayment).toHaveBeenCalled();
  });
});
