/**
 * Static site cloner: fetches a page, absolutizes URLs, inlines stylesheets and
 * PRESERVES the original scripts (GSAP, ScrollTrigger, Lenis, marquee, SVG draw,
 * parallax, …) so the cloned page animates exactly like the source.
 * No AI involved — pure fetch + rewrite.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Strip unusual Unicode line terminators that break HTML parsers and trigger
 * IDE warnings: Line Separator (U+2028) and Paragraph Separator (U+2029).
 * These are valid in JavaScript strings but invalid in HTML text content.
 */
function sanitizeLineTerminators(text: string): string {
  return text.replace(/[\u2028\u2029]/g, "\n");
}

function abs(url: string, base: string) {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/**
 * Third-party hosts whose resources are referer-gated (e.g. Mux video streams
 * return 403 unless the request carries the source site's Referer). Their
 * absolute URLs are rewritten to a local /_cloneproxy/<host>/<path> route so
 * the dev proxy / generated servers can re-fetch them server-side WITH the
 * correct Referer header. Kept as a small allow-list: rewriting every absolute
 * URL would break analytics, embeds and deep links.
 */
const PROXY_THIRD_PARTY = ["stream.mux.com", "image.mux.com", "player.vimeo.com"];

export { PROXY_THIRD_PARTY };

function toProxy(u: string) {
  for (const host of PROXY_THIRD_PARTY) {
    const prefix = `https://${host}/`;
    if (u.startsWith(prefix)) return `/_cloneproxy/${host}/${u.slice(prefix.length)}`;
  }
  return u;
}

/**
 * Rewrite an absolute http(s) URL to the local /_cloneproxy/<host>/<path> route.
 * Used for the site's own runtime scripts: module scripts are CORS-blocked
 * cross-origin when the source sends no ACAO header (S3/CloudFront etc.), and
 * a proxied script URL also keeps relative chunk imports on the local origin.
 */
function proxyUrl(u: string) {
  try {
    const p = new URL(u);
    if (p.protocol !== "https:" && p.protocol !== "http:") return u;
    return `/_cloneproxy/${p.host}${p.pathname}${p.search}${p.hash}`;
  } catch {
    return u;
  }
}

/**
 * Sanity's CDN/apicdn sends no Access-Control-Allow-Origin, so resources the
 * site loads WITH crossorigin (img/preload/Image/fetch/XHR) fail from a clone
 * origin. Routing .sanity.io URLs through /_cloneproxy/ makes those loads
 * same-origin. Plain <img> without crossorigin also keep working via the proxy.
 */
const SANITY_HOST_RE = /\.sanity\.io$/i;
function sanityProxy(u: string) {
  try {
    const p = new URL(u);
    if (p.protocol !== "https:" && p.protocol !== "http:") return u;
    if (SANITY_HOST_RE.test(p.hostname)) return `/_cloneproxy/${p.host}${p.pathname}${p.search}${p.hash}`;
  } catch {
    /* keep */
  }
  return u;
}

/** Rewrite referer-gated URLs inside inline JS/flight-payload string literals. */
function proxyCodeUrls(code: string) {
  let out = code;
  for (const host of PROXY_THIRD_PARTY) {
    out = out.split(`https://${host}/`).join(`/_cloneproxy/${host}/`);
  }
  return out;
}

function rewriteCss(css: string, base: string) {
  // First sanitize any unusual line terminators in CSS
  css = sanitizeLineTerminators(css);
  return css.replace(
    /url\(\s*(['"])(.*?)\1\s*\)|url\(\s*([^'")]+?)\s*\)/gi,
    (m, q: string, quoted: string, unquoted: string) => {
      const u = (q ? quoted : unquoted) ?? "";
      if (/^(data:|https?:|#)/i.test(u)) return m;
      return `url("${abs(u, base)}")`;
    },
  );
}

/** Skip responses that are actually HTML (anti-bot pages, error pages). */
function looksLikeHtml(text: string) {
  const head = text.trimStart().slice(0, 512);
  return /^<!doctype\s+html/i.test(head) || /^<html[\s>]/i.test(head);
}

function rewriteHtmlUrls(html: string, base: string) {
  let srcOrigin = "";
  try {
    srcOrigin = new URL(base).origin;
  } catch {
    /* keep empty */
  }

  // Absolute URLs on the source origin become same-origin relative paths so a
  // clone served on another host (dev proxy, vite, next, static <base href>)
  // resolves them against ITS origin instead of hard-coding the source. This is
  // what lets framework runtimes load their payload/manifest (Nuxt `_payload.json`
  // via `data-src`) and assets through the local proxy instead of CORS-blocked
  // cross-origin fetches.
  const toRel = (u: string) => {
    if (/^https?:/i.test(u) && srcOrigin) {
      try {
        const parsed = new URL(u);
        if (parsed.origin === srcOrigin) return parsed.pathname + parsed.search + parsed.hash;
      } catch {
        /* keep */
      }
    }
    return u;
  };

  html = html.replace(
    /\s(src|href|poster|data-src|data-srcset|srcset)\s*=\s*(['"])(.*?)\2/gi,
    (m, attr: string, q: string, val: string) => {
      const t = val.trim();
      if (/^(data:|mailto:|tel:|javascript:|#)/i.test(t)) return m;
      if (/srcset$/i.test(attr)) {
        // Split only on the candidate separator ", " — many CDNs (Sanity,
        // Next/Image) put commas INSIDE the URL query (e.g. ?rect=0,160,2000,1183),
        // so a naive comma split would truncate the URL and the CDN returns 400.
        const out = t
          .split(/,\s+/)
          .map((part) => {
            const trimmed = part.trim();
            if (!trimmed) return trimmed;
            const [u, ...rest] = trimmed.split(/\s+/);
            return [toRel(abs(u ?? "", base)), ...rest].join(" ");
          })
          .join(", ");
        return ` ${attr}="${out}"`;
      }
      if (/^https?:/i.test(t)) {
        const rel = toRel(t);
        if (rel !== t) return ` ${attr}="${rel}"`;
        const proxied = toProxy(t);
        if (proxied !== t) return ` ${attr}="${proxied}"`;
        const sp = sanityProxy(t);
        if (sp !== t) return ` ${attr}="${sp}"`;
        return m;
      }
      // Relative URLs stay relative: preview/vite/next resolve them against the
      // local origin (dev proxy), static resolves them via the <base href>.
      return ` ${attr}="${toRel(abs(t, base))}"`;
    },
  );
  // Absolutize url() inside inline style attributes (background-image etc.) so
  // the generated files don't depend on a <base href> to resolve them. Source-
  // origin absolute URLs are made relative so they route through the proxy too.
  return html.replace(/\sstyle\s*=\s*(['"])([\s\S]*?)\1/gi, (m, q: string, val: string) => {
    const out = val.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (mm, q2: string, u: string) => {
      const trimmed = u.trim();
      if (/^(data:|#)/i.test(trimmed)) return mm;
      const rewritten = /^https?:/i.test(trimmed) ? toRel(trimmed) : toRel(abs(trimmed, base));
      const finalUrl = sanityProxy(rewritten);
      return finalUrl === trimmed ? mm : `url("${finalUrl}")`;
    });
    return ` style=${q}${out}${q}`;
  });
}

async function fetchText(url: string, optional = false) {
  try {
    const res = await fetchRetry(url, { headers: { "user-agent": UA, accept: "*/*" } });
    if (!res.ok) {
      if (optional) return null;
      throw new Error(`HTTP ${res.status} saat mengambil ${url}`);
    }
    return sanitizeLineTerminators(await res.text());
  } catch (e) {
    if (optional) {
      console.warn(`[clone] optional fetch gagal: ${url}`, (e as Error).message);
      return null;
    }
    throw e;
  }
}

/**
 * Network fetch with a timeout + retries. The clone makes many upstream
 * fetches (HTML, stylesheets, fonts, scripts) and a single transient failure
 * (DNS blip, TLS hiccup, a flaky CDN edge) must not abort the whole clone —
 * retry a few times before giving up.
 * 
 * Strategi untuk bypass CORS/blocking:
 * 1. User-Agent rotation (Chrome, Firefox, Safari, Edge)
 * 2. Berbagai header kombinasi untuk terlihat legitimate
 * 3. Longer timeout untuk slow servers
 * 4. More aggressive retry (up to 5 attempts)
 */
async function fetchRetry(
  url: string,
  init: RequestInit = {},
  retries = 5,
  timeoutMs = 25_000,
): Promise<Response> {
  let lastErr: unknown;
  
  // Banyak User-Agents untuk bypass sophisticated bot detection
  const userAgents = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  ];
  
  // Multiple header combinations
  const headerSets = [
    {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "accept-encoding": "gzip, deflate, br",
      "dnt": "1",
    },
    {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "accept-language": "id-ID,id;q=0.9,en;q=0.8",
      "accept-encoding": "gzip, deflate",
    },
    {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9,id;q=0.8",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
    },
  ];
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const userAgent = userAgents[attempt % userAgents.length]!;
        const headerSet = headerSets[Math.floor(attempt / userAgents.length) % headerSets.length]!;
        
        const headers = {
          ...init.headers,
          "user-agent": userAgent,
          ...headerSet,
          "referer": new URL(url).origin + "/",
          "cache-control": "no-cache, no-store, must-revalidate",
          "pragma": "no-cache",
        } as Record<string, string>;
        
        console.log(`[clone] attempt ${attempt + 1}/${retries + 1}: ${userAgent.substring(0, 50)}...`);
        
        const res = await fetch(url, { 
          ...init, 
          headers,
          signal: ctrl.signal 
        });
        
        if (res.ok) {
          console.log(`[clone] ✅ berhasil fetch (HTTP ${res.status})`);
          return res;
        }
        
        console.log(`[clone] HTTP ${res.status} - retry...`);
        
        // Retry on 403 (forbidden), 429 (rate limit), 5xx
        if (res.status === 403 || res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}`);
          // Continue to next attempt
        } else {
          return res;
        }
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`[clone] attempt ${attempt + 1} gagal: ${msg}`);
      lastErr = e;
    }
    
    if (attempt < retries) {
      const delay = 300 * Math.pow(1.5, attempt); // 300ms, 450ms, 675ms, 1012ms, 1518ms
      console.log(`[clone] tunggu ${Math.round(delay)}ms sebelum retry...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Embed every @font-face font as a base64 data URI. On the live site the fonts
 * load same-origin; a clone served from another host (GitHub Pages, file://,
 * a different port) gets CORS-blocked and silently falls back to a system font,
 * visibly changing typography. Fetching them server-side and inlining as data
 * URIs makes the clone render fonts identically on any host.
 */
async function embedFonts(css: string): Promise<string> {
  const fontRe =
    /url\(\s*(['"]?)(https?:[^'")]+?\.(?:woff2?|ttf|otf|eot)(?:\?[^'")]*)?)\1\s*\)/gi;
  const matches = [...css.matchAll(fontRe)];
  if (!matches.length) return css;
  const cache = new Map<string, string>();
  for (const m of matches) {
    const url = m[2] ?? "";
    const clean = url.split(/[?#]/)[0] ?? url;
    try {
      let data: string | undefined = cache.get(clean);
      if (!data) {
        try {
          const res = await fetch(clean, { headers: { "user-agent": UA, accept: "*/*" } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const ext = clean.match(/\.(woff2|woff|ttf|otf|eot)$/i)?.[1] ?? "";
          const type =
            ext === "woff2" ? "font/woff2" : ext === "woff" ? "font/woff" : ext === "ttf" ? "font/ttf" : "font/otf";
          data = `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
          cache.set(clean, data);
        } catch (e) {
          console.warn(`[clone] font gagal diambil ${clean}:`, (e as Error).message);
          continue;
        }
      }
      css = css.replace(m[0], `url("${data}")`);
    } catch (e) {
      // Keep the remote URL — better a fallback font than a broken clone.
      console.warn(`[clone] error embed font:`, (e as Error).message);
    }
  }
  return css;
}

/** Follow one level of @import so component stylesheets aren't lost. */
async function inlineCssImports(css: string, base: string) {
  const importRe = /@import\s+(?:url\(\s*)?['"]?([^'")\s]+)['"]?\s*\)?\s*([^;]*);/gi;
  const found = [...css.matchAll(importRe)].slice(0, 50);
  for (const m of found) {
    const href = m[1];
    if (!href || href.startsWith("data:")) continue;
    const cssUrl = abs(href, base);
    try {
      const raw = await fetchText(cssUrl, true);
      if (!raw) continue;
      let child = rewriteCss(raw, cssUrl);
      // Keep the @import's media condition (e.g. `screen and (min-width: 768px)`)
      // so responsive rules don't leak to every breakpoint.
      const media = (m[2] ?? "").trim();
      if (media && !/^layer\b/i.test(media)) child = `@media ${media} {\n${child}\n}`;
      css = css.replace(m[0], `/* ${cssUrl} */\n${child}`);
    } catch {
      css = css.replace(m[0], "");
    }
  }
  return css;
}

/**
 * Only promote lazy image sources — we no longer strip animation attributes,
 * because the original scripts now run and need them.
 */
function unlazy(html: string) {
  return html.replace(
    /<(img|iframe|source|video)\b([^>]*)>/gi,
    (tag: string, name: string, attrs: string) => {
      let a = attrs;
      const pick = (re: RegExp) => a.match(re)?.[1];
      const lazySrc =
        pick(/\sdata-src\s*=\s*["']([^"']+)["']/i) ??
        pick(/\sdata-lazy-src\s*=\s*["']([^"']+)["']/i) ??
        pick(/\sdata-original\s*=\s*["']([^"']+)["']/i);
      const lazySet =
        pick(/\sdata-srcset\s*=\s*["']([^"']+)["']/i) ??
        pick(/\sdata-lazy-srcset\s*=\s*["']([^"']+)["']/i);
      if (lazySrc && !/\ssrc\s*=/.test(a)) a = `${a} src="${lazySrc}"`;
      if (lazySet && !/\ssrcset\s*=/.test(a)) a = `${a} srcset="${lazySet}"`;
      return `<${name}${a}>`;
    },
  );
}

/**
 * Remove full-screen overlay/mask elements that block all content.
 * Sites like griflan.com use a fixed black overlay (z-6666) that covers
 * everything until JavaScript runs the intro animation.
 */
function removeOverlays(html: string): string {
  // Remove fixed full-screen overlays with high z-index (masks, page transitions)
  // Pattern: div with position:fixed, inset:0, and high z-index or overlay classes
  html = html.replace(
    /<div[^>]*class="[^"]*(?:js-i-mask|js-t-mask|js-i-page-intro)[^"]*"[^>]*><\/div>/gi,
    "",
  );
  // Remove fixed overlays with z-index > 100 that cover the viewport
  html = html.replace(
    /<div[^>]*class="[^"]*(?:fixed\s+inset-0|inset-0\s+fixed)[^"]*(?:z-\[[\d]{4,}\]|z-\[100\]|z-\[101\]|z-50)[^"]*"[^>]*><\/div>/gi,
    "",
  );
  // Remove overlays with inline style opacity:0;visibility:hidden (page transition curtains)
  html = html.replace(
    /<div[^>]*style="[^"]*opacity:\s*0[^"]*visibility:\s*hidden[^"]*"[^>]*><\/div>/gi,
    "",
  );
  // Remove invisible overlays (Tailwind invisible class)
  html = html.replace(
    /<div[^>]*class="[^"]*(?:fixed\s+inset-0|inset-0\s+fixed)[^"]*(?:invisible|opacity-0)[^"]*"[^>]*><\/div>/gi,
    "",
  );
  // Remove full-screen overlays with high z-index that have both fixed+inset-0
  // even without specific class names (catches griflan z-[6666], z-[8888], etc.)
  html = html.replace(
    /<div[^>]*class="[^"]*fixed[^"]*inset-0[^"]*z-\[[\d]{3,}\][^"]*"[^>]*><\/div>/gi,
    "",
  );
  return html;
}

/** Minimal hygiene — force content visibility for cloned sites. */
const BASE_CSS = `
/* --- Site Cloner --- */
html, body { overflow-x: clip !important; }
`;

/**
 * Framework runtimes (Next.js, Nuxt, Astro, SvelteKit, Remix, …) are DETECTED
 * here but never dropped: the clones keep every original script so a real
 * browser (static preview, vite, nextjs) can boot the app itself. The flag is
 * used by the output builders to inject the history patch + <base href> and
 * skip the GSAP fallback layer.
 */
const FRAMEWORK_SCRIPT_RE =
  /\/(_next\/static|_nuxt\/|_astro\/|_sveltekit\/|_remix\/|_gatsby\/|_nuxt_icons\/)/i;
const FRAMEWORK_INLINE_RE =
  /self\.__next_f\.push|window\.__NUXT__|__NUXT_PAYLOAD__|window\.__remixContext|__astro_|_sveltekit/i;

function isFrameworkScript(s: CloneScript): boolean {
  if (s.src && FRAMEWORK_SCRIPT_RE.test(s.src)) return true;
  if (s.code && FRAMEWORK_INLINE_RE.test(s.code)) return true;
  return false;
}

export type CloneScript = {
  src?: string;
  code?: string;
  type?: string;
  module?: boolean;
  nomodule?: boolean;
  async?: boolean;
  defer?: boolean;
};

/** Extract every <script> in document order, keeping src and inline code. */
function extractScripts(html: string) {
  const scripts: CloneScript[] = [];
  const out = html.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>|<script\b([^>]*)\/>/gi,
    (_m, attrs = "", code = "", selfAttrs = "") => {
      const a: string = attrs || selfAttrs || "";
      const type = a.match(/\stype\s*=\s*["']([^"']+)["']/i)?.[1];
      // keep JSON-LD / templates in place, they are not executable
      if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type)) {
        return _m;
      }
      const src = a.match(/\ssrc\s*=\s*["']([^"']+)["']/i)?.[1];
      const module = /^module$/i.test(type ?? "") || /\stype\s*=\s*["']module["']/i.test(a);
      // Legacy polyfill / "update your browser" overlays ship as
      // <script nomodule>; dropping the attribute would let them run in modern
      // browsers and redeclare identifiers (e.g. Zajno's `var d` clashes with
      // the app head's `const d`).
      const nomodule = /\snomodule\b/i.test(a);
      const isAsync = /\sasync\b/i.test(a);
      const isDefer = /\sdefer\b/i.test(a);
      if (src) scripts.push({ src, module, nomodule, async: isAsync, defer: isDefer });
      else if (code.trim()) scripts.push({ code, module, nomodule, async: isAsync, defer: isDefer });
      return "";
    },
  );
  return { html: out, scripts };
}

export async function cloneSite(rawUrl: string) {
  let target: URL;
  try {
    target = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
  } catch {
    throw new Error("URL tidak valid");
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error("Hanya http/https yang didukung");

  const base = target.toString();
  
  let html: string;
  try {
    html = await fetchText(base);
  } catch (e) {
    const errMsg = (e as Error).message;
    console.error(`[clone] gagal fetch ${base}:`, errMsg);
    throw new Error(`Gagal mengambil halaman: ${errMsg}. Pastikan URL benar dan website accessible.`);
  }

  const title = (
    html
      // HTML comments can contain literal `<title>` text (e.g. Studiodialect's
      // head-manager note), which would otherwise be captured as the document
      // title. Strip well-formed comments before matching.
      .replace(/<!--[\s\S]*?-->/g, "")
      .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? target.hostname
  ).trim();

  // Extract scripts BEFORE rewriting URLs: rewriteHtmlUrls must never touch
  // JS code — a script containing a string like src="./lib.js" would be
  // mangled (an exact match of the HTML attribute regex inside JS strings).
  const extracted = extractScripts(html);
  html = extracted.html;

  // Collect + inline external stylesheets. Each stylesheet stays its own
  // <style> entry: browsers parse each stylesheet separately, so concatenating
  // everything into one sheet lets a stray brace in one block eat the rules of
  // the others (sections losing their 100% width, cards losing their styles).
  const linkRe = /<link\b[^>]*rel\s*=\s*['"]?stylesheet['"]?[^>]*>/gi;
  const links = html.match(linkRe) ?? [];
  const styles: string[] = [];
  const inlined = new Set<string>();
  const keptLinkTags: string[] = [];
   for (const tag of links.slice(0, 50)) {
     const href = tag.match(/href\s*=\s*['"]([^'"]+)['"]/i)?.[1];
     if (!href) continue;
     const cssUrl = abs(href, base);
     try {
       const raw = await fetchText(cssUrl, true);
       if (!raw) {
         console.warn(`[clone] stylesheet tidak bisa diambil: ${cssUrl}, keep as link`);
         keptLinkTags.push(tag);
         continue;
       }
       if (looksLikeHtml(raw)) throw new Error("stylesheet response is HTML");
       let css = await inlineCssImports(rewriteCss(raw, cssUrl), cssUrl);
       // Preserve the <link media="..."> condition so responsive stylesheets
       // only apply at their intended breakpoint (critical for mobile layout).
       // Skip the async-CSS pattern `media="print" onload="this.media='all'"`
       // (deferred loading) — wrapping it would make the whole sheet print-only.
       const media = tag.match(/\smedia\s*=\s*['"]([^'"]+)['"]/i)?.[1]?.trim();
       if (media && !/^(all|screen)$/i.test(media) && !/\sonload\s*=/.test(tag)) {
         css = `@media ${media} {\n${css}\n}`;
       }
       styles.push(`/* ${cssUrl} */\n${css}`);
       inlined.add(tag);
     } catch (e) {
       // Keep the original <link> so the browser loads the stylesheet itself —
       // more faithful than silently dropping it (hrefs are already absolutized).
       console.warn(`[clone] gagal inline stylesheet ${cssUrl}:`, (e as Error).message);
       keptLinkTags.push(tag);
     }
   }
  // Remove only the links we successfully inlined
  html = html.replace(linkRe, (m) => (inlined.has(m) ? "" : m));

  // Preserve the source's remaining <head> <link> tags (modulepreload, preload,
  // fonts, canonical, manifest, …) and <script type="importmap">. The clone
  // rebuilds a minimal head that previously dropped them — which for framework
  // sites (Nuxt/Vite) stops the app from hydrating: the eager chunk list
  // (including the default LAYOUT chunk) is only fetched via
  // <link rel="modulepreload">, so without it the async layout never resolves
  // and the page stays a frozen static snapshot (Griflan's intro mask stuck at
  // opacity 1, hero sections never built). Hrefs stay RELATIVE so the output
  // builders' <base href> (ZIP) / localhost proxy (preview) resolve them.
  const rawHeadTags = (html.match(/<link\b[^>]*>/gi) ?? [])
    .filter((t) => !/rel\s*=\s*['"]stylesheet['"]/i.test(t))
    .join("\n");
  const rawImportmap =
    html.match(/<script[^>]*type\s*=\s*['"]importmap['"][^>]*>[\s\S]*?<\/script>/i)?.[0] ?? "";

  // Inline <style> blocks (keeping their media conditions, one entry each)
  const inlineStyles: string[] = [];
  html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_m, attrs: string, css: string) => {
    let out = rewriteCss(css, base);
    const media = attrs.match(/\smedia\s*=\s*['"]([^'"]+)['"]/i)?.[1]?.trim();
    if (media && !/^(all|screen)$/i.test(media) && !/\sonload\s*=/.test(attrs)) {
      out = `@media ${media} {\n${out}\n}`;
    }
    inlineStyles.push(out);
    return "";
  });
  for (const css of inlineStyles) styles.push(await inlineCssImports(css, base));

  // Inline fonts as base64 data URIs so typography matches the source on any
  // host (cross-origin font fetches are CORS-blocked on clones).
  for (let i = 0; i < styles.length; i++) styles[i] = await embedFonts(styles[i]!);

  // Absolutize attribute URLs in the remaining HTML (script code was already
  // extracted above, so JS string literals can't be mangled).
  html = rewriteHtmlUrls(html, base);
  html = unlazy(html);

  // Detect framework BEFORE filtering scripts — the flag is needed by
  // the fallback scroll layer which can't re-detect after scripts are stripped.
  const isFramework = extracted.scripts.some((s) => isFrameworkScript(s));

  // Remove overlays that block all content (full-screen masks, page
  // transitions). ONLY for non-framework sites: framework apps (Nuxt, Next,
  // …) boot their own runtime and DRIVE those overlays — stripping them (e.g.
  // Griflan's js-i-mask/js-i-page-intro intro curtain) breaks the app's intro
  // flow and the content it builds behind it.
  if (!isFramework) html = removeOverlays(html);

  // Keep ALL same-page scripts in document order (no cap: dropping later
  // scripts silently kills init code — e.g. GSAP pin setup after >60
  // vendor scripts — which breaks pinned scroll animations in the clone).
  // Framework scripts (Next.js/Nuxt/…) are kept too: the preview / vite /
  // nextjs outputs serve them in a real browser where the app boots on its
  // own and the result matches the source site.
  // For framework sites the script srcs stay RELATIVE: the Turbopack/Next
  // runtime matches its chunks against relative "/_next/..." selectors, so
  // absolutizing the srcs would stop the app from booting. The <base href>
  // injected by the output builders resolves them to the source CDN instead.
  const scripts: CloneScript[] = [];
  let baseOrigin = "";
  try {
    baseOrigin = new URL(base).origin;
  } catch {
    /* keep empty */
  }
  for (const s of extracted.scripts) {
    if (s.src) {
      let src: string;
      if (isFramework && s.src.startsWith("/")) {
        src = s.src;
      } else {
        const resolved = abs(s.src, base);
        // Load the site's own runtime scripts through the local proxy: module
        // scripts are CORS-blocked cross-origin when the source sends no ACAO
        // header, and relative chunk imports resolve against the script URL,
        // so a proxied script URL keeps the whole Vite/plain module graph local.
        let sameOrigin = false;
        try {
          sameOrigin = new URL(resolved).origin === baseOrigin;
        } catch {
          /* keep false */
        }
        src = sameOrigin ? proxyUrl(resolved) : resolved;
      }
      scripts.push({
        src,
        module: !!s.module,
        ...(s.nomodule && !s.module ? { nomodule: true } : {}),
        ...(s.async ? { async: true } : {}),
        ...(s.defer ? { defer: true } : {}),
      });
    } else {
      scripts.push({
        code: proxyCodeUrls(s.code!),
        module: !!s.module,
        ...(s.nomodule && !s.module ? { nomodule: true } : {}),
        ...(s.async ? { async: true } : {}),
        ...(s.defer ? { defer: true } : {}),
      });
    }
  }

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyAttrs = html.match(/<body([^>]*)>/i)?.[1] ?? "";
  let body = (bodyMatch?.[1] ?? html).trim();

  // Fallback: if body is empty or very short, try to extract from the full HTML
  if (body.length < 100) {
    // Try to get content between <body> and </body> even if regex didn't match well
    const bodyStart = html.indexOf("<body");
    const bodyEnd = html.lastIndexOf("</body>");
    if (bodyStart !== -1 && bodyEnd !== -1) {
      const tagEnd = html.indexOf(">", bodyStart);
      if (tagEnd !== -1) {
        body = html.slice(tagEnd + 1, bodyEnd).trim();
      }
    }
  }
  const css = `${styles.join("\n\n")}\n\n${BASE_CSS}`;

  const assets = Array.from(
    new Set(
      (body.match(/src="(https?:\/\/[^"]+)"/g) ?? []).map((s) => s.slice(5, -1)).slice(0, 200),
    ),
  );

  return {
    url: base,
    title,
    body,
    bodyAttrs,
    css,
    styles: [...styles, BASE_CSS],
    assets,
    scripts,
    stylesheets: links.length,
    linkTags: keptLinkTags.join("\n"),
    headTags: isFramework
      ? `${rawHeadTags}${rawImportmap ? `\n${rawImportmap}` : ""}`.replace(/\n{3,}/g, "\n\n").trim()
      : "",
    isFramework,
  };
}

/**
 * Server-side store of rendered preview HTML, keyed by a random id so the
 * preview iframe can be served at a real URL (/api/preview/:id) instead of a
 * blob/srcdoc URL — framework apps can't resolve relative URLs from those.
 */
const previewHtmlStore = new Map<string, string>();

/**
 * Latest cloned site's origin, shared via globalThis so the vite dev-server
 * plugin (loaded in a separate module graph) can read it. Next.js resolves
 * runtime assets (offscreen-canvas workers, chunk CSS) from location.origin,
 * so the clone's /_next/* requests must be proxied to the source origin.
 */
export function getCloneBase() {
  return (globalThis as { __cloneBase?: string }).__cloneBase ?? "";
}

export function setPreviewHtml(id: string, html: string, base = "") {
  previewHtmlStore.set(id, html);
  if (base) (globalThis as { __cloneBase?: string }).__cloneBase = base;
}
export function getPreviewHtml(id: string) {
  return previewHtmlStore.get(id);
}
