/**
 * Static site cloner: fetches a page, absolutizes URLs, inlines stylesheets,
 * strips original scripts and injects a GSAP ScrollTrigger reveal layer.
 * No AI involved — pure fetch + rewrite.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const GSAP_SNIPPET = `
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js"></script>
<script>
  window.addEventListener("DOMContentLoaded", function () {
    if (!window.gsap) return;
    gsap.registerPlugin(ScrollTrigger);
    var blocks = document.querySelectorAll(
      "body section, body header, body footer, body main > div, body article, body .clone-reveal"
    );
    blocks.forEach(function (el) {
      gsap.from(el, {
        opacity: 0,
        y: 48,
        duration: 0.9,
        ease: "power3.out",
        scrollTrigger: { trigger: el, start: "top 85%", toggleActions: "play none none reverse" },
      });
    });
    document.querySelectorAll("h1, h2, h3").forEach(function (el) {
      gsap.from(el, {
        opacity: 0,
        y: 24,
        duration: 0.7,
        ease: "power2.out",
        scrollTrigger: { trigger: el, start: "top 90%" },
      });
    });
    document.querySelectorAll("img").forEach(function (el) {
      gsap.fromTo(
        el,
        { scale: 1.06 },
        { scale: 1, duration: 1.2, ease: "power2.out", scrollTrigger: { trigger: el, start: "top 95%" } }
      );
    });
  });
</script>
`;

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
    /\s(src|href|poster|data-src|srcset)\s*=\s*(['"])(.*?)\2/gi,
    (m, attr: string, q: string, val: string) => {
      if (/^(data:|https?:|mailto:|tel:|javascript:|#)/i.test(val.trim())) return m;
      if (attr.toLowerCase() === "srcset") {
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
 * Many sites hide sections until their own JS runs (lazy images, AOS/WOW/
 * ScrollReveal style classes, [hidden until scrolled] attributes). Since the
 * original scripts are stripped, we materialise that content up-front.
 */
function unlazy(html: string) {
  return (
    html
      // promote lazy image sources to real ones
      .replace(
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
          if (lazySrc) {
            a = /\ssrc\s*=/.test(a)
              ? a.replace(/\ssrc\s*=\s*["'][^"']*["']/i, ` src="${lazySrc}"`)
              : `${a} src="${lazySrc}"`;
          }
          if (lazySet) {
            a = /\ssrcset\s*=/.test(a)
              ? a.replace(/\ssrcset\s*=\s*["'][^"']*["']/i, ` srcset="${lazySet}"`)
              : `${a} srcset="${lazySet}"`;
          }
          a = a.replace(/\sloading\s*=\s*["']lazy["']/i, "");
          return `<${name}${a}>`;
        },
      )
      // reveal-on-scroll markers that depend on the site's own JS
      .replace(/\sdata-(aos|scroll|animate|reveal|sr-id)(-[a-z-]+)?\s*=\s*["'][^"']*["']/gi, "")
      .replace(/\s(hidden|aria-hidden)\s*=\s*["'](true|hidden|)["']/gi, "")
      // unwrap <noscript> fallbacks (usually the real <img>)
      .replace(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi, "$1")
  );
}

/** Neutralise "invisible until animated" states left behind by stripped JS. */
const UNHIDE_CSS = `
/* --- Site Cloner: reveal content that the original JS would have shown --- */
[class*="aos"], [class*="animate"], [class*="reveal"], [class*="fade"],
[class*="wow"], [class*="scroll-"], [class*="inview"], [class*="observe"],
[data-animation], .lazy, .lazyload, .lazyloaded {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
  clip-path: none !important;
  animation: none !important;
}
html, body { overflow-x: hidden !important; height: auto !important; }
body { opacity: 1 !important; visibility: visible !important; }
[style*="opacity:0"], [style*="opacity: 0"] { opacity: 1 !important; }
`;


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

  html = html
    .replace(linkRe, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*\/>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, "");

  html = rewriteHtmlUrls(html, base);
  html = unlazy(html);

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyAttrs = html.match(/<body([^>]*)>/i)?.[1] ?? "";
  const body = (bodyMatch?.[1] ?? html).trim();
  const css = `${cssParts.join("\n\n")}\n\n${UNHIDE_CSS}`;


  const assets = Array.from(
    new Set(
      (body.match(/src="(https?:\/\/[^"]+)"/g) ?? []).map((s) => s.slice(5, -1)).slice(0, 200),
    ),
  );

  return { url: base, title, body, bodyAttrs, css, assets, stylesheets: links.length };
}
