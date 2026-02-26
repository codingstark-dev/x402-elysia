# @codingstark/x402-elysia

[ElysiaJS](https://elysiajs.com/) plugin for the [x402 Payment Protocol](https://www.x402.org/). Protect any route behind a crypto micropayment with a single `.use()` call.

## Installation

```bash
bun add @codingstark/x402-elysia
# or
npm install @codingstark/x402-elysia
# or
pnpm add @codingstark/x402-elysia
```

Peer dependency: `elysia >= 1.0.0`

## Quick Start

```typescript
import { Elysia } from "elysia";
import { paymentMiddlewareFromConfig } from "@codingstark/x402-elysia";

const app = new Elysia()
  .use(
    paymentMiddlewareFromConfig(
      {
        "GET /api/weather": {
          accepts: {
            scheme: "exact",
            price: "$0.001",
            network: "eip155:84532",   // Base Sepolia testnet
            payTo: "0xYourAddress",
          },
          description: "Current weather data",
          mimeType: "application/json",
        },
      },
      // Uses the public Coinbase facilitator by default when omitted, or pass one explicitly:
      // new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" }),
    ),
  )
  .get("/api/weather", () => ({ temp: 72, unit: "F" }))
  .listen(3000);
```

When a client hits `GET /api/weather` without a valid payment header they receive a `402 Payment Required` response describing exactly what to pay. Once their wallet submits the on-chain payment, the request goes through and the route handler runs.

## API Reference

The package exports three factory functions at increasing levels of abstraction.

---

### `paymentMiddlewareFromConfig` (recommended)

The simplest way to add x402 protection. Builds the full server stack internally.

```typescript
import { paymentMiddlewareFromConfig, HTTPFacilitatorClient } from "@codingstark/x402-elysia";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const app = new Elysia()
  .use(
    paymentMiddlewareFromConfig(
      routes,                 // RoutesConfig — required
      facilitatorClients,     // FacilitatorClient | FacilitatorClient[] — optional
      schemes,                // SchemeRegistration[] — optional
      paywallConfig,          // PaywallConfig — optional
      paywall,                // PaywallProvider — optional
      syncFacilitatorOnStart, // boolean — default: true
    ),
  );
```

#### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `routes` | `RoutesConfig` | Yes | Route payment configurations |
| `facilitatorClients` | `FacilitatorClient \| FacilitatorClient[]` | No | Facilitator client(s). If omitted the x402ResourceServer default is used. |
| `schemes` | `SchemeRegistration[]` | No | Additional scheme+network registrations. EVM exact is registered automatically. |
| `paywallConfig` | `PaywallConfig` | No | Paywall UI options (app name, logo, testnet flag) |
| `paywall` | `PaywallProvider` | No | Custom paywall HTML provider |
| `syncFacilitatorOnStart` | `boolean` | No | Eagerly sync facilitator capabilities on startup (default: `true`) |

---

### `paymentMiddleware`

Mid-level factory. Accepts a pre-configured `x402ResourceServer`.

```typescript
import { Elysia } from "elysia";
import { x402ResourceServer, paymentMiddleware, HTTPFacilitatorClient } from "@codingstark/x402-elysia";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const facilitator = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const resourceServer = new x402ResourceServer(facilitator)
  .register("eip155:84532", new ExactEvmScheme());

const app = new Elysia()
  .use(
    paymentMiddleware(
      routes,                 // RoutesConfig — required
      resourceServer,         // x402ResourceServer — required
      paywallConfig,          // PaywallConfig — optional
      paywall,                // PaywallProvider — optional
      syncFacilitatorOnStart, // boolean — default: true
    ),
  );
```

---

### `paymentMiddlewareFromHTTPServer`

Low-level factory. Accepts a fully constructed `x402HTTPResourceServer`.

```typescript
import { x402HTTPResourceServer, paymentMiddlewareFromHTTPServer } from "@codingstark/x402-elysia";

const httpServer = new x402HTTPResourceServer(resourceServer, routes);

const app = new Elysia()
  .use(
    paymentMiddlewareFromHTTPServer(
      httpServer,             // x402HTTPResourceServer — required
      paywallConfig,          // PaywallConfig — optional
      paywall,                // PaywallProvider — optional
      syncFacilitatorOnStart, // boolean — default: true
    ),
  );
```

---

## Route Configuration

Routes are defined as a `RoutesConfig` object whose keys are `"METHOD /path"` strings.

```typescript
import type { RoutesConfig } from "@codingstark/x402-elysia";

const routes: RoutesConfig = {
  "GET /api/data": {
    accepts: {
      scheme: "exact",
      price: "$0.01",
      network: "eip155:84532",
      payTo: "0xYourAddress",
      maxTimeoutSeconds: 300,
    },
    description: "Premium data access",
    mimeType: "application/json",
  },
};
```

### `RouteConfig` fields

| Field | Type | Description |
|---|---|---|
| `accepts` | `PaymentRequirements \| PaymentRequirements[]` | One or more accepted payment options |
| `description` | `string` | Human-readable description shown in the paywall |
| `mimeType` | `string` | MIME type of the protected resource |
| `maxDeadlineSeconds` | `number` | Max clock skew tolerance in seconds |
| `extensions` | `Record<string, unknown>` | Extension data (e.g. `bazaar`) |

### `PaymentRequirements` fields

| Field | Type | Description |
|---|---|---|
| `scheme` | `string` | Payment scheme, e.g. `"exact"` |
| `network` | `Network` | CAIP-2 network ID, e.g. `"eip155:84532"` |
| `payTo` | `string` | Address to receive payment |
| `price` | `string` | Amount in USD, e.g. `"$0.01"`, or raw token amount |
| `maxTimeoutSeconds` | `number` | (optional) Payment validity window |

---

## Multiple Protected Routes

```typescript
const app = new Elysia()
  .use(
    paymentMiddlewareFromConfig({
      "GET /api/premium/*": {
        accepts: {
          scheme: "exact",
          price: "$1.00",
          network: "eip155:8453",   // Base mainnet
          payTo: "0xYourAddress",
        },
        description: "Premium API access",
      },
      "POST /api/generate": {
        accepts: {
          scheme: "exact",
          price: "$0.05",
          network: "eip155:8453",
          payTo: "0xYourAddress",
          maxTimeoutSeconds: 120,
        },
        description: "AI generation endpoint",
      },
    }),
  );
```

## Multiple Payment Networks

Accept payment on multiple chains simultaneously by providing an array of `accepts` entries and registering each scheme:

```typescript
import { paymentMiddleware, x402ResourceServer, HTTPFacilitatorClient } from "@codingstark/x402-elysia";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";

const facilitator = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const resourceServer = new x402ResourceServer(facilitator)
  .register("eip155:84532", new ExactEvmScheme())
  .register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmScheme());

const app = new Elysia()
  .use(
    paymentMiddleware(
      {
        "GET /api/weather": {
          accepts: [
            {
              scheme: "exact",
              price: "$0.001",
              network: "eip155:84532",
              payTo: "0xEvmAddress",
            },
            {
              scheme: "exact",
              price: "$0.001",
              network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
              payTo: "SolanaAddress",
            },
          ],
          description: "Weather data",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  )
  .get("/api/weather", () => ({ temp: 72, unit: "F" }))
  .listen(3000);
```

## Paywall Configuration

When a browser requests a protected endpoint the middleware returns an HTML paywall page instead of a raw JSON 402 response.

### Full Paywall UI (Recommended)

Install the optional `@x402/paywall` package for a complete wallet-connect and payment UI:

```bash
bun add @x402/paywall
```

Then pass a `PaywallConfig`:

```typescript
import type { PaywallConfig } from "@codingstark/x402-elysia";

const paywallConfig: PaywallConfig = {
  appName: "My App",
  appLogo: "https://example.com/logo.svg",
  testnet: true, // show testnet badge
};

app.use(paymentMiddlewareFromConfig(routes, undefined, undefined, paywallConfig));
```

### Basic Paywall (No Extra Install)

Without `@x402/paywall` installed the middleware falls back to a minimal HTML page with payment instructions.

### Custom Paywall Provider

```typescript
import type { PaywallProvider } from "@codingstark/x402-elysia";

const myPaywall: PaywallProvider = async (requirements, config) => {
  return `<html>...your custom HTML...</html>`;
};

app.use(paymentMiddlewareFromConfig(routes, undefined, undefined, paywallConfig, myPaywall));
```

## Custom Facilitator Client

```typescript
import { HTTPFacilitatorClient } from "@codingstark/x402-elysia";

const customFacilitator = new HTTPFacilitatorClient({
  url: "https://your-facilitator.example.com",
  createAuthHeaders: async () => ({
    verify: { Authorization: "Bearer your-token" },
    settle: { Authorization: "Bearer your-token" },
  }),
});

app.use(paymentMiddlewareFromConfig(routes, customFacilitator));
```

## Advanced: `onProtectedRequest` Hook

Register a hook on the `x402HTTPResourceServer` to run before payment processing on every protected route request. The hook can:

- **Pass through** (return `void`) — continue to normal payment processing
- **Grant access** (return `{ grantAccess: true }`) — allow the request without requiring payment
- **Abort** (return `{ abort: true; reason: string }`) — deny the request (returns 403)

```typescript
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  paymentMiddlewareFromHTTPServer,
  type ProtectedRequestHook,
} from "@codingstark/x402-elysia";

const hook: ProtectedRequestHook = async (context, routeConfig) => {
  const apiKey = context.adapter.getHeader("x-api-key");

  // Grant access unconditionally for internal requests
  if (apiKey === process.env.INTERNAL_API_KEY) {
    return { grantAccess: true };
  }

  // Block requests from certain paths
  if (context.path.startsWith("/api/restricted")) {
    return { abort: true, reason: "Access denied" };
  }

  // Otherwise continue to normal payment flow (return void)
};

const httpServer = new x402HTTPResourceServer(resourceServer, routes);
httpServer.onProtectedRequest(hook);

app.use(paymentMiddlewareFromHTTPServer(httpServer));
```

## `ElysiaAdapter`

The `ElysiaAdapter` class adapts an Elysia `Context` into the framework-agnostic `HTTPAdapter` interface consumed by `@x402/core`. It is exported for testing and advanced use cases.

```typescript
import { ElysiaAdapter } from "@codingstark/x402-elysia";

// In tests or custom plugins:
const adapter = new ElysiaAdapter(ctx);
adapter.getMethod();      // "GET"
adapter.getPath();        // "/api/weather"
adapter.getUrl();         // "http://localhost:3000/api/weather"
adapter.getHeader("x-payment"); // payment header value or undefined
adapter.getBody();        // parsed JSON body (application/json only) or undefined
adapter.getQueryParam("key");   // "value" | string[] | undefined
adapter.getQueryParams();       // Record<string, string | string[]>
```

## How It Works

1. **`onBeforeHandle`** — For every incoming request the plugin checks whether the route is protected. If not, it passes through immediately. If it is protected it calls `processHTTPRequest` from `@x402/core`, which:
   - Returns `payment-error` (status `402` or `412`) if no valid payment header is present — the response is returned immediately to the client.
   - Returns `payment-verified` if the header is valid — the verified payment payload is stored in a per-request context slot.

2. **`onAfterHandle`** — If a payment was verified and the route handler succeeded, settlement is run against the facilitator. On success the `PAYMENT-RESPONSE` header is injected into the response. On failure a `402` replaces the response (protecting the resource body).

## Exported Types

```typescript
import type {
  // Route config
  RoutesConfig,
  RouteConfig,

  // Payment
  PaymentRequirements,
  PaymentPayload,
  PaymentRequired,
  Price,
  UnpaidResponseBody,
  ProcessSettleResultResponse,

  // Dynamic route config helpers
  DynamicPayTo,      // (context: HTTPRequestContext) => string | Promise<string>
  DynamicPrice,      // (context: HTTPRequestContext) => Price | Promise<Price>

  // Hooks
  ProtectedRequestHook,  // runs before payment processing on protected routes

  // Server / facilitator
  FacilitatorClient,
  SchemeNetworkServer,

  // Paywall
  PaywallConfig,
  PaywallProvider,

  // Network
  Network,

  // Plugin-specific
  SchemeRegistration,
} from "@codingstark/x402-elysia";
```

## Build with Bunup

This package is built with [Bunup](https://bunup.dev/) using `bunup.config.ts`.

```bash
bun install
bun run build
```

Build outputs:

- ESM: `dist/esm/index.mjs` + `dist/esm/index.d.mts`
- CJS: `dist/cjs/index.js` + `dist/cjs/index.d.ts`

## Publish to npm

1. Ensure you are logged in:

```bash
bunx npm whoami
```

2. Run quality checks:

```bash
bun run test
bun run typecheck
bun run build
```

3. Bump version:

```bash
npm version patch
# or: npm version minor / npm version major
```

4. Publish:

```bash
bun publish --access public
```

5. Verify install:

```bash
bun add @codingstark/x402-elysia
```

## Native Elysia Plugin Wrapper Example

You can wrap x402 middleware inside your own Elysia native plugin and reuse it across apps.

```typescript
import { Elysia } from "elysia";
import {
  paymentMiddlewareFromConfig,
  type RoutesConfig,
  type PaywallConfig,
} from "@codingstark/x402-elysia";

type X402PluginOptions = {
  routes: RoutesConfig;
  paywall?: PaywallConfig;
};

export function x402NativePlugin({ routes, paywall }: X402PluginOptions) {
  return new Elysia({ name: "x402-native-plugin" }).use(
    paymentMiddlewareFromConfig(routes, undefined, undefined, paywall),
  );
}

const app = new Elysia()
  .use(
    x402NativePlugin({
      routes: {
        "GET /premium/weather": {
          accepts: {
            scheme: "exact",
            price: "$0.001",
            network: "eip155:84532",
            payTo: "0xYourAddress",
          },
          description: "Premium weather API",
          mimeType: "application/json",
        },
      },
      paywall: {
        appName: "My Premium API",
        testnet: true,
      },
    }),
  )
  .get("/premium/weather", () => ({ temp: 72, unit: "F" }))
  .listen(3000);
```

See a runnable file at `examples/native-plugin/server.ts`.

## License

MIT
