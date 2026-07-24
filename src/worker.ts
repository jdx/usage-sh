/**
 * usage.sh — a homepage for command-line tools.
 *
 * Experimental. Nothing here is deployed. See README.md.
 *
 * The routing shape encodes the central design constraint: every tab is assembled
 * from an independent public source, and any one of them being unavailable must
 * degrade that tab rather than fail the page.
 */

export interface Env {
  /** Response cache. Keyed by upstream ETag where one is available. */
  CACHE: KVNamespace;
  /** Static assets (the SPA). */
  ASSETS: Fetcher;
  /** Optional; raises the GitHub API rate limit for contributor lookups. */
  GITHUB_TOKEN?: string;
}

/** Upstream that already maps ~1000 CLI tools to their GitHub repos. */
const MISE_VERSIONS = "https://mise-versions.jdx.dev";

/**
 * Cache policy. Short max-age keeps a busy tool's page fresh; the long
 * stale-while-revalidate window means readers effectively never wait on an
 * upstream fetch.
 */
const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";

interface Tool {
  name: string;
  latest_version: string;
  latest_stable_version?: string;
  version_count: number;
  last_updated: string;
  description?: string;
  /** "owner/repo", when mise knows it. */
  github?: string;
  repo_url?: string;
  backends?: string[];
}

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
 * Fetch the tool index and find the entry for a GitHub repo.
 *
 * Reverse lookup rather than by tool name: the canonical identity of a CLI here
 * is its repository, because that is the one key every data source agrees on.
 */
async function toolForRepo(owner: string, repo: string): Promise<Tool | null> {
  const res = await fetch(`${MISE_VERSIONS}/tools.json`, {
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) return null;
  const { tools } = (await res.json()) as { tools: Tool[] };
  const slug = `${owner}/${repo}`.toLowerCase();
  return tools.find((t) => t.github?.toLowerCase() === slug) ?? null;
}

/**
 * Release history for a tool, straight from mise-versions.
 *
 * Deliberately not the GitHub releases API: this upstream is already aggregated,
 * already cached, and does not consume anyone's rate limit.
 *
 * TODO: parse the TOML rather than handing it back raw.
 */
async function releases(toolName: string): Promise<string | null> {
  const res = await fetch(`${MISE_VERSIONS}/${encodeURIComponent(toolName)}.toml`, {
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  return res.ok ? await res.text() : null;
}

/**
 * Top contributors for a repo.
 *
 * TODO: this is the naive call. It is paginated, rate-limited, and says nothing
 * about *recent* activity — a contributor who left three years ago still ranks
 * first. Real implementation should weight by recency.
 */
async function contributors(owner: string, repo: string, env: Env) {
  const headers: Record<string, string> = {
    "user-agent": "usage.sh",
    accept: "application/vnd.github+json",
  };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=20`,
    { headers, cf: { cacheTtl: 3600, cacheEverything: true } },
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
 * Performance history from the project's own `refs/notes/tak`.
 *
 * NOT IMPLEMENTED. A Worker cannot shell out to git, and the honest options are:
 *
 *   1. A small origin service that speaks real git, behind this cache. One
 *      `git fetch --depth 1` of the single notes ref returns everything —
 *      measured at 36ms / 124K for 100 commits, with no repo clone.
 *   2. Ingest instead: `tak` pushes results here from CI, authenticated with
 *      GitHub OIDC so there is still no account and no shared secret.
 *
 * (2) is less work given the existing infrastructure; (1) is what makes the page
 * resolve for repos that never opted in. Probably both, with (1) as the fallback.
 */
async function performance(_owner: string, _repo: string) {
  return null;
}

async function handleRepo(owner: string, repo: string, env: Env): Promise<Response> {
  // Each source is independent: one failing must not take the page with it.
  const [tool, people] = await Promise.all([
    toolForRepo(owner, repo).catch(() => null),
    contributors(owner, repo, env).catch(() => null),
  ]);

  const [versions, perf] = await Promise.all([
    tool ? releases(tool.name).catch(() => null) : Promise.resolve(null),
    performance(owner, repo).catch(() => null),
  ]);

  return json({
    repo: `${owner}/${repo}`,
    tool,
    tabs: {
      commands: null, // TODO: Usage spec
      performance: perf, // TODO: refs/notes/tak
      versions: versions ? { format: "toml", raw: versions } : null,
      contributors: people,
    },
  });
}

/**
 * Everything one person has contributed across indexed CLIs.
 *
 * NOT IMPLEMENTED. Doing this by fanning out over ~1000 repos per request is not
 * viable; it needs a periodically-built inverted index (contributor -> tools),
 * refreshed on a schedule and stored in KV.
 */
async function handleUser(login: string): Promise<Response> {
  return json(
    { login, tools: [], note: "not implemented — needs a prebuilt contributor index" },
    501,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "health") {
      return json({ status: "ok" });
    }

    // /gh/:owner/:repo
    if (parts[0] === "gh" && parts.length === 3) {
      return handleRepo(parts[1], parts[2], env);
    }

    // /u/:login
    if (parts[0] === "u" && parts.length === 2) {
      return handleUser(parts[1]);
    }

    // Everything else is the SPA.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
