import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { cloneSite, setPreviewHtml } from "./clone.server";
import { buildPreviewHtml } from "./export-zip";

export const clonePage = createServerFn({ method: "POST" })
  .validator((data) => z.object({ url: z.string().min(3) }).parse(data))
  .handler(async ({ data }) => {
    const result = await cloneSite(data.url);
    const previewId = crypto.randomUUID();
    setPreviewHtml(previewId, buildPreviewHtml(result), result.url);
    return { ...result, previewId };
  });
