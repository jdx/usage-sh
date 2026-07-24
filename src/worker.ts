/**
 * usage.sh — a homepage for command-line tools.
 *
 * Experimental. Nothing here is deployed. See README.md.
 *
 * Two constraints shape everything:
 *
 * 1. **Any public repo gets a page on first hit, with no registration.**
 *    Everything is detected live. mise-versions is enrichment, never a gate —
 *    its registry is deliberately curated, and gating pages on it would turn
 *    registry submissions into a queue of people who only want a usage.sh page.
 *
 * 2. **GitHub is one forge, not the model.** Routing and page assembly go
 *    through the Forge interface; ref detection is plain git protocol and is
 *    already portable. See ./forges/.
 *
 * URL scheme:
 *   /gh/:owner/:repo    a repo on GitHub
 *   /ghu/:login         a person on GitHub
 *
 * Per-forge prefixes rather than /gh/user/:login, which would be ambiguous with
 * /gh/:owner/:repo — both are three segments.
 */

import { forgeByPath } from "./forges";
import type { Forge, ForgeCtx } from "./forges";
import { takNotesSha } from "./git";

export interface Env {
  /** Response and detection cache. */
  CACHE: KVNamespace;
  /** Static assets (the SPA). */
  ASSETS: Fetcher;
  /** Optional; raises the GitHub API rate limit. */
  GITHUB_TOKEN?: string;
}

const MISE_VERSIONS = "https://mise-versions.jdx.dev";
const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": CACHE_CONTROL,
    },
  });
}

/**
 * Optional enrichment from mise's registry: backends, aqua links, aggregated
 * release history. Absence is the common case and means nothing is missing.
 *
 * GitHub-only for now, because mise-versions keys its entries on GitHub slugs.
 */
async function miseEntry(forge: Forge, owner: string, repo: string) {
  if (forge.id !== "gh") return null;
  const res = await fetch(`${MISE_VERSIONS}/tools.json`, {
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) return null;
  const { tools } = (await res.json()) as {
    tools: Array<{ name: string; github?: string; [k: string]: unknown }>;
  };
  const slug = `${owner}/${repo}`.toLowerCase();
  return tools.find((t) => t.github?.toLowerCase() === slug) ?? null;
}

/**
 * Release history for a tool already known to mise: pre-aggregated, cached, and
 * costs nobody's API rate limit. Returns null so the caller falls back to the
 * forge, which is what happens for the great majority of repos.
 */
async function miseReleases(toolName: string) {
  const res = await fetch(
    `${MISE_VERSIONS}/${encodeURIComponent(toolName)}.toml`,
    { cf: { cacheTtl: 3600, cacheEverything: true } },
  );
  if (!res.ok) return null;
  // TODO: parse the TOML rather than handing it back raw.
  return { source: "mise-versions", format: "toml", raw: await res.text() };
}

/**
 * Performance history from `refs/notes/tak`.
 *
 * Detection is done and cheap: git smart HTTP v2 `ls-refs` is an ordinary POST,
 * so no git binary and no origin service is involved — 64 bytes for a repo that
 * has the ref, 4 for one that does not. Reading note *contents* needs a packfile
 * fetch and delta resolution, which is the remaining work. Until then we report
 * presence and the ref SHA, which decides whether the tab exists and doubles as
 * its cache key.
 */
async function performance(forge: Forge, owner: string, repo: string) {
  const sha = await takNotesSha(forge.cloneUrl(owner, repo));
  if (!sha) return null;
  return { present: true, notes_sha: sha, records: null };
}

async function handleRepo(
  forge: Forge,
  owner: string,
  repo: string,
  env: Env,
): Promise<Response> {
  const ctx: ForgeCtx = { token: env.GITHUB_TOKEN };

  const meta = await forge.repoMeta(owner, repo, ctx);
  if (!meta) {
    return json(
      { error: `repository not found or not public on ${forge.name}` },
      404,
    );
  }

  // Independent sources, resolved concurrently. Any one failing degrades its own
  // tab to null and never takes the page down.
  const [spec, perf, mise, people, forgeReleases] = await Promise.all([
    forge.usageSpec(owner, repo, ctx).catch(() => null),
    performance(forge, owner, repo).catch(() => null),
    miseEntry(forge, owner, repo).catch(() => null),
    forge.contributors(owner, repo, ctx).catch(() => null),
    forge.releases(owner, repo, ctx).catch(() => null),
  ]);

  const versions =
    (mise?.name ? await miseReleases(mise.name as string).catch(() => null) : null) ??
    (forgeReleases ? { source: forge.id, releases: forgeReleases } : null);

  return json({
    forge: forge.id,
    repo: `${owner}/${repo}`,
    url: forge.webUrl(owner, repo),
    meta,
    mise: mise ?? null,
    tabs: {
      commands: spec,
      performance: perf,
      versions,
      contributors: people,
    },
  });
}

/**
 * Everything one person has contributed across indexed CLIs.
 *
 * NOT IMPLEMENTED. Fanning out over every known repo per request is not viable;
 * this needs an inverted index (contributor -> tools) built on a schedule. The
 * repo set to build it from is the union of the mise-versions seed and every
 * repo anyone has ever loaded a page for — so the index grows from use rather
 * than from registration.
 */
async function handleUser(forge: Forge, login: string): Promise<Response> {
  return json(
    {
      forge: forge.id,
      login,
      tools: [],
      note: "not implemented — needs a prebuilt contributor index",
    },
    501,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "health") return json({ status: "ok" });

    const hit = parts.length > 0 ? forgeByPath(parts[0]) : null;
    if (hit) {
      if (hit.kind === "repo" && parts.length === 3) {
        return handleRepo(hit.forge, parts[1], parts[2], env);
      }
      if (hit.kind === "user" && parts.length === 2) {
        return handleUser(hit.forge, parts[1]);
      }
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
