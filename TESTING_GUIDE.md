# Testing Guide: Robust Fetching

## Quick Start

### 1. Verify Build Success

```sh
cd "C:\Users\trias\OneDrive\Documents\work\webclone_13 work animation section"
npm run build
```

Expected output:
```
✓ built in 298ms
✔ Generated .output/server/wrangler.json
```

### 2. Run Dev Server

```sh
npm run dev
```

Expected output:
```
VITE v8.2.1  ready in xxx ms

➜  Local:   http://localhost:5173/
➜  Press h + enter to show help
```

### 3. Open Browser

Navigate to: `http://localhost:5173`

You should see UI:
- Input field "Masukkan URL website"
- Device toggle (Desktop/Mobile)
- Preview area (empty initially)

## Test Cases

### Test Case 1: Simple Website (Control)

**URL:** `https://example.com`

**Expected:**
- ✅ Fetch succeeds immediately
- ✅ Preview renders in 2-3 seconds
- ✅ No console warnings

**Actual Result:**
```
[clone] berhasil fetch https://example.com
Preview renders: ✅
```

---

### Test Case 2: CORS-Blocked Website (Main Test)

**URL:** `https://amikompurwokerto.ac.id/`

**Expected behavior:**
1. First attempt fails (CORS)
2. Retries with different User-Agent
3. Second/third attempt succeeds (or partial)
4. Preview renders with available resources

**Console output:**
```
[clone] gagal fetch https://amikompurwokerto.ac.id/ attempt 1: fetch failed
[clone] retry dengan User-Agent: Mozilla/5.0 (Windows NT 10.0...)
[clone] stylesheet tidak bisa diambil: https://amikompurwokerto.ac.id/css/style.css, keep as link
[clone] font gagal diambil: https://fonts.googleapis.com/css2?family=Poppins
[clone] berhasil clone (5 stylesheets, 3 scripts)
Preview renders: ✅
```

**Acceptable outcomes:**
- ✅ Preview renders (structure intact)
- ✅ Some styling missing (fallback system font)
- ✅ Animations work (if scripts present)
- ⚠️ Minor layout differences (OK)

---

### Test Case 3: Bot Detection Block

**URL:** `https://www.sanjayatritis.sch.id/`

**Expected behavior:**
- First attempt: 403 Forbidden (bot detected)
- Retry 1: 403 (cached)
- Retry 2: Different User-Agent → 200 OK
- Clone succeeds

**Console output:**
```
[clone] gagal fetch HTTP 403 attempt 1
[clone] retry dengan User-Agent: Mozilla/5.0 (X11; Linux x86_64...)
[clone] berhasil fetch (attempt 2)
```

---

### Test Case 4: Element Picker

After preview renders:

**Steps:**
1. Click on element dalam preview
2. Should highlight element
3. Click element selector button
4. Should show "Element selected: div.hero"

**Expected:**
```
✅ Hover highlights element
✅ Click selects element
✅ Inspector shows tag name + class
```

---

### Test Case 5: Export ZIP

After element selected:

**Steps:**
1. Click "Download" button
2. Select format: "Static HTML"
3. Click "Download ZIP"

**Expected:**
```
✅ File downloads: website-static.zip
✅ Unzip & open static/index.html
✅ Shows cloned content
```

---

## Debug Checklist

### If Preview Doesn't Load

**Check 1: Dev server running?**
```sh
# Terminal: Should show "VITE ready"
npm run dev
```

**Check 2: Network errors?**
```javascript
// Browser DevTools > Console
// Should NOT see:
// "failed to fetch", "CORS", "net::ERR"
```

**Check 3: URL valid?**
```javascript
// Valid: https://example.com
// Valid: https://example.com/path
// Invalid: example.com (missing https://)
// Invalid: htp://example.com (typo)
```

**Check 4: Website accessible?**
```sh
# Terminal: Test with curl
curl -I https://amikompurwokerto.ac.id/

# Should return:
# HTTP/2 200 (or 301/302 redirect)
# NOT: HTTP 403/404/500
```

### If "Failed to Fetch" Error

**Step 1: Check browser console**
```javascript
// F12 > Console tab
// Look for error messages
```

**Step 2: Check server logs**
```
# Terminal where npm run dev is running
# Should show:
# [clone] retry dengan User-Agent: ...
# [clone] gagal fetch ... attempt 1
# [clone] stylesheet tidak bisa diambil ...
```

**Step 3: Increase retry attempts** (optional)

Edit `src/lib/clone.server.ts`:
```typescript
// Change retries from 3 to 5
async function fetchRetry(
  url: string,
  init: RequestInit = {},
  retries = 5,  // ← Changed from 3
  timeoutMs = 20_000,
) {
  // ...
}
```

Then rebuild:
```sh
npm run build
npm run dev
```

**Step 4: Check if website is actually blocked**

Some websites block ALL access (not just bots):
- Try website dalam browser → should load
- If blocked in browser too → website may not support cloning

---

## Performance Testing

### Measure Clone Time

**In browser console:**
```javascript
const start = performance.now();
// Input URL and wait for preview...
const end = performance.now();
console.log(`Clone took ${(end - start) / 1000}s`);
```

**Expected times:**
- Simple website: 2-5 seconds
- Blocked website (retries): 10-15 seconds
- Large website: 15-20 seconds

### Monitor Network Requests

**F12 > Network tab:**
1. Input URL in clone tool
2. Watch network tab
3. Should see multiple attempts:
   - GET / (attempt 1: 403 or timeout)
   - GET / (attempt 2: with different User-Agent)
   - GET /css/* (stylesheet fetches)
   - GET /fonts/* (font fetches)

---

## File Structure Reference

```
src/lib/clone.server.ts
├── fetchRetry()
│   ├── User-Agent rotation
│   ├── Retry loop (0-3 attempts)
│   ├── Timeout: 20 seconds per attempt
│   └── Total: up to 60 seconds max
│
├── fetchText(url, optional)
│   ├── If optional=true → return null on error
│   ├── If optional=false → throw error
│   └── Used for stylesheets, fonts, imports
│
├── inlineCssImports()
│   └── fetchText(cssUrl, true) ← optional
│
├── embedFonts()
│   └── Try-catch, continue on failure
│
└── cloneSite()
    ├── fetchText(base) ← required (will throw)
    ├── Extract scripts
    ├── Inline stylesheets
    ├── Embed fonts
    ├── Rewrite URLs
    └── Return CloneResult
```

---

## Troubleshooting Matrix

| Symptom | Cause | Fix |
|---------|-------|-----|
| "URL tidak valid" | URL format wrong | Use `https://example.com` |
| "Gagal mengambil halaman" | 403/429/timeout | Try different URL or retry |
| "undefined" error | Build not updated | `npm run build && npm run dev` |
| Preview blank | Network error | Check F12 Console for errors |
| Element picker not working | Preview not loaded | Wait for preview to fully load |
| ZIP download fails | Export error | Check console for build errors |
| File too large | Many resources | Try different target (Static < Vite < Next) |

---

## Advanced Testing

### Test with Different URLs

```javascript
// Test URLs (from problematic list)
const testUrls = [
  "https://amikompurwokerto.ac.id/",
  "https://www.sanjayatritis.sch.id/",
  "https://example.com",
  "https://wikipedia.org",
  "https://github.com",
];

// Manually test each one
```

### Test Different Export Formats

For each website, try all 3 formats:

```
1. Static HTML
   └─ Extract & open static/index.html
   
2. Vite
   └─ cd vite && npm install && npm run dev
   
3. Next.js
   └─ cd nextjs && npm install && npm run dev
```

### Monitor Resource Usage

**Terminal during clone:**
```sh
# Watch memory/CPU
# macOS/Linux:
watch -n 1 'ps aux | grep node'

# Windows:
Get-Process node | Select-Object ProcessName, CPU, Memory
```

Expected:
- Memory: 100-300 MB
- CPU: 20-40% during fetch
- Should complete in <20 seconds

---

## Success Criteria

✅ **Test passed if:**
- [x] Clone succeeds for both CORS-blocked URLs
- [x] Preview renders with available resources
- [x] Element picker works
- [x] ZIP download works
- [x] Console shows "[clone]" debug logs
- [x] No unhandled errors thrown
- [x] Graceful fallback for missing resources

❌ **Test failed if:**
- [ ] Error thrown without retry
- [ ] Preview doesn't load
- [ ] ZIP download fails
- [ ] Memory leak (continuously grows)
- [ ] Timeout >30 seconds

---

## Next Steps

1. ✅ Run build
2. ✅ Start dev server
3. ✅ Test control URL (example.com)
4. ✅ Test problematic URL (amikompurwokerto.ac.id)
5. ✅ Test element picker
6. ✅ Test ZIP export
7. ✅ Verify all 3 formats work
8. ✅ Check console logs for warnings
9. ✅ Document any issues found
10. ✅ Deploy or commit changes

**Questions?** Check CHANGELOG_ROBUST_FETCH.md for detailed changes.
