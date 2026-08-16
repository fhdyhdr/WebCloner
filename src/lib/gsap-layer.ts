export const GSAP_SNIPPET = `
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js"></script>
<script src="./scroll.js" defer></script>
`;

const GSAP_CDN = "https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js";
const ST_CDN = "https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js";
const LENIS_CDN = "https://cdn.jsdelivr.net/npm/lenis@1.1.13/dist/lenis.min.js";

/**
 * Fallback scroll layer — provides scroll-reveal animations and Lenis smooth
 * scroll when the site's own animation system can't run (React/Next.js/Nuxt/
 * Vue apps whose runtime never boots inside a static clone).
 *
 * Detection strategy:
 * 1. Check window.__cloneIsFramework flag (set by the cloner before this script)
 * 2. If framework detected, activate fallback immediately (no waiting)
 * 3. Otherwise, wait for original scripts to boot and check for live animations
 * 4. Reveal hidden elements on scroll via GSAP ScrollTrigger (if available)
 *    or native IntersectionObserver (always available)
 *
 * Reveal is non-destructive: elements that are already visible are never
 * touched, and hidden elements are only ever brought back from their current
 * state (never pre-hidden), so a site that DOES animate later stays intact.
 */
export const SCROLL_JS = `/* Site Cloner — fallback scroll layer with Lenis smooth scroll */
(function () {
  window.__cloneOriginalScripts = true;

  /**
   * Check if the site's own animation system is ACTUALLY running.
   * Uses LIVE window references (not stale captures) so scripts that load
   * after this check starts are properly detected.
   */
  function siteHasOwnAnimation() {
    // GSAP with real tweens/triggers
    try {
      var g = window.gsap;
      var st = window.ScrollTrigger;
      if (st && st.getAll && st.getAll().length > 0) return true;
      if (g && g.globalTimeline && g.globalTimeline.getChildren) {
        var t = g.globalTimeline.getChildren(false, true, false);
        if (t && t.length > 0) return true;
      }
    } catch (e) {}
    // Lenis smooth scroll running
    try {
      if (window.Lenis && window.Lenis.__v) return true;
      if (window.lenis && window.lenis.scroll !== undefined) return true;
    } catch (e) {}
    // Other scroll/reveal libraries with live instances
    if (window.AOS || window.LocomotiveScroll || window.ScrollReveal || window.WOW) return true;
    // Framer embeds its own reveal runtime (plain script, always runs)
    if (document.querySelector("[data-framer-name]")) return true;
    // Webflow interactions runtime (plain script, always runs)
    try {
      if (window.Webflow && window.Webflow.require) return true;
    } catch (e) {}
    return false;
  }

  function loadScripts(urls, cb) {
    var pending = urls.length;
    if (!pending) { cb(); return; }
    urls.forEach(function (u) {
      var s = document.createElement("script");
      s.src = u;
      s.onload = s.onerror = function () { if (--pending === 0) cb(); };
      document.head.appendChild(s);
    });
  }

  function refreshScroll() {
    try {
      if (window.ScrollTrigger && window.ScrollTrigger.refresh) {
        window.addEventListener("load", function () { window.ScrollTrigger.refresh(); });
        setTimeout(function () { window.ScrollTrigger.refresh(); }, 1500);
        setTimeout(function () { window.ScrollTrigger.refresh(); }, 3500);
      }
    } catch (e) {}
  }

  /** Is this element visually hidden by its own computed style or CSS class? */
  function isHidden(el, cs) {
    var c = cs || getComputedStyle(el);
    if (c.display === "none") return false;
    if (c.visibility === "hidden") return true;
    if (el.hasAttribute("hidden")) return true;
    if (parseFloat(c.opacity) < 0.15) return true;
    var cls = el.className;
    if (typeof cls === "string") {
      if (/(?:^|\\s)(?:invisible|opacity-0|sr-only|visually-hidden|clip-hide)(?:\\s|$)/.test(cls)) return true;
    }
    return false;
  }

  /**
   * Native reveal — uses multiple strategies to ensure hidden elements
   * become visible. Works without any external library.
   *
   * Strategy:
   * 1. Immediately reveal elements that are already in the viewport
   * 2. Use IntersectionObserver for efficient scroll-based reveal
   * 3. Use scroll event listener as backup (IntersectionObserver can fail
   *    in srcDoc iframes)
   * 4. Use requestAnimationFrame polling as final safety net
   */
  var nativeRevealed = false;
  function addNativeReveal() {
    if (nativeRevealed) return;
    nativeRevealed = true;

    // Inject CSS for the reveal transition
    var style = document.createElement("style");
    style.textContent = '[data-clone-reveal]{opacity:1 !important;transform:translateY(0) !important;visibility:visible !important;transition:opacity .8s cubic-bezier(.22,.61,.36,1),transform .8s cubic-bezier(.22,.61,.36,1) !important}';
    document.head.appendChild(style);

    // Collect all animation-related selectors
    var sel = [
      "[data-inview]", "[data-reveal]", "[data-animate]", "[data-text-reveal]",
      "[data-scroll]", "[data-aos]"
    ].join(",");

    var targets = [];
    var seen = {};
    function addTarget(el) {
      if (seen[el.__cloneIdx]) return;
      var r = el.getBoundingClientRect();
      if (r.height < 8) return;
      seen[el.__cloneIdx] = true;
      targets.push(el);
    }

    // Mark elements with a unique index for dedup
    var idx = 0;
    Array.prototype.slice.call(document.querySelectorAll("body *")).forEach(function (el) {
      el.__cloneIdx = idx++;
    });

    // Collect hidden elements
    Array.prototype.slice.call(document.querySelectorAll(sel)).forEach(function (el) {
      if (isHidden(el)) addTarget(el);
    });
    Array.prototype.slice.call(document.querySelectorAll("body section, body header, body footer, body article, main")).forEach(function (el) {
      if (isHidden(el)) addTarget(el);
    });
    var vh = window.innerHeight;
    Array.prototype.slice.call(document.querySelectorAll("body *")).forEach(function (el) {
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") return;
      var r = el.getBoundingClientRect();
      if (r.height < 16 || r.height > vh * 6) return;
      if (!isHidden(el)) return;
      var cs = getComputedStyle(el);
      if (cs.position === "fixed" || cs.position === "sticky") return;
      addTarget(el);
    });

    if (!targets.length) return;

    function reveal(el) {
      if (el.hasAttribute("data-clone-reveal")) return;
      el.setAttribute("data-clone-reveal", "");
    }

    function isElementInView(el) {
      var r = el.getBoundingClientRect();
      return r.top < vh && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
    }

    // Strategy 1: Immediately reveal elements already in viewport
    targets.forEach(function (el) {
      if (isElementInView(el)) reveal(el);
    });

    // Strategy 2: IntersectionObserver (efficient, works in most contexts)
    try {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            reveal(entry.target);
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.01, rootMargin: "100px 0px" });
      targets.forEach(function (el) {
        if (!el.hasAttribute("data-clone-reveal")) observer.observe(el);
      });
    } catch (e) {}

    // Strategy 3: Scroll event listener (backup for srcDoc iframes)
    var scrollTicking = false;
    function onScroll() {
      if (scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(function () {
        scrollTicking = false;
        targets.forEach(function (el) {
          if (!el.hasAttribute("data-clone-reveal") && isElementInView(el)) {
            reveal(el);
          }
        });
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });

    // Strategy 4: Polling loop (final safety net — runs for 15 seconds)
    var pollCount = 0;
    var pollTimer = setInterval(function () {
      pollCount++;
      var allRevealed = true;
      targets.forEach(function (el) {
        if (!el.hasAttribute("data-clone-reveal")) {
          allRevealed = false;
          if (isElementInView(el)) reveal(el);
        }
      });
      if (allRevealed || pollCount > 30) {
        clearInterval(pollTimer);
        window.removeEventListener("scroll", onScroll);
      }
    }, 500);
  }

  /**
   * GSAP-based reveal — provides smoother animations with ScrollTrigger.
   * Falls back to native if GSAP is not available.
   */
  function addFallbackReveal() {
    if (!window.gsap || !window.ScrollTrigger) {
      addNativeReveal();
      return;
    }
    gsap.registerPlugin(window.ScrollTrigger);
    var vh = window.innerHeight;

    var hintSel = [
      "body section", "body header", "body footer", "body article", "main",
      "[data-scroll]", "[data-inview]", "[data-reveal]", "[data-animate]",
      "[data-aos]", "[data-aos-delay]", "[data-text-reveal]",
      "[class*='reveal']", "[class*='fade-up']", "[class*='fade-in']",
      "[class*='slide-up']", "[class*='slide-in']", "[class*='zoom-in']",
      ".gsap"
    ].join(",");
    var hinted = [];
    Array.prototype.slice.call(document.querySelectorAll(hintSel)).forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.height >= 24 && r.height <= vh * 8) hinted.push(el);
    });

    var hintedHasHiddenParent = function (el) {
      var p = el.parentElement;
      while (p && p !== document.body) {
        if (hinted.indexOf(p) !== -1) {
          var cs = getComputedStyle(p);
          if (parseFloat(cs.opacity) < 0.5 || cs.visibility === "hidden" || p.hasAttribute("hidden")) {
            return true;
          }
        }
        p = p.parentElement;
      }
      return false;
    };

    var targets = [];
    Array.prototype.slice.call(document.querySelectorAll("body *")).forEach(function (el) {
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") return;
      var r = el.getBoundingClientRect();
      if (r.height < 16) return;
      if (!isHidden(el)) return;
      if (hinted.indexOf(el) !== -1) return;
      if (hintedHasHiddenParent(el)) return;
      var cs = getComputedStyle(el);
      if (cs.position === "fixed") return;
      targets.push(el);
    });

    function reveal(el) {
      gsap.to(el, {
        opacity: 1,
        y: 0,
        duration: 0.9,
        ease: "power3.out",
        immediateRender: false,
        overwrite: "auto",
        scrollTrigger: { trigger: el, start: "top 92%", once: true }
      });
    }

    hinted.forEach(function (el) {
      if (isHidden(el)) reveal(el);
    });
    targets.forEach(function (el) { reveal(el); });

    refreshScroll();
  }

  function initLenis() {
    if (!window.Lenis) return;
    try {
      var lenis = new Lenis({
        duration: 1.2,
        easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
        touchMultiplier: 2
      });
      if (window.gsap && window.ScrollTrigger) {
        gsap.ticker.add(function (time) {
          lenis.raf(time * 1000);
        });
        gsap.ticker.lagSmoothing(0);
        window.addEventListener("resize", function () { lenis.resize(); });
      }
      window.lenis = lenis;
    } catch (e) {}
  }

  function rescueHidden() {
    var fixed = 0;
    Array.prototype.forEach.call(document.querySelectorAll("body *"), function (el) {
      var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      if (r.height <= 4) return;
      if (cs.display === "none") return;
      if (!isHidden(el, cs)) return;
      var p = el.parentElement;
      while (p && p !== document.body) {
        var pcs = getComputedStyle(p);
        if (parseFloat(pcs.opacity) < 0.05 || pcs.visibility === "hidden" || p.hasAttribute("hidden")) {
          return;
        }
        p = p.parentElement;
      }
      el.style.setProperty("opacity", "1", "important");
      if (cs.visibility === "hidden") el.style.setProperty("visibility", "visible", "important");
      if (el.hasAttribute("hidden")) el.removeAttribute("hidden");
      fixed++;
    });
    if (fixed > 0) refreshScroll();
    return fixed;
  }

  var decided = false;

  function decide() {
    if (decided) return;
    decided = true;

    // If the site's own animations are ACTUALLY running, keep out of the way.
    if (siteHasOwnAnimation()) {
      refreshScroll();
      return;
    }

    var finish = function () {
      // For framework sites, always activate — don't re-check because
      // framework scripts may load but fail to hydrate.
      if (!window.__cloneIsFramework && siteHasOwnAnimation()) {
        refreshScroll();
        return;
      }
      initLenis();
      addFallbackReveal();
      // Also start native reveal immediately as safety net
      addNativeReveal();
      setTimeout(function () { rescueHidden(); refreshScroll(); }, 2000);
      setTimeout(function () { rescueHidden(); refreshScroll(); }, 4000);
      setTimeout(function () { rescueHidden(); }, 7000);
    };

    var needGsap = !window.gsap;
    var needSt = !window.ScrollTrigger;
    var needLenis = !window.Lenis && !window.lenis;
    var urls = [];
    if (needGsap) urls.push("${GSAP_CDN}");
    if (needSt) urls.push("${ST_CDN}");
    if (needLenis) urls.push("${LENIS_CDN}");
    loadScripts(urls, finish);
  }

  function init() {
    // Check the flag set by the cloner — framework sites can't hydrate
    // in a static clone, so activate fallback immediately.
    if (window.__cloneIsFramework) {
      // Start native reveal RIGHT AWAY — no waiting for CDN scripts
      addNativeReveal();
      // Force-reveal elements already in viewport immediately
      setTimeout(function () { rescueHidden(); }, 100);
      // Also try GSAP reveal after a short delay (CDN might load)
      setTimeout(decide, 200);
      // Periodic rescue for slow-loading content
      setTimeout(function () { rescueHidden(); }, 1000);
      setTimeout(function () { rescueHidden(); }, 3000);
      setTimeout(function () { rescueHidden(); }, 5000);
      return;
    }

    // Non-framework: check if original scripts have booted
    setTimeout(function () {
      if (siteHasOwnAnimation()) { refreshScroll(); return; }
      window.addEventListener("load", function () {
        setTimeout(function () {
          if (!decided && siteHasOwnAnimation()) { decided = true; refreshScroll(); return; }
          if (!decided) decide();
        }, 500);
      });
      setTimeout(decide, 2500);
    }, 700);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
`;
