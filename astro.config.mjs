// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  adapter: cloudflare(),
  site: "https://usage.sh",

  // Every page is assembled live from upstream sources, so nothing can be
  // prerendered. Freshness comes from edge caching, not from build-time output.
  output: "server",

  // Islands are the point of choosing Astro here: pages ship zero JavaScript by
  // default, and interactivity (a command palette, comparison controls) can be
  // added per-component later without turning this into a SPA.
  build: { inlineStylesheets: "always" },
});
