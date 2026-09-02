# WebCloner

Clone any website and export as Static HTML, Vite, or Next.js.

## Features

- **Website Cloning** - Clone any website with HTML/CSS/JS preservation
- **Animation Support** - GSAP, ScrollTrigger, and custom animations preserved
- **Element Picker** - Select and extract specific sections
- **Multiple Exports** - Static HTML, Vite dev server, or Next.js project
- **CORS Handling** - Bypass CORS/bot detection with smart retry logic

## Quick Start

### Prerequisites
- Node.js 18+
- npm or bun

### Installation

```bash
git clone https://github.com/fhdyhdr/WebCloner.git
cd WebCloner
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

## Usage

1. Paste website URL
2. Preview the clone
3. Select element or section (optional)
4. Export as Static HTML, Vite, or Next.js

## Technology Stack

- React 19 + TypeScript
- TanStack (Router, Query, Start)
- Tailwind CSS 4
- Radix UI
- Vite 8

## Export Formats

**Static HTML** - Single file, no dependencies, open directly in browser

**Vite** - Full dev server with hot reload
```bash
cd vite
npm install
npm run dev
```

**Next.js** - Full-stack app with server-side proxying
```bash
cd nextjs
npm install
npm run dev
```

## Performance

| Scenario | Time | Success Rate |
|----------|------|--------------|
| Normal website | 2-5s | 100% |
| CORS-blocked | 12-18s | ~70-80% |

## License

MIT

## Author

[fhdyhdr](https://github.com/fhdyhdr)