/**
 * Forge abstraction.
 *
 * The goal is not to support every git host today — it is to keep GitHub from
 * leaking into the routing and page logic, so that adding one later is an
 * adapter rather than a rewrite.
 *
 * The split that matters:
 *
 *   - **Ref detection is already portable.** `refs/notes/tak` is found with
 *     git's own smart HTTP v2 protocol (see `../git.ts`), which every git host
 *     speaks. Nothing forge-specific is involved.
 *   - **Metadata is not.** Repo description, file listings, releases and
 *     contributors all come from a REST API whose shape differs per forge.
 *     That is what this interface covers.
 *
 * URL scheme: each forge claims two path prefixes, e.g. `gh` and `ghu`. They are
 * separate rather than nested because `/gh/user/:login` would be indistinguishable
 * from `/gh/:owner/:repo` — both are three segments.
 */

export interface RepoMeta {
  full_name: string;
  description: string | null;
  stars: number | null;
  language: string | null;
  topics: string[];
  default_branch: string | null;
  pushed_at: string | null;
  archived: boolean;
}

export interface Release {
  tag: string;
  published_at: string | null;
  url: string | null;
  prerelease: boolean;
}

export interface Contributor {
  login: string;
  contributions: number;
  avatar_url: string | null;
}

export interface SpecFile {
  file: string;
  raw: string;
}

export interface ForgeCtx {
  /** Optional API token for this forge, to raise rate limits. */
  token?: string;
}

export interface Forge {
  /** Stable short id, also the repo path prefix: `/gh/:owner/:repo`. */
  id: string;
  /** Human name. */
  name: string;
  /** User path prefix: `/ghu/:login`. */
  userPath: string;

  /** Clone URL, used for forge-agnostic ref detection. */
  cloneUrl(owner: string, repo: string): string;
  /** Canonical web URL for a repo. */
  webUrl(owner: string, repo: string): string;

  /** Repo metadata, or null if it does not exist or is not public. */
  repoMeta(owner: string, repo: string, ctx: ForgeCtx): Promise<RepoMeta | null>;
  /** A `*.usage.kdl` at the repo root, if present. */
  usageSpec(owner: string, repo: string, ctx: ForgeCtx): Promise<SpecFile | null>;
  /** Release history, newest first. */
  releases(owner: string, repo: string, ctx: ForgeCtx): Promise<Release[] | null>;
  /** Contributors, ranked by the forge's own notion of contribution. */
  contributors(
    owner: string,
    repo: string,
    ctx: ForgeCtx,
  ): Promise<Contributor[] | null>;
}

import { github } from "./github";

/** Registered forges, keyed by repo path prefix. */
export const FORGES: Record<string, Forge> = {
  [github.id]: github,
  // Adding GitLab/Codeberg/Gitea means implementing the Forge interface here.
  // Ref detection needs no work — only the REST adapter does.
};

/** Resolve a forge by its repo prefix (`gh`) or user prefix (`ghu`). */
export function forgeByPath(
  segment: string,
): { forge: Forge; kind: "repo" | "user" } | null {
  const byRepo = FORGES[segment];
  if (byRepo) return { forge: byRepo, kind: "repo" };
  const byUser = Object.values(FORGES).find((f) => f.userPath === segment);
  if (byUser) return { forge: byUser, kind: "user" };
  return null;
}
