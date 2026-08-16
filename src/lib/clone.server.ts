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
  html = html.replace(
    /\s(src|href|poster|data-src|data-srcset|srcset)\s*=\s*(['"])(.*?)\2/gi,
    (m, attr: string, q: string, val: string) => {
      if (/^(data:|https?:|mailto:|tel:|javascript:|#)/i.test(val.trim())) return m;
      if (/srcset$/i.test(attr)) {
        const out = val
          .split(",")
          .map((part) => {
            const [u, ...rest] = part.trim().split(/\s+/);
            return [abs(u ?? "", base), ...rest].join(" ");
          })
          .join(", ");
        return ` ${attr}="${out}"`;
      }
      return ` ${attr}="${abs(val, base)}"`;
    },
  );
  // Absolutize url() inside inline style attributes (background-image etc.) so
  // the generated files don't depend on a <base href> to resolve them.
  return html.replace(/\sstyle\s*=\s*(['"])([\s\S]*?)\1/gi, (m, q: string, val: string) => {
    const out = val.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (mm, q2: string, u: string) => {
      const trimmed = u.trim();
      if (/^(data:|https?:|#)/i.test(trimmed)) return mm;
      return `url("${abs(trimmed, base)}")`;
    });
    return ` style=${q}${out}${q}`;
  });
}

async function fetchText(url: string) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} saat mengambil ${url}`);
  return sanitizeLineTerminators(await res.text());
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
      const raw = rewriteCss(await fetchText(cssUrl), cssUrl);
      let child = raw;
      // Keep the @import's media condition (e.g. `screen and (min-width: 768px)`)
      // so responsive rules don't leak to every breakpoint.
      const media = (m[2] ?? "").trim();
      if (media && !/^layer\b/i.test(media)) child = `@media ${media} {\n${raw}\n}`;
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
 * Framework runtimes (Next.js, Nuxt, Astro, SvelteKit, Remix, …) cannot boot
 * inside a static clone: their module chunks fail CORS, their bootstrap needs
 * a full app runtime, and their inline boot payloads are only consumed by that
 * runtime. Keeping them just produces console errors (and some apps blank the
 * page when hydration fails), so they are dropped — the fallback scroll layer
 * animates the clone instead. Third-party scripts (GSAP CDN, analytics, …)
 * are preserved.
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

export type CloneScript = { src?: string; code?: string; type?: string; module?: boolean };

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
      if (src) scripts.push({ src, module });
      else if (code.trim()) scripts.push({ code, module });
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
  let html = await fetchText(base);

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? target.hostname).trim();

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
      const raw = await fetchText(cssUrl);
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
      keptLinkTags.push(tag);
    }
  }
  // Remove only the links we successfully inlined
  html = html.replace(linkRe, (m) => (inlined.has(m) ? "" : m));

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

  // Absolutize attribute URLs in the remaining HTML (script code was already
  // extracted above, so JS string literals can't be mangled).
  html = rewriteHtmlUrls(html, base);
  html = unlazy(html);

  // Remove overlays that block all content (full-screen masks, page transitions)
  html = removeOverlays(html);

  // Detect framework BEFORE filtering scripts — the flag is needed by
  // the fallback scroll layer which can't re-detect after scripts are stripped.
  const isFramework = extracted.scripts.some((s) => isFrameworkScript(s));

  // Keep ALL same-page scripts in document order (no cap: dropping later
  // scripts silently kills init code — e.g. GSAP pin setup after >60
  // vendor scripts — which breaks pinned scroll animations in the clone),
  // except un-runnable framework boot scripts.
  const scripts: CloneScript[] = [];
  for (const s of extracted.scripts) {
    if (isFrameworkScript(s)) continue;
    if (s.src) {
      scripts.push({ src: abs(s.src, base), module: !!s.module });
    } else {
      scripts.push(s);
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
    isFramework,
  };
}
