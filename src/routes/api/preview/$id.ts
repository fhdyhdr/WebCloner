import { createFileRoute } from "@tanstack/react-router";
import { getPreviewHtml } from "@/lib/clone.server";

export const Route = createFileRoute("/api/preview/$id")({
  server: {
    handlers: {
      GET: ({ params }) => {
        const html = getPreviewHtml(params.id);
        if (!html) return new Response("Preview not found", { status: 404 });
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  },
});