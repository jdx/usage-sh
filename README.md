# usage.sh

> [!CAUTION]
> ## 🚧 GO AWAY 🚧
>
> **This is a half-baked experiment. Do not use it. Do not depend on it. Do not link to it.**
>
> It is vibe-coded slop that exists so one person can find out whether an idea is any good.
> Nothing here is deployed, nothing is stable, and every URL in this README is aspirational.
> It may be renamed, rewritten from scratch, or deleted outright. There is no support and no
> roadmap you should trust.
>
> **Please do not file issues or open pull requests.** They will most likely be closed unread.

## If you want to look up a CLI tool right now

- **[npmx.dev](https://npmx.dev)** — an excellent, finished, fast browser for the npm registry.
  Most of the interaction design ideas below are stolen from it.
- **[mise-versions.jdx.dev](https://mise-versions.jdx.dev)** — version history for ~1000 CLI tools.
- Or just go to the project's GitHub page like a normal person.

---

## The idea

A homepage for command-line tools. One URL per CLI, assembled from data that already exists
in public, with no cooperation required from the project:

```
usage.sh/gh/astral-sh/uv
  ├── Commands        ← Usage spec (github.com/jdx/usage), if the project has one
  ├── Performance     ← refs/notes/tak, if the project uses tak
  ├── Versions        ← mise-versions.jdx.dev
  └── Contributors    ← GitHub
```

**Any public repo gets a page on first hit. There is no registration.** You visit the URL,
everything is detected live, and whatever exists is displayed. A repo with a `*.usage.kdl`
gets a command reference. A repo with `refs/notes/tak` gets performance. A repo with neither
still gets versions and contributors, because those come from public GitHub data.

**Each tab works without the others**, and no tab is a prerequisite for the page.

### `usage.sh/u/:login`

Everything one person has contributed across every indexed CLI. Not a vanity page for its own
sake — it is the answer to "who actually maintains the tools I depend on," and it is the only
part of this that a human has a reason to share.

## mise-versions is a seed, not a gate

`mise-versions.jdx.dev/tools.json` maps ~1000 CLI tools to their GitHub repositories, and
`mise-versions.jdx.dev/uv.toml` returns every release with a timestamp and URL, consuming
nobody's GitHub rate limit. Both are used, and both are **enrichment only**.

They cannot be the index, because mise's registry is deliberately curated and rejects most
submissions. Gating pages on registry membership would quietly turn registry PRs into a queue
of people who only want a usage.sh page — making a curation problem worse to solve a
discovery problem. So the registry supplies a nice seed list for browsing, and every other
public repo resolves on demand from GitHub directly.

## Detection is cheap

**Performance data needs no database and no origin service.** [tak](https://github.com/jdx/tak)
stores measurements in `refs/notes/tak` in the project's own repository, and git's smart HTTP
protocol v2 `ls-refs` is an ordinary HTTP POST — so a Worker can detect it with `fetch()`, no
git binary involved. Filtering on `ref-prefix` keeps it tiny. Measured against GitHub:

| repo | response |
|---|---|
| `jdx/tak` (has the ref) | **64 bytes**, 169ms — returns the SHA |
| `jdx/mise` (no ref) | **4 bytes**, 162ms — bare flush packet |
| *v1 advertisement, for contrast* | 547 KB for `jdx/mise` — all 8292 refs |

The notes ref SHA doubles as the ETag: it only moves when a new measurement lands.

Reading note *contents* is the remaining work — that needs a packfile fetch and delta
resolution. Out of band, a plain `git fetch --depth 1` of that single ref returns 100 commits
of history in 36ms / 124K, transferring zero project commit objects, because a notes tree is
keyed by commit SHA as *path names* and never references the commits it annotates.

## Interaction design, stolen wholesale from npmx

Speed is the feature. Everything else follows from that:

- **URL-driven state** — every view, filter and comparison is a shareable link.
- **Command palette** (`⌘K` / `Ctrl+K`) reaching every page and action.
- **Full keyboard navigation** — no view should require a mouse.
- **Dark mode**, and both themes designed rather than inverted.
- **Data inline where you need it**, not behind a click.

## Architecture

```
Cloudflare Worker  ──  static assets + KV cache
      │
      ├── mise-versions.jdx.dev   tool index, release history
      ├── refs/notes/tak          performance (shallow single-ref fetch)
      ├── GitHub API              contributors, repo metadata
      └── Usage spec              command reference
```

Heavily cached by design: `max-age=300, stale-while-revalidate=3600`, with upstream
revalidation gated on cheap ETags. The hosted service is a cache and a renderer — never the
only copy of anything. All the underlying data stays readable without it.

## Status

Nothing works. This is a routing skeleton and a set of opinions.

- [x] `/gh/:owner/:repo` resolves any public repo, no registration
- [x] `refs/notes/tak` detection over plain HTTP (`src/git.ts`)
- [x] `*.usage.kdl` detection at repo root
- [x] release history — mise-versions with a GitHub releases fallback
- [x] contributors (naive; see the TODO about recency weighting)
- [ ] any frontend whatsoever — this is JSON only
- [ ] reading note contents (packfile fetch + delta resolution)
- [ ] KDL parsing into a command tree
- [ ] `/u/:login` — needs a prebuilt inverted index
- [ ] `/badge/:owner/:repo/:metric`
- [ ] command palette

## Related

- [jdx/tak](https://github.com/jdx/tak) — produces the performance data. Also experimental slop.
- [jdx/usage](https://github.com/jdx/usage) — the CLI spec whose command reference this renders.
- [npmx.dev](https://github.com/npmx-dev/npmx.dev) — the bar for this kind of thing.

## License

MIT
