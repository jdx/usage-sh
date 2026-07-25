/**
 * D1 access.
 *
 * Migrations are wrangler's own (`wrangler d1 migrations apply`), applied from
 * CI after deploy — there is no hand-rolled framework here, because the
 * platform already ships one that tracks applied migrations in a
 * `d1_migrations` table.
 *
 * Every function is a no-op when the binding is absent, so local development
 * and a misconfigured deploy degrade to "no index" rather than a broken page.
 */

export interface SeenRepo {
  forge: string;
  owner: string;
  name: string;
  stars: number | null;
  hasTak: boolean;
  hasSpec: boolean;
}

/**
 * Record that a repo was resolved.
 *
 * Deliberately fire-and-forget: this is bookkeeping for a feature that does not
 * exist yet, and it must never delay or fail a page render. Callers should pass
 * it to `waitUntil` rather than awaiting it.
 */
export async function recordRepo(db: D1Database | undefined, r: SeenRepo): Promise<void> {
  if (!db) return;
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO repos (forge, owner, name, first_seen, last_seen, stars, has_tak, has_spec)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (forge, owner, name) DO UPDATE SET
           last_seen = excluded.last_seen,
           stars     = excluded.stars,
           -- Monotonic on purpose. A page render cannot tell "this repo has no
           -- tak data" from "that probe just failed", because both arrive as
           -- null, so writing 0 here would clear a flag on any transient error
           -- and quietly corrupt the partial index. Erring toward stale-true is
           -- the right failure for a discovery index; a reconciliation job can
           -- clear flags deliberately, with evidence.
           has_tak   = MAX(repos.has_tak, excluded.has_tak),
           has_spec  = MAX(repos.has_spec, excluded.has_spec)`,
      )
      .bind(
        r.forge,
        r.owner,
        r.name,
        now,
        now,
        r.stars,
        r.hasTak ? 1 : 0,
        r.hasSpec ? 1 : 0,
      )
      .run();
  } catch {
    // An unmigrated or unavailable database must not surface to the reader.
  }
}
