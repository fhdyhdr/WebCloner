/**
 * Static site cloner: fetches a page, absolutizes URLs, inlines stylesheets and
 * PRESERVES the original scripts (GSAP, ScrollTrigger, Lenis, marquee, SVG draw,
 * parallax, …) so the cloned page animates exactly like the source.
 * No AI involved — pure fetch + rewrite.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function abs(url: string, base: string) {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

function rewriteCss(css: string, base: string) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    if (/^(data:|https?:|#)/i.test(u)) return m;
    return `url("${abs(u, base)}")`;
  });
}

function rewriteHtmlUrls(html: string, base: string) {
  return html.replace(
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
}

async function fetchText(url: string) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} saat mengambil ${url}`);
  return await res.text();
}

/** Follow one level of @import so component stylesheets aren't lost. */
async function inlineCssImports(css: string, base: string) {
  const importRe = /@import\s+(?:url\(\s*)?['"]?([^'")\s]+)['"]?\s*\)?[^;]*;/gi;
  const found = [...css.matchAll(importRe)].slice(0, 15);
  for (const m of found) {
    const href = m[1];
    if (!href || href.startsWith("data:")) continue;
    const cssUrl = abs(href, base);
    try {
      const child = rewriteCss(await fetchText(cssUrl), cssUrl);
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

/** Minimal hygiene only — never force-reveal, that would kill real animations. */
const BASE_CSS = `
/* --- Site Cloner --- */
html, body { overflow-x: hidden !important; }
`;

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

  // Absolutize before anything else so script srcs are usable too
  html = rewriteHtmlUrls(html, base);

  // Collect + inline external stylesheets
  const linkRe = /<link\b[^>]*rel\s*=\s*['"]?stylesheet['"]?[^>]*>/gi;
  const links = html.match(linkRe) ?? [];
  const cssParts: string[] = [];
  for (const tag of links.slice(0, 20)) {
    const href = tag.match(/href\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    if (!href) continue;
    const cssUrl = abs(href, base);
    try {
      const css = await fetchText(cssUrl);
      cssParts.push(`/* ${cssUrl} */\n${await inlineCssImports(rewriteCss(css, cssUrl), cssUrl)}`);
    } catch {
      /* skip unreachable stylesheet */
    }
  }
  // Inline <style> blocks
  const inlineStyles: string[] = [];
  html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_m, css: string) => {
    inlineStyles.push(rewriteCss(css, base));
    return "";
  });
  for (const css of inlineStyles) cssParts.push(await inlineCssImports(css, base));

  html = html.replace(linkRe, "");

  // Keep the original scripts: that's what recreates the real animations.
  const extracted = extractScripts(html);
  html = unlazy(extracted.html);

  // Inline same-page scripts as text where possible so they still work offline
  const scripts: CloneScript[] = [];
  for (const s of extracted.scripts.slice(0, 60)) {
    if (s.src) {
      scripts.push({ src: abs(s.src, base), module: !!s.module });
    } else {
      scripts.push(s);
    }
  }

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyAttrs = html.match(/<body([^>]*)>/i)?.[1] ?? "";
  const body = (bodyMatch?.[1] ?? html).trim();
  const css = `${cssParts.join("\n\n")}\n\n${BASE_CSS}`;

  const assets = Array.from(
    new Set(
      (body.match(/src="(https?:\/\/[^"]+)"/g) ?? []).map((s) => s.slice(5, -1)).slice(0, 200),
    ),
  );

  return { url: base, title, body, bodyAttrs, css, assets, scripts, stylesheets: links.length };
}
