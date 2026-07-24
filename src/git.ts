/**
 * Just enough of git's smart HTTP protocol to detect refs from a Worker.
 *
 * A Worker cannot shell out to git, but the v2 `ls-refs` command is an ordinary
 * HTTP POST, so ref *detection* needs no git binary and no origin service.
 * Filtering with `ref-prefix` keeps the response tiny — measured against GitHub:
 *
 *   jdx/tak   (has refs/notes/tak)   64 bytes
 *   jdx/mise  (no notes ref)          4 bytes   (bare flush packet)
 *
 * versus 547KB for the v1 advertisement of jdx/mise, which dumps all 8292 refs.
 *
 * Reading note *contents* is a different matter: it means a `fetch` command, a
 * packfile response, and delta resolution. Not implemented here.
 */

/** Encode one pkt-line: 4 hex length digits (inclusive) followed by payload. */
function pkt(line: string): string {
  return (line.length + 4).toString(16).padStart(4, "0") + line;
}

const FLUSH = "0000";
const DELIM = "0001";

/**
 * Split a pkt-line stream into payloads, skipping flush and delimiter packets.
 *
 * Tolerant by design: a truncated or malformed tail yields the packets parsed so
 * far rather than throwing, because the caller's fallback for "no data" and for
 * "unparseable data" is identical.
 */
function parsePktLines(body: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i + 4 <= body.length) {
    const len = parseInt(body.slice(i, i + 4), 16);
    if (Number.isNaN(len)) break;
    if (len === 0 || len === 1) {
      i += 4;
      continue;
    }
    if (len < 4 || i + len > body.length) break;
    out.push(body.slice(i + 4, i + len));
    i += len;
  }
  return out;
}

export interface Ref {
  sha: string;
  name: string;
}

/**
 * List refs under `prefix` for a public repository.
 *
 * Takes a clone URL rather than owner/repo because this is the one part of the
 * stack that is genuinely forge-agnostic: smart HTTP v2 is git's protocol, not
 * GitHub's, so this works unchanged against GitLab, Gitea, Codeberg and
 * self-hosted remotes. Only the REST metadata calls need per-forge adapters.
 *
 * Returns `[]` for a repo that does not exist, is private, or simply has no
 * matching refs — all three are the same outcome for our purposes: no tab.
 */
export async function lsRefs(cloneUrl: string, prefix: string): Promise<Ref[]> {
  const body =
    pkt("command=ls-refs\n") +
    pkt("object-format=sha1\n") +
    DELIM +
    pkt(`ref-prefix ${prefix}\n`) +
    FLUSH;

  const res = await fetch(`${cloneUrl}/git-upload-pack`, {
    method: "POST",
    headers: {
      "git-protocol": "version=2",
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
      "user-agent": "usage.sh",
    },
    body,
    // Cheap and stable enough to cache; the SHA is the thing we key on.
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) return [];

  return parsePktLines(await res.text())
    .map((line) => {
      const [sha, name] = line.trim().split(" ");
      return sha && name ? { sha, name } : null;
    })
    .filter((r): r is Ref => r !== null);
}

/**
 * The SHA of a project's `refs/notes/tak`, or null if it has none.
 *
 * Doubles as the cache key for that project's performance data: the ref only
 * moves when a new measurement lands, so an unchanged SHA means an unchanged
 * dashboard.
 */
export async function takNotesSha(cloneUrl: string): Promise<string | null> {
  const refs = await lsRefs(cloneUrl, "refs/notes/tak");
  return refs.find((r) => r.name === "refs/notes/tak")?.sha ?? null;
}
