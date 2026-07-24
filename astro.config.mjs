// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  // `passthrough` keeps the adapter from wiring up a Cloudflare Images binding.
  // There are no Astro <Image> components here — the only images are remote
  // avatars in plain <img> tags — so the binding would be a provisioning step
  // and an extra token permission bought for nothing.
  adapter: cloudflare({ imageService: "passthrough" }),

  site: "https://usage.sh",

  // Every page is assembled live from upstream sources, so nothing can be
  // prerendered. Freshness comes from edge caching, not from build-time output.
  output: "server",

  // The adapter defaults to backing Astro sessions with an auto-provisioned KV
  // namespace, which makes `wrangler deploy` call the KV API and therefore
  // demand Workers KV Storage:Edit on the deploy token. This site is stateless
  // and reads nothing per-visitor, so declaring any driver at all suppresses
  // that injection and keeps the token scoped to Workers Scripts:Edit.
  session: { driver: "memory" },

  // Islands are the point of choosing Astro here: pages ship zero JavaScript by
  // default, and interactivity (a command palette, comparison controls) can be
  // added per-component later without turning this into a SPA.
  build: { inlineStylesheets: "always" },
});
