-- Repositories someone has loaded a page for.
--
-- Nothing registers here; the index grows from use. That matters because the
-- per-person view (`/ghu/:login`) needs a set of repos to invert, and fanning
-- out over every repo on GitHub per request is not viable. The mise-versions
-- tool list seeds it; everything else arrives because a human asked for it.
--
-- Keyed on (forge, owner, name) rather than a surrogate id: a repo's identity
-- here *is* its address, and there is nothing to join against yet.
CREATE TABLE IF NOT EXISTS repos (
  forge      TEXT    NOT NULL,
  owner      TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  first_seen TEXT    NOT NULL,
  last_seen  TEXT    NOT NULL,
  stars      INTEGER,
  -- Cheap denormalised flags so "which indexed CLIs publish performance data"
  -- is one query rather than a fan-out of ls-refs probes.
  has_tak    INTEGER NOT NULL DEFAULT 0,
  has_spec   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (forge, owner, name)
);

-- Drives a "recently looked at" listing.
CREATE INDEX IF NOT EXISTS repos_last_seen ON repos (last_seen DESC);

-- Partial index: the interesting query is almost always "repos with tak data",
-- and the overwhelming majority of rows will not have any.
CREATE INDEX IF NOT EXISTS repos_has_tak ON repos (has_tak) WHERE has_tak = 1;
