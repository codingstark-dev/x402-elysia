import { Elysia } from "elysia";
import {
  paymentMiddlewareFromConfig,
  type PaywallConfig,
  type RoutesConfig,
} from "@codingstark/x402-elysia";

type X402PluginOptions = {
  routes: RoutesConfig;
  paywall?: PaywallConfig;
};

function x402NativePlugin({ routes, paywall }: X402PluginOptions) {
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
            payTo: process.env.PAY_TO ?? "0xYourAddress",
          },
          description: "Premium weather endpoint",
          mimeType: "application/json",
        },
      },
      paywall: {
        appName: "x402 Native Plugin Example",
        testnet: true,
      },
    }),
  )
  .get("/premium/weather", () => ({ temp: 72, unit: "F" }))
  .get("/health", () => ({ ok: true }))
  .listen(3000);

console.log(`x402 native plugin example listening on http://localhost:${app.server?.port ?? 3000}`);
