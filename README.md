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

**Each tab must work without the others.** A project with a Usage spec and no perf data gets
a command reference. A project with neither still gets versions and contributors, because
those come from public sources. Nothing about this should require a project to opt in, sign
up, or add a config file.

### `usage.sh/u/:login`

Everything one person has contributed across every indexed CLI. Not a vanity page for its own
sake — it is the answer to "who actually maintains the tools I depend on," and it is the only
part of this that a human has a reason to share.

## Why this is cheap to build

**The index already exists.** `mise-versions.jdx.dev/tools.json` maps ~1000 CLI tools to their
GitHub repositories, with descriptions, backends and release counts. There is no registry to
build.

**Release history already exists.** `mise-versions.jdx.dev/uv.toml` returns every version with
a timestamp and release URL — no GitHub API rate limits involved.

**Performance data needs no database.** [tak](https://github.com/jdx/tak) stores measurements
in `refs/notes/tak` in the project's own repository. Because a notes tree is keyed by commit
SHA as *path names* and never references the annotated commits, one shallow fetch of that
single ref returns the entire history without cloning anything:

```console
$ git fetch --depth 1 origin '+refs/notes/tak:refs/notes/tak'
36ms · 124K · 100 commits of history · 0 project commit objects transferred
```

And `git ls-remote origin refs/notes/tak` is a **4ms** round trip returning just a SHA, which
makes an almost-free cache validator. The notes ref SHA is the ETag.

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

- [ ] `/gh/:owner/:repo` shell
- [ ] tool index from mise-versions
- [ ] release history tab
- [ ] contributors tab
- [ ] performance tab reading `refs/notes/tak`
- [ ] `/u/:login`
- [ ] `/badge/:owner/:repo/:metric`
- [ ] command palette
- [ ] Usage spec rendering

## Related

- [jdx/tak](https://github.com/jdx/tak) — produces the performance data. Also experimental slop.
- [jdx/usage](https://github.com/jdx/usage) — the CLI spec whose command reference this renders.
- [npmx.dev](https://github.com/npmx-dev/npmx.dev) — the bar for this kind of thing.

## License

MIT
