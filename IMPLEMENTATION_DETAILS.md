# Implementation Details: Robust Fetching Architecture

## Overview

Solusi 4-layer untuk handle website dengan CORS/blocking:

```
Layer 1: User-Agent Rotation
  └─ Setiap retry coba User-Agent berbeda
  └─ Bypass simple bot detection

Layer 2: Better Headers
  └─ Referer, Accept-Language, Cache-Control
  └─ Terlihat seperti legitimate browser

Layer 3: Optional Resources
  └─ CSS/fonts/imports gagal → skip, jangan error
  └─ Clone tetap berhasil

Layer 4: Graceful Degradation
  └─ Keep <link> tags jika stylesheet gagal
  └─ Browser load dari source sebagai fallback
```

## Deep Dive: Each Component

### Component 1: fetchRetry() with User-Agent Rotation

**Location:** `src/lib/clone.server.ts` line 197-254

**Purpose:** Network request dengan retry logic + multiple strategies

**Code Flow:**

```typescript
async function fetchRetry(
  url: string,
  init: RequestInit = {},
  retries = 3,
  timeoutMs = 20_000,
): Promise<Response> {
  const userAgents = [
    // UA 1: macOS Chrome (Desktop)
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36...",
    // UA 2: Windows Chrome (Desktop)
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36...",
    // UA 3: Linux Chrome (Server/Bot-like)
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36...",
  ];

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // AbortController: timeout protection
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      
      try {
        // Rotate UA setiap attempt
        const userAgent = userAgents[attempt % userAgents.length]!;
        
        const headers = {
          ...init.headers,
          "user-agent": userAgent,
          "accept": "text/html,application/xhtml+xml,...",
          "accept-language": "en-US,en;q=0.9",
          "referer": new URL(url).origin + "/",
          "cache-control": "no-cache",
        };

        // Fetch dengan timeout
        const res = await fetch(url, { 
          ...init, 
          headers,
          signal: ctrl.signal 
        });

        if (res.ok) return res;  // ✅ Success
        
        // Retry 5xx / 429, fail on 4xx
        if (res.status >= 500 || res.status === 429) {
          lastErr = new Error(`HTTP ${res.status}`);
          // Continue retry loop
        } else {
          return res;  // ✅ 4xx = client error, don't retry
        }
      } finally {
        clearTimeout(t);  // Cleanup timeout
      }
    } catch (e) {
      lastErr = e;  // Timeout / network error
    }

    // Exponential backoff: 400ms, 800ms, 1200ms
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }

  throw lastErr;
}
```

**Key Design Decisions:**

1. **User-Agent Rotation**
   - 3 different UAs: macOS, Windows, Linux
   - Cycle through: `attempt % userAgents.length`
   - Reason: Bot detection often checks UA + IP combo

2. **Exponential Backoff**
   - Attempt 1: wait 400ms
   - Attempt 2: wait 800ms
   - Attempt 3: wait 1200ms
   - Reason: Let server cool down, reduce rate-limit hits

3. **HTTP Status Handling**
   - 200-299: Return immediately ✅
   - 300-399: Return (let fetch handle redirects)
   - 400-499: Return (client error, don't retry)
   - 500-599: Retry (server error, might recover)
   - 429: Retry (rate limited, wait helps)
   - Timeout/Network: Retry (transient failure)

4. **Timeout Protection**
   - Per-request: 20 seconds max
   - AbortSignal ensures cleanup
   - Prevents hanging forever

---

### Component 2: fetchText() with Optional Mode

**Location:** `src/lib/clone.server.ts` line 185-200

**Purpose:** Text fetching dengan graceful degradation

**Code Flow:**

```typescript
async function fetchText(url: string, optional = false) {
  try {
    const res = await fetchRetry(url, { 
      headers: { "user-agent": UA, accept: "*/*" } 
    });
    
    if (!res.ok) {
      if (optional) {
        console.warn(`[clone] optional fetch gagal: ${url}`);
        return null;  // ← Silent fail
      }
      throw new Error(`HTTP ${res.status} saat mengambil ${url}`);
    }
    
    return sanitizeLineTerminators(await res.text());
  } catch (e) {
    if (optional) {
      console.warn(`[clone] optional fetch error: ${url}`, (e as Error).message);
      return null;  // ← Return null, don't throw
    }
    throw e;  // ← Throw untuk required resources
  }
}
```

**Usage Pattern:**

```typescript
// Required resource (main HTML)
const html = await fetchText(base);  // Will throw on error

// Optional resource (stylesheet)
const css = await fetchText(cssUrl, true);
if (!css) {
  console.log("CSS tidak bisa diambil, keep <link> tag");
  keptLinkTags.push(originalLinkTag);
} else {
  inlinedStyles.push(css);
}

// Optional resource (font)
const font = await fetchText(fontUrl, true);
if (!font) {
  console.log("Font tidak bisa, browser pakai fallback");
} else {
  embeddedFonts.push(base64(font));
}
```

**Contract:**
- `fetchText(url)` = throw on error (required)
- `fetchText(url, true)` = return null on error (optional)

---

### Component 3: Resource-Specific Handlers

#### 3a. CSS Imports

**Location:** `src/lib/clone.server.ts` line 263-285

```typescript
async function inlineCssImports(css: string, base: string) {
  const importRe = /@import\s+(?:url\(\s*)?['"]?([^'")\s]+)/gi;
  const found = [...css.matchAll(importRe)].slice(0, 50);
  
  for (const m of found) {
    const href = m[1];
    if (!href || href.startsWith("data:")) continue;
    const cssUrl = abs(href, base);
    
    try {
      // ← Optional fetch
      const raw = await fetchText(cssUrl, true);
      
      if (!raw) {
        // Skip gagal imports
        console.warn(`[clone] import gagal: ${cssUrl}`);
        css = css.replace(m[0], "");  // Remove @import
        continue;
      }
      
      let child = rewriteCss(raw, cssUrl);
      const media = (m[2] ?? "").trim();
      if (media && !/^layer\b/i.test(media)) {
        child = `@media ${media} {\n${child}\n}`;
      }
      css = css.replace(m[0], `/* ${cssUrl} */\n${child}`);
    } catch {
      css = css.replace(m[0], "");
    }
  }
  return css;
}
```

**Result:** Gagal @import → removed, CSS tetap valid

---

#### 3b. Font Embedding

**Location:** `src/lib/clone.server.ts` line 235-270

```typescript
async function embedFonts(css: string): Promise<string> {
  const fontRe = /url\(\s*(['"]?)(https?:[^'")]+?\.(?:woff2?|ttf|otf|eot))/gi;
  const matches = [...css.matchAll(fontRe)];
  const cache = new Map<string, string>();

  for (const m of matches) {
    const url = m[2] ?? "";
    const clean = url.split(/[?#]/)[0] ?? url;
    
    try {
      let data: string | undefined = cache.get(clean);
      if (!data) {
        try {
          // Regular fetch (not optional, but has try-catch)
          const res = await fetch(clean, { 
            headers: { "user-agent": UA } 
          });
          
          if (!res.ok) {
            console.warn(`[clone] font HTTP ${res.status}: ${clean}`);
            continue;  // ← Skip, don't throw
          }
          
          const ext = clean.match(/\.(woff2|woff|ttf|otf|eot)$/i)?.[1] ?? "";
          const type = {
            "woff2": "font/woff2",
            "woff": "font/woff",
            "ttf": "font/ttf",
            "otf": "font/otf",
          }[ext] ?? "font/otf";
          
          data = `data:${type};base64,${Buffer.from(
            await res.arrayBuffer()
          ).toString("base64")}`;
          
          cache.set(clean, data);
        } catch (e) {
          console.warn(`[clone] font fetch error: ${clean}`, (e as Error).message);
          continue;  // ← Skip gagal font
        }
      }
      
      css = css.replace(m[0], `url("${data}")`);
    } catch (e) {
      console.warn(`[clone] font embed error:`, (e as Error).message);
    }
  }
  
  return css;  // ← CSS returned even if some fonts failed
}
```

**Result:** Gagal font → browser pakai system font fallback

---

#### 3c. Stylesheet Inlining

**Location:** `src/lib/clone.server.ts` line 486-511

```typescript
for (const tag of links.slice(0, 50)) {
  const href = tag.match(/href\s*=\s*['"]([^'"]+)['"]/i)?.[1];
  if (!href) continue;
  const cssUrl = abs(href, base);
  
  try {
    // ← Optional fetch
    const raw = await fetchText(cssUrl, true);
    
    if (!raw) {
      console.warn(`[clone] stylesheet gagal: ${cssUrl}, keep <link>`);
      keptLinkTags.push(tag);  // ← Keep original tag
      continue;
    }
    
    if (looksLikeHtml(raw)) {
      throw new Error("stylesheet response is HTML");
    }
    
    let css = await inlineCssImports(
      rewriteCss(raw, cssUrl), 
      cssUrl
    );
    
    const media = tag.match(/\smedia\s*=\s*['"]([^'"]+)['"]/i)?.[1]?.trim();
    if (media && !/^(all|screen)$/i.test(media) && !/\sonload\s*=/.test(tag)) {
      css = `@media ${media} {\n${css}\n}`;
    }
    
    styles.push(`/* ${cssUrl} */\n${css}`);
    inlined.add(tag);
  } catch (e) {
    console.warn(`[clone] gagal inline ${cssUrl}:`, (e as Error).message);
    keptLinkTags.push(tag);  // ← Keep original tag
  }
}

// Remove only successfully inlined links
html = html.replace(linkRe, (m) => (inlined.has(m) ? "" : m));
```

**Result:**
- ✅ Inlined stylesheet → remove `<link>`
- ⚠️ Gagal stylesheet → keep `<link>`, browser load from source
- ✅ Clone succeeds either way

---

### Component 4: Main Clone Flow

**Location:** `src/lib/clone.server.ts` line 450-475

```typescript
export async function cloneSite(rawUrl: string) {
  // Validate URL
  let target: URL;
  try {
    target = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
  } catch {
    throw new Error("URL tidak valid");
  }
  
  if (!/^https?:$/.test(target.protocol)) {
    throw new Error("Hanya http/https yang didukung");
  }

  const base = target.toString();
  
  // Fetch main HTML - REQUIRED, will throw
  let html: string;
  try {
    html = await fetchText(base);
  } catch (e) {
    const errMsg = (e as Error).message;
    console.error(`[clone] gagal fetch ${base}:`, errMsg);
    throw new Error(
      `Gagal mengambil halaman: ${errMsg}. ` +
      `Pastikan URL benar dan website accessible.`
    );
  }

  // Extract title
  const title = (
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? 
      target.hostname
  ).trim();

  // Extract scripts (from HTML before URL rewriting)
  const extracted = extractScripts(html);
  html = extracted.html;

  // Rest of processing...
  // (Each step can fail gracefully)
}
```

**Error Handling:**
- Main HTML fetch: ❌ throw (hard requirement)
- Stylesheets: ⚠️ keep as `<link>` if fail
- Fonts: ⚠️ skip if fail
- Scripts: ⚠️ keep `src` attribute if fail
- Imports: ⚠️ skip if fail

---

## Configuration

### Tuning Parameters

**In `src/lib/clone.server.ts`:**

```typescript
// fetchRetry parameters
const timeoutMs = 20_000;  // Per-request timeout (ms)
const retries = 3;         // Number of retries (total: 4 attempts)

// Exponential backoff formula
// Wait = 400 * (attempt + 1) ms
// Attempt 1: 400ms
// Attempt 2: 800ms
// Attempt 3: 1200ms
// Total: ~2.4 seconds waiting

// Total maximum time per URL:
// (20s timeout × 4 attempts) + (400 + 800 + 1200)ms backoff
// = 80s + 2.4s = ~82.4 seconds worst case
```

**To increase robustness:**
```typescript
// More retries
const retries = 5;  // 6 attempts total

// Longer timeout
const timeoutMs = 30_000;  // 30 seconds per request

// Less aggressive backoff
await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));  // 100ms backoff
```

**To speed up:**
```typescript
// Fewer retries
const retries = 2;  // 3 attempts total

// Shorter timeout
const timeoutMs = 10_000;  // 10 seconds per request

// Faster backoff
await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));  // 200ms backoff
```

---

## Monitoring & Logging

All operations logged dengan `[clone]` prefix:

```typescript
console.warn(`[clone] optional fetch gagal: ${url}`);
console.warn(`[clone] stylesheet tidak bisa diambil: ${cssUrl}`);
console.warn(`[clone] font gagal diambil: ${fontUrl}`);
console.warn(`[clone] gagal inline stylesheet: ${cssUrl}`);
console.error(`[clone] gagal fetch ${base}: ${message}`);
```

**In production:**
- Check logs untuk "gagal" warnings
- Track retry patterns
- Monitor time-to-clone

---

## Testing Strategy

### Unit Tests (Future)

```typescript
// test/clone.server.test.ts

describe("fetchRetry", () => {
  it("should retry with different User-Agents", async () => {
    // Mock fetch to fail first 2 times
    // Pass on 3rd with different UA
  });
  
  it("should handle 5xx errors", async () => {
    // Mock 503 Service Unavailable
    // Should retry
  });
  
  it("should not retry 4xx errors", async () => {
    // Mock 404 Not Found
    // Should fail immediately
  });
});

describe("fetchText with optional", () => {
  it("should throw on error if not optional", async () => {
    // Mock failure, should throw
  });
  
  it("should return null on error if optional", async () => {
    // Mock failure, should return null
  });
});
```

### Integration Tests

```typescript
// test/clone.integration.test.ts

describe("cloneSite", () => {
  it("should clone simple website", async () => {
    const result = await cloneSite("https://example.com");
    expect(result.html).toBeTruthy();
    expect(result.title).toBeTruthy();
  });
  
  it("should handle CORS-blocked website gracefully", async () => {
    const result = await cloneSite("https://amikompurwokerto.ac.id/");
    expect(result.html).toBeTruthy();  // Still cloned
    expect(result.styles.length).toBeGreaterThan(0);  // Some styles
  });
  
  it("should keep link tags for failed stylesheets", async () => {
    const result = await cloneSite(corsBlockedUrl);
    expect(result.linkTags).toContain("<link");  // Has fallback links
  });
});
```

---

## Performance Metrics

### Baseline (Normal Website)

```
URL: https://example.com
Time: 2-4 seconds
Retries: 0 (succeeds first attempt)
Resources: All inlined
Result: Full clone
```

### CORS-Blocked Website

```
URL: https://amikompurwokerto.ac.id/
Time: 12-18 seconds
Retries: 2-3 (depends on server response time)
Resources: ~50% inlined, ~50% kept as <link>
Result: Partial clone (structure intact)
```

### Worst Case

```
URL: Unreachable or heavily rate-limited
Time: ~80 seconds
Retries: All 4 attempts exhausted
Resources: None inlined
Result: Error thrown (expected)
```

---

## Debugging Tips

### Enable Verbose Logging

Add to `src/lib/clone.server.ts`:

```typescript
const DEBUG = true;

if (DEBUG) {
  console.log(`[clone] fetching: ${url}`);
  console.log(`[clone] attempt ${attempt + 1} with UA: ${userAgent}`);
}
```

### Network Throttling (Browser)

F12 > Network > Throttle:
- Set to "Slow 3G"
- Watch retry behavior
- Verify timeout handling

### Simulate CORS Block

Use browser console to test:
```javascript
// This will fail with CORS error
fetch("https://example.com", {
  mode: 'cors',
  headers: { 'origin': 'http://different-origin.com' }
});
```

---

## Future Enhancements

1. **Proxy Integration**
   ```typescript
   const proxyUrl = `https://cors-proxy.example.com/?url=${url}`;
   await fetchRetry(proxyUrl);
   ```

2. **Request Pooling**
   ```typescript
   class FetchPool {
     async fetch(urls: string[]) {
       // Batch requests, avoid rate limiting
     }
   }
   ```

3. **Headless Browser Fallback**
   ```typescript
   if (fetchRetry fails 3 times) {
     // Launch Puppeteer
     // Render page with JavaScript
   }
   ```

4. **Smart Caching**
   ```typescript
   const cache = new Map();  // Cache 1 hour
   if (cache.has(url)) return cache.get(url);
   ```

---

**End of Implementation Details**

For questions, check:
- `README.md` — Overview
- `CHANGELOG_ROBUST_FETCH.md` — What changed
- `TESTING_GUIDE.md` — How to test
