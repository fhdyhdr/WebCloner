import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { Download, Globe, Loader2, Monitor, Rows3, Scissors, Smartphone, Zap } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { clonePage } from "@/lib/clone.functions";
import {
  buildZip,
  formatHtml,
  snippetHtml,
  type CloneResult,
  type CloneSelection,
  type Target,
} from "@/lib/export-zip";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Site Cloner — Clone Website ke HTML, Vite & Next.js" },
      {
        name: "description",
        content:
          "Tempel link website, lihat preview hasil kloning dengan animasi scroll GSAP, lalu unduh ZIP berisi versi HTML/CSS/JS, Vite, dan Next.js.",
      },
      { property: "og:title", content: "Site Cloner — Clone Website Jadi Kode Siap Pakai" },
      {
        property: "og:description",
        content:
          "Input link, preview, download ZIP: static HTML, Vite, dan Next.js dengan GSAP ScrollTrigger.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const TARGETS: { id: Target; label: string; hint: string }[] = [
  { id: "static", label: "HTML / CSS / JS", hint: "Buka langsung di browser" },
  { id: "vite", label: "Vite", hint: "npm run dev" },
  { id: "next", label: "Next.js", hint: "App Router" },
];

/**
 * Renders the clone inside an iframe with a REAL device viewport width
 * (1440px desktop / 390px mobile) scaled down to fit the preview card.
 * Without this, a narrow preview frame shrinks the layout below its native
 * breakpoints — sections and cards end up cramped ("mepet").
 */
const DEVICE_WIDTHS = { desktop: 1440, mobile: 390 } as const;

/**
 * Picker logic that runs directly on the preview iframe's document (same-origin,
 * so the parent can attach capture-phase listeners without injecting a script).
 * Mode "element": picks the exact element under the cursor — or, if that leaf
 * has no id/class, the deepest ancestor that does. Shift+click walks further up
 * to the largest labelled ancestor. Mode "section": picks the nearest semantic
 * block (section/header/footer/…). Hover outlines the element that will be
 * picked; element mode also inlines the element's computed layout + wraps it in
 * the parent's flex/grid context so the downloaded piece keeps its preview size
 * and centering. Returns an uninstall function.
 */
function installPicker(
  doc: Document,
  mode: PickMode,
  onPick: (sel: CloneSelection) => void,
  onCancel: () => void,
): () => void {
  const hasLabel = (el: Element) => !!(el.id || el.getAttribute("class"));
  const isRoot = (node: Element | null) =>
    !!(node && node !== doc.body && node !== doc.documentElement);
  const SECTION_SEL =
    "section, header, footer, article, main, aside, nav, [data-section], [class*=section], [id*=section]";
  const pickElement = (el: Element): Element => {
    if (hasLabel(el)) return el;
    let node = el.parentElement;
    for (let i = 0; i < 4 && isRoot(node); i++) {
      if (hasLabel(node!)) return node!;
      node = node!.parentElement;
    }
    return el;
  };
  const pickSection = (el: Element): Element => {
    let node: Element | null = el;
    // Framer/Webflow component trees nest dozens of levels deep; a 10-level
    // walk gave up and fell back to a tiny labeled fragment (no images, no
    // animations) even though a <section> was further up — the exported ZIP
    // then looked "broken". Walk far enough to always escape the component.
    for (let i = 0; i < 80 && isRoot(node); i++) {
      if (node!.matches && node!.matches(SECTION_SEL)) return node!;
      node = node!.parentElement;
    }
    return pickElement(el);
  };
  const resolve = (el: Element) => (mode === "section" ? pickSection(el) : pickElement(el));
  const txOf = (n: Element): [number, number] | null => {
    const m = doc.defaultView?.getComputedStyle(n).transform;
    if (!m || m === "none") return null;
    const v = m.match(/matrix.*\((.+)\)/);
    if (!v) return null;
    const p = v[1]!.split(",").map(parseFloat);
    return [p[4] || 0, p[5] || 0];
  };
  // Clicking inside a running marquee resolves to the text inside one item.
  // The text ITSELF drifts with the track, so "is the target moving?" can't
  // decide anything — instead always look for a qualified MOVING ANCESTOR:
  // steady drift across two intervals, >= 3 element children (repeated
  // items of a track), bounded size, not a page-level tag. If one exists,
  // grow the selection to it so the exported piece contains the looping
  // track; otherwise keep the original target.
  const expandToMovingAncestor = async (el: Element): Promise<Element> => {
    const w = doc.defaultView;
    if (!w) return el;
    const chain: Element[] = [];
    let node: Element | null = el.parentElement;
    for (let i = 0; i < 6 && node && isRoot(node); i++) {
      chain.push(node);
      node = node.parentElement;
    }
    if (!chain.length) return el;
    // Tickers often slow to a crawl while hovered (Framer marquees drop to
    // ~10% speed under the cursor), and the pick click leaves the cursor
    // exactly on the element. Suspend pointer events so :hover clears and the
    // track runs at full speed during the measurement, then restore.
    const noHover = doc.createElement("style");
    noHover.textContent = "html, body { pointer-events: none !important; }";
    doc.head.appendChild(noHover);
    try {
      await new Promise((r) => setTimeout(r, 150));
      // Slow luxury marquees crawl (~8px/s): sample two LONG intervals and use
      // a small threshold, or real tickers fall under the noise floor.
      const s0 = new Map<Element, [number, number] | null>();
      const s1 = new Map<Element, [number, number] | null>();
      for (const n of chain) s0.set(n, txOf(n));
      await new Promise((r) => setTimeout(r, 600));
      for (const n of chain) s1.set(n, txOf(n));
      await new Promise((r) => setTimeout(r, 600));
      const dist = (
        a: [number, number] | null | undefined,
        b: [number, number] | null | undefined,
      ) => (!a || !b ? 0 : Math.abs(b[0]! - a[0]!) + Math.abs(b[1]! - a[1]!));
      for (const n of chain) {
        if (dist(s0.get(n), s1.get(n)) <= 1.5) continue;
        if (dist(s1.get(n), txOf(n)) <= 1.5) continue;
        if (n.children.length < 3) continue;
        const r = n.getBoundingClientRect();
        if (r.width > w.innerWidth * 1.2 || r.height > w.innerHeight * 1.2) continue;
        if (/^(main|body|html)$/i.test(n.tagName)) continue;
        return n;
      }
      return el;
    } finally {
      noHover.remove();
    }
  };

  const LAYOUT_PROPS = [
    "display",
    "position",
    "width",
    "height",
    "maxWidth",
    "minWidth",
    "maxHeight",
    "minHeight",
    "marginTop",
    "marginRight",
    "marginBottom",
    "marginLeft",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "boxSizing",
    "overflow",
    "overflowX",
    "overflowY",
    "zIndex",
    "top",
    "right",
    "bottom",
    "left",
    "aspectRatio",
    "objectFit",
    "objectPosition",
    "flexDirection",
    "flexWrap",
    "justifyContent",
    "alignItems",
    "alignContent",
    "gap",
    "rowGap",
    "columnGap",
    "flexGrow",
    "flexShrink",
    "flexBasis",
    "order",
    "alignSelf",
    "justifySelf",
    "gridTemplateColumns",
    "gridTemplateRows",
    "gridAutoFlow",
    "justifyItems",
    "gridColumn",
    "gridRow",
    "textAlign",
    "backgroundColor",
    "backgroundImage",
    "color",
    "borderRadius",
    "boxShadow",
    "opacity",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor",
    "borderStyle",
    "verticalAlign",
  ];
  // Resolved typography. Sites (Framer et al.) size headline text through
  // container/media queries based on a small base size; outside that context
  // the text falls back to the base and renders tiny with wrong spacing.
  // Inlining the computed values makes the captured piece look exactly like
  // the preview, whatever the query context.
  const TYPO_PROPS = [
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "lineHeight",
    "letterSpacing",
    "textTransform",
    "whiteSpace",
    "textShadow",
    "textWrap",
    "WebkitTextStrokeWidth",
    "WebkitTextStrokeColor",
    "textDecorationLine",
  ];
  const camelToKebab = (s: string) => s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  const SKIP_VALUES = new Set(["auto", "none", "static", "normal", "visible", ""]);
  // Selectors whose rules size boxes in viewport units. The app renders the
  // preview iframe scaled via transform, which inflates 100vh (a 700px-tall
  // panel reports ~935px) — baking that computed pixel value froze sections
  // at the wrong height once exported. Such boxes stay responsive instead:
  // the copied stylesheet rule keeps applying in the clone. Same for every
  // VERTICAL prop (top/margins/paddings): baked px from the tall iframe
  // shifted whole content blocks once the user opened the file in their own
  // (shorter) window — the full-page ZIP never had this problem because the
  // site's scripts recompute layout at the real viewport.
  type VpRule = { sel: string; props: Set<string> };
  const VP_VERT = new Set([
    "height",
    "min-height",
    "max-height",
    "top",
    "bottom",
    "margin-top",
    "margin-bottom",
    "padding-top",
    "padding-bottom",
  ]);
  const VP_UNIT_RE = /(vh|vw|vmin|vmax|dvh|svh|lvh)/;
  let vpUnitRulesCache: VpRule[] | null = null;
  const vpUnitRules = (): VpRule[] => {
    if (vpUnitRulesCache) return vpUnitRulesCache;
    const out: VpRule[] = [];
    for (const sheet of Array.from(doc.styleSheets)) {
      let rules: CSSRuleList | undefined;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      if (!rules) continue;
      const walk = (list: CSSRuleList) => {
        for (const rule of Array.from(list)) {
          if (rule.type === 4) {
            walk((rule as CSSMediaRule).cssRules);
            continue;
          }
          const sr = rule as CSSStyleRule;
          if (!sr.style || !sr.selectorText) continue;
          const props = new Set<string>();
          for (let k = 0; k < sr.style.length; k++) {
            const name = sr.style[k]!;
            if (!VP_VERT.has(name)) continue;
            const v = sr.style.getPropertyValue(name);
            if (v && VP_UNIT_RE.test(v)) props.add(name);
          }
          if (props.size) out.push({ sel: sr.selectorText, props });
        }
      };
      walk(rules);
    }
    vpUnitRulesCache = out;
    return out;
  };
  const sizedByViewport = (el: Element, kebabProp: string): boolean => {
    let spec = "";
    try {
      spec = (el as HTMLElement).style?.getPropertyValue(kebabProp) || "";
    } catch {
      /* SVG etc. */
    }
    if (VP_UNIT_RE.test(spec)) return true;
    return vpUnitRules().some((r) => {
      if (!r.props.has(kebabProp)) return false;
      try {
        return el.matches(r.sel);
      } catch {
        return false;
      }
    });
  };
  const inlineComputed = (el: Element, extra: string[] = []): string => {
    const cs = getComputedStyle(el);
    // A border with zero width on every side means the color/style props are
    // default noise — skip the whole border group for such elements.
    const hasBorder =
      cs.getPropertyValue("border-top-width") !== "0px" ||
      cs.getPropertyValue("border-left-width") !== "0px";
    const parts: string[] = [];
    for (const p of [...LAYOUT_PROPS, ...extra]) {
      // getPropertyValue expects the kebab-case CSS name (camelCase returns
      // "" for multi-word properties in Chrome, silently dropping them).
      const v = cs.getPropertyValue(camelToKebab(p));
      if (!v || SKIP_VALUES.has(v)) continue;
      if (p === "position" && v === "static") continue;
      // Don't inline "no background" or resolved-transparent colors.
      if (p === "backgroundColor" && (v === "rgba(0, 0, 0, 0)" || v === "transparent")) continue;
      // Only inline gradients; url() images resolve to proxy URLs / data URIs
      // that are huge or broken outside the preview — let the site's CSS (kept
      // in the ZIP) handle image backgrounds.
      if (p === "backgroundImage" && v.includes("url(")) continue;
      if (p === "opacity" && v === "1") continue;
      // Zero-width borders make color/style props default noise, but radius is
      // independent of borders — photos rounded via inherit/class chains lose
      // their radius if it's skipped here.
      if ((p.endsWith("Color") || p === "borderStyle") && !hasBorder) continue;
      // Viewport-sized vertical props keep their unit (see sizedByViewport) —
      // the capture viewport is the app's scaled iframe, not the user's window.
      const kebab = camelToKebab(p);
      if (VP_VERT.has(kebab)) {
        let spec = "";
        try {
          spec = (el as HTMLElement).style?.getPropertyValue(kebab) || "";
        } catch {
          /* SVG etc. */
        }
        // Inline vh/vw values are preserved verbatim ("height: 100vh") —
        // dropping them made sections fall back to smaller stylesheet
        // min-heights; baking computed px froze them at iframe height.
        if (VP_UNIT_RE.test(spec)) {
          parts.push(`${kebab}: ${spec};`);
          continue;
        }
        if (sizedByViewport(el, kebab)) continue;
      }
      parts.push(`${kebab}: ${v};`);
    }
    return parts.join(" ");
  };
  // Elements with direct text content get typography inlined too (Framer text
  // nodes are leaves or text + <br>).
  const hasDirectText = (el: Element) =>
    Array.from(el.childNodes).some((n) => n.nodeType === 3 && !!n.textContent?.trim());
  const needsTypo = (el: Element) =>
    hasDirectText(el) ||
    (typeof el.classList !== "undefined" && el.classList.contains("framer-text")) ||
    /^(H[1-6]|P|SPAN|A|LI|DT|DD|BLOCKQUOTE|FIGCAPTION|BUTTON|LABEL)$/i.test(el.tagName);
  // Rules gated on classes living OUTSIDE the capture root (html/body-level
  // state like ".loaded .x { transform: scale(1) }") keep matching their base
  // branch in the export — the gate class is gone, so pre-load states
  // (scale/opacity offsets) stick forever and shift elements. For elements a
  // gated rule targets, the current computed values are materialized inline,
  // overriding whatever stale branch the exported CSS would pick.
  let gateRules: { sel: string; props: string[] }[] | null = null;
  // Gate candidates also include EVERY ancestor class of the picked subtree
  // (div.app/.page wrappers gate reveals too, not just html/body).
  const gateExtra = new Set<string>();
  // Structural ancestor classes (wrappers between the pick and <body>) are
  // re-created on the export wrapper so descendant rules like
  // ".framer-V7F88 .framer-15cgbio { height: 100vh }" match again — without
  // them the section lost its viewport height and collapsed to min-height.
  const contextClasses = new Set<string>();
  const gateSelectorRules = (): { sel: string; props: string[] }[] => {
    if (gateRules) return gateRules;
    const out: { sel: string; props: string[] }[] = [];
    const gates = new Set<string>();
    for (const cls of (doc.documentElement.className + " " + doc.body.className).split(/\s+/)) {
      if (cls) gates.add(cls);
    }
    for (const cls of gateExtra) gates.add(cls);
    if (gates.size) {
      for (const sheet of Array.from(doc.styleSheets)) {
        let rules: CSSRuleList | undefined;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        if (!rules) continue;
        const walk = (list: CSSRuleList) => {
          for (const rule of Array.from(list)) {
            if (rule.type === 4) {
              walk((rule as CSSMediaRule).cssRules);
              continue;
            }
            const sr = rule as CSSStyleRule;
            if (!sr.style || !sr.selectorText || !sr.selectorText.includes(" ")) continue;
            let gated = false;
            for (const g of gates) {
              if (sr.selectorText.includes("." + g)) {
                gated = true;
                break;
              }
            }
            if (!gated) continue;
            const props: string[] = [];
            for (let k = 0; k < sr.style.length; k++) {
              const name = sr.style[k]!;
              if (name.startsWith("--")) continue;
              // Only animation-state props are safe to materialize. On Framer
              // nearly every selector carries wrapper classes, so treating all
              // of them as gates and baking layout props froze dynamic layout
              // (17px shifts). Layout stays responsive; only reveal state is
              // pinned.
              if (
                name === "transform" ||
                name === "translate" ||
                name === "rotate" ||
                name === "scale" ||
                name === "opacity" ||
                name === "filter" ||
                name === "clip-path" ||
                name === "visibility" ||
                name === "display" ||
                name.startsWith("animation") ||
                name.startsWith("transition")
              ) {
                props.push(name);
              }
            }
            if (props.length) out.push({ sel: sr.selectorText, props });
          }
        };
        walk(rules);
      }
    }
    gateRules = out;
    return out;
  };
  // Deep-inline the computed layout of the LIVE subtree onto a matching clone,
  // so the captured piece is self-contained and pixel-faithful even though
  // Framer/etc. put layout in class-based CSS that depends on ancestors that
  // aren't captured (this also fixes flex-direction/gap and section width).
  const inlineTreeMarked = (nodes: Element[], pairs: Map<number, HTMLElement>): void => {
    const gated = gateSelectorRules();
    for (const [k, c] of pairs) {
      const l = nodes[k];
      // A node replaced by the site mid-capture is detached — its computed
      // style would be garbage defaults, so skip it.
      if (!l || !l.isConnected) continue;
      const own = c.getAttribute("style") || "";
      const comp = inlineComputed(l, needsTypo(l) ? TYPO_PROPS : []);
      // Materialize out-of-root gated state (defaults included — transform
      // "none" must still override a stale pre-load scale in the export).
      let extra = "";
      for (const g of gated) {
        let m = false;
        try {
          m = l.matches(g.sel);
        } catch {
          continue;
        }
        if (!m) continue;
        const cs2 = getComputedStyle(l);
        for (const name of g.props) extra += `${name}: ${cs2.getPropertyValue(name)};`;
      }
      if (comp || extra) c.setAttribute("style", (own ? own + ";" : "") + comp + extra);
    }
  };
  // Strip picker artifacts (data-cp-old / leftover hover outline) recursively.
  const cleanCapture = (el: HTMLElement): string => {
    const clone = el.cloneNode(true) as HTMLElement;
    const walk = (n: Element) => {
      n.removeAttribute("data-cp-old");
      n.removeAttribute("data-cp-i");
      if ((n.getAttribute("style") || "").trim() === "") n.removeAttribute("style");
      for (const c of Array.from(n.children)) walk(c);
    };
    walk(clone);
    return clone.outerHTML;
  };

  // --- Animation capture -------------------------------------------------
  // JS-driven animations (Framer variants, GSAP/motion) set styles via inline
  // style updates that are lost when only the static HTML is cloned. Two
  // techniques bring them back as pure CSS:
  //   hover  — simulate mouseover/mouseout, diff computed styles, emit scoped
  //            `:hover` rules (pure-CSS hover already survives via the site's
  //            retained stylesheets).
  //   scroll — sample animated props across scroll positions, emit @keyframes
  //            driven by `animation-timeline: scroll()` (GSAP/ScrollTrigger
  //            entrance + scrub replays as a CSS scroll timeline).
  const ANIM_PROPS = [
    "transform",
    "translate",
    "rotate",
    "scale",
    "opacity",
    "backgroundColor",
    "color",
    "boxShadow",
    "filter",
    "outline",
    "borderColor",
    "borderWidth",
    "width",
    "height",
    "top",
    "right",
    "bottom",
    "left",
    "marginTop",
    "marginRight",
    "marginBottom",
    "marginLeft",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderRadius",
    "letterSpacing",
  ];
  const tick = () =>
    new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const flatNodes = (root: Element): Element[] => {
    const out: Element[] = [];
    const walk = (n: Element) => {
      out.push(n);
      for (const c of Array.from(n.children)) walk(c);
    };
    walk(root);
    return out;
  };
  const readAnims = (nodes: Element[]): string[][] =>
    nodes.map((n) => {
      const cs = getComputedStyle(n);
      return ANIM_PROPS.map((p) => cs.getPropertyValue(camelToKebab(p)));
    });
  // Fire the full enter/leave sequence: React's mouseenter/leave emulation runs
  // on mouseover/mouseout while Framer motion's hover runs on pointer events.
  const fireEnter = (el: Element) => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
  };
  const fireLeave = (el: Element) => {
    el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
  };
  // Hover replay: only visual props survive as :hover rules. Layout props
  // (height/width/position/… ) captured mid-layout-shift are artifacts that
  // the frozen inline layout (min-height etc.) won't honor faithfully.
  const HOVER_PROPS = [
    "transform",
    "translate",
    "rotate",
    "scale",
    "opacity",
    "backgroundColor",
    "color",
    "boxShadow",
    "filter",
    "outline",
    "borderColor",
  ];
  const HOVER_IDX = HOVER_PROPS.map((p) => ANIM_PROPS.indexOf(p));
  const OP_IDX = ANIM_PROPS.indexOf("opacity");
  // JS-driven continuous animations (GSAP/motion rAF loops — e.g. a rotating
  // photo ring) never appear in getAnimations(), and their per-frame inline
  // transform gets frozen mid-angle in the clone ("vertical became
  // horizontal"). Sample transforms twice: an element rotating at constant
  // speed is replayed as an infinite linear CSS spin starting at the same
  // angle, which also overrides the frozen baked transform.
  const parseMatrix = (t: string): number[] | null => {
    const m = t.match(/^matrix\(([^)]+)\)$/);
    const v = m && m[1] ? m[1].split(",").map((x) => parseFloat(x)) : null;
    return v && v.length === 6 && v.every((x) => isFinite(x)) ? v : null;
  };
  // Entrance/reveal animations (fade-slide-in on load) are finite WAAPI
  // animations. Record their keyframes as CSS that replays on load in the
  // clone, then finish() them so every later computed read (base inline,
  // hover/scroll baselines) sees the settled final state instead of a
  // mid-entrance snapshot (baked half-faded, offset text).
  const captureEntranceAnimations = async (nodes: Element[]): Promise<Map<number, string>> => {
    const out = new Map<number, string>();
    const index = new Map<Element, number>();
    nodes.forEach((n, i) => index.set(n, i));
    const anims = doc.getAnimations().filter((a) => {
      const t = (a.effect as KeyframeEffect | null)?.target;
      if (!t || !index.has(t)) return false;
      if ((a as CSSTransition).transitionProperty) return false;
      try {
        const timing = (a.effect as KeyframeEffect).getTiming();
        if (timing.iterations !== 1) return false;
        const end = Number((a as unknown as { endTime: number }).endTime);
        if (!isFinite(end)) return false;
      } catch {
        return false;
      }
      return true;
    });
    for (const a of anims) {
      try {
        const t = (a.effect as KeyframeEffect).target!;
        const idx = index.get(t)!;
        const kfs = (a as unknown as { getKeyframes(): Keyframe[] }).getKeyframes();
        const timing = (a.effect as KeyframeEffect).getTiming();
        const dur = Number(timing.duration) || 0;
        if (!out.has(idx) && kfs.length >= 2 && dur > 0) {
          const stops: string[] = [];
          for (const kf of kfs) {
            if (kf.offset == null) continue;
            const props: string[] = [];
            for (const [name, value] of Object.entries(kf)) {
              if (name === "offset" || name === "composite" || name === "easing") continue;
              if (value == null) continue;
              props.push(`${camelToKebab(name)}: ${Array.isArray(value) ? value[0] : value};`);
            }
            if (!props.length) continue;
            const ease =
              kf.easing && kf.easing !== "ease"
                ? "animation-timing-function: " + kf.easing + "; "
                : "";
            stops.push(`${Math.round(kf.offset * 100)}% { ${ease}${props.join(" ")} }`);
          }
          if (stops.length >= 2) {
            const delay = Number(timing.delay) || 0;
            const easing = timing.easing && timing.easing !== "ease" ? timing.easing : "ease";
            out.set(
              idx,
              `@keyframes cp-e${idx} { ${stops.join(" ")} } #cp-root .cp-a${idx} { animation: cp-e${idx} ${Math.round(dur)}ms ${easing} ${Math.round(delay)}ms both; }`,
            );
          }
        }
        a.finish();
      } catch {
        /* finish() can throw on drives already released — ignore */
      }
    }
    await tick();
    return out;
  };
  const captureTimeAnimations = async (
    nodes: Element[],
  ): Promise<{ rules: Map<number, string>; animated: Set<number> }> => {
    const animated = new Set<number>();
    const rules = new Map<number, string>();
    // Hover-slowed tickers would be measured at ~10% speed (the pick click
    // leaves the cursor on the element), producing wrong marquee durations.
    // Suspend pointer events so :hover clears and JS hover handlers fire
    // mouseleave, then measure at true speed.
    const noHover = doc.createElement("style");
    noHover.textContent = "html, body { pointer-events: none !important; }";
    doc.head.appendChild(noHover);
    await new Promise((r) => setTimeout(r, 150));
    try {
      const s0 = nodes.map((n) => getComputedStyle(n).transform);
      await new Promise((r) => setTimeout(r, 320));
      const dt = 0.32;
      const s1 = nodes.map((n) => getComputedStyle(n).transform);
      await new Promise((r) => setTimeout(r, 320));
      const s2 = nodes.map((n) => getComputedStyle(n).transform);
      for (let i = 0; i < nodes.length; i++) {
        const t0 = s0[i];
        const t1 = s1[i];
        if (!t0 || !t1 || t0 === "none" || t1 === "none" || t0 === t1) continue;
        const m0 = parseMatrix(t0);
        const m1 = parseMatrix(t1);
        if (!m0 || !m1) continue;
        // Linear translation drift (Framer Ticker marquees: rAF writes
        // translateX inline every frame, so no WAAPI/CSS animation exists to
        // copy). Require the drift to repeat consistently across a second
        // interval — one-off transitions don't pass. Then rebuild it as an
        // infinite CSS marquee stepping exactly one repeated child (item +
        // gap), which loops seamlessly.
        const dx0 = m1[4]! - m0[4]!;
        const dy0 = m1[5]! - m0[5]!;
        if (Math.abs(dx0) > 1 || Math.abs(dy0) > 1) {
          const m2 = parseMatrix(s2[i]!);
          if (m2) {
            const dx1 = m2[4]! - m1[4]!;
            const dy1 = m2[5]! - m1[5]!;
            const steady =
              Math.abs(dx1 - dx0) < Math.max(0.6, Math.abs(dx0) * 0.35) &&
              Math.abs(dy1 - dy0) < Math.max(0.6, Math.abs(dy0) * 0.35);
            const sc0m = Math.hypot(m0[0]!, m0[1]!);
            const sc1m = Math.hypot(m1[0]!, m1[1]!);
            const rigid = Math.abs(sc0m - sc1m) <= 1e-3 * Math.max(1, sc0m);
            const el = nodes[i]!;
            const kid = el.firstElementChild as HTMLElement | null;
            const kid2 = (kid?.nextElementSibling as HTMLElement | null) ?? null;
            if (steady && rigid && kid && kid2) {
              const step =
                Math.abs(kid2.offsetLeft - kid.offsetLeft) ||
                Math.abs(kid2.offsetTop - kid.offsetTop);
              const speed = Math.hypot(dx0 / dt, dy0 / dt);
              if (step > 8 && step < 4000 && speed > 2) {
                const dur = step / speed;
                if (isFinite(dur) && dur >= 0.3 && dur <= 600) {
                  const sx = dx0 < 0 ? -step : step;
                  const sy = dy0 < 0 ? -step : step;
                  const tx = Math.abs(dx0) >= Math.abs(dy0) ? sx : 0;
                  const ty = Math.abs(dx0) >= Math.abs(dy0) ? 0 : sy;
                  rules.set(
                    i,
                    `@keyframes cp-yk${i} { from { transform: translate3d(0, 0, 0); } to { transform: translate3d(${tx}px, ${ty}px, 0); } }\n` +
                      `#cp-root .cp-y${i} { animation: cp-yk${i} ${dur.toFixed(3)}s linear infinite; }`,
                  );
                  animated.add(i);
                  continue;
                }
              }
            }
          }
          continue;
        }
        // Rotation-only drift: translation and scale must be unchanged.
        const sc0 = Math.hypot(m0[0]!, m0[1]!);
        const sc1 = Math.hypot(m1[0]!, m1[1]!);
        if (Math.abs(sc0 - sc1) > 1e-4 * Math.max(1, sc0)) continue;
        const a0 = Math.atan2(m0[1]!, m0[0]!);
        const a1 = Math.atan2(m1[1]!, m1[0]!);
        let dA = a1 - a0;
        if (dA > Math.PI) dA -= 2 * Math.PI;
        if (dA < -Math.PI) dA += 2 * Math.PI;
        if (Math.abs(dA) < 0.008) continue;
        const omega = dA / dt;
        const period = Math.abs((2 * Math.PI) / omega);
        if (!isFinite(period) || period < 0.4 || period > 600) continue;
        const th1 = a0 + (dA > 0 ? 2 : -2) * Math.PI;
        const f = (th: number) =>
          `matrix(${Math.cos(th) * sc0}, ${Math.sin(th) * sc0}, ${-Math.sin(th) * sc0}, ${Math.cos(th) * sc0}, ${m0[4]}, ${m0[5]})`;
        rules.set(
          i,
          `@keyframes cp-tk${i} { from { transform: ${f(a0)}; } to { transform: ${f(th1)}; } }\n` +
            `#cp-root .cp-t${i} { animation: cp-tk${i} ${period.toFixed(3)}s linear infinite; }`,
        );
        animated.add(i);
      }
      return { rules, animated };
    } finally {
      noHover.remove();
    }
  };
  // Continuous animations that DO exist as Web Animations API objects —
  // marquees/pulses driven by element.animate() with infinite iterations
  // (GSAP-style loops on non-Framer sites). Their keyframes are exact, so
  // they can be copied verbatim instead of reconstructed from drift. CSS
  // animations/transitions are skipped: those already survive via the
  // copied stylesheets and materialized animation-* properties.
  const captureWAAPIInfinite = async (
    nodes: Element[],
  ): Promise<{ rules: Map<number, string>; animated: Set<number> }> => {
    const animated = new Set<number>();
    const rules = new Map<number, string>();
    const index = new Map<Element, number>();
    nodes.forEach((n, k) => index.set(n, k));
    for (const a of doc.getAnimations()) {
      try {
        let eff: KeyframeEffect | null = null;
        let i = -1;
        let dur = 0;
        let ease = "linear";
        if (a instanceof CSSAnimation) continue;
        if (a instanceof CSSTransition) continue;
        if (a.playState !== "running") continue;
        if (a.timeline !== doc.timeline) continue;
        eff = a.effect as KeyframeEffect | null;
        if (!eff || !eff.target) continue;
        const ni = index.get(eff.target);
        if (ni === undefined) continue;
        const timing = eff.getTiming();
        if (timing.iterations !== Infinity) continue;
        dur = typeof timing.duration === "number" ? timing.duration : 0;
        if (!dur || dur < 100 || dur > 600000) continue;
        i = ni;
        ease = timing.easing && timing.easing !== "ease" ? timing.easing : "linear";
        const parts: string[] = [];
        const seenOffsets = new Set<number>();
        let ok = true;
        for (const kf of eff.getKeyframes()) {
          // Keyframes created via element.animate() usually omit explicit
          // offsets — computedOffset carries the resolved 0..1 position.
          const rawOff = kf.computedOffset ?? kf.offset ?? 0;
          const off = Math.round(rawOff * 1000) / 1000;
          if (seenOffsets.has(off)) continue;
          const decls: string[] = [];
          for (const p of Object.keys(kf)) {
            if (p === "offset" || p === "computedOffset" || p === "easing" || p === "composite")
              continue;
            const v = (kf as Record<string, string | null>)[p];
            if (v == null || v === "") continue;
            if (!/^(transform|opacity|filter|clipPath)$/.test(p)) {
              ok = false;
              break;
            }
            decls.push(`${camelToKebab(p)}: ${v};`);
          }
          if (!ok || !decls.length) {
            ok = false;
            break;
          }
          seenOffsets.add(off);
          parts.push(`${Math.round(off * 1000) / 10}% { ${decls.join(" ")} }`);
        }
        if (!ok || parts.length < 2) continue;
        rules.set(
          i,
          `@keyframes cp-wk${i} { ${parts.join(" ")} }\n` +
            `#cp-root .cp-w${i} { animation: cp-wk${i} ${(dur / 1000).toFixed(3)}s ${ease} infinite; }`,
        );
        animated.add(i);
      } catch {
        /* unreadable animation — skip */
      }
    }
    return { rules, animated };
  };
  const captureHoverStyles = async (
    root: Element,
    nodes: Element[],
    skip?: Set<number>,
  ): Promise<Map<number, { trig: number; props: Map<string, string> }>> => {
    // Reset any JS-driven hover state so the baseline is the unhovered look.
    fireLeave(root);
    await tick();
    const index = new Map<Element, number>();
    nodes.forEach((n, k) => index.set(n, k));
    const base = readAnims(nodes);
    // Keyed by the CHANGED element; also records WHICH element was hovered
    // (the trigger). Group-hover patterns (hover a card, its label dims)
    // need the real trigger or the emitted :hover rule can never fire.
    const out = new Map<number, { trig: number; props: Map<string, string> }>();
    // Hover effects (Framer variants, group-hover dimming) act on the hovered
    // node, its siblings and ancestors — diffing just that neighborhood keeps
    // the sweep affordable on big subtrees (a full re-read of every node per
    // hover made large sections take minutes and time out the pick).
    const scopeOf = (idx: number): number[] => {
      const scope = new Set<number>([idx]);
      let n: Element | null = nodes[idx]!;
      for (let depth = 0; n && depth < 5; depth++) {
        const p: Element | null = n.parentElement;
        const pi = p ? index.get(p) : undefined;
        if (!p || pi === undefined) break;
        scope.add(pi);
        for (const c of Array.from(p.children)) {
          const ci = index.get(c);
          if (ci !== undefined) scope.add(ci);
        }
        n = p;
      }
      return Array.from(scope);
    };
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      fireEnter(n);
      await tick();
      const scope = scopeOf(i);
      const now = scope.map((j) => {
        const cs = getComputedStyle(nodes[j]!);
        return HOVER_IDX.map((hi) => cs.getPropertyValue(camelToKebab(ANIM_PROPS[hi]!)));
      });
      for (let k = 0; k < scope.length; k++) {
        const j = scope[k]!;
        // Time-driven spinners contaminate every diff with drift — excluded.
        if (skip?.has(j)) continue;
        // Skip elements that are invisible (opacity < 0.5) at baseline —
        // their "hover delta" is really a group-hover dim/blur artifact
        // that per-element :hover rules can't replay faithfully.
        const baseOpacity = parseFloat(base[j]![OP_IDX]!);
        if (!Number.isNaN(baseOpacity) && baseOpacity < 0.5) continue;
        for (let hi = 0; hi < HOVER_IDX.length; hi++) {
          const pi = HOVER_IDX[hi]!;
          if (now[k]![hi] !== base[j]![pi]) {
            const prev = out.get(j);
            if (prev && prev.trig === i) {
              prev.props.set(ANIM_PROPS[pi]!, now[k]![hi]!);
            } else {
              out.set(j, { trig: i, props: new Map([[ANIM_PROPS[pi]!, now[k]![hi]!]]) });
            }
          }
        }
      }
      fireLeave(n);
      await tick();
    }
    return out;
  };
  const captureScrollAnimations = async (
    root: Element,
    nodes: Element[],
    skip?: Set<number>,
  ): Promise<Map<number, { rows: string[][]; prog: number[] }>> => {
    const scroller = (doc.scrollingElement || doc.documentElement) as HTMLElement;
    const orig = scroller.scrollTop;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const box = root.getBoundingClientRect();
    const start = Math.max(0, orig - box.height - 800);
    const end = Math.min(max, orig + box.height * 2 + 800);
    if (end - start < 200) return new Map();
    // Each sample is tagged with the root's VIEW progress (0 = entering the
    // viewport, 1 = leaving). The clone replays the animation against a
    // view-timeline on #cp-root — scroll(root) progress would be meaningless
    // in a standalone export whose page is only as tall as the section.
    const docY = box.top + orig;
    const vh = scroller.clientHeight;
    const denom = Math.max(1, vh + box.height);
    const N = 9;
    const samples: string[][][] = [];
    const progs: number[] = [];
    for (let s = 0; s < N; s++) {
      const y = start + ((end - start) * s) / (N - 1);
      scroller.scrollTop = y;
      await tick();
      await tick();
      samples.push(readAnims(nodes));
      progs.push(Math.min(1, Math.max(0, (y - (docY - vh)) / denom)));
    }
    scroller.scrollTop = orig;
    await tick();
    const out = new Map<number, { rows: string[][]; prog: number[] }>();
    const opIdx = ANIM_PROPS.indexOf("opacity");
    for (let j = 0; j < nodes.length; j++) {
      if (skip?.has(j)) continue;
      const rows = samples.map((s) => s[j]!);
      let animated = false;
      for (let p = 0; p < ANIM_PROPS.length && !animated; p++) {
        if (new Set(rows.map((r) => r[p])).size > 1) animated = true;
      }
      // Entrance reveals (opacity climbs from ~0) used to be dropped
      // entirely: with no scroll room in a standalone export they would have
      // frozen invisible. The standalone runway now provides scroll room and
      // the prog mapping mirrors the live scroll position, so they replay as
      // scroll-driven fades — this is where most of a section's visible
      // motion lives. Only skip elements still hidden at the END of the
      // range (states never meant to be seen, e.g. headers faded out while
      // scrolling away).
      const lastOp = parseFloat(rows[rows.length - 1]![opIdx]!);
      const endHidden = !Number.isNaN(lastOp) && lastOp < 0.5;
      if (animated && !endHidden) out.set(j, { rows, prog: progs });
    }
    return out;
  };
  // Turn the captured deltas/scroll-samples into CSS rules and tag the matching
  // clone nodes via the marker pair map (mutation-proof, see captureHtml).
  const applyAnimStyles = (
    nodes: Element[],
    pairs: Map<number, HTMLElement>,
    hover: Map<number, { trig: number; props: Map<string, string> }>,
    scroll: Map<number, { rows: string[][]; prog: number[] }>,
    time?: Map<number, string>,
    entrance?: Map<number, string>,
    preState?: WeakMap<Element, { o: string; t: string; f: string }>,
  ): string => {
    if (
      hover.size === 0 &&
      scroll.size === 0 &&
      (!time || time.size === 0) &&
      (!entrance || entrance.size === 0) &&
      !preState
    )
      return "";
    const rules: string[] = [];
    if (scroll.size > 0) {
      // One shared view-timeline on the capture root; every cp-s animation
      // maps its keyframes onto the section's own visibility progression.
      rules.push("#cp-root { view-timeline-name: --cpv; view-timeline-axis: block; }");
    }
    const idxs = Array.from(pairs.keys()).sort((a, b) => a - b);
    for (const i of idxs) {
      const c = pairs.get(i)!;
      const l = nodes[i];
      if (!l || !l.isConnected) continue;
      const h = hover.get(i);
      const s = scroll.get(i);
      const t = time?.get(i);
      const e = entrance?.get(i);
      if (e) {
        c.classList.add("cp-a" + i);
        rules.push(e);
      }
      if (h && h.props.size) {
        // Skip hover states that hide the element (group-hover dimming) — the
        // captured "hovered" look must stay visible to be a usable :hover rule.
        const hOpacity = h.props.get("opacity");
        if (!hOpacity || parseFloat(hOpacity) >= 0.5) {
          c.classList.add("cp-h" + i);
          const st: string[] = [];
          for (const [p, v] of h.props) st.push(`${camelToKebab(p)}: ${v} !important;`);
          const cs = getComputedStyle(l);
          if (
            cs.transitionDuration &&
            cs.transitionDuration !== "0s" &&
            cs.transitionDuration !== "0ms"
          ) {
            st.push(`transition: ${cs.transition};`);
          }
          if (h.trig === i) {
            rules.push(`#cp-root .cp-h${i}:hover { ${st.join(" ")} }`);
          } else {
            // The change fires when a DIFFERENT element (ancestor card, sibling
            // link) is hovered — tag the real trigger and target both.
            const tc = pairs.get(h.trig);
            if (tc) {
              tc.classList.add("cp-g" + h.trig);
              rules.push(`#cp-root .cp-g${h.trig}:hover .cp-h${i} { ${st.join(" ")} }`);
            }
          }
        }
      }
      if (t) {
        // Marquee (cp-y), WAAPI-infinite (cp-w) and rotation (cp-t) rules
        // each carry their own class prefix.
        const cls = t.includes(`cp-yk${i}`) ? "cp-y" : t.includes(`cp-wk${i}`) ? "cp-w" : "cp-t";
        c.classList.add(cls + i);
        rules.push(t);
      }
      if (s) {
        c.classList.add("cp-s" + i);
        const N = s.rows.length;
        const frames: string[] = [];
        let lastPct = -1;
        for (let k = 0; k < N; k++) {
          const pct = Math.round(s.prog[k]! * 100);
          // Clamped tails collapse onto the same percentage — keep the first.
          if (pct === lastPct) continue;
          lastPct = pct;
          const props: string[] = [];
          const seen = new Set<string>();
          for (let p = 0; p < ANIM_PROPS.length; p++) {
            const v = s.rows[k]![p];
            if (v === s.rows[0]![p]) continue;
            const name = camelToKebab(ANIM_PROPS[p]!);
            if (seen.has(name)) continue;
            seen.add(name);
            props.push(`${name}: ${v};`);
          }
          frames.push(`${pct}% { ${props.join(" ")} }`);
        }
        rules.push(`@keyframes cp-k${i} { ${frames.join(" ")} }`);
        // Intro replay: appear/reveal effects run once when the element
        // first shows, and the scroll sweep's first frame captured that
        // pre-entrance look. Replay it as a one-shot time-driven animation
        // so a freshly opened file visibly animates in. The micro-script
        // adds .cp-go when the element first intersects the viewport, so
        // above-fold content plays its intro on load while deeper elements
        // reveal on scroll — mirroring the source behavior. The intro is
        // listed AFTER the scrub animation (last animation wins shared
        // props while active) with timelines mapped index-wise.
        const r0 = s.rows[0]!;
        const rN = s.rows[N - 1]!;
        const introProps: string[] = [];
        for (let p = 0; p < ANIM_PROPS.length; p++) {
          if (r0[p] !== rN[p]) introProps.push(`${camelToKebab(ANIM_PROPS[p]!)}: ${r0[p]};`);
        }
        if (introProps.length) {
          c.classList.add("cp-i" + i);
          rules.push(`@keyframes cp-ik${i} { from { ${introProps.join(" ")} } }`);
          rules.push(
            `#cp-root .cp-s${i} { animation: cp-k${i} linear both; animation-timeline: --cpv; }`,
          );
          rules.push(
            `#cp-root .cp-s${i}.cp-go { animation: cp-k${i} linear both, cp-ik${i} 900ms cubic-bezier(0.22, 1, 0.36, 1) both; animation-timeline: --cpv, auto; }`,
          );
        } else {
          rules.push(
            `#cp-root .cp-s${i} { animation: cp-k${i} linear both; animation-timeline: --cpv; }`,
          );
        }
      }
    }
    // Pre-state entrances: the preview records every element's FIRST-SEEN
    // computed opacity/transform/filter (usually the pre-reveal look Framer
    // renders before its runtime plays the entrance). Finished one-shot
    // animations have left getAnimations() long before a pick happens, which
    // is why whole sections exported completely static. Diffing first-seen vs
    // settled state recovers that reveal even when nothing was mid-flight.
    if (preState) {
      let pk = 0;
      const mat = (m: string): [number, number] => {
        const v = m.match(/matrix.*\((.+)\)/);
        if (!v) return [0, 0];
        const p = v[1]!.split(",").map(parseFloat);
        return [p[4] || 0, p[5] || 0];
      };
      for (const i of idxs) {
        const l = nodes[i];
        const c = pairs.get(i);
        if (!l || !l.isConnected || !c) continue;
        const st = preState.get(l);
        if (!st) continue;
        // Elements already carrying a synthesized animation keep it; don't
        // stack a second reveal on top.
        if (/(^| )cp-(a|e|s|w|t|y|h|g)\d/.test(c.getAttribute("class") || "")) continue;
        const cs = getComputedStyle(l);
        const co = cs.opacity;
        const ct = cs.transform;
        const cf = cs.filter;
        if (co === st.o && ct === st.t && cf === st.f) continue;
        const from: string[] = [];
        const to: string[] = [];
        let delta = false;
        if (st.o !== co && Math.abs(parseFloat(st.o || "1") - parseFloat(co)) > 0.02) {
          from.push(`opacity: ${st.o}`);
          to.push(`opacity: ${co}`);
          delta = true;
        }
        if (st.t !== ct) {
          const [ax, ay] = mat(st.t);
          const [bx, by] = mat(ct);
          if (Math.abs(ax - bx) + Math.abs(ay - by) > 24) {
            from.push(`transform: ${st.t === "none" ? "translate(0, 0)" : st.t}`);
            to.push(`transform: ${ct === "none" ? "translate(0, 0)" : ct}`);
            delta = true;
          }
        }
        if (st.f !== cf && st.f !== "none" && cf !== "none") {
          from.push(`filter: ${st.f}`);
          to.push(`filter: ${cf}`);
          delta = true;
        }
        if (!delta) continue;
        rules.push(
          `@keyframes cp-pk${i} { from { ${from.join("; ")}; } to { ${to.join("; ")}; } }`,
        );
        rules.push(
          `.cp-pk${i} { animation: cp-pk${i} 0.9s cubic-bezier(0.22, 0.61, 0.36, 1) both; animation-delay: ${Math.min(pk * 70, 700)}ms; }`,
        );
        c.classList.add("cp-pk" + i);
        pk++;
      }
    }
    return rules.join("\n");
  };
  // The visible background of a transparent element comes from its ancestors
  // (Framer sections are often transparent over <main>/<body>). Resolve the
  // nearest ancestor's solid background so the captured piece shows the same
  // backdrop it had in the preview.
  const effectiveBackground = (el: Element): string | null => {
    let node = el.parentElement;
    while (node) {
      const cs = getComputedStyle(node);
      const bg = cs.getPropertyValue("background-color");
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
      node = node.parentElement;
    }
    return null;
  };
  // Icons rendered via <use href="#id"> resolve against sprite <svg> templates
  // that usually live OUTSIDE the captured subtree (Framer keeps them in a
  // div#svg-templates at body level). Without their defs the <use> collapses
  // to 0x0 and the icon disappears. Copy any referenced-but-missing defs into
  // a hidden container at the top of the clone.
  // Relative link hrefs (./projects, /about) resolve against the export's own
  // location and 404. Rebase them onto the original site so the clone stays
  // navigable — canonical/og:url carry the real origin even behind the proxy.
  const absolutizeLinks = (clone: HTMLElement) => {
    let base: string | null = null;
    try {
      const canon = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
      if (canon) base = new URL(canon, doc.baseURI).origin + "/";
    } catch {
      /* malformed canonical */
    }
    if (!base) {
      try {
        const og = doc.querySelector('meta[property="og:url"]')?.getAttribute("content");
        if (og) base = new URL(og, doc.baseURI).origin + "/";
      } catch {
        /* malformed og:url */
      }
    }
    if (!base) return;
    for (const a of Array.from(clone.querySelectorAll("a[href]"))) {
      const href = a.getAttribute("href") || "";
      if (!href || href.startsWith("#") || /^[a-z]+:/i.test(href)) continue;
      try {
        a.setAttribute("href", new URL(href, base).href);
      } catch {
        /* unparseable href — leave as-is */
      }
    }
  };
  const copySvgDefs = (clone: Element) => {
    const cloneIds = new Set<string>();
    for (const e of Array.from(clone.querySelectorAll("[id]"))) cloneIds.add(e.id);
    const needed = new Set<string>();
    for (const u of Array.from(clone.querySelectorAll("use"))) {
      const href = u.getAttribute("href") || u.getAttribute("xlink:href") || "";
      if (href.startsWith("#")) needed.add(href.slice(1));
    }
    // also catch fill/clip-path/mask/filter="url(#id)" references
    const urlRef = /url\(["']?#([^"')]+)["']?\)/g;
    for (const e of Array.from(clone.querySelectorAll("*"))) {
      for (const a of Array.from(e.attributes)) {
        if (!a.value.includes("url(#")) continue;
        urlRef.lastIndex = 0;
        let m = urlRef.exec(a.value);
        while (m) {
          if (m[1]) needed.add(m[1]);
          m = urlRef.exec(a.value);
        }
      }
    }
    const host = doc.createElement("div");
    host.setAttribute("data-cp-sprites", "");
    host.style.display = "none";
    let added = 0;
    for (const id of needed) {
      if (cloneIds.has(id)) continue;
      const def = doc.getElementById(id);
      if (def) {
        host.appendChild(def.cloneNode(true));
        added++;
      }
    }
    if (added) clone.insertBefore(host, clone.firstChild);
  };
  const captureHtml = async (
    el: Element,
    onProgress?: (pct: number, label: string) => void,
  ): Promise<{ html: string; styles: string }> => {
    const prog = onProgress || ((): void => undefined);
    // Clear any JS-driven hover state (Framer dims/blurs sibling links while
    // one is hovered) so the captured base is the neutral "nothing hovered"
    // look instead of a frozen mid-interaction snapshot.
    fireLeave(el);
    await tick();
    // Ancestor classes feed gate detection; reset the cached stylesheet scan
    // because every pick has a different ancestor context.
    gateExtra.clear();
    contextClasses.clear();
    for (let a = el.parentElement; a && a !== doc.documentElement; a = a.parentElement) {
      for (const c of Array.from(a.classList)) gateExtra.add(c);
      // html/body classes are handled by gate materialization instead —
      // body-level classes (custom cursors, scroll locks) must not style the
      // export wrapper.
      if (a !== doc.body) {
        for (const c of Array.from(a.classList)) contextClasses.add(c);
      }
    }
    gateRules = null;
    // One shared node list keeps indices aligned across every sampler and the
    // final live/clone pairing walk. Marking the live nodes up-front makes the
    // pairing mutation-proof: scroll scenes can add/remove nodes during the
    // async sampling, which silently desynced positional walks (styles landing
    // on the wrong element — lost radii, display:contents reverted, shifted
    // headers).
    const nodes = flatNodes(el);
    const MARK = "data-cp-i";
    nodes.forEach((n, i) => n.setAttribute(MARK, String(i)));
    capturing = true;
    doc.documentElement.classList.add("clone-capturing");
    prog(10, "Menganalisis struktur…");
    let hover: Map<number, { trig: number; props: Map<string, string> }> = new Map();
    let scroll: Map<number, { rows: string[][]; prog: number[] }> = new Map();
    let time = { rules: new Map<number, string>(), animated: new Set<number>() };
    let clone!: HTMLElement;
    let styles = "";
    let entrance: Map<number, string> = new Map();
    try {
      prog(18, "Menangkap animasi masuk…");
      entrance = await captureEntranceAnimations(nodes);
      // rAF-driven marquees (Framer Ticker) pause while off-screen, and the
      // entrance pass can leave the viewport elsewhere — bring the section
      // back into view so continuous animations are actually running when
      // their drift gets sampled.
      el.scrollIntoView({ block: "center" });
      await new Promise((r) => setTimeout(r, 400));
      prog(38, "Menangkap animasi berjalan (marquee/spinner)…");
      time = await captureTimeAnimations(nodes);
      const waapi = await captureWAAPIInfinite(nodes);
      for (const [wi, wr] of waapi.rules) {
        if (!time.rules.has(wi)) time.rules.set(wi, wr);
      }
      for (const wi of waapi.animated) time.animated.add(wi);
      prog(52, "Menangkap efek hover…");
      hover = await captureHoverStyles(el, nodes, time.animated);
      prog(66, "Menangkap animasi scroll…");
      scroll = await captureScrollAnimations(el, nodes, time.animated);
      // Take the snapshot while still guarding the picker handlers: after the
      // scroll sweep Chrome synthesizes mouse events under the parked cursor,
      // which would re-apply the blue hover outline straight into the clone.
      if (hovered) {
        restore(hovered);
        hovered = null;
      }
      // Wait out async settling before snapshotting: React commits from the
      // scroll scenes, JS-driven reveals (GSAP/rAF inline writes) AND class-
      // gated CSS transitions (e.g. ".loaded .x { transform: scale(1) }" with
      // multi-second delays — invisible to inline-style diffs). Baking a
      // mid-transition frame froze elements scaled/offset ("positions not
      // tidy"). Signature uses COMPUTED transform/opacity; time-driven
      // spinners are excluded or it would never settle.
      const settleSig = () => {
        let s = String(flatNodes(el).length) + "#";
        for (let i = 0; i < nodes.length; i++) {
          if (time.animated.has(i)) continue;
          const cs = getComputedStyle(nodes[i]!);
          s += cs.transform + "|" + cs.opacity + ";";
        }
        return s;
      };
      // Finite animations/transitions still running anywhere in the subtree.
      const activeAnims = () => {
        let n = 0;
        for (const a of doc.getAnimations()) {
          const t = (a.effect as KeyframeEffect | null)?.target;
          if (!t || !el.contains(t)) continue;
          try {
            if ((a.effect as KeyframeEffect).getTiming().iterations === Infinity) continue;
          } catch {
            /* ignore */
          }
          if (a.playState === "running") n++;
        }
        return n;
      };
      let prevKey = "";
      let stableRounds = 0;
      prog(80, "Menunggu animasi stabil…");
      for (let i = 0; i < 18 && stableRounds < 2; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const act = activeAnims();
        const key = settleSig() + "#A" + act;
        if (key === prevKey && act === 0) stableRounds++;
        else {
          stableRounds = 0;
          prevKey = key;
        }
      }
      await tick();
      clone = el.cloneNode(true) as HTMLElement;
      // Pair clone nodes to live indices by marker; unmarked nodes (added by
      // the site mid-capture) are skipped instead of shifting every later pair.
      const pairs = new Map<number, HTMLElement>();
      const assign = (c: Element) => {
        const m = c.getAttribute(MARK);
        if (m !== null) {
          const k = Number(m);
          if (!pairs.has(k)) pairs.set(k, c as HTMLElement);
          c.removeAttribute(MARK);
        }
        for (const ch of Array.from(c.children)) assign(ch);
      };
      assign(clone);
      for (const n of nodes) n.removeAttribute(MARK);
      prog(92, "Merakit CSS & snapshot DOM…");
      inlineTreeMarked(nodes, pairs);
      // Videos: Framer writes a source URL WITHOUT the file extension into
      // the src attribute; its runtime resolves the real media URL into the
      // src property/currentSrc. A cloned attribute alone fails to load in
      // the export and only the poster shows ("the video became an image").
      // Bake the resolved URL into the attribute, then classify the clip the
      // way the source site treats it: ambient background loops (autoplay +
      // muted + playsinline, played/paused by viewport observers) versus
      // click-to-play players (poster shown, sound allowed, waits for a
      // click). Forcing autoplay on both made player clips start silently
      // moving on open — the export's micro-script reads data-cp-clickplay
      // and wires the same click interaction instead.
      for (let k = 0; k < nodes.length; k++) {
        const live = nodes[k]!;
        if (live.tagName !== "VIDEO") continue;
        const c = pairs.get(k);
        if (!c) continue;
        const v = live as HTMLVideoElement;
        const real = v.currentSrc || v.src;
        if (real) c.setAttribute("src", real);
        c.setAttribute("preload", "auto");
        // Classify from STATIC attributes only: runtime state is contaminated
        // by the capture itself (the scroll sweep / synthetic hover can
        // trigger the site's own play-on-view or play-on-hover logic, which
        // flips a player clip into an autoplaying one mid-capture). The
        // stable Framer signatures are: background loops ship muted +
        // playsinline and no poster; player clips ("Video file") ship a
        // poster and are not muted.
        const ambient =
          v.hasAttribute("muted") && v.hasAttribute("playsinline") && !v.hasAttribute("poster");
        if (ambient) {
          if (!c.hasAttribute("autoplay")) c.setAttribute("autoplay", "");
          if (!c.hasAttribute("muted")) c.setAttribute("muted", "");
          if (!c.hasAttribute("playsinline")) c.setAttribute("playsinline", "");
        } else {
          // The live DOM may have gained an autoplay attribute when the
          // site's own logic triggered the clip during capture — strip it so
          // a player clip never starts by itself.
          c.removeAttribute("autoplay");
          c.setAttribute("data-cp-clickplay", "");
        }
      }
      // First-seen pre-reveal states recorded by the preview's bootstrap
      // script (see CP_PRESTATE_SCRIPT) — lets the export replay entrances
      // that already finished before the pick started.
      const preState = (
        doc.defaultView as {
          __cpPre?: WeakMap<Element, { o: string; t: string; f: string }>;
        } | null
      )?.__cpPre;
      styles = applyAnimStyles(nodes, pairs, hover, scroll, time.rules, entrance, preState).trim();
      // Must run AFTER the pairing walks above — inserting the sprite
      // container earlier would add an unmarked child mid-walk.
      copySvgDefs(clone);
      absolutizeLinks(clone);
    } finally {
      doc.documentElement.classList.remove("clone-capturing");
      capturing = false;
    }
    const eff = effectiveBackground(el);
    // The wrapper always exists: it carries the parent's flex/grid context,
    // the inherited background, and the structural ancestor classes so
    // descendant stylesheet rules keep matching in the export.
    let st = "";
    const p = el.parentElement;
    if (p) {
      const pcs = getComputedStyle(p);
      const disp = pcs.getPropertyValue("display");
      if (disp === "flex" || disp === "inline-flex") {
        st = `display:flex;flex-direction:${pcs.flexDirection};flex-wrap:${pcs.flexWrap};justify-content:${pcs.justifyContent};align-items:${pcs.alignItems};align-content:${pcs.alignContent};`;
      } else if (disp === "grid" || disp === "inline-grid") {
        st = `display:grid;grid-template-columns:${pcs.gridTemplateColumns};justify-items:${pcs.justifyItems};align-items:${pcs.alignItems};justify-content:${pcs.justifyContent};align-content:${pcs.alignContent};`;
      }
    }
    if (eff) st += `background-color:${eff};`;
    // Context classes go on an inner display:contents wrapper: descendant
    // rules like ".framer-V7F88 .framer-15cgbio" still match, but rules
    // styling the context class ITSELF find no box to paint on — the outer
    // cp-root stays a neutral positioning parent.
    const ctx = Array.from(contextClasses).join(" ");
    const inner = ctx
      ? `<div class="${ctx}" style="display:contents;">${cleanCapture(clone)}</div>`
      : cleanCapture(clone);
    return {
      html: `<div id="cp-root" style="${st}">${inner}</div>`,
      styles,
    };
  };
  const label = (el: Element) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = el.getAttribute("class");
    if (cls) s += "." + String(cls).trim().split(/\s+/).slice(0, 3).join(".");
    return s;
  };

  let hovered: Element | null = null;
  let capturing = false;
  const isElem = (t: unknown): t is Element => !!t && (t as Element).nodeType === 1;
  const restore = (el: Element) =>
    el.setAttribute("style", (el.getAttribute("data-cp-old") || "").replace(/^;/, ""));
  const onOver = (e: Event) => {
    if (capturing) return;
    if (hovered) restore(hovered);
    hovered = null;
    const t = e.target;
    if (isElem(t)) {
      const el = resolve(t);
      if (!el.hasAttribute("data-cp-old"))
        el.setAttribute("data-cp-old", el.getAttribute("style") || "");
      el.setAttribute(
        "style",
        `${el.getAttribute("style") || ""};outline:2px solid #3b82f6 !important;outline-offset:-1px;`,
      );
      hovered = el;
    }
    e.stopPropagation();
  };
  const onOut = () => {
    if (capturing) return;
    if (hovered) restore(hovered);
    hovered = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
  };
  // Full-screen progress overlay shown while the capture runs. It is appended
  // to <html> (not <body>) so it stays visible even though the anti-glitch
  // rule hides body during the capture's scroll jumps — the user sees a
  // progress bar instead of a blank preview.
  const showCaptureProgress = () => {
    const root = doc.createElement("div");
    root.setAttribute("data-cp-progress", "");
    root.setAttribute(
      "style",
      "all:initial;position:fixed;inset:0;z-index:2147483647;background:#0b0f17;" +
        "display:flex;align-items:center;justify-content:center;" +
        "font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;",
    );
    const card = doc.createElement("div");
    card.setAttribute(
      "style",
      "width:min(420px,84vw);background:#111827;border:1px solid #1f2937;border-radius:16px;" +
        "padding:22px 24px;box-shadow:0 20px 60px rgba(0,0,0,.6);color:#e5e7eb;",
    );
    const head = doc.createElement("div");
    head.setAttribute("style", "display:flex;align-items:center;gap:10px;");
    const spin = doc.createElement("div");
    spin.setAttribute(
      "style",
      "width:18px;height:18px;border-radius:50%;border:2.5px solid #374151;border-top-color:#3b82f6;" +
        "animation:cp-spin .8s linear infinite;flex:none;",
    );
    const title = doc.createElement("div");
    title.textContent = "Menangkap pilihan…";
    title.setAttribute("style", "font-size:14px;font-weight:600;color:#f9fafb;");
    head.appendChild(spin);
    head.appendChild(title);
    const status = doc.createElement("div");
    status.textContent = "Bersiap…";
    status.setAttribute("style", "font-size:12.5px;color:#9ca3af;margin-top:8px;min-height:17px;");
    const track = doc.createElement("div");
    track.setAttribute(
      "style",
      "margin-top:14px;height:8px;background:#1f2937;border-radius:999px;overflow:hidden;",
    );
    const fill = doc.createElement("div");
    fill.setAttribute(
      "style",
      "height:100%;width:0%;border-radius:inherit;background:linear-gradient(90deg,#3b82f6,#22d3ee);" +
        "transition:width .35s ease;",
    );
    track.appendChild(fill);
    const pct = doc.createElement("div");
    pct.textContent = "0%";
    pct.setAttribute("style", "font-size:11px;color:#6b7280;margin-top:6px;text-align:right;");
    card.appendChild(head);
    card.appendChild(status);
    card.appendChild(track);
    card.appendChild(pct);
    root.appendChild(card);
    const animStyle = doc.createElement("style");
    animStyle.textContent = "@keyframes cp-spin{to{transform:rotate(360deg)}}";
    root.appendChild(animStyle);
    doc.documentElement.appendChild(root);
    return {
      set(p: number, text: string) {
        fill.style.width = Math.max(0, Math.min(100, p)) + "%";
        pct.textContent = Math.round(Math.max(0, Math.min(100, p))) + "%";
        status.textContent = text;
      },
      done() {
        fill.style.width = "100%";
        pct.textContent = "100%";
        setTimeout(() => {
          if (root.parentNode) root.parentNode.removeChild(root);
        }, 200);
      },
    };
  };
  const onClick = async (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (capturing) return;
    const t = e.target;
    if (!isElem(t) || !t.outerHTML) return;
    let el = resolve(t);
    if (mode === "element") el = await expandToMovingAncestor(el);
    if ((e as MouseEvent).shiftKey) {
      let node = el.parentElement;
      for (let i = 0; i < 6 && isRoot(node); i++) {
        if (hasLabel(node!)) el = node!;
        node = node!.parentElement;
      }
    }
    if (hovered) restore(hovered);
    hovered = null;
    const ov = showCaptureProgress();
    let sel: {
      html: string;
      label: string;
      styles?: string;
      cut?: { path: string; y: number; h: number };
    } | null = null;
    try {
      const { html, styles } = await captureHtml(el, (p, s) => ov.set(p, s));
      // Structural locator for the perfect-cut embed: child indices from
      // <body> down to the element + absolute Y/height at pick time. The
      // preview document is the SAME html as the full clone in the ZIP, so
      // the path resolves there too.
      let cut: { path: string; y: number; h: number } | undefined;
      const w = doc.defaultView;
      if (w && doc.body && el.parentElement) {
        const idxs: number[] = [];
        let n: Element | null = el;
        while (n && n.parentElement) {
          const kids = n.parentElement.children;
          let k = -1;
          for (let i = 0; i < kids.length; i++)
            if (kids[i] === n) {
              k = i;
              break;
            }
          if (k < 0) break;
          idxs.unshift(k);
          const stop: Element = n.parentElement;
          if (stop === doc.body || stop === doc.documentElement) break;
          n = stop;
        }
        if (idxs.length) {
          const r = el.getBoundingClientRect();
          cut = {
            path: idxs.join("-"),
            y: Math.round((r.top + w.scrollY) * 10) / 10,
            h: Math.round(r.height),
          };
        }
      }
      sel = { html, label: label(el), styles, ...(cut ? { cut } : {}) };
    } finally {
      ov.done();
    }
    onPick(sel);
  };
  let styleEl: HTMLStyleElement | null = null;
  if (!doc.getElementById("clone-picker-style")) {
    styleEl = doc.createElement("style");
    styleEl.id = "clone-picker-style";
    styleEl.textContent =
      "html.clone-picking, html.clone-picking * { cursor: crosshair !important; }" +
      // Hide the preview while the animation sampler jumps the scroll position,
      // so the capture's scroll sweep is invisible (no glitch-scroll flash).
      "html.clone-capturing body { visibility: hidden !important; }";
    (doc.head || doc.documentElement).appendChild(styleEl);
  }
  doc.documentElement.classList.add("clone-picking");
  doc.addEventListener("mouseover", onOver, true);
  doc.addEventListener("mouseout", onOut, true);
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("keydown", onKey as EventListener, true);
  return () => {
    doc.documentElement.classList.remove("clone-picking");
    doc.documentElement.style.cursor = "";
    if (hovered) restore(hovered);
    doc.removeEventListener("mouseover", onOver, true);
    doc.removeEventListener("mouseout", onOut, true);
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("keydown", onKey as EventListener, true);
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
  };
}

export type PickMode = "element" | "section";

function DeviceFrame({
  device,
  previewId,
  pickMode,
  srcOverride,
  onPick,
  onCancel,
}: {
  device: "desktop" | "mobile";
  previewId: string;
  pickMode: PickMode | null;
  /** When set (snippet preview after a pick), the iframe shows this instead of the full page. */
  srcOverride?: string | null;
  onPick: (sel: CloneSelection) => void;
  onCancel: () => void;
}) {
  const base = DEVICE_WIDTHS[device];
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(1);
  const [loadTick, setLoadTick] = useState(0);
  // Real content height of the previewed page: the iframe is sized to fit it
  // exactly instead of a fixed 70vh box that leaves dead space below shorter
  // pages (most visible in desktop mode where the scale shrinks the frame).
  const [contentH, setContentH] = useState<number | null>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let cancelled = false;
    setContentH(null);
    const measure = () => {
      try {
        const d = frame.contentDocument;
        if (!d || !d.documentElement || cancelled) return;
        const h = Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
        if (h > 100) setContentH(h);
      } catch {
        /* cross-origin or not ready */
      }
    };
    measure();
    // Late loads (images, web fonts, layout-shifting reveals) change the page
    // height — keep tracking it instead of measuring once. A ResizeObserver
    // can't help here: <html>'s border box stays viewport-sized even when its
    // scrollHeight grows, so poll briefly instead.
    const iv = setInterval(measure, 700);
    const stop = setTimeout(() => clearInterval(iv), 25000);
    return () => {
      cancelled = true;
      clearInterval(iv);
      clearTimeout(stop);
    };
  }, [previewId, loadTick, srcOverride]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setScale(Math.min(1, el.clientWidth / base));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [base]);

  // Enable/disable the sniper inside the iframe whenever pick mode, preview,
  // device or load state changes. Attach the picker directly to the iframe's
  // document — same-origin, so no script injection (which Vite's transform of a
  // template-literal script string had corrupted) and no window globals needed.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const doc = frame.contentDocument;
    if (!doc) return;
    if (!pickMode) return;
    if (srcOverride) return;
    return installPicker(doc, pickMode, onPick, onCancel);
  }, [pickMode, previewId, device, loadTick, srcOverride, onPick, onCancel]);

  const heightVh = 70 / scale;
  // Some sites' own runtimes (Lenis/Framer scroll transforms gone feral in
  // the static preview) inflate scrollHeight to Chrome's 2^25px layout cap —
  // clamp so the preview stays usable; anything taller just scrolls inside
  // the frame as before.
  const safeH = contentH ? Math.max(200, Math.min(contentH, 16000)) : null;
  // The frame fits the page exactly when the page is shorter than a viewport
  // band (no dead space below), and caps at that band for longer pages —
  // those simply scroll inside the frame like before. Reserving the page's
  // full height in the wrapper was tried and rejected: it turned the preview
  // into a huge mostly-empty region.
  const vhBand = typeof window !== "undefined" ? window.innerHeight * 0.7 : 700;
  const frameCssH = safeH ? Math.round(Math.min(safeH, vhBand / scale)) : null;
  const wrapHeight = frameCssH ? `${Math.round(frameCssH * scale)}px` : `${heightVh}vh`;
  const frameHeight = frameCssH ? `${frameCssH}px` : `${heightVh}vh`;

  const frameSrc = srcOverride ?? `/?preview=${previewId}`;
  return (
    <div ref={wrapRef} className="w-full" style={{ height: wrapHeight }}>
      <iframe
        ref={frameRef}
        title="Preview hasil kloning"
        src={frameSrc}
        onLoad={() => setLoadTick((x) => x + 1)}
        sandbox="allow-same-origin allow-scripts"
        className="rounded-xl bg-white"
        style={{
          width: base,
          height: frameHeight,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      />
    </div>
  );
}

function Index() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<CloneResult | null>(null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [targets, setTargets] = useState<Target[]>(["static", "vite", "next"]);
  const [pickMode, setPickMode] = useState<PickMode | null>(null);
  const [selection, setSelection] = useState<CloneSelection | null>(null);
  const [zipping, setZipping] = useState(false);
  // After a successful pick, the preview iframe can show the exported snippet
  // itself (what the ZIP will contain) instead of the full page — instant
  // visual confirmation that the cut-out keeps its animations.
  const [showSnippetView, setShowSnippetView] = useState(false);
  const [snippetUrl, setSnippetUrl] = useState<string | null>(null);
  // Bumping the nonce rebuilds the blob URL, which restarts every CSS
  // animation from zero — entrance reveals only play once (~1.6s), so without
  // a replay they look "dead" to anyone who looks after they settle.
  const [snippetNonce, setSnippetNonce] = useState(0);
  const run = useServerFn(clonePage);

  const mutation = useMutation({
    mutationFn: async (value: string) => (await run({ data: { url: value } })) as CloneResult,
    onSuccess: (data) => {
      setResult(data);
      setSelection(null);
      setPickMode(null);
      setShowSnippetView(false);
      toast.success(`Berhasil mengkloning ${new URL(data.url).hostname}`);
    },
    onError: (e: Error) => toast.error(e.message || "Gagal mengambil halaman"),
  });

  useEffect(() => {
    if (!result || !selection) {
      setSnippetUrl(null);
      return;
    }
    const html = snippetHtml(result, formatHtml(selection.html), selection.styles);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    setSnippetUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [result, selection, snippetNonce]);

  const toggle = (t: Target) =>
    setTargets((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const startPick = (mode: PickMode) => {
    setPickMode((cur) => (cur === mode ? null : mode));
    setSelection(null);
    // Picking needs the full page in the frame.
    setShowSnippetView(false);
  };

  const download = async () => {
    if (!result) return;
    if (targets.length === 0) {
      toast.error("Pilih minimal satu format");
      return;
    }
    setZipping(true);
    try {
      const blob = await buildZip(result, targets, selection);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${new URL(result.url).hostname.replace(/\W+/g, "-")}-clone.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success("ZIP berhasil dibuat");
    } catch {
      toast.error("Gagal membuat ZIP");
    } finally {
      setZipping(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster />
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_0%,color-mix(in_oklch,var(--accent)_28%,transparent),transparent_55%)]" />

      <main className="relative mx-auto max-w-6xl px-6 py-14">
        <header className="max-w-2xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs font-mono uppercase tracking-widest text-muted-foreground">
            <Zap className="size-3.5" /> tanpa AI · murni fetch &amp; rewrite
          </span>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-5xl">
            Clone website jadi kode siap pakai
          </h1>
          <p className="mt-4 text-muted-foreground">
            Tempel link, lihat preview dengan animasi scroll GSAP ScrollTrigger, lalu unduh ZIP
            berisi versi HTML/CSS/JS, Vite, dan Next.js.
          </p>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) mutation.mutate(url.trim());
          }}
          className="mt-10 flex flex-col gap-3 sm:flex-row"
        >
          <div className="flex flex-1 items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
            <Globe className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://contoh-website.com"
              className="w-full bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <button
            type="submit"
            disabled={mutation.isPending}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {mutation.isPending ? "Mengambil…" : "Clone sekarang"}
          </button>
        </form>

        {result ? (
          <section className="mt-12">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">{result.title}</h2>
                <p className="font-mono text-xs text-muted-foreground">
                  {result.url} · {result.stylesheets} stylesheet · {result.assets.length} aset ·{" "}
                  {result.scripts?.length ?? 0} script asli
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => startPick("element")}
                  aria-label="Pilih elemen di preview"
                  className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${pickMode === "element" ? "border-primary bg-accent text-accent-foreground" : "border-border text-muted-foreground hover:bg-accent"}`}
                >
                  <Scissors className="size-4" />
                  {pickMode === "element" ? "Mengambil elemen…" : "Pilih elemen"}
                </button>
                <button
                  onClick={() => startPick("section")}
                  aria-label="Pilih section di preview"
                  className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${pickMode === "section" ? "border-primary bg-accent text-accent-foreground" : "border-border text-muted-foreground hover:bg-accent"}`}
                >
                  <Rows3 className="size-4" />
                  {pickMode === "section" ? "Mengambil section…" : "Pilih section"}
                </button>
                <span className="font-mono text-xs text-muted-foreground">
                  {DEVICE_WIDTHS[device]}px
                </span>
                <div className="flex items-center gap-1 rounded-lg border border-border p-1">
                  <button
                    onClick={() => setDevice("desktop")}
                    aria-label="Preview desktop"
                    className={`rounded-md p-2 ${device === "desktop" ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
                  >
                    <Monitor className="size-4" />
                  </button>
                  <button
                    onClick={() => setDevice("mobile")}
                    aria-label="Preview mobile"
                    className={`rounded-md p-2 ${device === "mobile" ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
                  >
                    <Smartphone className="size-4" />
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-5 overflow-hidden rounded-2xl border border-border bg-card p-3">
              {result.previewId ? (
                <DeviceFrame
                  device={device}
                  previewId={result.previewId}
                  pickMode={pickMode}
                  srcOverride={showSnippetView && snippetUrl ? snippetUrl : null}
                  onPick={(sel) => {
                    setSelection(sel);
                    setPickMode(null);
                    setShowSnippetView(true);
                    toast.success(`${sel.label} dipilih`);
                  }}
                  onCancel={() => setPickMode(null)}
                />
              ) : null}
            </div>

            {pickMode ? (
              <p className="mt-3 font-mono text-xs text-muted-foreground">
                {pickMode === "section"
                  ? "Klik area mana pun dalam section pada preview; section terdekat akan dipilih. Arahkan mouse untuk melihat sorotan. Tekan Esc untuk batal."
                  : "Klik elemen pada preview untuk memilihnya persis (tanpa ancestor berlebih). Shift+klik untuk memperluas ke section terbesar. Tekan Esc untuk batal."}
              </p>
            ) : null}

            {selection ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2">
                <Scissors className="size-4 text-emerald-500" />
                <span className="font-mono text-xs">
                  ZIP akan berisi: <span className="font-semibold">{selection.label}</span>
                </span>
                {snippetUrl ? (
                  <>
                    <button
                      onClick={() => setShowSnippetView((v) => !v)}
                      className="ml-auto font-mono text-xs underline underline-offset-2 hover:opacity-80"
                    >
                      {showSnippetView ? "lihat halaman penuh" : "preview potongan"}
                    </button>
                    <button
                      onClick={() => {
                        setSnippetNonce((n) => n + 1);
                        setShowSnippetView(true);
                      }}
                      className="font-mono text-xs underline underline-offset-2 hover:opacity-80"
                    >
                      putar ulang animasi
                    </button>
                  </>
                ) : (
                  <span className="ml-auto" />
                )}
                <button
                  onClick={() => setSelection(null)}
                  className="font-mono text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  batal
                </button>
              </div>
            ) : null}

            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              {TARGETS.map((t) => {
                const on = targets.includes(t.id);
                return (
                  <button
                    key={t.id}
                    onClick={() => toggle(t.id)}
                    className={`rounded-xl border p-4 text-left transition-colors ${on ? "border-primary bg-accent" : "border-border bg-card"}`}
                  >
                    <p className="text-sm font-medium">{t.label}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">{t.hint}</p>
                  </button>
                );
              })}
            </div>

            <button
              onClick={download}
              disabled={zipping}
              className="mt-5 inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {zipping ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {selection ? "Download elemen/section terpilih" : "Download ZIP"}
            </button>
          </section>
        ) : (
          <p className="mt-12 max-w-xl font-mono text-xs leading-relaxed text-muted-foreground">
            Catatan: kloning bersifat statis, tapi skrip asli situs (GSAP, ScrollTrigger, parallax,
            running text, SVG draw) ikut dipertahankan agar animasi scroll berjalan persis. Sisipan
            GSAP bawaan hanya jadi cadangan bila situs tidak punya animasi sendiri.
          </p>
        )}
      </main>
    </div>
  );
}
