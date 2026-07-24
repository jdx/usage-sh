/**
 * Server-rendered HTML.
 *
 * No client bundle, no hydration, no framework. The page is assembled at the
 * edge and shipped as one document — which for a reference page people hit and
 * leave is both the fastest option and the least to maintain. npmx's lesson is
 * that speed *is* the feature; the cheapest way to be fast is to not ship a SPA.
 *
 * Progressive enhancement can come later. Nothing here needs JavaScript.
 */

const esc = (s: unknown): string =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Everything on the page is derived from untrusted upstream data — repo
 * descriptions, benchmark names, file contents. It all goes through `esc`.
 */
const CSS = `
:root{
  --bg:#f6f7f9; --panel:#fff; --sunk:#eceff4; --rule:#dbe0e8;
  --ink:#12161d; --mid:#4d5766; --faint:#7d8797;
  --accent:#9a6b00; --good:#1c7a68; --bad:#b0472f;
  --mono:ui-monospace,"SF Mono","Cascadia Mono","JetBrains Mono",Menlo,Consolas,monospace;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
@media(prefers-color-scheme:dark){:root{
  --bg:#0c0f14; --panel:#131820; --sunk:#0a0d12; --rule:#242c38;
  --ink:#e3e8ef; --mid:#a0abbb; --faint:#69748550;
  --accent:#d9a21b; --good:#3fb39f; --bad:#db7256;
  --faint:#697485;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 var(--sans);
  -webkit-font-smoothing:antialiased}
.wrap{max-width:60rem;margin:0 auto;padding:2rem 1.25rem 5rem}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
header{border-bottom:2px solid var(--ink);padding-bottom:1.25rem;margin-bottom:1.75rem}
.brand{font-family:var(--mono);font-size:.72rem;letter-spacing:.18em;text-transform:uppercase;
  color:var(--faint);margin-bottom:.6rem}
h1{font-family:var(--mono);font-size:clamp(1.4rem,4vw,2rem);margin:0 0 .4rem;
  letter-spacing:-.03em;word-break:break-word}
.desc{color:var(--mid);margin:0;max-width:60ch}
.facts{display:flex;flex-wrap:wrap;gap:.4rem .9rem;margin-top:.9rem;
  font-family:var(--mono);font-size:.75rem;color:var(--faint)}
.facts b{color:var(--mid);font-weight:500}
section{margin-top:2.25rem}
h2{font-family:var(--mono);font-size:.75rem;text-transform:uppercase;letter-spacing:.14em;
  color:var(--accent);margin:0 0 .75rem;display:flex;align-items:center;gap:.75rem}
h2::after{content:"";flex:1;height:1px;background:var(--rule)}
.card{border:1px solid var(--rule);border-radius:6px;background:var(--panel);padding:1rem 1.1rem}
.empty{color:var(--faint);font-size:.85rem;border:1px dashed var(--rule);border-radius:6px;
  padding:.9rem 1.1rem;background:transparent}
.empty code{font-family:var(--mono);color:var(--mid)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.82rem}
th,td{text-align:left;padding:.4rem .65rem;border-bottom:1px solid var(--rule)}
th{font-family:var(--mono);font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;
  color:var(--faint);font-weight:600}
td.num{font-family:var(--mono);text-align:right;font-variant-numeric:tabular-nums}
td.m{font-family:var(--mono)}
tr:last-child td{border-bottom:0}
.people{display:flex;flex-wrap:wrap;gap:.5rem}
.person{display:flex;align-items:center;gap:.45rem;border:1px solid var(--rule);
  border-radius:999px;padding:.2rem .65rem .2rem .2rem;font-size:.8rem;background:var(--panel)}
.person img{width:20px;height:20px;border-radius:50%;display:block}
.person b{font-weight:600}
.person span{color:var(--faint);font-family:var(--mono);font-size:.7rem}
pre{margin:0;font-family:var(--mono);font-size:.78rem;line-height:1.6;overflow-x:auto;
  color:var(--mid);max-height:26rem}
footer{margin-top:3.5rem;padding-top:1rem;border-top:1px solid var(--rule);
  font-family:var(--mono);font-size:.72rem;color:var(--faint)}
.warn{border:1px solid var(--bad);border-radius:6px;padding:.6rem .9rem;margin-bottom:1.5rem;
  font-size:.8rem;color:var(--bad);background:transparent}
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

function empty(msg: string): string {
  return `<div class="empty">${msg}</div>`;
}

function commandsTab(spec: { file: string; raw: string } | null): string {
  if (!spec) {
    return empty(
      `No <code>*.usage.kdl</code> in this repository. ` +
        `<a href="https://usage.jdx.dev">Usage</a> specs render here automatically.`,
    );
  }
  // TODO: parse KDL into a command tree instead of dumping the source.
  return `<div class="card"><pre>${esc(spec.raw.slice(0, 8000))}</pre></div>
    <div class="facts"><span>from <b>${esc(spec.file)}</b></span></div>`;
}

function performanceTab(
  perf: { present: boolean; notes_sha: string; records: unknown } | null,
): string {
  if (!perf) {
    return empty(
      `No <code>refs/notes/tak</code> in this repository. ` +
        `Projects using <a href="https://github.com/jdx/tak">tak</a> show performance history here.`,
    );
  }
  if (!perf.records) {
    return `<div class="card">
      <p style="margin:0 0 .5rem">Performance data detected.</p>
      <div class="facts"><span>notes ref <b>${esc(perf.notes_sha.slice(0, 12))}</b></span></div>
      <p style="margin:.75rem 0 0;color:var(--faint);font-size:.8rem">
        Reading the measurements needs a packfile fetch and delta resolution — not built yet.</p>
    </div>`;
  }
  return `<div class="card"><pre>${esc(JSON.stringify(perf.records, null, 2))}</pre></div>`;
}

interface Release {
  tag: string;
  published_at: string | null;
  url: string | null;
  prerelease: boolean;
}

function versionsTab(v: any): string {
  if (!v) return empty("No releases found.");
  if (v.format === "toml") {
    return `<div class="card"><pre>${esc(String(v.raw).slice(0, 8000))}</pre></div>
      <div class="facts"><span>source <b>${esc(v.source)}</b></span></div>`;
  }
  const rows = (v.releases as Release[])
    .slice(0, 25)
    .map(
      (r) => `<tr>
        <td class="m">${r.url ? `<a href="${esc(r.url)}">${esc(r.tag)}</a>` : esc(r.tag)}</td>
        <td class="num">${esc(r.published_at?.slice(0, 10) ?? "")}</td>
        <td>${r.prerelease ? "pre-release" : ""}</td></tr>`,
    )
    .join("");
  return `<div class="card scroll"><table>
    <thead><tr><th>tag</th><th style="text-align:right">published</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div class="facts"><span>source <b>${esc(v.source)}</b></span>
      <span><b>${(v.releases as Release[]).length}</b> releases</span></div>`;
}

interface Person {
  login: string;
  contributions: number;
  avatar_url: string | null;
}

function contributorsTab(people: Person[] | null, userPath: string): string {
  if (!people?.length) return empty("No contributor data available.");
  const chips = people
    .map(
      (p) => `<a class="person" href="/${esc(userPath)}/${esc(p.login)}">
        ${p.avatar_url ? `<img src="${esc(p.avatar_url)}&s=40" alt="" loading="lazy">` : ""}
        <b>${esc(p.login)}</b><span>${p.contributions}</span></a>`,
    )
    .join("");
  return `<div class="people">${chips}</div>
    <div class="facts"><span>ranked by all-time commits — <b>not</b> weighted for recency</span></div>`;
}

export function repoPage(data: {
  forgeName: string;
  userPath: string;
  repo: string;
  url: string;
  meta: any;
  tabs: any;
}): string {
  const m = data.meta;
  const facts = [
    m.language ? `<span><b>${esc(m.language)}</b></span>` : "",
    m.stars != null ? `<span><b>${esc(m.stars)}</b> stars</span>` : "",
    m.pushed_at
      ? `<span>pushed <b>${esc(m.pushed_at.slice(0, 10))}</b></span>`
      : "",
    m.archived ? `<span style="color:var(--bad)"><b>archived</b></span>` : "",
    `<span><a href="${esc(data.url)}">${esc(data.forgeName)} ↗</a></span>`,
  ].join("");

  const body = `
<header>
  <div class="brand">usage.sh</div>
  <h1>${esc(data.repo)}</h1>
  <p class="desc">${esc(m.description ?? "")}</p>
  <div class="facts">${facts}</div>
</header>

<div class="warn"><b>Experimental.</b> This is an unfinished side project and the data may be
wrong, stale, or absent. Don't rely on it.</div>

<section><h2>Commands</h2>${commandsTab(data.tabs.commands)}</section>
<section><h2>Performance</h2>${performanceTab(data.tabs.performance)}</section>
<section><h2>Versions</h2>${versionsTab(data.tabs.versions)}</section>
<section><h2>Contributors</h2>${contributorsTab(data.tabs.contributors, data.userPath)}</section>

<footer>Assembled live from public sources. Nothing is registered or stored.
&middot; <a href="?format=json">JSON</a>
&middot; <a href="https://github.com/jdx/usage-sh">source</a></footer>`;

  return page(`${data.repo} — usage.sh`, body);
}

export function errorPage(status: number, message: string): string {
  return page(`${status} — usage.sh`, `
<header><div class="brand">usage.sh</div><h1>${status}</h1>
<p class="desc">${esc(message)}</p></header>
<footer><a href="/">home</a></footer>`);
}

export function homePage(): string {
  return page("usage.sh", `
<header>
  <div class="brand">usage.sh</div>
  <h1>a homepage for command-line tools</h1>
  <p class="desc">Commands, performance, versions and contributors for any public repository —
  assembled live, with no registration.</p>
</header>

<div class="warn"><b>Experimental.</b> Unfinished side project. Don't rely on it, don't link to it.</div>

<section><h2>Try it</h2>
<div class="card"><pre>usage.sh/gh/jdx/tak
usage.sh/gh/astral-sh/uv
usage.sh/gh/sharkdp/hyperfine

usage.sh/ghu/jdx          <span style="color:var(--faint)">(not built yet)</span></pre></div>
</section>

<section><h2>How it works</h2>
<div class="card"><p style="margin:0">Every tab is detected live from public data.
A <code>*.usage.kdl</code> in the repo becomes a command reference.
A <code>refs/notes/tak</code> ref becomes performance history.
Neither is required — versions and contributors work for any repo.</p></div>
</section>

<footer><a href="https://github.com/jdx/usage-sh">source</a>
&middot; <a href="https://github.com/jdx/tak">tak</a></footer>`);
}
