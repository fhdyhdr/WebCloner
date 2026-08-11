import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { Download, Globe, Loader2, Monitor, Smartphone, Zap } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { clonePage } from "@/lib/clone.functions";
import { buildPreviewHtml, buildZip, type CloneResult, type Target } from "@/lib/export-zip";

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
        content: "Input link, preview, download ZIP: static HTML, Vite, dan Next.js dengan GSAP ScrollTrigger.",
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

function Index() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<CloneResult | null>(null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [targets, setTargets] = useState<Target[]>(["static", "vite", "next"]);
  const [zipping, setZipping] = useState(false);
  const run = useServerFn(clonePage);

  const mutation = useMutation({
    mutationFn: async (value: string) => (await run({ data: { url: value } })) as CloneResult,
    onSuccess: (data) => {
      setResult(data);
      toast.success(`Berhasil mengkloning ${new URL(data.url).hostname}`);
    },
    onError: (e: Error) => toast.error(e.message || "Gagal mengambil halaman"),
  });

  const toggle = (t: Target) =>
    setTargets((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const download = async () => {
    if (!result) return;
    if (targets.length === 0) return toast.error("Pilih minimal satu format");
    setZipping(true);
    try {
      const blob = await buildZip(result, targets);
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
                  {result.url} · {result.stylesheets} stylesheet · {result.assets.length} aset
                </p>
              </div>
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

            <div className="mt-5 overflow-hidden rounded-2xl border border-border bg-card p-3">
              <div className={device === "mobile" ? "mx-auto w-[390px] max-w-full" : "w-full"}>
                <iframe
                  title="Preview hasil kloning"
                  srcDoc={buildPreviewHtml(result)}
                  sandbox="allow-same-origin allow-scripts"
                  className="h-[70vh] w-full rounded-xl bg-white"
                />
              </div>
            </div>

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
              {zipping ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              Download ZIP
            </button>
          </section>
        ) : (
          <p className="mt-12 max-w-xl font-mono text-xs leading-relaxed text-muted-foreground">
            Catatan: kloning bersifat statis — markup, CSS, dan aset diambil apa adanya, sementara
            skrip asli dilepas dan diganti layer animasi GSAP ScrollTrigger. Halaman yang seluruh
            isinya dirender oleh JavaScript bisa tampil kosong.
          </p>
        )}
      </main>
    </div>
  );
}
