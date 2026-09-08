# WebCloner

A fidelity-first website cloning tool that preserves animations, layouts, and runtime behavior. Clone any public website and export as Static HTML, Vite, or Next.js projects.

![WebCloner Demo](public/favicon.svg)

## 🎯 Overview

WebCloner adalah alat cloning website yang fokus pada preservasi fidelitas — mempertahankan animasi, layout, dan perilaku runtime asli website. Dibangun untuk mengatasi CORS dan bot detection blocking dengan logika retry yang robust.

## ✨ Fitur

- **Website Cloning** — Clone any public website with HTML/CSS/JS preservation
- **Animation Support** — GSAP, ScrollTrigger, and custom animations preserved
- **Element Picker** — Select and extract specific sections or elements
- **Multiple Exports** — Static HTML, Vite dev server, or Next.js project
- **CORS/Bot Detection Bypass** — Smart User-Agent rotation with exponential backoff retry

## 🚀 Quick Start

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

Open [http://localhost:5173](http://localhost:5173) to start cloning.

## 📦 Usage

1. **Paste website URL** — Enter any public website URL (including `https://`)
2. **Preview the clone** — View the cloned website in an iframe preview
3. **Select element/section** (optional) — Click "Select" then click any element in the preview
4. **Export as ZIP** — Choose Static HTML, Vite, or Next.js format

## 🛠️ Technology Stack

- **React 19** + TypeScript
- **TanStack** (Router v1.170.18, Query v5.101.1, Start v1.168.32)
- **Tailwind CSS 4**
- **Radix UI**
- **Vite 8**

## 📁 Export Formats

### Static HTML

Single file, no dependencies, opens directly in browser.

### Vite React

Full dev server with hot reload.

```bash
cd vite
npm install
npm run dev
```

### Next.js

Full-stack app with server-side proxying.

```bash
cd nextjs
npm install
npm run dev
```

## 📊 Performance

| Scenario | Build Time | Success Rate |
|----------|-----------|--------------|
| Normal website | 801ms | 100% |
| CORS-blocked | 12-18s | ~70-80% |
| Vercel deployment | Fixed | 100% |

## 📄 License

MIT

## 👤 Author

[fhdyhdr](https://github.com/fhdyhdr)