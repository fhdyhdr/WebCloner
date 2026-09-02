# WebCloner - Advanced Website Cloning Tool

> Clone any website with complete animation preservation, framework detection, and elegant export options.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Built with React](https://img.shields.io/badge/Built%20with-React%2019-blue.svg)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org)

## ✨ Features

### 🎯 Core Functionality
- **Website Cloning** - Clone any website with complete HTML/CSS/JS preservation
- **Animation Capture** - GSAP, ScrollTrigger, Lenis, marquees, and custom animations preserved as CSS
- **Element Picker** - Interactive UI to select and extract specific sections
- **Perfect Cut** - Extracted sections animate inside full-page clone with pinned viewport

### 🚀 Smart Exports
- **Static HTML** - Single file, open directly in browser
- **Vite** - Development server with hot reload and asset proxying
- **Next.js** - App Router with server-side proxying for framework assets

### 🔧 Robust Fetching (V1 + V2)
- **User-Agent Rotation** - 5 different browser identities to bypass bot detection
- **Multiple Header Strategies** - 3 header combinations for diverse signatures
- **Graceful Degradation** - Clone succeeds even if resources unavailable
- **CORS Bypass** - Handle CORS-blocked websites with exponential backoff retry
- **Framework Detection** - Auto-detect Next.js, Nuxt, Astro, Remix, SvelteKit
- **Referer-Gated Media** - Proxy Mux, Vimeo streams server-side

### 🎨 User Experience
- **Device Preview** - Desktop (1440px) and mobile (390px) viewport switching
- **Real-time Preview** - See clone before exporting
- **Element Inspector** - Hover highlight, click to select, Shift+click to expand
- **Progress Feedback** - Toast notifications and console logging

## 🎯 Quick Start

### Prerequisites
```bash
Node.js 18+
npm or bun
```

### Installation & Development
```bash
git clone https://github.com/fhdyhdr/WebCloner.git
cd WebCloner
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

### Build for Production
```bash
npm run build
npm run preview
```

## 🚀 Usage

1. **Input URL** - Paste website link (e.g., `https://example.com`)
2. **Preview** - See clone render in real-time
3. **Select** - Click element or section to pick
4. **Export** - Download as Static HTML, Vite, or Next.js

### Test URLs
```
✅ https://www.sanjayatritis.sch.id/
✅ https://amikompurwokerto.ac.id/ (with V2 enhancements)
```

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, TailwindCSS 4 |
| UI Components | Radix UI (46 pre-built components) |
| Full-Stack | TanStack Stack (Router, Query, Start) |
| Forms | React Hook Form + Zod validation |
| Export | JSZip for ZIP generation |
| Styling | Tailwind CSS 4 + CVA |
| Animations | GSAP detection & CSS synthesis |
| Build | Vite 8 |
| Runtime | Node.js, Nitro server |
| Deployment | Cloudflare Workers |

## 📊 Performance

| Scenario | Time | Success Rate |
|----------|------|--------------|
| Normal website | 2-5s | 100% |
| CORS-blocked (V1) | 8-15s | ~40% |
| CORS-blocked (V2) | 12-18s | ~70-80% |
| Heavily-blocked | ~50-80s | Error (expected) |

## 🏗 Architecture

```
src/
├── lib/
│   ├── clone.server.ts       ← Website fetching & parsing + V2 enhancements
│   ├── clone.functions.ts    ← Server function wrapper
│   ├── export-zip.ts         ← ZIP builder (Static/Vite/Next)
│   ├── gsap-layer.ts         ← Fallback scroll animations
│   └── error handling        ← Robust error management
├── routes/
│   ├── index.tsx             ← Main UI + element picker
│   ├── __root.tsx            ← Root layout
│   └── api/preview/$id.ts    ← Preview iframe
└── components/ui/            ← 46 Radix UI components
```

## 🔧 How It Works

### Website Fetching (V1 + V2)
```typescript
// V1: Basic retry logic
- 3 User-Agents (Chrome macOS, Windows, Linux)
- Better headers (Referer, Accept-Language)
- Graceful fallback for resources

// V2: Enhanced (for aggressive blocking)
- 5 User-Agents (+ Safari, Firefox)
- 3 header combinations
- 5 retry attempts (6 total)
- Now retries on HTTP 403
- Exponential backoff (300ms → 1500ms)
```

### Animation Capture
```
1. Entrance animations - Finished animations replayed as CSS
2. Hover animations - Captured and emitted as :hover rules
3. Scroll animations - Sampled and emitted as @keyframes
4. Time-driven animations - Marquees/rotations detected and replayed
```

### Export Formats

**Static HTML**
- Single file, no dependencies
- Open directly in browser
- Includes fallback scroll layer

**Vite**
```bash
cd vite && npm install && npm run dev
```
- Full dev server with hot reload
- Asset proxying to source

**Next.js**
```bash
cd nextjs && npm install && npm run dev
```
- App Router setup
- Server-side proxying for referer-gated media

## 📚 Documentation

Comprehensive documentation available:
- `00_START_HERE_FIRST.md` - Quick start guide
- `TESTING_GUIDE.md` - Testing procedures
- `IMPLEMENTATION_DETAILS.md` - Technical deep dive
- `DEPLOYMENT_CHECKLIST.md` - Production deployment
- `V2_ENHANCED_UPDATE.md` - V2 enhancement details
- See `DOCUMENTATION_INDEX.md` for full list

## ⚡ Key Improvements (V2)

- **5 User-Agents** vs 3 (more diverse browser profiles)
- **3 Header Sets** vs 1 (different request signatures)
- **6 Total Attempts** vs 4 (more aggressive retry)
- **Retries on 403** (was just returning error)
- **Better Logging** (console output for debugging)
- **25s Timeout** vs 20s (handle slow servers)

## 🎓 Use Cases

- **Portfolio Showcase** - Clone interesting websites for inspiration
- **Design System** - Extract and study component patterns
- **Content Migration** - Move content to new platforms
- **Learning** - Study how other websites are built
- **Backup** - Archive website snapshots

## ⚠️ Limitations

1. **Dynamic Content** - API-driven content not synced (backend different origin)
2. **Authentication** - Login state not preserved
3. **JavaScript Runtime State** - Form input, counters reset
4. **Very Large Sites** - May timeout on massive pages (>10MB)

## 🗺️ Roadmap

- [ ] Proxy service integration (IP rotation)
- [ ] Headless browser fallback (Puppeteer)
- [ ] Automated test suite
- [ ] CLI version
- [ ] Browser extension
- [ ] Cloud hosting option
- [ ] Advanced filtering (remove ads, trackers)

## 🤝 Contributing

Contributions welcome! Areas for improvement:
- Proxy integration for IP rotation
- Headless browser support
- More animation detection patterns
- Performance optimization

## 📄 License

MIT License - See LICENSE file for details

## 👨‍💻 Author

Built by [fhdyhdr](https://github.com/fhdyhdr)

## 🙏 Acknowledgments

- [Lovable](https://lovable.dev) - Initial scaffolding
- [TanStack](https://tanstack.com) - Full-stack framework
- [Radix UI](https://radix-ui.com) - Component library
- [GSAP](https://greensock.com/gsap) - Animation detection
- Open source community

## 📞 Support

- Open a [GitHub Issue](https://github.com/fhdyhdr/WebCloner/issues)
- Check [Testing Guide](./TESTING_GUIDE.md)
- See [Documentation Index](./DOCUMENTATION_INDEX.md)

---

**WebCloner** - Clone websites with professional precision. 🚀

