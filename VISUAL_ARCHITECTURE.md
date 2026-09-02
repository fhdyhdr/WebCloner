# Visual Architecture: Robust Fetching Flow

## Overall Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     User Input URL                              │
│              https://amikompurwokerto.ac.id/                   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │  cloneSite()    │
                    │ (Main entry)    │
                    └────────┬────────┘
                             │
                ┌────────────┼────────────┐
                │                        │
                ▼                        ▼
         ┌─────────────────┐    ┌──────────────────┐
         │ fetchText(url)  │    │ Validate URL     │
         │   REQUIRED      │    │ Check protocol   │
         │                 │    │ (http/https)     │
         └────────┬────────┘    └──────────────────┘
                  │
                  ▼
         ┌─────────────────────────┐
         │  fetchRetry()           │
         │  (With 3 Retries)       │
         └────────┬────────────────┘
                  │
    ┌─────────────┼─────────────┐
    │             │             │
    ▼             ▼             ▼
┌─────────┐  ┌─────────┐  ┌─────────┐
│Attempt 1│  │Attempt 2│  │Attempt 3│
│UA: macOS│  │UA: Win  │  │UA: Linux│
│Headers  │  │Headers  │  │Headers  │
└────┬────┘  └────┬────┘  └────┬────┘
     │            │            │
     ▼            ▼            ▼
  ┌──────────────────────────────────────┐
  │  fetch(url, { headers, timeout })    │
  │         (20 second timeout)          │
  └──────┬───────────────────────────────┘
         │
    ┌────┴────────────────────────────┐
    │                                  │
    ▼                                  ▼
  Success                            Fail
    │                                  │
    ├─ 200-299: ✅ Return             ├─ 4xx: Return (don't retry)
    ├─ 300-399: ✅ Return             ├─ 5xx: Retry
    │                                  ├─ 429: Retry
    │                                  ├─ Timeout: Retry
    │                                  └─ Network: Retry
    │                                  
    │                  ┌─ Wait 400ms ─┐
    │                  │ Wait 800ms ─ ├─ Try next attempt
    │                  └ Wait 1200ms ┘
    │
    ▼
  HTML Content ✅
```

## Resource Processing Flow

```
┌──────────────────────────┐
│   HTML Content Ready     │
└────────────┬─────────────┘
             │
    ┌────────┼────────┐
    │        │        │
    ▼        ▼        ▼
┌────────┐ ┌──────┐ ┌────────┐
│Scripts │ │Styles│ │Content │
└────┬───┘ └──┬───┘ └────┬───┘
     │        │         │
     ▼        ▼         ▼
┌──────────────────────────────────────┐
│  Extract Resources (Before rewrite)  │
│  - Extract <script> tags             │
│  - Extract <link rel="stylesheet">   │
│  - Extract <style> blocks            │
│  - Extract text content              │
└──────────┬───────────────────────────┘
           │
    ┌──────┴──────┬──────────┬─────────┐
    │             │          │         │
    ▼             ▼          ▼         ▼
┌─────────┐  ┌──────────┐ ┌────────┐ ┌────────┐
│ Scripts │  │Stylesheets│ │Imports │ │ Fonts  │
│ KEEP    │  │ INLINE   │ │ INLINE │ │EMBED   │
│ AS SRC  │  │ OR KEEP  │ │ OR SKIP│ │OR SKIP │
└────┬────┘  └────┬─────┘ └───┬────┘ └───┬────┘
     │            │            │         │
     │    ┌───────▼─────────┐  │         │
     │    │  fetchText()    │  │         │
     │    │  optional=false │  │         │
     │    │  REQUIRED       │  │         │
     │    │                 │  │         │
     │    │  Results:       │  │         │
     │    │  ✅ Inline CSS  │  │         │
     │    │  ⚠️ Keep <link> │  │         │
     │    └────────────────┘  │         │
     │                        │         │
     │                ┌───────▼────────┐
     │                │fetchText()     │
     │                │optional=true   │
     │                │FALLBACK OK     │
     │                │                │
     │                │ If fail:       │
     │                │ ✅ Skip import │
     │                │ ✅ Skip font   │
     │                └────────────────┘
     │
     ▼
┌─────────────────────────────────────┐
│     URL Rewriting                   │
│ - Absolutize relative URLs          │
│ - Proxy referer-gated media         │
│ - Sanity CDN URLs                   │
└────────────────┬────────────────────┘
                 │
                 ▼
        ┌──────────────────┐
        │  CloneResult {}  │
        ├──────────────────┤
        │ url              │
        │ title            │
        │ html             │
        │ body             │
        │ css              │
        │ scripts[]        │
        │ styles[]         │
        │ linkTags[]       │
        │ isFramework      │
        │ previewId        │
        └──────────────────┘
```

## Error Handling Flowchart

```
                    ┌─────────────────┐
                    │ fetchText(url)  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ optional param? │
                    └────┬────────┬───┘
                         │        │
                    No   │        │   Yes
                         │        │
            ┌────────────┘        └──────────────┐
            │                                    │
            ▼                                    ▼
    ┌──────────────────┐        ┌──────────────────────┐
    │ Fetch fails?     │        │ Fetch fails?         │
    └────┬────────┬───┘        └────┬────────┬────────┘
         │        │                 │        │
      Yes│        │No            Yes│        │No
         │        │                 │        │
         ▼        ▼                 ▼        ▼
    ┌───────┐  ┌──────┐        ┌────────┐ ┌──────┐
    │THROW  │  │Return│        │RETURN  │ │Return│
    │ERROR  │  │ OK   │        │ null   │ │ OK   │
    │ ❌    │  │  ✅  │        │  ⚠️    │ │  ✅  │
    └───────┘  └──────┘        └────────┘ └──────┘
         │        │                 │        │
         │        └─────────┬───────┘        │
         │                  │                │
    Process fails      ┌─────▼──────┐       │
    Clone aborts       │ In caller: │       │
    ❌                │ Check null │  Return
                       │ Handle as  │   ✅
                       │ fallback   │
                       └────────────┘
                            │
                ┌───────────┬┴────────────┐
                │           │            │
         CSS OK │     ✅ Inline  ⚠️ Keep link
         Font OK│     ✅ Embed   ⚠️ Skip font
         Import │     ✅ Inline  ⚠️ Skip import
                │
         Clone continues ✅
```

## Resource Decision Tree

```
                        ┌─────────────────────┐
                        │  Resource Type      │
                        └──────────┬──────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
        ▼                          ▼                          ▼
   ┌──────────┐            ┌─────────────┐           ┌──────────────┐
   │ REQUIRED │            │  OPTIONAL   │           │  OPTIONAL    │
   │(Main HTML)            │(Stylesheets)│           │ (Fonts/Import)
   └────┬─────┘            └──────┬──────┘           └────┬─────────┘
        │                         │                      │
        ▼                         ▼                      ▼
   ┌──────────┐            ┌──────────────┐        ┌──────────────┐
   │ fetchText│            │ fetchText()  │        │ fetchText()  │
   │ (no opt) │            │ optional=true│        │ optional=true│
   └────┬─────┘            └──────┬───────┘        └────┬─────────┘
        │                         │                     │
    ┌───┴────────┐           ┌────┴────┐          ┌────┴────┐
    │             │           │         │          │         │
    ▼             ▼           ▼         ▼          ▼         ▼
  ✅OK          ❌FAIL      ✅OK       ❌FAIL    ✅OK       ❌FAIL
    │             │           │         │          │         │
    │             │           │         │          │         │
 Process       THROW       Inline   Keep Link   Embed    Skip
 continue      ERROR        CSS        TAG      Font     Font
  ✅            ❌          ✅         ✅        ✅       ✅
```

## Timeline: Single Website Clone

### Case 1: Normal Website (Simple)
```
Time  Event
─────────────────────────────────────────────
0s    Input: https://example.com
0s    Validate URL ✅
0.5s  fetchText(base) - Attempt 1 ✅ 200 OK
1.5s  Extract resources
2s    Fetch stylesheets (all inline ✅)
2.5s  Embed fonts (all embedded ✅)
3s    Rewrite URLs
3.5s  ✅ CLONE SUCCESS
      Time: 3.5 seconds
      Resources: 100% inlined
```

### Case 2: CORS-Blocked Website
```
Time  Event
─────────────────────────────────────────────
0s    Input: https://amikompurwokerto.ac.id/
0s    Validate URL ✅
0.5s  fetchText(base) - Attempt 1 ❌ 403 Forbidden
0.9s  Wait 400ms backoff
1.3s  fetchText(base) - Attempt 2 with UA2 ❌ 403
1.7s  Wait 800ms backoff
2.5s  fetchText(base) - Attempt 3 with UA3 ✅ 200 OK
3.5s  Extract resources
4s    Fetch stylesheet 1 ✅ Inline
4.5s  Fetch stylesheet 2 ❌ Keep <link>
5s    Fetch stylesheet 3 ✅ Inline
5.5s  Fetch fonts ❌ Skip (fallback)
6s    Fetch imports ✅ Inline
7s    Rewrite URLs
7.5s  ✅ CLONE SUCCESS
      Time: 7.5 seconds
      Resources: ~60% inlined, ~40% fallback
```

### Case 3: Heavily Blocked Website
```
Time  Event
─────────────────────────────────────────────
0s    Input: https://blocked.example.com/
0s    Validate URL ✅
0.5s  fetchText(base) - Attempt 1 ❌ Timeout
0.9s  Wait 400ms
1.3s  fetchText(base) - Attempt 2 ❌ Timeout
2.1s  Wait 800ms
3s    fetchText(base) - Attempt 3 ❌ 429 Rate Limited
3.8s  Wait 1200ms
5s    fetchText(base) - Attempt 4 ❌ 403 Forbidden
6s    ❌ CLONE FAILED (All retries exhausted)
      Time: 6 seconds
      Error: "Gagal mengambil halaman: HTTP 403..."
```

## Request Headers Comparison

### Before (Simple)
```
GET / HTTP/1.1
Host: example.com
User-Agent: Mozilla/5.0 ...
Accept: */*
```

### After (Robust)
```
GET / HTTP/1.1
Host: example.com
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8
Accept-Language: en-US,en;q=0.9
Referer: https://example.com/
Cache-Control: no-cache
```

**Headers added:**
- ✅ More specific User-Agent (looks like real browser)
- ✅ Accept-Language (looks like real browser)
- ✅ Referer (looks like real browser)
- ✅ Cache-Control (bypass aggressive caching)

## Resource Fallback Chain

```
STYLESHEET FETCH
┌─────────────────────┐
│ Try inline CSS      │
└──────┬──────────────┘
       │ Success? ✅
       └─→ CSS inlined into <style> tag
       
       │ Fail? ❌
       └─→ ┌─────────────────────┐
           │ Keep original <link>│
           └──────┬──────────────┘
                  │
                  └─→ Browser will load from source
                      (May fail if CORS, but at least we tried)


FONT FETCH
┌──────────────────────┐
│ Try embed as base64  │
└──────┬───────────────┘
       │ Success? ✅
       └─→ Font embedded in CSS data URI
       
       │ Fail? ❌
       └─→ ┌──────────────────────┐
           │ Remove @font-face    │
           └──────┬───────────────┘
                  │
                  └─→ Browser uses system fallback font
                      (May look different, but functional)


CSS @IMPORT
┌──────────────────────┐
│ Try inline import    │
└──────┬───────────────┘
       │ Success? ✅
       └─→ Imported CSS merged into main stylesheet
       
       │ Fail? ❌
       └─→ ┌──────────────────────┐
           │ Remove @import rule  │
           └──────┬───────────────┘
                  │
                  └─→ Component CSS missing, but page works
                      (May lack styling, but not broken)
```

## Success vs Failure States

```
BEFORE ROBUST FETCHING
═════════════════════════════════

CORS-Blocked Website
    ↓
Try fetch
    ↓
❌ CORS ERROR
    ↓
THROW EXCEPTION
    ↓
❌ CLONE FAILED
    ↓
Show error to user
⏱️  Time: ~2 seconds


AFTER ROBUST FETCHING
═════════════════════════════════

CORS-Blocked Website
    ↓
Try fetch (Attempt 1) ❌ 403
    ↓
Wait 400ms, Try with different UA (Attempt 2) ❌ 403
    ↓
Wait 800ms, Try with different UA (Attempt 3) ✅ 200 OK
    ↓
Extract resources
    ↓
Try inline stylesheets
├─ Stylesheet A ✅ Inline
├─ Stylesheet B ❌ Keep <link>
└─ Stylesheet C ✅ Inline
    ↓
Try embed fonts
├─ Font A ✅ Embed
└─ Font B ❌ Skip
    ↓
✅ CLONE PARTIAL SUCCESS
    ↓
Show preview to user
    ├─ Structure: 100% intact
    ├─ Styling: ~80% (some fallback)
    └─ Functionality: 100% (scripts preserved)
⏱️  Time: ~12-18 seconds
```

---

**Visual Summary:** Multi-layer retry logic + graceful fallback = higher success rate even with blocking.
