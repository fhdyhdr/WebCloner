import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { cloneSite } from "./clone.server";

export const clonePage = createServerFn({ method: "POST" })
  .inputValidator((data) => z.object({ url: z.string().min(3) }).parse(data))
  .handler(async ({ data }) => {
    return await cloneSite(data.url);
  });
