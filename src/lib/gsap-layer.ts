export const GSAP_SNIPPET = `
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js"></script>
<script src="./scroll.js" defer></script>
`;

/**
 * Fallback layer only. The cloned page keeps the site's own scripts, so if the
 * source already animates (GSAP, AOS, Lenis, Locomotive, ScrollReveal…) we stay
 * completely out of the way and only make sure nothing is stuck invisible.
 */
export const SCROLL_JS = `/* Site Cloner — fallback scroll layer (runs only if the site has none) */
(function () {
  function siteHasOwnAnimation() {
    if (window.__cloneOriginalScripts) {
      if (window.ScrollTrigger && ScrollTrigger.getAll && ScrollTrigger.getAll().length > 0) return true;
      if (window.AOS || window.LocomotiveScroll || window.Lenis || window.ScrollReveal || window.WOW) return true;
      if (document.querySelector("[data-scroll],[data-aos],[data-animate],.gsap,[data-speed]")) return true;
    }
    return false;
  }

  function rescueHidden() {
    document.querySelectorAll("body *").forEach(function (el) {
      var cs = getComputedStyle(el);
      if (parseFloat(cs.opacity) < 0.02 && el.getBoundingClientRect().height > 8) {
        el.style.setProperty("opacity", "1", "important");
        el.style.setProperty("visibility", "visible", "important");
      }
    });
  }

  function addFallbackReveal() {
    if (!window.gsap || !window.ScrollTrigger) return;
    gsap.registerPlugin(ScrollTrigger);
    var vh = window.innerHeight;
    var blocks = Array.prototype.slice
      .call(document.querySelectorAll("body section, body header, body footer, body article, body main > div"))
      .filter(function (el) {
        var r = el.getBoundingClientRect();
        return r.height >= 24 && r.height <= vh * 4;
      });
    blocks.forEach(function (el) {
      gsap.fromTo(
        el,
        { opacity: 0, y: 40 },
        {
          opacity: 1, y: 0, duration: 0.9, ease: "power3.out",
          immediateRender: false, overwrite: "auto",
          scrollTrigger: { trigger: el, start: "top 92%", once: true }
        }
      );
    });
    window.addEventListener("load", function () { ScrollTrigger.refresh(); });
    setTimeout(function () { ScrollTrigger.refresh(); }, 1200);
  }

  function init() {
    // give the original scripts a moment to boot
    setTimeout(function () {
      if (siteHasOwnAnimation()) {
        // original animations are alive — only refresh measurements
        if (window.ScrollTrigger && ScrollTrigger.refresh) {
          window.addEventListener("load", function () { ScrollTrigger.refresh(); });
          setTimeout(function () { ScrollTrigger.refresh(); }, 1500);
        }
        setTimeout(rescueHidden, 6000);
      } else {
        addFallbackReveal();
        setTimeout(rescueHidden, 4000);
      }
    }, 600);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
`;
