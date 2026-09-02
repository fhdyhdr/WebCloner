# Web Duplicator

Clone website dengan animasi GSAP/ScrollTrigger preserved. Tanpa AI, pure fetch + rewrite + animation synthesis.

**Input URL → Preview → Download** sebagai HTML/CSS/JS, Vite, atau Next.js

## Fitur Utama

- ✅ Clone website + semua animasi (GSAP, ScrollTrigger, Lenis, marquee, rotation)
- ✅ Element picker: pilih section mana yang mau di-export
- ✅ Perfect cut: section animates inside full-page clone (pinned via hash)
- ✅ Export 3 format: Static HTML, Vite dev, Next.js App Router
- ✅ Framework detection: Next.js, Nuxt, Astro, Remix, SvelteKit
- ✅ Robust fetching: Multiple User-Agents, retry logic, graceful degradation
- ✅ Handle CORS/blocking: Fallback jika fetch gagal, tetap clone frontendnya

## Perubahan Recent (Robust Fetching)

### Problem
Website dengan backend blocking (CSP headers, bot detection, regional blocks) gagal dengan error "failed to fetch":
- `https://amikompurwokerto.ac.id/`
- `https://www.sanjayatritis.sch.id/`

### Solution
**Multiple strategies untuk bypass blocking:**

1. **Rotating User-Agents** — coba 3 different User-Agents (Chrome macOS, Windows, Linux)
2. **Better headers** — tambah Referer, Accept-Language, Accept, Cache-Control
3. **Optional fetching** — stylesheet/font/imports gagal → keep as `<link>` tag, jangan throw error
4. **Graceful degradation** — tetap clone frontendnya meski beberapa resources gagal

### Kode Changes
File: `src/lib/clone.server.ts`

**1. fetchRetry()** — Multiple User-Agent rotation
```typescript
const userAgents = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)...",  // Chrome macOS
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64)...",         // Chrome Windows
  "Mozilla/5.0 (X11; Linux x86_64)...",                   // Chrome Linux
];
// Setiap attempt coba user-agent berbeda
const userAgent = userAgents[attempt % userAgents.length]!;
```

**2. fetchText()** — Optional mode
```typescript
async function fetchText(url: string, optional = false) {
  try {
    const res = await fetchRetry(url, {...});
    if (!res.ok) {
      if (optional) return null;  // ← Silent fail
      throw new Error(...);
    }
    return sanitizeLineTerminators(await res.text());
  } catch (e) {
    if (optional) {
      console.warn(`[clone] optional fetch gagal: ${url}`);
      return null;  // ← Tetap lanjut
    }
    throw e;
  }
}
```

**3. inlineCssImports()** — Skip gagal imports
```typescript
const raw = await fetchText(cssUrl, true);  // ← optional=true
if (!raw) continue;  // Skip jika gagal
```

**4. embedFonts()** — Graceful font embedding
```typescript
const res = await fetch(clean, {...});
if (!res.ok) {
  console.warn(`[clone] font gagal diambil ${clean}`);
  continue;  // Skip font, browser akan gunakan fallback
}
```

**5. Stylesheet inlining** — Keep link tags jika gagal
```typescript
const raw = await fetchText(cssUrl, true);
if (!raw) {
  keptLinkTags.push(tag);  // ← Keep original <link>
  continue;
}
```

## Hasil

| Skenario | Sebelum | Sesudah |
|----------|--------|--------|
| Website normal | ✅ Clone | ✅ Clone |
| Website + CORS block | ❌ Gagal | ✅ Clone (tanpa stylesheet inline) |
| Website + bot detection | ❌ Gagal | ✅ Clone (retry 3x diff User-Agent) |
| Website + CSP headers | ❌ Gagal | ✅ Clone (fallback ke link tags) |
| Missing fonts/CSS | ❌ Gagal | ✅ Clone (browser load fallback) |

## Cara Pakai

### Development

```sh
git clone <repo-url>
cd <repo-name>
npm i
npm run dev
```

Buka `http://localhost:5173`

### Testing URLs dengan Backend

1. Input URL: `https://amikompurwokerto.ac.id/`
2. Tunggu preview render (multiple retries, ~10-15 detik)
3. Pilih device: Desktop / Mobile
4. Klik element untuk pick section
5. Download: Static / Vite / Next.js

**Expected behavior:**
- ✅ Frontend cloned dengan styling
- ✅ Animations preserved (jika website ada scripts-nya)
- ✅ Graceful fallback jika backend resources unavailable
- ⚠️ Dynamic content (API-driven) tidak sync (normal, backend di clone origin)

## Architecture

```
src/
├── lib/
│   ├── clone.server.ts          ← Main fetching + parsing
│   ├── clone.functions.ts       ← Server function wrapper
│   ├── export-zip.ts            ← ZIP builder (Static/Vite/Next)
│   ├── gsap-layer.ts            ← Fallback scroll reveal
│   └── ...
├── routes/
│   ├── index.tsx                ← UI + element picker
│   ├── __root.tsx               ← Root layout
│   └── api/preview/$id.ts       ← Preview iframe route
└── components/ui/               ← 46 Radix UI components
```

## Tech Stack

- **Framework**: TanStack Start (React 19, TypeScript)
- **Build**: Vite 8
- **Styling**: Tailwind CSS 4
- **UI**: Radix UI + Shadcn patterns
- **Forms**: React Hook Form + Zod
- **Export**: JSZip
- **Animation**: GSAP detection + synthesis

## Known Limitations

1. **Backend API calls** — tidak bekerja di clone (beda origin)
   - Solution: Proxy rewrites di Vite/Next config
   
2. **Authentication** — login tidak sync
   - Solution: Clone hanya bagian public

3. **JavaScript runtime state** — form input, counters reset
   - Solution: Preserve kode script, tetap execute

## Build

```sh
npm run build          # Production build (Cloudflare)
npm run preview        # Preview build locally
npm run lint           # ESLint check
npm run format         # Prettier format
```

## Project Status

✅ **Core features working:**
- Fetch + parse website
- Extract animations
- Element picker
- ZIP export (3 targets)
- Robust fetching + graceful degradation

🚀 **Recent improvements:**
- Multiple User-Agent rotation
- Optional resource fetching
- Better error handling
- Support websites dengan CORS/bot detection

## Credits

Built with [Lovable](https://lovable.dev) + custom enhancements.

---

**Questions?** Check `/src/lib/clone.server.ts` untuk fetch logic dan `/src/routes/index.tsx` untuk UI logic.

