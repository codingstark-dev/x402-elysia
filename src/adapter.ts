import type { HTTPAdapter } from "@x402/core/server";
import type { Context } from "elysia";

/**
 * Adapts an Elysia `Context` into the framework-agnostic `HTTPAdapter` interface
 * that `x402HTTPResourceServer` from `@x402/core` consumes.
 *
 * Elysia pre-reads the request body into `ctx.body` before any lifecycle hook runs,
 * so we read the parsed body from there rather than from `ctx.request` (which is
 * already consumed). All other request data comes from the Web-standard `Request`
 * object on `ctx.request`.
 *
 * We only surface the body when the request Content-Type indicates JSON. For other
 * content types (text/plain, form-data, etc.) `getBody()` returns `undefined` so
 * that x402 core treats the body as absent, which is the correct behaviour — the
 * x402 protocol communicates payment information via headers, not the request body.
 */
export class ElysiaAdapter implements HTTPAdapter {
  private readonly request: Request;
  private readonly parsedBody: unknown;
  private _url: URL | null = null;

  constructor(ctx: Context) {
    this.request = ctx.request;
    // Only expose the body when the request is JSON — x402 doesn't use other
    // content-type bodies, and returning raw text/form data would be misleading.
    const contentType = ctx.request.headers.get("content-type") ?? "";
    this.parsedBody = contentType.includes("application/json")
      ? (ctx as { body?: unknown }).body
      : undefined;
  }

  /** Lazily parsed URL — avoids creating multiple URL objects per request. */
  private get url(): URL {
    return (this._url ??= new URL(this.request.url));
  }

  /** Case-insensitive header read (Headers API is case-insensitive by spec). */
  getHeader(name: string): string | undefined {
    return this.request.headers.get(name) ?? undefined;
  }

  /** Returns the HTTP method in upper-case (e.g. `"GET"`, `"POST"`). */
  getMethod(): string {
    return this.request.method;
  }

  /** Returns the URL path without query string (e.g. `"/api/weather"`). */
  getPath(): string {
    return this.url.pathname;
  }

  /** Returns the full request URL including scheme, host, path, and query string. */
  getUrl(): string {
    return this.request.url;
  }

  /** Used by x402 core to detect browser requests (decides paywall HTML vs JSON). */
  getAcceptHeader(): string {
    return this.request.headers.get("accept") ?? "";
  }

  /** Returns the `User-Agent` header value, or an empty string if absent. */
  getUserAgent(): string {
    return this.request.headers.get("user-agent") ?? "";
  }

  /**
   * Returns all query parameters as a flat record.
   * Parameters that appear more than once are collected into a string array;
   * single-occurrence parameters are returned as a plain string.
   *
   * Iteration over `URLSearchParams` is always finite — the set of keys is
   * bounded by the URL length, which is capped by the HTTP server.
   */
  getQueryParams(): Record<string, string | string[]> {
    const params = this.url.searchParams;
    const result: Record<string, string | string[]> = {};
    for (const key of params.keys()) {
      const values = params.getAll(key);
      result[key] = values.length === 1 ? (values[0] as string) : values;
    }
    return result;
  }

  /**
   * Returns the value(s) for a single named query parameter.
   * - Returns `undefined` when the parameter is absent.
   * - Returns a `string` when the parameter appears exactly once.
   * - Returns `string[]` when the parameter appears more than once
   *   (e.g. `?tag=a&tag=b` → `["a", "b"]`).
   */
  getQueryParam(name: string): string | string[] | undefined {
    const params = this.url.searchParams;
    const values = params.getAll(name);
    if (values.length === 0) return undefined;
    return values.length === 1 ? (values[0] as string) : values;
  }

  /**
   * Returns the pre-parsed body from Elysia's context.
   *
   * Elysia reads and parses the request body (JSON, form-data, etc.) before any
   * lifecycle hooks run and stores it in `ctx.body`. The raw `ctx.request` body
   * stream is already consumed at that point, so we read from `ctx.body` instead.
   *
   * Returns `undefined` if no body was sent or if Elysia could not parse it.
   */
  getBody(): unknown {
    return this.parsedBody;
  }
}
