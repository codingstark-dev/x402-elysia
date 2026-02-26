import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPRequestContext,
  type PaywallConfig,
  type PaywallProvider,
  type RouteConfig,
  type RoutesConfig,
} from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements, Price, SchemeNetworkServer } from "@x402/core/types";
import { Elysia } from "elysia";
import { ElysiaAdapter } from "./adapter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Represents a verified payment that has been passed from onBeforeHandle to onAfterHandle. */
interface VerifiedPaymentContext {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  declaredExtensions?: Record<string, unknown>;
  /**
   * The HTTPRequestContext built in onBeforeHandle — forwarded to processSettlement
   * as the `transportContext.request` so that extensions (e.g. Bazaar) that need
   * request metadata can access it during settlement.
   */
  context: HTTPRequestContext;
}

/**
 * Mutable container for the per-request payment state.
 *
 * Elysia's `derive` makes the derived property itself readonly (you cannot
 * reassign `ctx.x402PaymentContext = …`), but a mutable container object
 * lets us update `ctx.x402PaymentContext.value` freely across lifecycle hooks.
 */
interface PaymentContextHolder {
  value: VerifiedPaymentContext | null;
}

/** Scheme registration used by `paymentMiddlewareFromConfig`. */
export interface SchemeRegistration {
  /** CAIP-2 network identifier, e.g. "eip155:8453" */
  network: Network;
  /** The scheme server implementation for this network */
  server: SchemeNetworkServer;
}

/**
 * Dynamic `payTo` function — receives the HTTP request context and returns the
 * address to pay, allowing per-request routing of payments.
 *
 * Mirrors `DynamicPayTo` from `@x402/core` (not yet publicly exported in v2.4.x).
 */
export type DynamicPayTo = (context: HTTPRequestContext) => string | Promise<string>;

/**
 * Dynamic `price` function — receives the HTTP request context and returns the
 * price for the request, enabling per-request pricing.
 *
 * Mirrors `DynamicPrice` from `@x402/core` (not yet publicly exported in v2.4.x).
 */
export type DynamicPrice = (context: HTTPRequestContext) => Price | Promise<Price>;

/**
 * Hook that runs on every request to a protected route, before payment processing.
 * Can grant access without payment, deny the request, or continue to the payment flow.
 *
 * Return values:
 * - `void` — continue to normal payment processing
 * - `{ grantAccess: true }` — grant access without requiring payment
 * - `{ abort: true; reason: string }` — deny the request (returns 403)
 *
 * Register via `httpServer.onProtectedRequest(hook)`.
 *
 * Mirrors `ProtectedRequestHook` from `@x402/core` (not yet publicly exported in v2.4.x).
 */
export type ProtectedRequestHook = (
  context: HTTPRequestContext,
  routeConfig: RouteConfig,
) => Promise<
  | void
  | { grantAccess: true }
  | { abort: true; reason: string }
>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Checks whether any route in the config declares a "bazaar" extension.
 */
function checkIfBazaarNeeded(routes: RoutesConfig): boolean {
  // Single-route config (RouteConfig has `accepts`)
  if ("accepts" in routes) {
    const rc = routes as RouteConfig;
    return !!(rc.extensions && "bazaar" in rc.extensions);
  }
  // Multi-route config
  return Object.values(routes as Record<string, RouteConfig>).some(
    (rc) => !!(rc.extensions && "bazaar" in rc.extensions),
  );
}

/**
 * Core plugin factory. Takes a pre-configured `x402HTTPResourceServer` and returns an
 * Elysia plugin instance that enforces x402 payment on every request.
 *
 * **Important — no `name` is given to the Elysia instance.**
 * Elysia deduplicates plugins that share the same `name` + `seed`: if two plugins have
 * the same name, the second `.use()` call is silently ignored. Because this factory is
 * meant to be called multiple times with different server configurations (e.g. separate
 * plugins for different route groups), each call must produce an independent plugin.
 * Naming it would be a security vulnerability — a stricter middleware registered second
 * would be silently dropped, leaving routes unprotected.
 *
 * Lifecycle overview:
 *  1. `derive` — attaches a mutable `x402PaymentContext` slot to each request context
 *     so state can flow from `onBeforeHandle` to `onAfterHandle` without a WeakMap.
 *  2. `onBeforeHandle` — checks whether the route requires payment:
 *     - Not required → passes through immediately.
 *     - Payment error (missing header, bad payload, wrong amount, etc.) →
 *       returns a 402 or 412 Response and short-circuits the request.
 *     - Payment verified → stores the payload in `x402PaymentContext` and continues
 *       to the route handler.
 *  3. `onAfterHandle` — if `x402PaymentContext` is populated (a payment was verified):
 *     - Skips settlement when the route handler returned a 4xx response (the client
 *       made an error; we do not charge for server-side failures).
 *     - Runs settlement against the facilitator.
 *     - On success → injects the `PAYMENT-RESPONSE` header into the outgoing response.
 *     - On failure → replaces the response with a 402; the protected body is never sent.
 *
 * @param httpServer              Pre-built `x402HTTPResourceServer` instance
 * @param paywallConfig           Optional paywall display config (app name, logo URL, etc.)
 * @param paywall                 Optional custom paywall HTML provider
 * @param syncFacilitatorOnStart  When `true` (default), eagerly fetches facilitator
 *                                capabilities at startup. Set to `false` in tests or
 *                                serverless environments where cold-start latency matters.
 */
export function paymentMiddlewareFromHTTPServer(
  httpServer: x402HTTPResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart = true,
): Elysia {
  if (paywall) {
    httpServer.registerPaywallProvider(paywall);
  }

  // Kick off facilitator capability sync at construction time so it completes
  // before the first protected request arrives.  We await the promise lazily —
  // only when the first protected route is actually hit — so startup time is
  // not blocked if no protected routes are called early.
  //
  // Concurrent-request safety: if two requests arrive simultaneously and both
  // find `initPromise` truthy, both await the *same* promise (idempotent).
  // The first to resume sets it to null; the second sets null→null harmlessly.
  // Requests arriving after null is set skip the await (init already finished).
  let initPromise: Promise<void> | null = syncFacilitatorOnStart ? httpServer.initialize() : null;

  // Dynamically load the bazaar extension only if needed and not yet registered.
  // Skip if pre-registered (e.g. in serverless environments where static imports are used).
  let bazaarPromise: Promise<void> | null = null;
  if (checkIfBazaarNeeded(httpServer.routes) && !httpServer.server.hasExtension("bazaar")) {
    bazaarPromise = import(
      // @ts-ignore — optional peer dependency, may not be installed
      "@x402/extensions/bazaar"
    )
      .then(({ bazaarResourceServerExtension }) => {
        httpServer.server.registerExtension(bazaarResourceServerExtension);
      })
      .catch((err: unknown) => {
        console.error("[x402-elysia] Failed to load bazaar extension:", err);
      });
  }

  return (
    new Elysia()
      // ------------------------------------------------------------------
      // derive: add a per-request mutable slot to carry payment state from
      // onBeforeHandle → onAfterHandle without any external WeakMap or store.
      // We use a container object because Elysia's derive makes the top-level
      // derived property readonly — but the object's inner `value` is mutable.
      // ------------------------------------------------------------------
      .derive({ as: "scoped" }, () => ({
        x402PaymentContext: { value: null } as PaymentContextHolder,
      }))

      // ------------------------------------------------------------------
      // onBeforeHandle: enforce payment on protected routes
      // ------------------------------------------------------------------
      .onBeforeHandle({ as: "scoped" }, async (ctx) => {
        const adapter = new ElysiaAdapter(ctx as unknown as import("elysia").Context);
        const context: HTTPRequestContext = {
          adapter,
          path: adapter.getPath(),
          method: adapter.getMethod(),
          // Support both x402 v2 header name and v1 legacy.
          // Use || so that an empty-string header is treated as absent,
          paymentHeader:
            adapter.getHeader("payment-signature") || adapter.getHeader("x-payment"),
        };

        // Fast-path: skip all payment logic for unprotected routes.
        // `requiresPayment` is a synchronous O(1) route-map lookup in core.
        if (!httpServer.requiresPayment(context)) {
          return;
        }

        // Block on init only when we actually hit a protected route.
        if (initPromise) {
          await initPromise;
          initPromise = null;
        }
        if (bazaarPromise) {
          await bazaarPromise;
          bazaarPromise = null;
        }

        const result = await httpServer.processHTTPRequest(context, paywallConfig);

        switch (result.type) {
          case "no-payment-required":
            // A hook on the httpServer granted access — pass through.
            return;

          case "payment-error": {
            // Build the error response using the status code, headers, and body
            // provided by core.  Status is 402 for normal payment errors and 412
            // (Precondition Failed) for permit2_allowance_required cases.
            // Iteration over response.headers is always finite — it is a plain
            // Record<string, string> constructed by @x402/core, not user input.
            const { response } = result;
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              headers.set(key, value);
            }

            if (response.isHtml) {
              headers.set("content-type", "text/html; charset=utf-8");
              return new Response(response.body as string, {
                status: response.status,
                headers,
              });
            }

            headers.set("content-type", "application/json");
            return new Response(JSON.stringify(response.body ?? {}), {
              status: response.status,
              headers,
            });
          }

          case "payment-verified": {
            // Store verified payload so onAfterHandle can run settlement.
            // Also carry the HTTPRequestContext so it can be forwarded to
            // processSettlement as transportContext.request.
            ctx.x402PaymentContext.value = {
              paymentPayload: result.paymentPayload,
              paymentRequirements: result.paymentRequirements,
              declaredExtensions: result.declaredExtensions,
              context,
            };
            return; // pass through to the route handler
          }
        }
      })

      // ------------------------------------------------------------------
      // onAfterHandle: settle verified payments
      // ------------------------------------------------------------------
      .onAfterHandle({ as: "scoped" }, async (ctx) => {
        const paymentCtx = ctx.x402PaymentContext.value;

        // Only run settlement if a payment was verified in onBeforeHandle.
        // `paymentCtx` is null for unprotected routes and for requests that were
        // rejected with a 402 in onBeforeHandle (those never reach here because
        // Elysia stops the lifecycle on a returned Response from onBeforeHandle).
        if (!paymentCtx) return;

        // Do not charge the client when the route handler itself returned an error.
        // Two shapes to check:
        //   • `Response` object  — handler returned `new Response(...)` directly.
        //   • `{ code, response }` — Elysia's internal wrapper produced by the
        //     `error()` / `status()` helpers (e.g. `error(404, "Not found")`).
        // Any status >= 400 in either form skips settlement.
        const r = ctx.response;
        if (r instanceof Response && r.status >= 400) return;
        if (
          r !== null &&
          typeof r === "object" &&
          "code" in r &&
          typeof (r as { code: unknown }).code === "number" &&
          (r as { code: number }).code >= 400
        )
          return;

        // Serialise the response body into a Buffer for processSettlement's
        // transportContext.  This allows core and extensions to inspect the response body when needed
        // that extensions such as Bazaar that inspect the response body (e.g.
        // for receipt generation) work correctly across all adapters.
        // The serialisation covers four possible handler return shapes in Elysia:
        let responseBody: Buffer;
        if (r instanceof Response) {
          // Web-standard Response — clone before consuming the body stream so
          // Elysia can still serialise the original to the client.
          responseBody = Buffer.from(await r.clone().arrayBuffer());
        } else if (typeof r === "string") {
          responseBody = Buffer.from(r);
        } else if (r !== null && r !== undefined && typeof r === "object") {
          responseBody = Buffer.from(JSON.stringify(r));
        } else {
          // null, undefined, or a primitive other than string
          responseBody = Buffer.alloc(0);
        }

        try {
          // @x402/core v2.4.0 only declares a 3-param overload for processSettlement.
          // The 4th `transportContext` arg (carrying the request context and the
          // serialised response body) was added in an upcoming release — see
          // method to include the extra param while preserving the return type so
          // the call-site remains fully typed.
          //
          // `.bind(httpServer)` is required: extracting a class method as a value
          // loses its `this` binding; calling it unbound causes a runtime crash
          // ("undefined is not an object (evaluating 'this.ResourceServer')").
          //
          // TODO: remove this cast once @x402/core exports the updated signature.
          type _Settle = Awaited<ReturnType<typeof httpServer.processSettlement>>;
          const settle = httpServer.processSettlement.bind(httpServer) as (
            payload: PaymentPayload,
            requirements: PaymentRequirements,
            extensions?: Record<string, unknown>,
            transportContext?: { request: HTTPRequestContext; responseBody: Buffer },
          ) => Promise<_Settle>;

          const settleResult = await settle(
            paymentCtx.paymentPayload,
            paymentCtx.paymentRequirements,
            paymentCtx.declaredExtensions,
            { request: paymentCtx.context, responseBody },
          );

          if (!settleResult.success) {
            // Settlement failed — replace the response with a 402.
            // SECURITY: the protected resource body must NOT be revealed to the
            // client when settlement fails.  By returning a new Response here we
            // discard ctx.response entirely, ensuring the protected content is
            // never sent even if Elysia has already serialised the handler result.
            return new Response(
              JSON.stringify({
                error: "Settlement failed",
                details: settleResult.errorReason,
              }),
              {
                status: 402,
                headers: { "content-type": "application/json" },
              },
            );
          }

          // Settlement confirmed — inject the PAYMENT-RESPONSE header via
          // `ctx.set.headers` so Elysia merges it into the outgoing response
          // regardless of what shape the handler returned (plain object, string,
          // or a Response instance).  Iteration over settleResult.headers is safe
          // — it is a finite Record<string, string> from the facilitator.
          for (const [key, value] of Object.entries(settleResult.headers)) {
            ctx.set.headers[key] = value;
          }
        } catch (err: unknown) {
          // Treat any unexpected settlement error as a payment failure.
          // Log it server-side but never expose internal details to the client.
          // SECURITY: same as the !success path — return 402 without the
          // protected body.
          const message = err instanceof Error ? err.message : "Unknown error";
          console.error("[x402-elysia] Settlement error:", err);
          return new Response(
            JSON.stringify({ error: "Settlement failed", details: message }),
            {
              status: 402,
              headers: { "content-type": "application/json" },
            },
          );
        }
      })
  ) as unknown as Elysia;
}

// ---------------------------------------------------------------------------
// Mid-level factory: takes a pre-configured x402ResourceServer + routes
// ---------------------------------------------------------------------------

/**
 * Mid-level factory: creates an Elysia x402 payment plugin from a pre-configured
 * `x402ResourceServer` and route definitions.
 *
 * Use this when you need direct control over the `x402ResourceServer` — for example,
 * to register custom scheme implementations or reuse a server instance across multiple
 * frameworks.
 *
 * @param routes                  Route-to-payment-requirements mapping
 * @param server                  Pre-configured `x402ResourceServer`
 * @param paywallConfig           Optional paywall display config (app name, logo URL, etc.)
 * @param paywall                 Optional custom paywall HTML provider
 * @param syncFacilitatorOnStart  When `true` (default), eagerly fetches facilitator
 *                                capabilities at startup.
 *
 * @example
 * ```ts
 * import { Elysia } from "elysia";
 * import { x402ResourceServer } from "@x402/core/server";
 * import { paymentMiddleware } from "@x402/elysia";
 *
 * const server = new x402ResourceServer(facilitatorClient)
 *   .register("eip155:84532", new ExactEvmScheme());
 *
 * const app = new Elysia()
 *   .use(paymentMiddleware(
 *     { "GET /api/weather": { accepts: { scheme: "exact", network: "eip155:84532", payTo: "0x...", price: "$0.01" } } },
 *     server,
 *   ))
 *   .get("/api/weather", () => ({ temp: 72 }));
 * ```
 */
export function paymentMiddleware(
  routes: RoutesConfig,
  server: x402ResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart = true,
): Elysia {
  const httpServer = new x402HTTPResourceServer(server, routes);
  return paymentMiddlewareFromHTTPServer(httpServer, paywallConfig, paywall, syncFacilitatorOnStart);
}

// ---------------------------------------------------------------------------
// High-level convenience factory: builds everything from config
// ---------------------------------------------------------------------------

/**
 * The simplest way to add x402 payment protection to an Elysia app.
 * Builds the full `x402ResourceServer` stack internally from a facilitator client
 * and optional scheme registrations.
 *
 * For most applications this is the only factory you need. Use `paymentMiddleware`
 * instead when you need to share a pre-built `x402ResourceServer` across multiple
 * frameworks, or `paymentMiddlewareFromHTTPServer` for maximum control.
 *
 * @param routes                  Route-to-payment-requirements mapping
 * @param facilitatorClients      One or more facilitator clients (e.g. `HTTPFacilitatorClient`)
 * @param schemes                 Optional scheme-network server registrations
 * @param paywallConfig           Optional paywall display config
 * @param paywall                 Optional custom paywall HTML provider
 * @param syncFacilitatorOnStart  When `true` (default), eagerly fetches facilitator
 *                                capabilities at startup.
 *
 * @example
 * ```ts
 * import { Elysia } from "elysia";
 * import { HTTPFacilitatorClient } from "@x402/elysia";
 * import { paymentMiddlewareFromConfig } from "@x402/elysia";
 *
 * const app = new Elysia()
 *   .use(paymentMiddlewareFromConfig(
 *     {
 *       "GET /api/weather": {
 *         accepts: {
 *           scheme: "exact",
 *           network: "eip155:84532",
 *           payTo: "0xYourAddress",
 *           price: "$0.001",
 *         },
 *         description: "Current weather data",
 *         mimeType: "application/json",
 *       },
 *     },
 *     new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" }),
 *   ))
 *   .get("/api/weather", () => ({ temp: 72, unit: "F" }))
 *   .listen(3000);
 * ```
 */
export function paymentMiddlewareFromConfig(
  routes: RoutesConfig,
  facilitatorClients?: FacilitatorClient | FacilitatorClient[],
  schemes?: SchemeRegistration[],
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart = true,
): Elysia {
  const resourceServer = new x402ResourceServer(facilitatorClients);
  if (schemes) {
    for (const { network, server } of schemes) {
      resourceServer.register(network, server);
    }
  }
  return paymentMiddleware(routes, resourceServer, paywallConfig, paywall, syncFacilitatorOnStart);
}

// ---------------------------------------------------------------------------
// Re-exports: expose core types so consumers don't need @x402/core directly
// ---------------------------------------------------------------------------

export {
  x402ResourceServer,
  x402HTTPResourceServer,
  HTTPFacilitatorClient,
  RouteConfigurationError,
  type FacilitatorClient,
  type PaywallConfig,
  type PaywallProvider,
  type RouteConfig,
  type RoutesConfig,
  type RouteValidationError,
  type UnpaidResponseBody,
  type ProcessSettleResultResponse,
} from "@x402/core/server";

export type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";

export { ElysiaAdapter } from "./adapter";
