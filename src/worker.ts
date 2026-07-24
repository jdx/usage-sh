/**
 * usage.sh — a homepage for command-line tools.
 *
 * Experimental. Nothing here is deployed. See README.md.
 *
 * Central constraint: **any public GitHub repo gets a page, on first hit, with
 * no registration.** Everything is detected live. mise-versions is an enrichment
 * source, never a gate — its registry is deliberately curated, and gating pages
 * on it would turn registry submissions into a queue of people who just want a
 * usage.sh page.
 *
 * Every tab is independently optional. A repo with none of the signals still
 * gets a page built from public GitHub metadata.
 */

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

function gh(env: Env): Record<string, string> {
  const h: Record<string, string> = {
    "user-agent": "usage.sh",
    accept: "application/vnd.github+json",
  };
  if (env.GITHUB_TOKEN) h.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

/** Repo metadata. Also our existence check — null means 404 the page. */
async function repoMeta(owner: string, repo: string, env: Env) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: gh(env),
    cf: { cacheTtl: 600, cacheEverything: true },
  });
  if (!res.ok) return null;
  const r = (await res.json()) as Record<string, unknown>;
  return {
    full_name: r.full_name,
    description: r.description,
    stars: r.stargazers_count,
    language: r.language,
    topics: r.topics,
    default_branch: r.default_branch,
    pushed_at: r.pushed_at,
    archived: r.archived,
  };
}

/**
 * Detect a Usage spec: `<name>.usage.kdl` at the repo root.
 *
 * Only the root is checked. A recursive search would be a tree walk on every
 * cold hit, and the convention is a root-level file.
 */
async function usageSpec(owner: string, repo: string, env: Env) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/`,
    { headers: gh(env), cf: { cacheTtl: 600, cacheEverything: true } },
  );
  if (!res.ok) return null;
  const entries = (await res.json()) as Array<{
    name: string;
    type: string;
    download_url: string | null;
  }>;
  const spec = entries.find(
    (e) => e.type === "file" && e.name.endsWith(".usage.kdl"),
  );
  if (!spec?.download_url) return null;

  const body = await fetch(spec.download_url, {
    cf: { cacheTtl: 600, cacheEverything: true },
  });
  if (!body.ok) return null;
  // TODO: parse KDL into a command tree. Raw for now.
  return { file: spec.name, raw: await body.text() };
}

/**
 * Release history.
 *
 * Prefers mise-versions: it is pre-aggregated, already cached, and consumes
 * nobody's GitHub rate limit. Falls back to the GitHub releases API so that
 * repos outside mise's curated registry — which is most of them — still get
 * the tab.
 */
async function versions(
  owner: string,
  repo: string,
  toolName: string | null,
  env: Env,
) {
  if (toolName) {
    const res = await fetch(
      `${MISE_VERSIONS}/${encodeURIComponent(toolName)}.toml`,
      { cf: { cacheTtl: 3600, cacheEverything: true } },
    );
    if (res.ok) {
      return { source: "mise-versions", format: "toml", raw: await res.text() };
    }
  }

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`,
    { headers: gh(env), cf: { cacheTtl: 3600, cacheEverything: true } },
  );
  if (!res.ok) return null;
  const rels = (await res.json()) as Array<{
    tag_name: string;
    published_at: string;
    html_url: string;
    prerelease: boolean;
  }>;
  return {
    source: "github",
    releases: rels.map(({ tag_name, published_at, html_url, prerelease }) => ({
      tag_name,
      published_at,
      html_url,
      prerelease,
    })),
  };
}

/**
 * Optional enrichment from mise's registry: backends, aqua links, aggregated
 * version counts. Absence is the common case and means nothing is missing.
 */
async function miseEntry(owner: string, repo: string) {
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
 * Top contributors.
 *
 * TODO: GitHub ranks by all-time commit count, so someone who left three years
 * ago outranks whoever is doing the work now. Needs recency weighting before
 * this is shown as "top contributor" to anybody.
 */
async function contributors(owner: string, repo: string, env: Env) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=20`,
    { headers: gh(env), cf: { cacheTtl: 3600, cacheEverything: true } },
  );
  if (!res.ok) return null;
  const list = (await res.json()) as Array<{
    login: string;
    contributions: number;
    avatar_url: string;
  }>;
  return list.map(({ login, contributions, avatar_url }) => ({
    login,
    contributions,
    avatar_url,
  }));
}

/**
 * Performance history from `refs/notes/tak`.
 *
 * Detection is done and cheap — see ./git.ts. Reading the note *contents* needs
 * a packfile fetch and delta resolution, which is the remaining work. Until then
 * we report presence and the ref SHA, which is enough to decide whether the tab
 * exists and doubles as its cache key.
 */
async function performance(owner: string, repo: string) {
  const sha = await takNotesSha(owner, repo);
  if (!sha) return null;
  return {
    present: true,
    notes_sha: sha,
    records: null, // TODO: packfile fetch + parse
  };
}

async function handleRepo(
  owner: string,
  repo: string,
  env: Env,
): Promise<Response> {
  const meta = await repoMeta(owner, repo, env);
  if (!meta) {
    return json({ error: "repository not found or not public" }, 404);
  }

  // Independent sources, resolved concurrently. Any one failing degrades its own
  // tab to null and never takes the page down.
  const [spec, perf, mise, people] = await Promise.all([
    usageSpec(owner, repo, env).catch(() => null),
    performance(owner, repo).catch(() => null),
    miseEntry(owner, repo).catch(() => null),
    contributors(owner, repo, env).catch(() => null),
  ]);

  const vers = await versions(
    owner,
    repo,
    (mise?.name as string) ?? null,
    env,
  ).catch(() => null);

  return json({
    repo: `${owner}/${repo}`,
    meta,
    mise: mise ?? null,
    tabs: {
      commands: spec,
      performance: perf,
      versions: vers,
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
 * repo anyone has ever loaded a page for.
 */
async function handleUser(login: string): Promise<Response> {
  return json(
    {
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
    if (parts[0] === "gh" && parts.length === 3) {
      return handleRepo(parts[1], parts[2], env);
    }
    if (parts[0] === "u" && parts.length === 2) return handleUser(parts[1]);

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
