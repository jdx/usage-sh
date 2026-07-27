/**
 * Page data assembly.
 *
 * Kept out of the Astro components so the fetching logic stays testable in
 * plain node — which is how the git client was verified without ever running a
 * Cloudflare runtime.
 */

import type { Skill } from "../skills";
import { parse as parseToml } from "smol-toml";

import type { Contributor, Forge, ForgeCtx, RepoMeta, SpecFile } from "../forges";
import { takNotesSha } from "../git";
import { fetchNotes } from "../pack";

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

/** One measurement, as stored on a line of a git note. */
export interface TakRecord {
  v: number;
  bench: string;
  tool: string;
  version?: string;
  runner: string;
  ts: string;
  metrics: Record<string, number>;
}

/** A benchmark's history on one runner class, oldest first. */
export interface Series {
  bench: string;
  tool: string;
  runner: string;
  points: Array<{
    ts: string;
    version: string | null;
    instructions: number | null;
    wall_min_ms: number | null;
  }>;
}

export interface Performance {
  present: true;
  notes_sha: string;
  series: Series[];
  records: number;
  /** Whether the pack was fetched and parsed, whatever it turned out to hold. */
  read: boolean;
}

export interface RepoData {
  forgeId: string;
  forgeName: string;
  userPath: string;
  slug: string;
  url: string;
  meta: RepoMeta;
  /** Name in mise's registry, when it is in there at all. */
  miseToolName: string | null;
  commands: SpecFile | null;
  /** Agent Skills the repo publishes under `skills/`. */
  skills: Skill[] | null;
  performance: Performance | null;
  versions: Versions | null;
  contributors: Contributor[] | null;
}

/** One day. The registry changes slowly; a stale tool name costs nothing. */
const INDEX_TTL_SECONDS = 86_400;
const INDEX_KEY = "mise:slug-to-tool:v1";

/**
 * Reverse index of GitHub slug -> mise tool name.
 *
 * `tools.json` is 485 KB and the only way to resolve a repo to a mise tool, so
 * downloading it per render dominated cold page time. The derived map is ~1000
 * short strings, which is small enough to keep whole.
 *
 * Also memoised per isolate: within one isolate's lifetime even the KV read is
 * skipped. That alone helps under load, but it is not a substitute for KV —
 * isolates are numerous and short-lived.
 */
let indexMemo: { at: number; map: Record<string, string> } | null = null;

async function slugToTool(cache?: KVNamespace): Promise<Record<string, string>> {
  const now = Date.now();
  if (indexMemo && now - indexMemo.at < INDEX_TTL_SECONDS * 1000) {
    return indexMemo.map;
  }

  if (cache) {
    const cached = await cache.get(INDEX_KEY, "json").catch(() => null);
    if (cached) {
      indexMemo = { at: now, map: cached as Record<string, string> };
      return indexMemo.map;
    }
  }

  const res = await fetch(`${MISE_VERSIONS}/tools.json`, {
    cf: { cacheTtl: INDEX_TTL_SECONDS, cacheEverything: true },
  } as RequestInit);
  if (!res.ok) return {};

  const { tools } = (await res.json()) as {
    tools: Array<{ name: string; github?: string }>;
  };
  const map: Record<string, string> = {};
  for (const t of tools) {
    if (t.github) map[t.github.toLowerCase()] = t.name;
  }

  indexMemo = { at: now, map };
  // Fire-and-forget: a failed write just means the next cold isolate rebuilds.
  if (cache) {
    cache.put(INDEX_KEY, JSON.stringify(map), {
      expirationTtl: INDEX_TTL_SECONDS,
    }).catch(() => {});
  }
  return map;
}

/**
 * The mise tool name for a repo, if the registry knows it.
 *
 * Absence is the common case and means nothing is missing — the registry is
 * deliberately curated, so most repos are not in it. GitHub-only, because
 * mise-versions keys its entries on GitHub slugs.
 */
async function miseToolName(
  forge: Forge,
  owner: string,
  repo: string,
  cache?: KVNamespace,
): Promise<string | null> {
  if (forge.id !== "gh") return null;
  const map = await slugToTool(cache);
  return map[`${owner}/${repo}`.toLowerCase()] ?? null;
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

/** Highest schema version this reader understands. */
const MAX_RECORD_V = 1;

/**
 * Group records into per-(bench, tool, runner) series, oldest first.
 *
 * Runner is part of the key rather than a label: absolute counts shift between
 * machine classes, so charting two runners as one line would invent a step
 * change that never happened.
 */
export function toSeries(records: TakRecord[]): Series[] {
  const byKey = new Map<string, Series>();

  for (const r of records) {
    const key = `${r.bench}\u0000${r.tool}\u0000${r.runner}`;
    let s = byKey.get(key);
    if (!s) {
      s = { bench: r.bench, tool: r.tool, runner: r.runner, points: [] };
      byKey.set(key, s);
    }
    s.points.push({
      ts: r.ts,
      version: r.version ?? null,
      instructions: r.metrics.instructions ?? null,
      wall_min_ms: r.metrics.wall_min_ms ?? null,
    });
  }

  for (const s of byKey.values()) {
    // Sorted by timestamp, never by version string — tool versions are
    // frequently not orderable and must stay opaque.
    s.points.sort((a, b) => a.ts.localeCompare(b.ts));
  }
  // Longest series first: that is the one worth looking at.
  return [...byKey.values()].sort((a, b) => b.points.length - a.points.length);
}

/** Parse a note body, skipping lines this reader cannot understand. */
export function parseNote(body: string): TakRecord[] {
  const out: TakRecord[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as TakRecord;
      // A newer writer must not break an older reader.
      // `ts` is validated as a string because `toSeries` sorts on it with
      // localeCompare, which throws on anything else — and one bad line would
      // then take down every chart for the repository.
      if (
        typeof r.v === "number" &&
        r.v <= MAX_RECORD_V &&
        typeof r.ts === "string" &&
        typeof r.bench === "string" &&
        typeof r.tool === "string" &&
        typeof r.runner === "string" &&
        r.metrics !== null &&
        typeof r.metrics === "object" &&
        // Values are checked, not just the container. A non-numeric metric
        // survives every other guard and then reaches Math.min/Math.max in the
        // chart as NaN, which breaks the SVG silently — exactly the outcome the
        // rest of this parser skips lines to avoid.
        Object.values(r.metrics as Record<string, unknown>).every(
          (v) => typeof v === "number" && Number.isFinite(v),
        )
      ) {
        out.push(r);
      }
    } catch {
      // One malformed line must not discard a repository's whole history.
    }
  }
  return out;
}

/**
 * Performance history from `refs/notes/tak`.
 *
 * Detection is one cheap `ls-refs`; the contents are one `fetch` returning a
 * packfile with every note in it. If the pack read fails the section still
 * renders as "detected", because knowing data exists is better than pretending
 * it does not.
 */
async function performance(
  forge: Forge,
  owner: string,
  repo: string,
): Promise<Performance | null> {
  const cloneUrl = forge.cloneUrl(owner, repo);
  const sha = await takNotesSha(cloneUrl);
  if (!sha) return null;

  try {
    const notes = await fetchNotes(cloneUrl, sha);
    const records = [...notes.values()].flatMap(parseNote);
    return {
      present: true,
      notes_sha: sha,
      series: toSeries(records),
      records: records.length,
      read: true,
    };
  } catch {
    // Distinguished from "read fine, contained nothing we understand" so the
    // page can say which happened rather than blaming a fetch that worked.
    return { present: true, notes_sha: sha, series: [], records: 0, read: false };
  }
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
  cache?: KVNamespace,
): Promise<RepoData | null> {
  const meta = await forge.repoMeta(owner, repo, ctx);
  if (!meta) return null;

  const [commands, skills, perf, toolName, contributors, forgeReleases] =
    await Promise.all([
      forge.usageSpec(owner, repo, ctx).catch(() => null),
      forge.skills(owner, repo, ctx).catch(() => null),
      performance(forge, owner, repo).catch(() => null),
      miseToolName(forge, owner, repo, cache).catch(() => null),
      forge.contributors(owner, repo, ctx).catch(() => null),
      forge.releases(owner, repo, ctx).catch(() => null),
    ]);

  const versions =
    (toolName ? await miseReleases(toolName).catch(() => null) : null) ??
    (forgeReleases ? { source: forge.id, releases: forgeReleases } : null);

  return {
    forgeId: forge.id,
    forgeName: forge.name,
    userPath: forge.userPath,
    slug: `${owner}/${repo}`,
    url: forge.webUrl(owner, repo),
    meta,
    miseToolName: toolName,
    commands,
    skills,
    performance: perf,
    versions,
    contributors,
  };
}
