/**
 * GitHub adapter.
 *
 * Everything GitHub-specific lives here. Ref detection deliberately does not —
 * that is plain git protocol and works against any host (see `../git.ts`).
 */

import { parseSkill, type Skill } from "../skills";
import { parseSpec } from "../spec";
import type {
  Contributor,
  Forge,
  ForgeCtx,
  Release,
  RepoMeta,
  SpecFile,
} from "./index";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/**
 * Cap on skills read per repo. The cost is one fetch each, paid on a cold hit
 * for any repo anyone visits, and nothing stops a repo having a hundred
 * directories under `skills/`.
 */
const MAX_SKILLS = 25;

function headers(ctx: ForgeCtx): Record<string, string> {
  const h: Record<string, string> = {
    "user-agent": "usage.sh",
    accept: "application/vnd.github+json",
  };
  if (ctx.token) h.authorization = `Bearer ${ctx.token}`;
  return h;
}

export const github: Forge = {
  id: "gh",
  name: "GitHub",
  userPath: "ghu",

  cloneUrl: (owner, repo) => `https://github.com/${owner}/${repo}.git`,
  webUrl: (owner, repo) => `https://github.com/${owner}/${repo}`,

  async repoMeta(owner, repo, ctx): Promise<RepoMeta | null> {
    const res = await fetch(`${API}/repos/${owner}/${repo}`, {
      headers: headers(ctx),
      cf: { cacheTtl: 600, cacheEverything: true },
    });
    if (!res.ok) return null;
    const r = (await res.json()) as Record<string, any>;
    return {
      full_name: r.full_name,
      description: r.description ?? null,
      stars: r.stargazers_count ?? null,
      language: r.language ?? null,
      topics: r.topics ?? [],
      default_branch: r.default_branch ?? null,
      pushed_at: r.pushed_at ?? null,
      archived: Boolean(r.archived),
    };
  },

  /**
   * Only the repo root is checked. A recursive search would be a tree walk on
   * every cold hit, and `<name>.usage.kdl` is a root-level convention.
   */
  async usageSpec(owner, repo, ctx): Promise<SpecFile | null> {
    const res = await fetch(`${API}/repos/${owner}/${repo}/contents/`, {
      headers: headers(ctx),
      cf: { cacheTtl: 600, cacheEverything: true },
    });
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
    const raw = await body.text();
    // A spec that will not parse still shows its source, so a syntax error
    // upstream degrades the Commands tab rather than emptying the page.
    return { file: spec.name, raw, spec: parseSpec(raw) };
  },

  /**
   * `skills/<name>/SKILL.md`, per https://agentskills.io/specification.
   *
   * One listing plus one fetch per skill. Capped, because the cost is paid on
   * a cold hit for any repo anyone visits and a repo can have any number of
   * directories under `skills/`.
   *
   * `null` means there is no `skills/` directory; an empty array means there
   * is one but nothing in it could be read. The page says different things
   * for the two, because "no skills here" is wrong when the directory exists
   * and the frontmatter is simply broken.
   */
  async skills(owner, repo, ctx): Promise<Skill[] | null> {
    const res = await fetch(`${API}/repos/${owner}/${repo}/contents/skills`, {
      headers: headers(ctx),
      cf: { cacheTtl: 600, cacheEverything: true },
    });
    // 404 is the normal case: most repos ship no skills.
    if (!res.ok) return null;

    const entries = (await res.json()) as Array<{ name: string; type: string }>;
    if (!Array.isArray(entries)) return null;

    const dirs = entries
      .filter((e) => e.type === "dir")
      .map((e) => e.name)
      .sort()
      .slice(0, MAX_SKILLS);

    const loaded = await Promise.all(
      dirs.map(async (dir) => {
        const body = await fetch(
          `${RAW}/${owner}/${repo}/HEAD/skills/${encodeURIComponent(dir)}/SKILL.md`,
          { cf: { cacheTtl: 600, cacheEverything: true } },
        ).catch(() => null);
        if (!body?.ok) return null;
        // A skill whose frontmatter cannot be read is skipped rather than
        // shown half-parsed; it is someone else's file, not ours to guess at.
        return parseSkill(dir, await body.text());
      }),
    );

    return loaded.filter((s): s is Skill => s !== null);
  },

  async releases(owner, repo, ctx): Promise<Release[] | null> {
    const res = await fetch(
      `${API}/repos/${owner}/${repo}/releases?per_page=100`,
      { headers: headers(ctx), cf: { cacheTtl: 3600, cacheEverything: true } },
    );
    if (!res.ok) return null;
    const rels = (await res.json()) as Array<Record<string, any>>;
    return rels.map((r) => ({
      tag: r.tag_name,
      published_at: r.published_at ?? null,
      url: r.html_url ?? null,
      prerelease: Boolean(r.prerelease),
    }));
  },

  /**
   * TODO: GitHub ranks by all-time commit count, so a contributor who left three
   * years ago outranks whoever maintains the project now. Needs recency
   * weighting before this is labelled "top contributor" anywhere a human sees it.
   */
  async contributors(owner, repo, ctx): Promise<Contributor[] | null> {
    const res = await fetch(
      `${API}/repos/${owner}/${repo}/contributors?per_page=20`,
      { headers: headers(ctx), cf: { cacheTtl: 3600, cacheEverything: true } },
    );
    if (!res.ok) return null;
    const list = (await res.json()) as Array<Record<string, any>>;
    return list.map((c) => ({
      login: c.login,
      contributions: c.contributions ?? 0,
      avatar_url: c.avatar_url ?? null,
    }));
  },
};
