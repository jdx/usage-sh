# usage.sh

> [!CAUTION]
> ## 🚧 GO AWAY 🚧
>
> **This is a half-baked experiment. Do not use it. Do not depend on it. Do not link to it.**
>
> It is vibe-coded slop that exists so one person can find out whether an idea is any good.
> Nothing here is stable. It may be renamed, rewritten from scratch, taken offline, or deleted
> outright without notice. There is no support and no roadmap you should trust.
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
usage.sh/gh/astral-sh/uv          a repo
  ├── Commands        ← *.usage.kdl in the repo, if present
  ├── Performance     ← refs/notes/tak, if the project uses tak
  ├── Versions        ← mise-versions, falling back to the forge
  └── Contributors    ← the forge

usage.sh/ghu/jdx                  a person, across every indexed CLI
```

`gh` is a forge prefix, not an assumption. Each forge claims two path segments —
`/gh/:owner/:repo` and `/ghu/:login` — kept separate because `/gh/user/:login` would be
indistinguishable from `/gh/:owner/:repo`, both being three segments. Adding GitLab or
Codeberg means implementing one adapter interface; **ref detection needs no work at all**,
because it is git's own protocol rather than any forge's API.

**Any public repo gets a page on first hit. There is no registration.** You visit the URL,
everything is detected live, and whatever exists is displayed. A repo with a `*.usage.kdl`
gets a command reference. A repo with `refs/notes/tak` gets performance. A repo with neither
still gets versions and contributors, because those come from public GitHub data.

**Each tab works without the others**, and no tab is a prerequisite for the page.

### `usage.sh/ghu/:login`

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

Reading note *contents* is one `fetch` command returning a packfile with every note in it —
implemented in `src/pack.ts`, including `ref_delta` resolution, which is not optional: a real
fetch of jdx/communique's notes ref returns 21 objects of which 3 are deltas. Out of band, a plain `git fetch --depth 1` of that single ref returns 100 commits
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
Cloudflare Worker  ──  server-rendered HTML, no client bundle
      │
      ├── mise-versions.jdx.dev   release history, registry enrichment
      ├── git smart HTTP v2       refs/notes/tak detection
      ├── forge REST API          repo metadata, contributors, releases
      └── *.usage.kdl             command reference
```

No static assets and no build step: pages are assembled at the edge and shipped as one
document. For a reference page people hit and leave, that is both the fastest option and the
least to maintain.

Heavily cached by design — `max-age=300, stale-while-revalidate=3600`. The hosted service is a
cache and a renderer, never the only copy of anything. Every underlying source stays readable
without it, which is what makes it safe to switch off.

**Deploys happen only from CI.** No Cloudflare credentials exist outside the `deploy` workflow's
secrets, and nobody deploys this from a laptop.

## Status

Pages render and performance history charts. The per-person view does not exist yet.

- [x] `/gh/:owner/:repo` + `/ghu/:login` routing over a forge registry
- [x] any public repo resolves on first hit, no registration
- [x] `refs/notes/tak` detection over plain HTTP (`src/git.ts`)
- [x] `*.usage.kdl` detection at repo root
- [x] release history — mise-versions with a GitHub releases fallback
- [x] contributors (naive; see the TODO about recency weighting)
- [x] server-rendered HTML pages (no client bundle)
- [x] GitHub Actions deploy workflow (deploys only from CI)
- [x] reading note contents — packfile fetch, delta resolution, SVG charts
- [ ] KDL parsing into a command tree
- [ ] `/ghu/:login` — needs a prebuilt inverted index
- [ ] `/badge/:owner/:repo/:metric`
- [ ] command palette

## Related

- [jdx/tak](https://github.com/jdx/tak) — produces the performance data. Also experimental slop.
- [jdx/usage](https://github.com/jdx/usage) — the CLI spec whose command reference this renders.
- [npmx.dev](https://github.com/npmx-dev/npmx.dev) — the bar for this kind of thing.

## License

MIT
