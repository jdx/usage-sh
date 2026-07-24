/**
 * Page data assembly.
 *
 * Kept out of the Astro components so the fetching logic stays testable in
 * plain node — which is how the git client was verified without ever running a
 * Cloudflare runtime.
 */

import { parse as parseToml } from "smol-toml";

import type { Contributor, Forge, ForgeCtx, RepoMeta, SpecFile } from "../forges";
import { takNotesSha } from "../git";

const MISE_VERSIONS = "https://mise-versions.jdx.dev";

export interface ReleaseRow {
  tag: string;
  published_at: string | null;
  url: string | null;
  prerelease: boolean;
}

export interface Versions {
  source: string;
  releases: ReleaseRow[];
}

export interface Performance {
  present: true;
  notes_sha: string;
  records: null;
}

export interface RepoData {
  forgeId: string;
  forgeName: string;
  userPath: string;
  slug: string;
  url: string;
  meta: RepoMeta;
  mise: Record<string, unknown> | null;
  commands: SpecFile | null;
  performance: Performance | null;
  versions: Versions | null;
  contributors: Contributor[] | null;
}

/**
 * Enrichment from mise's registry: backends, aqua links, aggregated releases.
 * Absence is the common case and means nothing is missing — the registry is
 * deliberately curated, so most repos are not in it.
 *
 * GitHub-only, because mise-versions keys its entries on GitHub slugs.
 */
async function miseEntry(forge: Forge, owner: string, repo: string) {
  if (forge.id !== "gh") return null;
  const res = await fetch(`${MISE_VERSIONS}/tools.json`, {
    cf: { cacheTtl: 3600, cacheEverything: true },
  } as RequestInit);
  if (!res.ok) return null;
  const { tools } = (await res.json()) as {
    tools: Array<{ name: string; github?: string; [k: string]: unknown }>;
  };
  const slug = `${owner}/${repo}`.toLowerCase();
  return tools.find((t) => t.github?.toLowerCase() === slug) ?? null;
}

/**
 * Release history for a tool mise already tracks: pre-aggregated, cached, and
 * costing nobody's API rate limit. Returns null so the caller falls back to the
 * forge, which is what happens for the great majority of repos.
 */
async function miseReleases(toolName: string): Promise<Versions | null> {
  const res = await fetch(
    `${MISE_VERSIONS}/${encodeURIComponent(toolName)}.toml`,
    { cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit,
  );
  if (!res.ok) return null;

  let parsed: unknown;
  try {
    parsed = parseToml(await res.text());
  } catch {
    // Malformed upstream is the forge fallback's problem, not a page failure.
    return null;
  }

  const versions = (parsed as { versions?: Record<string, unknown> }).versions;
  if (!versions) return null;

  const releases: ReleaseRow[] = Object.entries(versions).map(([tag, v]) => {
    const row = (v ?? {}) as { created_at?: unknown; release_url?: unknown };
    const created = row.created_at;
    return {
      tag,
      published_at:
        created instanceof Date
          ? created.toISOString()
          : typeof created === "string"
            ? created
            : null,
      url: typeof row.release_url === "string" ? row.release_url : null,
      // mise-versions does not flag pre-releases; infer nothing rather than lie.
      prerelease: false,
    };
  });

  // Newest first. Sorting on the timestamp rather than the tag deliberately
  // avoids assuming version strings are ordered — many tools' are not.
  releases.sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  return { source: "mise-versions", releases };
}

/**
 * Performance history from `refs/notes/tak`.
 *
 * Detection is cheap: git smart HTTP v2 `ls-refs` is an ordinary POST, so no git
 * binary and no origin service — 64 bytes for a repo that has the ref, 4 for one
 * that does not. Reading note *contents* needs a packfile fetch and delta
 * resolution, which is the remaining work. Until then we report presence and the
 * ref SHA, which decides whether the section has anything and doubles as its
 * cache key.
 */
async function performance(
  forge: Forge,
  owner: string,
  repo: string,
): Promise<Performance | null> {
  const sha = await takNotesSha(forge.cloneUrl(owner, repo));
  return sha ? { present: true, notes_sha: sha, records: null } : null;
}

/**
 * Assemble a repo page. Returns null when the repo does not exist or is private.
 *
 * Every source is independent and every failure degrades one section to null —
 * a rate-limited contributors call must never cost you the performance data.
 */
export async function repoData(
  forge: Forge,
  owner: string,
  repo: string,
  ctx: ForgeCtx,
): Promise<RepoData | null> {
  const meta = await forge.repoMeta(owner, repo, ctx);
  if (!meta) return null;

  const [commands, perf, mise, contributors, forgeReleases] = await Promise.all([
    forge.usageSpec(owner, repo, ctx).catch(() => null),
    performance(forge, owner, repo).catch(() => null),
    miseEntry(forge, owner, repo).catch(() => null),
    forge.contributors(owner, repo, ctx).catch(() => null),
    forge.releases(owner, repo, ctx).catch(() => null),
  ]);

  const versions =
    (mise?.name
      ? await miseReleases(mise.name as string).catch(() => null)
      : null) ??
    (forgeReleases ? { source: forge.id, releases: forgeReleases } : null);

  return {
    forgeId: forge.id,
    forgeName: forge.name,
    userPath: forge.userPath,
    slug: `${owner}/${repo}`,
    url: forge.webUrl(owner, repo),
    meta,
    mise,
    commands,
    performance: perf,
    versions,
    contributors,
  };
}
