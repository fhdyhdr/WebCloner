import { createStart } from "@tanstack/react-start";
import { renderErrorPage } from "./lib/error-page";

export const startInstance = createStart({
  requestMiddleware: [],
});
