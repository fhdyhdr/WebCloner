import JSZip from "jszip";
import { SCROLL_JS } from "./gsap-layer";
import { PROXY_THIRD_PARTY } from "./clone.server";

export type CloneScript = {
  src?: string;
  code?: string;
  type?: string;
  module?: boolean;
  nomodule?: boolean;
  async?: boolean;
  defer?: boolean;
};

export type CloneResult = {
  url: string;
  title: string;
  body: string;
  bodyAttrs: string;
  css: string;
  assets: string[];
  scripts?: CloneScript[];
  stylesheets: number;
  /** Each original stylesheet as its own entry (keeps browser's per-sheet parsing). */
  styles?: string[];
  /** Original <link rel="stylesheet"> tags that couldn't be inlined (kept as fallback). */
  linkTags?: string;
  /**
   * Framework-only preserved head <link> tags (modulepreload / preload / fonts /
   * canonical …) plus <script type="importmap">. Nuxt/Vite apps load their eager
   * chunk graph (incl. the default layout) via <link rel="modulepreload>, so
   * dropping them leaves the page a frozen static snapshot.
   */
  headTags?: string;
  /** Whether the original site uses a framework (Next.js, Nuxt, Astro, etc.) */
  isFramework?: boolean;
  /** Server-side id of the rendered preview HTML (served at /api/preview/:id). */
  previewId?: string;
};

export type Target = "static" | "vite" | "next";

/** An element/section picked in the preview ("snipping"); only this is exported. */
export type CloneSelection = {
  html: string;
  label: string;
  styles?: string;
  /**
   * Perfect-cut locator into the FULL page clone: structural child-index path
   * from <body> down to the picked element, plus its absolute Y and height at
   * pick time. static/index.html (embed cut) passes these through the iframe
   * hash so full/index.html can pin & clip the original animated page to
   * exactly this section — with every site script/library still running.
   */
  cut?: { path: string; y: number; h: number };
};

const esc = (s: string) => stripLineSeparators(s).replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

/**
 * Framework apps (Next.js App Router etc.) call history.pushState/replaceState
 * with URLs resolved against the injected <base href>. When the clone runs on
 * a local origin that differs from the source site, the browser throws
 * SecurityError and the app bails to its error page. This patch runs before
 * any app script and forces every history URL to the local origin, so the app
 * boots locally while <base href> keeps resolving assets/`/_next/` to the
 * source CDN.
 * Next.js also REPLACES <head> during hydration and drops the injected <base>.
 * The MutationObserver re-inserts it whenever it disappears, so the app's lazy
 * images and /_next/ assets keep resolving to the source site after hydration.
 * Runs before the <base> element by design, so it must be placed AFTER the
 * <base href> in the head.
 * The theme re-assert keeps the theme the source SSR'd: some apps re-apply
 * prefers-color-scheme on hydration and flip a light-only source to dark mode
 * (inverted colors) even though the live site stays light.
 */
function historyPatch(r: CloneResult) {
  const themeLock = `
  (function () {
    var d = document.documentElement;
    var ATTRS = ["data-theme", "data-mode", "data-bs-theme", "data-theme-mode", "data-color-mode"];
    var locked = {};
    var csSet = false, csVal = "";
    function applyTheme() {
      if (!d) return;
      for (var i = 0; i < ATTRS.length; i++) {
        var a = ATTRS[i];
        var cur = d.getAttribute(a);
        if (!(a in locked)) {
          if (cur !== null) locked[a] = cur;
        } else if (cur !== locked[a]) {
          d.setAttribute(a, locked[a]);
        }
      }
      var cs = d.style.colorScheme;
      if (cs) {
        if (!csSet) { csSet = true; csVal = cs; }
        if (cs !== csVal) d.style.colorScheme = csVal;
      } else if (csSet) {
        d.style.colorScheme = csVal;
      }
    }
    applyTheme();
    if (window.MutationObserver) {
      new MutationObserver(applyTheme).observe(d, {
        attributes: true,
        attributeFilter: ["style", "class"].concat(ATTRS),
        subtree: false,
      });
    }
  })();`;
  return `<script>
(function () {
  var href = (document.querySelector("base") || { href: "" }).href;
  var wrap = function (orig) {
    return function (data, unused, url) {
      try {
        if (url) {
          var dest = new URL(String(url), location.href);
          var abs = location.origin + dest.pathname + dest.search + dest.hash;
          if (abs !== String(url)) url = abs;
        }
      } catch (e) {}
      return orig.call(this, data, unused, url);
    };
  };
  history.replaceState = wrap(history.replaceState.bind(history));
  history.pushState = wrap(history.pushState.bind(history));
  function ensureBase() {
    var h = document.head;
    if (!h) return;
    if (!h.querySelector("base") && href) {
      var b = document.createElement("base");
      b.href = href;
      h.appendChild(b);
    }
  }
  document.addEventListener("DOMContentLoaded", ensureBase);
  ensureBase();
  new MutationObserver(ensureBase).observe(document, { subtree: true, childList: true });
${themeLock}
})();
</script>`;
}

/** Strip unusual Unicode line separators (U+2028 LS, U+2029 PS) from output. */
function stripLineSeparators(s: string): string {
  return s.replace(/[\u2028\u2029]/g, "\n");
}

/**
 * Pretty-print an HTML fragment so sections sit on their own indented lines
 * (the source pages are usually minified single lines). Semantics-safe:
 * - inline elements (span/a/img/…) and their text stay on one line — no
 *   whitespace is inserted where it could change rendering (inline runs, flex
 *   gaps, text nodes);
 * - block containers (div/section/article/…) are indented by nesting depth;
 * - <script>/<style>/<pre>/<textarea>/<svg> content is kept verbatim;
 * - element-internal text closes inline (<p>text</p>) unless a block child was
 *   seen, so layouts and copy-paste both stay clean.
 */
export function formatHtml(html: string): string {
  const VERBATIM = new Set(["script", "style", "pre", "textarea", "svg", "math", "template"]);

  // ">" is only a tag terminator outside quoted attribute values.
  function findTagEnd(s: string, from: number): number {
    let quote: string | null = null;
    for (let j = from + 1; j < s.length; j++) {
      const ch = s[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        return j + 1;
      }
    }
    return s.length;
  }

  function tagNameAt(s: string, at: number): string {
    const m = /^<\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(s.slice(at));
    return m ? m[1]!.toLowerCase() : "";
  }

  // Collapse whitespace inside a tag (outside quoted attribute values) to
  // single spaces and remove space before > or /> — multi-line tags from
  // minified sources become one clean line without touching attribute values.
  function normalizeTag(tag: string): string {
    let out = "";
    let quote: string | null = null;
    for (let k = 0; k < tag.length; k++) {
      const ch = tag[k]!;
      if (quote) {
        out += ch;
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        out += ch;
      } else if (/\s/.test(ch)) {
        if (out.length && !/\s/.test(out[out.length - 1]!)) out += " ";
      } else {
        out += ch;
      }
    }
    return out
      .replace(/\s+>/g, ">")
      .replace(/\s+\/>/g, "/>")
      .replace(/^<\s+/, "<");
  }

  // Whitespace-preserving rewrite: tags are normalized to one clean line but
  // the runs BETWEEN tags are copied through untouched. Pretty indentation is
  // deliberately not injected — under white-space: pre-wrap contexts (Framer
  // text presets) an inserted newline + indent renders as a real line box and
  // pushes the following text down (~14px), and even a single added space
  // shows up visually. The captured markup comes straight from DOM
  // serialization, so leaving it verbatim keeps geometry identical.
  void tagNameAt;
  let out = "";
  let i = 0;
  const len = html.length;
  while (i < len) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    if (lt > i) {
      out += html.slice(i, lt);
      i = lt;
    }
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      const endIdx = end < 0 ? len : end + 3;
      out += html.slice(i, endIdx);
      i = endIdx;
      continue;
    }
    const tagEnd = findTagEnd(html, i);
    const raw = html.slice(i, tagEnd);
    if (/^<!(doctype|DOCTYPE)/.test(raw)) {
      out += raw;
      i = tagEnd;
      continue;
    }
    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(raw);
    if (!m) {
      out += raw;
      i = tagEnd;
      continue;
    }
    const name = m[2]!.toLowerCase();
    if (!m[1] && VERBATIM.has(name)) {
      out += raw;
      const sub = html.slice(tagEnd);
      const cm = sub.match(new RegExp("</" + name + "\\s*>", "i"));
      if (cm && cm.index !== undefined) {
        out += sub.slice(0, cm.index);
        out += sub.slice(cm.index, cm.index + cm[0].length);
        i = tagEnd + cm.index + cm[0].length;
      } else {
        i = len;
      }
      continue;
    }
    out += normalizeTag(raw);
    i = tagEnd;
  }
  return out.trim();
}

/**
 * Rewrite the site's runtime API fetches / image loads to a local /_cloneproxy/
 * route. Sites whose data backend sends no Access-Control-Allow-Origin (e.g.
 * Sanity's apicdn/CDN) CORS-block the app's cross-origin fetch()/XHR/image
 * loads from a clone origin; the URL is often built at runtime (template
 * literals), so a static JS rewrite can't catch it. Patching window.fetch,
 * XMLHttpRequest.open and the HTMLImageElement src setter early (classic head
 * script, runs before the app's module scripts) sends those same-origin and the
 * server proxies them.
 */
function apiProxyPatch() {
  const thirdParty = JSON.stringify(PROXY_THIRD_PARTY);
  return `<script>
(function () {
  if (window.__cloneApiProxy) return;
  window.__cloneApiProxy = true;
  var PROXY_HOSTS = ${thirdParty};
  function isSanity(host) {
    return host === "sanity.io" || host.endsWith(".sanity.io");
  }
  function isRefererGated(host) {
    for (var i = 0; i < PROXY_HOSTS.length; i++) {
      if (host === PROXY_HOSTS[i] || host.endsWith("." + PROXY_HOSTS[i])) return true;
    }
    return false;
  }
  function rewrite(raw) {
    if (typeof raw !== "string") return raw;
    try {
      var u = new URL(raw, location.href);
      // Sanity CDN and referer-gated third-party media (Vimeo playback, Mux
      // streams) fail cross-origin from a clone: route them through the local
      // proxy so loads are same-origin and the server re-fetches with the
      // source Referer. A fast proxy failure (unreachable host -> 502) also
      // lets media elements fire error/play-rejection promptly instead of
      // hanging the site's loader on a dead connection.
      if (isSanity(u.hostname) || isRefererGated(u.hostname))
        return "/_cloneproxy/" + u.host + u.pathname + u.search + u.hash;
    } catch (e) {}
    return raw;
  }
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === "string") {
      input = rewrite(input);
    } else if (
      typeof Request === "function" && input instanceof Request && typeof input.url === "string"
    ) {
      var rw = rewrite(input.url);
      if (rw !== input.url) input = new Request(rw, input);
    }
    return origFetch.call(this, input, init);
  };
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    return origOpen.call(this, method, rewrite(url));
  };
  function patchSrc(proto) {
    try {
      var d = Object.getOwnPropertyDescriptor(proto, "src");
      if (d && d.set) {
        Object.defineProperty(proto, "src", {
          get: function () { return d.get.call(this); },
          set: function (v) { return d.set.call(this, rewrite(v)); },
          configurable: true,
        });
      }
    } catch (e) {}
  }
  patchSrc(HTMLImageElement.prototype);
  // NOTE: src is NOT an own property of HTMLVideoElement/HTMLAudioElement �
  // it is inherited from HTMLMediaElement, so patching those prototypes does
  // nothing (own descriptor is undefined). Patch HTMLMediaElement instead.
  patchSrc(HTMLMediaElement.prototype);
  patchSrc(HTMLSourceElement.prototype);
})();
</script>`;
}

/**
 * Preview-only performance patch. The clone's animations (GSAP, WebGL,
 * parallax) all run on requestAnimationFrame; capping the frame rate made the
 * preview visibly choppy, so instead this keeps rAF at the browser's native
 * 60fps when the preview is on screen, and FREEZES it entirely the moment the
 * preview is not being looked at (tab hidden / iframe scrolled out of view).
 * Actively viewing a clone therefore runs full speed; idle clones cost zero
 * CPU/GPU. Only injected into the preview HTML — the downloadable builds are
 * untouched.
 */
function ecoPreviewPatch() {
  return `<script>
(function () {
  var origRaf = window.requestAnimationFrame.bind(window);
  var origCaf = window.cancelAnimationFrame.bind(window);
  var nextId = 0;
  var cbs = new Map();
  var active = true;
  var scheduled = false;
  function loop(ts) {
    if (!active) {
      scheduled = false;
      return;
    }
    // Keep "scheduled" true while processing so a callback that re-requests a
    // frame (GSAP ticker, WebGL render loop) just re-registers instead of
    // double-scheduling — exactly one pending rAF at all times.
    scheduled = true;
    var batch = Array.from(cbs.entries());
    cbs.clear();
    for (var i = 0; i < batch.length; i++) {
      try { batch[i][1](ts); } catch (e) {}
    }
    origRaf(loop);
  }
  window.requestAnimationFrame = function (cb) {
    var id = ++nextId;
    cbs.set(id, cb);
    if (!scheduled) {
      scheduled = true;
      origRaf(loop);
    }
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    cbs.delete(id);
  };
  function resume() {
    active = !document.hidden;
    if (active && !scheduled) {
      scheduled = true;
      origRaf(loop);
    }
  }
  document.addEventListener("visibilitychange", resume);
  try {
    // Pause when the preview scrolls out of the top-level viewport too.
    var io = new IntersectionObserver(function (entries) {
      active = entries.some(function (e) { return e.isIntersecting; }) && !document.hidden;
      if (active && !scheduled) {
        scheduled = true;
        origRaf(loop);
      }
    }, { threshold: 0.01 });
    io.observe(document.documentElement);
  } catch (e) {}
})();
</script>`;
}

/** Re-emit the original site scripts in document order. */
function scriptTags(r: CloneResult) {
  return (r.scripts ?? [])
    .map((s) => {
      const type = s.module ? ' type="module"' : "";
      // <script nomodule> are legacy polyfills / "update your browser" overlays
      // that must NOT run in modern browsers (they can redeclare identifiers
      // like Zajno's `var d`). Keep the attribute so browsers skip them.
      const nomoduleAttr = s.nomodule && !s.module ? ' nomodule=""' : "";
      // Module scripts require CORS to load cross-origin; classic scripts must
      // NOT set crossorigin, otherwise servers without CORS headers reject them.
      const cross = s.module ? ' crossorigin="anonymous"' : "";
      // Preserve async/defer: dropping async turns framework chunks into
      // blocking scripts that run BEFORE the inline flight-data payloads,
      // which stops Next.js/… from booting.
      const asyncAttr = s.async && !s.module ? ' async=""' : "";
      const deferAttr = s.defer ? ' defer=""' : "";
      if (s.src)
        return `<script${type}${nomoduleAttr} src="${s.src}"${cross}${asyncAttr}${deferAttr}></script>`;
      return `<script${type}${nomoduleAttr}>${(s.code ?? "").replace(/<\/script>/gi, "<\\/script>")}</script>`;
    })
    .join("\n");
}

const linkTags = (r: CloneResult) => (r.linkTags ? `\n${r.linkTags}` : "");

/**
 * Section/element exports used to ship no site scripts at all — the #1 reason
 * users saw "no animations" (GSAP, Lenis, sliders, counters…) next to a
 * full-page export where those same scripts run. Classic (non-module) scripts
 * usually work fine on a fragment: CDN libraries load, and init code that
 * queries selectors simply finds them inside #cp-root. Module scripts are
 * skipped — they belong to framework hydration graphs that cannot boot on a
 * fragment DOM.
 *
 * The harness is defensive because site code expects the whole page:
 * 1. snapshot #cp-root, disable the synthesized animation styles (#cp-anim)
 * 2. inject classic scripts sequentially in document order
 * 3. if the root got wiped/mangled (hydration nuked it) restore the snapshot;
 *    if nothing visibly moves after boot, re-enable the synthesized styles so
 *    the section never ends up with LESS motion than before.
 */
function absScriptSrc(src: string, base: string): string {
  if (src.startsWith("/_cloneproxy/")) return "https://" + src.slice("/_cloneproxy/".length);
  try {
    return new URL(src, base).toString();
  } catch {
    return src;
  }
}

function cpRuntimeHarness(r: CloneResult): string {
  const seen = new Set<string>();
  const list: Array<{ src: string } | { code: string }> = [];
  for (const s of r.scripts ?? []) {
    if (s.module || s.nomodule) continue;
    if (s.src) {
      const src = absScriptSrc(s.src, r.url);
      if (!/^https?:/i.test(src) || seen.has(src)) continue;
      seen.add(src);
      list.push({ src });
    } else if (s.code && s.code.trim() && !/document\.write/.test(s.code)) {
      list.push({ code: s.code });
    }
  }
  if (!list.length) return "";
  const boot = `(function(){
var root=document.getElementById("cp-root");
if(!root)return;
var snap=root.innerHTML;
var anim=document.getElementById("cp-anim");
if(anim)anim.disabled=true;
var mutated=0;
var mo=new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){if(ms[i].attributeName==="style")mutated++;}});
mo.observe(root,{attributes:true,attributeFilter:["style"],subtree:true});
var inRoot=function(a){var t=a.effect&&a.effect.target;return t&&root.contains(t);};
var baseAnims=document.getAnimations().filter(inRoot).length;
var list=${JSON.stringify(list)};
var i=-1;
function finish(){
  mo.disconnect();
  var broken=root.children.length===0||root.innerHTML.length<snap.length*0.25;
  if(broken){try{root.innerHTML=snap;}catch(e){}}
  var animsNow=document.getAnimations().filter(inRoot).length;
  var alive=!broken&&(animsNow>baseAnims||mutated>=3);
  if(anim&&(broken||!alive))anim.disabled=false;
}
function next(){
  i++;
  if(i>=list.length){setTimeout(finish,1200);return;}
  var s=list[i];
  if(s.src){
    var t=document.createElement("script");
    t.src=s.src;t.async=false;
    t.onerror=function(){setTimeout(next,0);};
    t.onload=function(){setTimeout(next,0);};
    document.body.appendChild(t);
  }else{
    try{(new Function(s.code))();}catch(e){}
    setTimeout(next,0);
  }
}
setTimeout(next,250);
})();`;
  return `<script>${boot}</script>`;
}

/** Preserved framework head links + importmap (modulepreload/preload/fonts). */
const headTags = (r: CloneResult) => (r.headTags ? `\n${r.headTags}` : "");

/** One <style> per original stylesheet — browsers parse each independently. */
const styleBlocks = (r: CloneResult) =>
  (r.styles?.length ? r.styles : [r.css]).map((css) => `<style>\n${css}\n</style>`).join("\n");

/** <link> tags for the zip variants, one stylesheet per file. */
const styleLinks = (r: CloneResult, prefix: string) => {
  const count = r.styles?.length ?? 1;
  return Array.from(
    { length: count },
    (_, i) => `<link rel="stylesheet" href="${prefix}${i}.css" />`,
  ).join("\n");
};

export function buildPreviewHtml(r: CloneResult) {
  const fwFlag = r.isFramework ? "<script>window.__cloneIsFramework=true;</script>" : "";
  return stripLineSeparators(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${r.isFramework ? historyPatch(r) : ""}
${apiProxyPatch()}
${ecoPreviewPatch()}
${CP_PRESTATE_SCRIPT}
<title>${r.title}</title>
${styleBlocks(r)}${linkTags(r)}${headTags(r)}
</head>
<body${r.bodyAttrs}>
${fwFlag}
${r.body}
${scriptTags(r)}
${r.isFramework ? "" : `<script>${SCROLL_JS}</script>`}
</body>
</html>`);
}

/**
 * Single-file static build: styles + scroll layer inlined, exactly like the
 * preview. External CSS files would be broken by <base href> (relative paths
 * would resolve against the ORIGINAL site, not the local folder), which is why
 * the preview looked perfect but the ZIP lost its gaps.
 */
function staticHtml(r: CloneResult) {
  const fwFlag = r.isFramework ? "<script>window.__cloneIsFramework=true;</script>" : "";
  const sw = r.isFramework
    ? `<script>
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(function () {});
}
</script>`
    : "";
  return stripLineSeparators(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<base href="${r.url}" />
${r.isFramework ? historyPatch(r) : ""}
${apiProxyPatch()}
<title>${r.title}</title>
<meta name="description" content="Cloned from ${r.url}" />
${styleBlocks(r)}${linkTags(r)}${headTags(r)}
</head>
<body${r.bodyAttrs}>
${fwFlag}
${formatHtml(r.body)}
${scriptTags(r)}
${r.isFramework ? "" : `<script>${SCROLL_JS}</script>`}
${sw}
<script>${CP_CUT_BOOT}</script>
</body>
</html>`);
}

/**
 * Hash-gated pin script for the "perfect cut" embed: when full/index.html is
 * loaded inside static/index.html's iframe with #cp-cut=<path>&cp-y=<y>, it
 * walks the structural child-index path to the picked section, locks page
 * scrolling and pins the viewport exactly at the section's Y. The FULL page
 * runtime (React/GSAP/Lenis/videos — every original script) keeps running, so
 * the cut shows the real animated site, not a resynthesis. Wheel/touch are
 * swallowed in capture phase so smooth-scroll layers can't drift the pin.
 */
const CP_CUT_BOOT = `(function(){try{
var h=location.hash;
var m=h.match(/cp-cut=([0-9\\-]+)/);if(!m)return;
var ids=m[1].split("-");
var yHint=parseFloat((h.match(/cp-y=([0-9.]+)/)||[])[1]||"0");
["wheel","touchmove"].forEach(function(t){window.addEventListener(t,function(e){e.preventDefault();e.stopImmediatePropagation();},{capture:true,passive:false});});
// Layout at open time differs from pick time (late fonts/images shift
// everything above the section), so anchor to the ELEMENT's live position,
// never the stale absolute Y. Re-anchor once after full load, then guard the
// position against SPA scroll resets.
var el=null,pinY=yHint,tries=0;
function findEl(){
  var n=document.body;
  if(!n)return null;
  for(var i=0;i<ids.length;i++){n=n.children[+ids[i]];if(!n)return null;}
  return n;
}
function anchor(){if(!el)return;var r=el.getBoundingClientRect();pinY=r.top+window.scrollY;}
function apply(){
  document.documentElement.style.overflow="hidden";
  document.body.style.overflow="hidden";
  window.scrollTo(0,pinY);
}
var iv=setInterval(function(){
  tries++;
  if(!el){el=findEl();if(!el){if(tries>60)clearInterval(iv);return;}anchor();}
  apply();
  if(tries>60)clearInterval(iv);
},200);
window.addEventListener("load",function(){setTimeout(function(){if(el)anchor();},1500);});
setInterval(function(){if(el&&Math.abs(window.scrollY-pinY)>1)apply();},250);
}catch(e){}})();`;

/** Shared geometry/hash pieces of the perfect-cut wrapper. */
function cutParts(sel: CloneSelection) {
  const c = sel.cut ?? { path: "", y: 0, h: 600 };
  return {
    hash: `cp-cut=${c.path}&cp-y=${c.y}&cp-h=${c.h}`,
    height: Math.max(c.h, 120),
    label: sel.label,
  };
}

const CUT_FRAME_CSS =
  "html,body{margin:0;padding:0;background:#fff;}iframe{display:block;border:0;width:100%;background:#fff;}";

/**
 * The embed wrapper for a perfect cut: a borderless iframe exactly as tall as
 * the picked section pointing into ./full/index.html (the complete animated
 * clone with all original scripts). Everything below/above the cut stays out
 * of view because the inner page is pinned by CP_CUT_BOOT.
 */
function cutEmbedHtml(r: CloneResult, sel: CloneSelection) {
  const p = cutParts(sel);
  return stripLineSeparators(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${r.title} — ${sel.label} (live cut)</title>
<style>${CUT_FRAME_CSS}iframe{height:${p.height}px;}</style>
</head>
<body>
<iframe title="${p.label}" src="./full/index.html#${p.hash}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>
</body>
</html>`);
}

/** Vite/Next variant: same cut over /full.html served from public/. */
function cutViteIndexHtml(r: CloneResult, sel: CloneSelection) {
  const p = cutParts(sel);
  return stripLineSeparators(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${r.title} — ${sel.label} (live cut)</title>
<style>${CUT_FRAME_CSS}iframe{height:${p.height}px;}</style>
</head>
<body>
<iframe title="${p.label}" src="/full.html#${p.hash}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>
</body>
</html>`);
}

function cutNextPage(r: CloneResult, sel: CloneSelection) {
  const p = cutParts(sel);
  return `const FRAME_CSS = ${JSON.stringify(`${CUT_FRAME_CSS}iframe{height:${p.height}px;}`)};

export default function Page() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: FRAME_CSS }} />
      <iframe
        title=${JSON.stringify(p.label)}
        src=${JSON.stringify(`/full.html#${p.hash}`)}
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        allowFullScreen
      />
    </>
  );
}
`;
}

/**
 * Single-file build for a PICKED element/section ("snipping"). Markup only +
 * all inlined styles so the section renders standalone; no site scripts (they
 * target the whole page), no framework patches, no service worker. The
 * <base href> keeps relative asset URLs resolving to the source site.
 */
/**
 * Scroll-linked animations synthesized for a picked section replay against a
 * view-timeline on #cp-root: their progress is "how far the section has
 * travelled through the viewport" of whatever page embeds it. No runway is
 * appended: a standalone page freezes them at their 0% state (the natural
 * resting look), while an embedded section scrubs with the host scroll.
 */

/**
 * The source site drives its videos, reveals and scrolling from runtime
 * scripts; a section export ships no site scripts. This restores those
 * behaviors: ambient background clips play while on screen (and pause off
 * screen), click-to-play clips wait for a click like the source's player
 * button, .cp-go is stamped on intro-replay elements the first time they show
 * so entrance animations fire on load / on scroll-in, and the mouse wheel is
 * smoothed (Lenis-style lerp) to match the source's inertial scrolling.
 */
const CP_VIDEO_SCRIPT = `<script>(function(){var vs=[].slice.call(document.querySelectorAll("#cp-root video"));var intros=[].slice.call(document.querySelectorAll("#cp-root [class*='cp-i']"));function go(el){el.classList.add("cp-go");}if("IntersectionObserver" in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){var p=e.target.play();if(p&&p.catch)p.catch(function(){});}else{e.target.pause();}});},{threshold:0.15});var io2=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){go(e.target);io2.unobserve(e.target);}});},{threshold:0.05});intros.forEach(function(el){io2.observe(el);});vs.forEach(function(v){if(v.hasAttribute("data-cp-clickplay"))return;io.observe(v);});}else{intros.forEach(go);vs.forEach(function(v){if(v.hasAttribute("data-cp-clickplay"))return;var p=v.play();if(p&&p.catch)p.catch(function(){});});}vs.forEach(function(v){if(!v.hasAttribute("data-cp-clickplay"))return;var zone=v.parentElement||v;zone.style.cursor="pointer";zone.addEventListener("click",function(ev){ev.preventDefault();if(v.paused){var p=v.play();if(p&&p.catch)p.catch(function(){});v.setAttribute("data-cp-playing","");[].slice.call(zone.querySelectorAll("[data-framer-name],button,[role='button']")).forEach(function(el){var n=(el.getAttribute("data-framer-name")||"")+String(el.className||"");if(/play/i.test(n))el.style.opacity="0";});}else{v.pause();v.removeAttribute("data-cp-playing");}});});var tgt=window.scrollY,cur=tgt,raf=false;function step(){cur+=(tgt-cur)*0.12;if(Math.abs(tgt-cur)<0.5){cur=tgt;raf=false;}window.scrollTo(0,cur);if(raf)requestAnimationFrame(step);}window.addEventListener("wheel",function(e){if(e.ctrlKey)return;if(/lenis/i.test(document.documentElement.className+" "+(document.body?document.body.className:"")))return;e.preventDefault();tgt+=e.deltaY;var mx=document.documentElement.scrollHeight-window.innerHeight;tgt=Math.max(0,Math.min(mx,tgt));if(!raf){raf=true;requestAnimationFrame(step);}},{passive:false});window.addEventListener("scroll",function(){if(!raf){tgt=cur=window.scrollY;}},{passive:true});
try{var sd=true;try{sd=CSS.supports("animation-timeline","--cpv");}catch(e){sd=false;}if(/[?&]cp-nosd=1/.test(location.search))sd=false;
if(!sd&&document.querySelector("#cp-root")){var root=document.querySelector("#cp-root");
var findKF=function(name){var out=null;[].slice.call(document.styleSheets).forEach(function(sh){var rs;try{rs=sh.cssRules;}catch(e){return;}[].slice.call(rs).forEach(function(r){if(r.type===7&&r.name===name)out=r;});});return out;};
var mkFrames=function(kf){var fs=[];[].slice.call(kf.cssRules).forEach(function(fr){var kt=fr.keyText;var off=kt==="from"?0:kt==="to"?1:parseFloat(kt)/100;var st={};for(var i=0;i<fr.style.length;i++){var pn=fr.style.item(i);st[pn]=fr.style.getPropertyValue(pn);}fs.push([off,st]);});fs.sort(function(a,b){return a[0]-b[0];});return fs.map(function(f){var o={offset:f[0]};for(var k in f[1])o[k]=f[1][k];return o;});};
var items=[];
var attach=function(el){var nm=(getComputedStyle(el).animationName||"none").split(",")[0].trim();if(nm.indexOf("cp-k")!==0)return;var kf=findKF(nm);if(!kf)return;var frames=mkFrames(kf);if(!frames.length)return;var an=el.animate(frames,{duration:1000,fill:"both",easing:"linear"});an.pause();items.push(an);};
[].slice.call(root.querySelectorAll("[class*='cp-s']")).forEach(function(el){if(el.__cpfb)return;el.__cpfb=1;if(el.getAttribute("class").indexOf("cp-i")>=0){var mo=new MutationObserver(function(){if(el.classList.contains("cp-go")){mo.disconnect();setTimeout(function(){attach(el);upd();},950);}});mo.observe(el,{attributes:true,attributeFilter:["class"]});}else{attach(el);}});
var upd=function(){var r=root.getBoundingClientRect();var vh=window.innerHeight;var p=(vh-r.top)/(vh+r.height);p=Math.max(0,Math.min(1,p));for(var i=0;i<items.length;i++){try{items[i].currentTime=p*1000;}catch(e){}}};
window.addEventListener("scroll",upd,{passive:true});window.addEventListener("resize",upd);setInterval(upd,200);upd();}
}catch(e){}
})();</script>`;

/**
 * Preview-only bootstrap: records each element's FIRST-SEEN computed
 * opacity/transform/filter in a WeakMap on the preview window. Framer-style
 * runtimes render elements hidden and reveal them once; by the time a user
 * picks a section the entrance has finished and left getAnimations(), so the
 * capture used to find nothing and whole sections exported static. The
 * first-seen snapshot preserves that pre-reveal look so applyAnimStyles can
 * synthesize the reveal from the delta.
 */
const CP_PRESTATE_SCRIPT = `<script>(function(){try{var pre=new WeakMap();window.__cpPre=pre;function grab(n){if(!n||n.nodeType!==1)return;if(pre.has(n))return;try{var cs=getComputedStyle(n);var o=cs.opacity,t=cs.transform,f=cs.filter;if(parseFloat(o)<0.95||(t&&t!=="none")||(f&&f!=="none"))pre.set(n,{o:o,t:t,f:f});}catch(e){}}function walk(r){if(!r||!r.querySelectorAll)return;grab(r);var a=r.querySelectorAll("*");for(var i=0;i<a.length;i++)grab(a[i]);}new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var ad=ms[i].addedNodes;for(var j=0;j<ad.length;j++)walk(ad[j]);}}).observe(document.documentElement,{childList:true,subtree:true});function start(){walk(document.body)}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();}catch(e){}})();</script>`;

export function snippetHtml(r: CloneResult, html: string, styles?: string): string {
  return stripLineSeparators(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<base href="${r.url}" />
<title>${r.title} — selected element</title>
<meta name="description" content="Selected element extracted from ${r.url}" />
${styleBlocks(r)}${linkTags(r)}
<style id="cp-anim">${styles ?? ""}</style>
</head>
<body>
${html}
${CP_VIDEO_SCRIPT}
${cpRuntimeHarness(r)}
</body>
</html>`);
}

/** Vite variant of a picked element: styles as files, no runtime scripts. */
function snippetViteHtml(r: CloneResult, html: string, styles?: string): string {
  return stripLineSeparators(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<base href="${r.url}" />
<title>${r.title} — selected element</title>
${styleLinks(r, "/src/styles-")}${linkTags(r)}
<style id="cp-anim">${styles ?? ""}</style>
</head>
<body>
${html}
${CP_VIDEO_SCRIPT}
${cpRuntimeHarness(r)}
</body>
</html>`);
}

/** Next.js page for a picked element: markup only, no original scripts. */
function snippetNextPage(r: CloneResult, html: string, styles?: string): string {
  const harness = cpRuntimeHarness(r)
    .replace(/^<script>/, "")
    .replace(/<\/script>$/, "");
  return `export default function Page() {
  return (
    <>
      <style id="cp-anim" dangerouslySetInnerHTML={{ __html: ${JSON.stringify(styles ?? "")} }} />
      <div dangerouslySetInnerHTML={{ __html: \`${esc(formatHtml(html))}\` }} />
      <script dangerouslySetInnerHTML={{ __html: ${JSON.stringify(CP_VIDEO_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, ""))} }} />
      ${harness ? `<script dangerouslySetInnerHTML={{ __html: ${JSON.stringify(harness)} }} />` : ""}
    </>
  );
}
`;
}
/**
 * Service worker for the static build. Next.js (Turbopack) builds runtime asset
 * URLs (offscreen-canvas workers, chunk CSS) as new URL("/_next/...",
 * location.origin); on a clone origin those 404. Intercepting them and
 * re-fetching from the source keeps the worker-backed canvas animations (e.g.
 * the cosmos.so hero film) running. Works when served over http(s) at the
 * origin root (GitHub Pages user site, custom domain); not on file://.
 */
function staticSw(r: CloneResult) {
  const src = new URL(r.url).origin;
  return stripLineSeparators(`const SRC = ${JSON.stringify(src)};
const ASSET = /\\/_[^/]+\\/|\\/vortex\\/|\\/[^/?#]+\\.([a-z0-9]{1,6})(?:[?#].*)?$/i;
const PROXY = "/_cloneproxy/";
async function fetchRetry(url, init, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || res.status < 500) return res;
      lastErr = new Error("HTTP " + res.status);
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith(PROXY)) {
    // Referer-gated third-party media (Mux). Best effort: the SW can't set a
    // Referer header (forbidden), so streams may still 403 without a server.
    const target = "https://" + url.pathname.slice(PROXY.length) + url.search;
    event.respondWith(
      fetchRetry(target, { signal: AbortSignal.timeout(6000) }).then((res) => {
        const ct = res.headers.get("content-type") || "";
        if (/mpegurl|m3u8/i.test(ct)) {
          return res.text().then((text) =>
            new Response(text.replace(/https:\\/\\/([a-zA-Z0-9.-]+\\/)/g, "/_cloneproxy/$1"), {
              status: res.status,
              headers: { "content-type": ct },
            }),
          );
        }
        if (/(javascript|json|css|html|xml|text)/i.test(ct)) {
          return res.text().then((text) =>
            new Response(text.replace(/https:\\/\\/([a-z0-9-]+\\.(?:apicdn|cdn)\\.sanity\\.io)\\//g, "/_cloneproxy/$1/"), {
              status: res.status,
              headers: { "content-type": ct },
            }),
          );
        }
        return res;
      }),
    );
    return;
  }
  // SPA backends fetch their own routes with same-origin mode to get JSON+body
  // (e.g. Zajno fetches "/?device=d", "/studio?device=d"). Serve the local
  // index.html only for the bare root; any other path (or a query on the root
  // that isn't a local preview) is proxied to the source.
  if (url.pathname === "/") {
    if (!url.search) return;
    event.respondWith(fetch(SRC + "/" + url.search));
    return;
  }
  if (!ASSET.test(url.pathname)) {
    event.respondWith(fetch(SRC + url.pathname + url.search));
    return;
  }
  if (ASSET.test(url.pathname)) {
    event.respondWith(fetch(SRC + url.pathname + url.search));
  }
});
`);
}

export async function buildZip(
  r: CloneResult,
  targets: Target[],
  selection?: CloneSelection | null,
) {
  const zip = new JSZip();
  const host = new URL(r.url).hostname.replace(/\W+/g, "-");
  const snipped = !!selection?.html;
  const body = snipped ? formatHtml(selection.html) : "";

  zip.file(
    "README.md",
    `# Clone of ${r.url}\n\nGenerated by Site Cloner (no AI, pure fetch + rewrite).\n\nIncluded builds: ${targets.join(", ")}\n\n- \`static/\` — open \`index.html\` directly in a browser\n- \`vite/\` — \`npm install && npm run dev\`\n- \`nextjs/\` — \`npm install && npm run dev\`\n\n${snipped ? "This ZIP contains only the element/section you selected in the preview (" + selection.label + "). EVERY build is a PERFECT CUT: a frame pinned to the complete cloned page (\`static/full/index.html\`, vite+nextjs \`public/full.html\`) — every original script, library and CDN asset still running — clipped to exactly your selection, so animations behave like the live site (internet needed for CDN assets). The pure dependency-free CSS variant with synthesized replay animations ships alongside: \`static/snippet.html\` / \`public/snippet.html\`.\n\n" : "The site's own scripts (GSAP, ScrollTrigger, parallax, framework runtimes, …) are preserved so animations run exactly like the original. For framework sites (Next.js/Nuxt/…), a small history patch lets the app boot on a local origin. Frameworks resolve their runtime assets (Web-Worker canvas renderers, module scripts, chunk CSS) from the document origin, so the \`vite\` and \`nextjs\` builds proxy those paths to the source CDN and \`static/\` ships a \`sw.js\` service worker for the same job (works when served over http(s)). Referer-gated third-party media (e.g. Mux streams) are re-fetched through a local \`/_cloneproxy/*\` route carrying the source Referer; \`static/\` has no server so those streams may still be blocked (open the \`vite\` or \`nextjs\` build for full playback). The GSAP fallback scroll layer is embedded only when the site has no animation of its own.\n"}Generated by Site Cloner (no AI, pure fetch + rewrite).\n`,
  );

  if (targets.includes("static")) {
    const f = zip.folder("static")!;
    if (snipped) {
      if (selection?.cut) {
        // Perfect cut: index.html embeds ./full/index.html — the COMPLETE
        // clone with every original script/library still running — pinned
        // and clipped to exactly the picked section. The pure-CSS resynthesis
        // stays available as snippet.html.
        f.file("index.html", cutEmbedHtml(r, selection));
        f.folder("full")!.file("index.html", staticHtml(r));
        if (r.isFramework) f.folder("full")!.file("sw.js", staticSw(r));
        f.file("snippet.html", snippetHtml(r, body, selection?.styles));
      } else {
        f.file("index.html", snippetHtml(r, body, selection?.styles));
      }
    } else {
      f.file("index.html", staticHtml(r));
      if (r.isFramework) f.file("sw.js", staticSw(r));
    }
  }

  if (targets.includes("vite")) {
    const f = zip.folder("vite")!;
    f.file(
      "package.json",
      JSON.stringify(
        {
          name: `${host}-vite-clone`,
          private: true,
          type: "module",
          scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
          dependencies: { gsap: "^3.12.5" },
          devDependencies: { vite: "^5.4.0" },
        },
        null,
        2,
      ),
    );
    // Frameworks resolve runtime assets (module entry scripts, offscreen-canvas
    // workers, chunk CSS/media) against location.origin � on a local origin they
    // 404, and cross-origin module scripts are CORS-blocked. Proxy every
    // asset-like path to the source CDN so the clone boots feature-identical
    // (the clone HTML uses no <base href>). /_cloneproxy/* re-fetches
    // referer-gated third-party media (Mux) server-side with the source Referer
    // and rewrites HLS playlists so variants/segments route through the proxy.
    const viteOrigin = new URL(r.url).origin;
    f.file(
      "vite.config.js",
      stripLineSeparators(`import { defineConfig } from "vite";

const SRC = ${JSON.stringify(viteOrigin)};

const loggedHosts = new Set();
async function proxyFetch(target, init, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(target, init);
      if (res.ok || res.status < 500) return res;
      lastErr = new Error("HTTP " + res.status);
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// SPA backends fetch their OWN routes with same-origin mode to get JSON+body
// (e.g. Zajno fetches "/?device=d", "/studio?device=d"). The clone is served
// from this local origin, so only vite's own paths are local; everything else
// is proxied to the source.
const LOCAL = ["/src/", "/@", "/node_modules/", "/favicon"${snipped && selection?.cut ? ', "/full.html", "/snippet.html"' : ""}];
const cloneProxy = {
  name: "clone-proxy",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const u = req.url || "/";
      let target;
      let viaProxy = false;
      if (u.startsWith("/_cloneproxy/")) {
        target = "https://" + u.slice("/_cloneproxy/".length);
        viaProxy = true;
      } else if (u === "/" || LOCAL.some((p) => u.startsWith(p))) {
        return next();
      } else {
        target = SRC + u;
      }
      const method = (req.method || "GET").toUpperCase();
      if (method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const headers = { referer: SRC + "/", "user-agent": req.headers["user-agent"] || "" };
        if (method !== "GET" && method !== "HEAD") {
          if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
          if (req.headers["accept"]) headers["accept"] = req.headers["accept"];
        }
        proxyFetch(target, {
          method,
          headers,
          body: method !== "GET" && method !== "HEAD" && body.length ? body : undefined,
          // Fail fast on unreachable hosts so site loaders (which wait on every
          // media element with no timeout of their own) don't hang forever.
          signal: AbortSignal.timeout(6000),
        })
          .then(async (up) => {
            res.statusCode = up.status;
            const ct = up.headers.get("content-type") || "";
            if (ct) res.setHeader("content-type", ct);
            if (up.body) {
              const reader = up.body.getReader();
              if (/(javascript|json|css|html|xml|text|mpegurl|m3u8)/i.test(ct)) {
                let text = "";
                for (;;) {
                  const r = await reader.read();
                  if (r.done) break;
                  text += Buffer.from(r.value).toString("utf8");
                }
                // Sanity runtime data APIs send no ACAO header, so route their
                // URLs through the proxy (no CORS server-side) � same-origin to
                // the browser. HLS playlists route every URL through the proxy.
                const out = /mpegurl|m3u8/i.test(ct)
                  ? text.replace(/https:\\/\\/([a-zA-Z0-9.-]+\\/)/g, "/_cloneproxy/$1")
                  : text.replace(/https:\\/\\/([a-z0-9-]+\\.(?:apicdn|cdn)\\.sanity\\.io)\\//g, "/_cloneproxy/$1/");
                res.write(Buffer.from(out));
              } else {
                for (;;) {
                  const r = await reader.read();
                  if (r.done) break;
                  res.write(Buffer.from(r.value));
                }
              }
            }
            res.end();
          })
          .catch(() => {
            res.statusCode = 502;
            res.end();
          });
      });
    });
  },
};

export default defineConfig({
  plugins: [cloneProxy],
  server: {
    proxy: {
      "/assets": { target: ${JSON.stringify(viteOrigin)}, changeOrigin: true },
      "/_next": { target: ${JSON.stringify(viteOrigin)}, changeOrigin: true },
      "/_nuxt": { target: ${JSON.stringify(viteOrigin)}, changeOrigin: true },
      "/vortex": { target: ${JSON.stringify(viteOrigin)}, changeOrigin: true },
      "^/(static|media|images|fonts|icons|svg)/.*\\\\.([a-z0-9]+)$": {
        target: ${JSON.stringify(viteOrigin)},
        changeOrigin: true,
      },
    },
  },
});
`),
    );
    f.file(
      "index.html",
      snipped
        ? selection?.cut
          ? cutViteIndexHtml(r, selection)
          : snippetViteHtml(r, body, selection?.styles)
        : stripLineSeparators(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${r.isFramework ? historyPatch(r) : ""}
${apiProxyPatch()}
<title>${r.title}</title>
${styleLinks(r, "/src/styles-")}${linkTags(r)}${headTags(r)}
</head>
<body${r.bodyAttrs}>
${formatHtml(r.body)}
${scriptTags(r)}
<script type="module" src="/src/main.js"></script>
</body>
</html>`),
    );
    const src = f.folder("src")!;
    const cssParts = r.styles?.length ? r.styles : [r.css];
    cssParts.forEach((part, i) => src.file(`styles-${i}.css`, part));
    if (snipped && selection?.cut) {
      // Perfect cut needs the full animated clone served by Vite itself
      // (public/ maps to the server root); snippet.html keeps the pure-CSS
      // variant browsable next to it.
      f.folder("public")!.file("full.html", staticHtml(r));
      f.folder("public")!.file("snippet.html", snippetHtml(r, body, selection?.styles));
    }
    src.file(
      "main.js",
      snipped
        ? `// Element extract: markup + styles only. Add your own JS here.\n`
        : r.isFramework
          ? `// Framework app: the original scripts drive the page, no fallback needed.\n`
          : `import gsap from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);
window.gsap = window.gsap || gsap;
window.ScrollTrigger = window.ScrollTrigger || ScrollTrigger;

${SCROLL_JS}
`,
    );
  }

  if (targets.includes("next")) {
    const f = zip.folder("nextjs")!;
    f.file(
      "package.json",
      JSON.stringify(
        {
          name: `${host}-next-clone`,
          private: true,
          scripts: { dev: "next dev", build: "next build", start: "next start" },
          dependencies: {
            gsap: "^3.12.5",
            next: "^14.2.5",
            react: "^18.3.1",
            "react-dom": "^18.3.1",
          },
        },
        null,
        2,
      ),
    );
    f.file(
      "next.config.mjs",
      `export default {
  images: { unoptimized: true },
  async rewrites() {
    const origin = ${JSON.stringify(new URL(r.url).origin)};
    return [
      { source: "/_next/:path*", destination: origin + "/_next/:path*" },
      { source: "/_nuxt/:path*", destination: origin + "/_nuxt/:path*" },
      { source: "/vortex/:path*", destination: origin + "/vortex/:path*" },
      { source: "/assets/:path*", destination: origin + "/assets/:path*" },
      { source: "/:dir(static|media|images|fonts|icons|svg)/:path*", destination: origin + "/:dir/:path*" },
      // SPA backends fetch their own routes with same-origin mode to get JSON+body
      // (e.g. Zajno fetches "/?device=d", "/studio?device=d"). The clone's only
      // local files are the root page, styles-*.css and _next/*, so rewrite every
      // other route to the source.
      { source: "/:path((?!styles-).*)", destination: origin + "/:path" },
    ];
  },
};
`,
    );
    const app = f.folder("app")!;
    if (snipped && selection?.cut) {
      // Perfect cut: Next serves the full animated clone (and the pure-CSS
      // variant) straight from public/ — public files win over the catch-all
      // rewrite to the source site, so /full.html stays local.
      f.folder("public")!.file("full.html", staticHtml(r));
      f.folder("public")!.file("snippet.html", snippetHtml(r, body, selection?.styles));
    }
    // Referer-gated third-party media (Mux) proxied server-side: catch-all route
    // /_cloneproxy/<host>/<path?query> -> https://<host>/<path?query> with the
    // source Referer, rewriting HLS playlists so variants/segments stay proxied.
    const cloneproxyDir = app.folder("cloneproxy")!;
    cloneproxyDir.folder("[...path]")!.file(
      "route.js",
      `import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SRC = ${JSON.stringify(new URL(r.url).origin)};
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

export async function GET(request, { params }) {
  return handle(request, params, null);
}

export async function POST(request, { params }) {
  const body = await request.arrayBuffer();
  return handle(request, params, body);
}

async function fetchRetry(url, init, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || res.status < 500) return res;
      lastErr = new Error("HTTP " + res.status);
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function handle(request, params, body) {
  const path = params?.path || [];
  const host = path[0];
  if (!host) return new NextResponse("bad proxy", { status: 400 });
  const target = "https://" + host + "/" + path.slice(1).join("/") + request.nextUrl.search;
  const headers = { referer: SRC + "/", "user-agent": UA };
  const ctHeader = request.headers.get("content-type");
  if (ctHeader && body) headers["content-type"] = ctHeader;
  const res = await fetchRetry(target, {
    method: body ? "POST" : "GET",
    headers,
    body,
    // Fail fast on unreachable hosts so site loaders waiting on media don't hang.
    signal: AbortSignal.timeout(6000),
  });
  const ct = res.headers.get("content-type") || "";
  if (/mpegurl|m3u8/i.test(ct)) {
    const text = await res.text();
    return new NextResponse(text.replace(/https:\\/\\/([a-zA-Z0-9.-]+\\/)/g, "/_cloneproxy/$1"), {
      status: res.status,
      headers: { "content-type": ct },
    });
  }
  if (/(javascript|json|css|html|xml|text)/i.test(ct)) {
    const text = await res.text();
    // Sanity runtime data APIs send no ACAO header � route their URLs through
    // the proxy so the browser sees a same-origin response.
    return new NextResponse(text.replace(/https:\\/\\/([a-z0-9-]+\\.(?:apicdn|cdn)\\.sanity\\.io)\\//g, "/_cloneproxy/$1/"), {
      status: res.status,
      headers: { "content-type": ct },
    });
  }
  return new NextResponse(await res.arrayBuffer(), {
    status: res.status,
    headers: { "content-type": ct },
  });
}
`,
    );
    const cssParts = r.styles?.length ? r.styles : [r.css];
    const cssImports = cssParts.map((_, i) => `import "./styles-${i}.css";`).join("\n");
    cssParts.forEach((part, i) => app.file(`styles-${i}.css`, part));
    app.file(
      "layout.jsx",
      `${cssImports}
// Raw head markup (proxy/runtime scripts, links, meta) is injected as an HTML
// string: inline script bodies contain braces that JSX would parse as
// expressions, and non-self-closing <link> tags are JSX syntax errors.
const HEAD_HTML = ${JSON.stringify(
        [r.isFramework ? historyPatch(r) : "", apiProxyPatch(), r.linkTags ?? "", r.headTags ?? ""]
          .filter(Boolean)
          .join("\n"),
      )};

export const metadata = {
  title: ${JSON.stringify(r.title)},
  description: ${JSON.stringify(`Cloned from ${r.url}`)},
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head dangerouslySetInnerHTML={{ __html: HEAD_HTML }} />
      <body>{children}</body>
    </html>
  );
}
`,
    );
    app.file(
      "page.jsx",
      snipped
        ? selection?.cut
          ? cutNextPage(r, selection)
          : snippetNextPage(r, body, selection?.styles)
        : `import OriginalScripts from "./OriginalScripts";

const MARKUP = \`${esc(formatHtml(r.body))}\`;

export default function Page() {
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: MARKUP }} />
      <OriginalScripts />
    </>
  );
}
`,
    );
    if (!snipped) {
      app.file("scripts.json", JSON.stringify(r.scripts ?? [], null, 2));
      app.file(
        "OriginalScripts.jsx",
        `"use client";

import { useEffect } from "react";
import gsap from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";
import SCRIPTS from "./scripts.json";

// Loads the original site scripts (GSAP, ScrollTrigger, parallax, marquee,
// SVG draw, …) in document order so the clone animates like the source.
export default function OriginalScripts() {
  useEffect(() => {
    let cancelled = false;
    gsap.registerPlugin(ScrollTrigger);
    window.gsap = window.gsap || gsap;
    window.ScrollTrigger = window.ScrollTrigger || ScrollTrigger;
    window.__cloneOriginalScripts = true;

    const added = [];
    async function run() {
      for (const s of SCRIPTS) {
        if (cancelled) return;
        // nomodule scripts are legacy polyfills / "update your browser" overlays
        // that must not run in modern browsers.
        if (s.nomodule && !s.module) continue;
        await new Promise((resolve) => {
          const el = document.createElement("script");
          if (s.module) el.type = "module";
          if (s.src) {
            el.src = s.src;
            if (s.module) el.crossOrigin = "anonymous";
            el.onload = resolve;
            el.onerror = resolve;
          } else {
            el.textContent = s.code || "";
          }
          document.body.appendChild(el);
          added.push(el);
          if (!s.src) resolve();
        });
      }
      window.dispatchEvent(new Event("load"));
      setTimeout(() => ScrollTrigger.refresh(), 1200);
    }
    run();

    return () => {
      cancelled = true;
      added.forEach((el) => el.remove());
    };
  }, []);
  return null;
}
`,
      );
    }
  }

  return await zip.generateAsync({ type: "blob" });
}
