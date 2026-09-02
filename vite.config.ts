// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import type { Connect, Plugin } from "vite";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { getCloneBase } from "./src/lib/clone.server.ts";

/**
 * Frameworks resolve their runtime assets — offscreen-canvas workers, module
 * entry scripts, chunk CSS/media — against the document origin (or location.origin)
 * as root-relative paths. A clone served from a local origin would 404 on
 * those, and cross-origin module scripts are CORS-blocked by the source, so
 * every asset-like path is proxied to the cloned site's origin. The clone's
 * HTML therefore needs NO <base href>: scripts, styles, workers and the film's
 * /vortex/* image set all load same-origin and boot feature-identical.
 */
const APP_PATHS = ["/api/", "/@", "/src/", "/node_modules/", "/favicon", "/__"];
const FRAMEWORK_PREFIXES = [
  "/_next/",
  "/_nuxt/",
  "/vortex/",
  "/_astro/",
  "/_sveltekit/",
  "/_remix/",
  "/_gatsby/",
  "/_nuxt_icons/",
  "/images/",
  "/static/",
  "/media/",
  "/fonts/",
  "/icons/",
  "/svg/",
];

// Rewrite any absolute URL in an HLS playlist (variants, segments, init maps,
// keys) to a /_cloneproxy/<host>/<path> route so every resource goes through
// the server proxy, which re-fetches it WITH the source Referer (Mux/Fastly
// reject referer-gated streams otherwise).
const M3U8_URL_RE = /https:\/\/([a-zA-Z0-9.-]+\/)/g;

// The site's runtime data backend. Sanity's apicdn sends no
// Access-Control-Allow-Origin, so the app's cross-origin fetch() to it is
// CORS-blocked from a clone origin. Rewriting its URLs to /_cloneproxy/ lets
// the server re-fetch (no CORS server-side) and the browser sees same-origin.
// Applies to proxied JS/JSON/CSS bodies, not the document HTML.
const SANITY_RE = /https:\/\/([a-z0-9-]+\.(?:apicdn|cdn)\.sanity\.io)\//g;

const TEXT_RE =
  /(?:javascript|json|css|html|xml|text|mpegurl|m3u8)/i;

// Hosts whose upstream fetch already failed — log the first failure only so
// preloading dozens of dead media doesn't flood the console.
const loggedProxyHosts = new Set<string>();

/**
 * Upstream fetch with a couple of quick retries: a transient failure (DNS
 * blip, flaky CDN edge) must not 502 the browser's request and break the
 * cloned app's runtime script/asset loading. Unreachable hosts still fail
 * fast because each attempt is bounded by the AbortSignal timeout.
 */
async function proxyFetch(target: URL, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(target, init);
      if (res.ok || res.status < 500) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function readBody(req: Connect.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.alloc(0)));
  });
}

function rewriteText(text: string, ct: string) {
  if (/mpegurl|m3u8/i.test(ct)) {
    return text.replace(M3U8_URL_RE, "/_cloneproxy/$1");
  }
  return text.replace(SANITY_RE, "/_cloneproxy/$1/");
}

function shouldProxy(url: string) {
  // The clone page is served from the same local origin as the cloner UI, and
  // SPA backends fetch their OWN routes with same-origin mode to get JSON+body
  // (e.g. Zajno fetches "/?device=d", "/studio?device=d"). Only the cloner's
  // own paths are served locally; everything else is proxied to the source.
  if (url.startsWith("/_cloneproxy/")) return true;
  if (url === "/") return false;
  if (url.startsWith("/?preview=")) return false;
  if (url.startsWith("/_serverFn")) return false;
  if (APP_PATHS.some((p) => url.startsWith(p))) return false;
  if (FRAMEWORK_PREFIXES.some((p) => url.startsWith(p))) return true;
  return true;
}

function cloneNextAssetProxy(): Plugin {
  const proxy: Connect.NextHandleFunction = (req, res, next) => {
    const base = getCloneBase();
    if (!base) return next();
    const url = req.url ?? "/";
    if (!shouldProxy(url)) return next();
    let target: URL;
    if (url.startsWith("/_cloneproxy/")) {
      // /_cloneproxy/<host>/<path?query> -> https://<host>/<path?query>
      target = new URL(`https://${url.slice("/_cloneproxy/".length)}`);
    } else {
      target = new URL(url, base);
    }
    const method = (req.method ?? "GET").toUpperCase();
    if (method === "OPTIONS") {
      // Same-origin requests don't preflight, but answer anyway.
      res.statusCode = 204;
      res.end();
      return;
    }
    readBody(req).then((body) => {
      const headers: Record<string, string> = { "user-agent": req.headers["user-agent"] ?? "" };
      if (method !== "GET" && method !== "HEAD") {
        // Forward the request body + content headers so API calls (e.g. Sanity
        // GraphQL POST) reach the backend intact.
        if (req.headers["content-type"]) headers["content-type"] = String(req.headers["content-type"]);
        if (req.headers["accept"]) headers["accept"] = String(req.headers["accept"]);
      }
      if (url.startsWith("/_cloneproxy/")) {
        // Mux/Fastly gate their streams on the Referer; server-side we can send
        // the cloned site's origin so signed/token URLs are accepted.
        try {
          headers["referer"] = `${new URL(base).origin}/`;
        } catch {
          /* keep */
        }
      }
      const init: RequestInit = { method, headers };
      if (method !== "GET" && method !== "HEAD" && body.length) init.body = body as unknown as BodyInit;
      // Cap the upstream fetch so unreachable hosts (blocked CDNs, dead links)
      // fail FAST instead of hanging the browser (a site loader waiting on a
      // media element has no timeout of its own).
      if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
        init.signal = (AbortSignal as any).timeout(6_000);
      }
      proxyFetch(target, init)
        .then(async (up) => {
          res.statusCode = up.status;
          const ct = up.headers.get("content-type") ?? "";
          if (ct) res.setHeader("content-type", ct);
          // NOTE: fetch() auto-decompresses br/gzip bodies but leaves the
          // upstream content-length at the COMPRESSED size. Forwarding it would
          // truncate scripts/styles in the browser (e.g. Nuxt chunks → "Unexpected
          // end of input"), so let Node use chunked transfer instead.
          if (up.body) {
            const reader = up.body.getReader();
            if (TEXT_RE.test(ct)) {
              let text = "";
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                text += Buffer.from(value).toString("utf8");
              }
              res.write(Buffer.from(rewriteText(text, ct)));
            } else {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
              }
            }
            res.end();
          } else {
            res.end();
          }
        })
        .catch((err) => {
          // Expected for media on unreachable hosts (e.g. Vimeo behind a broken
          // MITM certificate) — log once per host so the console isn't spammed
          // by a site preloading a dozen dead videos.
          let host = "unknown";
          try {
            host = new URL(target).hostname;
          } catch {
            /* keep */
          }
          if (!loggedProxyHosts.has(host)) {
            loggedProxyHosts.add(host);
            console.error(`[clone-proxy] failed to fetch asset (${host}):`, (err as Error)?.message ?? err);
          }
          res.statusCode = 502;
          res.end();
        });
    });
  };
  return {
    name: "clone-next-asset-proxy",
    configureServer(server) {
      // Root mount so all clone-resolved asset paths (/_next/*, /_nuxt/*,
      // /vortex/*, …) are proxied. App/UI paths are skipped in shouldProxy.
      server.middlewares.use(proxy);
    },
  };
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [cloneNextAssetProxy()],
    // Favicon configuration
    resolve: {
      alias: {
        '@icon': '/favicon.ico',
      },
    },
  },
});
