// Export a list of links as JSON or as a standalone HTML page. Pure.

/** @typedef {'json' | 'html'} ExportFormat */
/** @typedef {'include' | 'exclude' | 'only'} DeadMode */

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'links';

// Only web links become clickable anchors; anything else (file:, about:,
// javascript:, …) is shown as text so an exported page can't carry a script URL.
const isLinkable = (url) => /^(https?|ftp):/i.test(url);

/**
 * @param {import('./library.js').LinkRow[]} rows
 * @param {{format: ExportFormat, dead?: DeadMode, label: string}} opts
 *   dead: include dead links, leave them out, or export only them (the report)
 * @returns {{filename: string, mime: string, body: string, count: number}}
 */
export function buildExport(rows, { format, dead = 'include', label }) {
  let list = rows;
  if (dead === 'exclude') list = rows.filter((r) => r.status !== 'dead');
  else if (dead === 'only') list = rows.filter((r) => r.status === 'dead');
  list = [...list].sort((a, b) => (a.titleLc ?? '').localeCompare(b.titleLc ?? ''));

  const base = `${dead === 'only' ? 'dead-links' : 'links'}-${slug(label)}`;
  if (format === 'json') {
    const body = JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scope: label,
        dead,
        count: list.length,
        links: list.map((r) => ({
          title: r.title || null,
          url: r.url,
          kind: r.kind,
          status: r.status,
          sessions: r.sessionCount,
        })),
      },
      null,
      2,
    );
    return { filename: `${base}.json`, mime: 'application/json', body, count: list.length };
  }
  return { filename: `${base}.html`, mime: 'text/html', body: toHtml(list, label, dead), count: list.length };
}

function toHtml(rows, label, dead) {
  const heading = dead === 'only' ? `Dead-link report — ${label}` : `Link library — ${label}`;
  const items = rows
    .map((r) => {
      const badge =
        r.status === 'dead' ? ' <span class="dead">[DEAD]</span>'
        : r.status === 'paywalled' ? ' <span class="pay">[MEMBERS]</span>'
        : '';
      const title = esc(r.title || '(no title)');
      const head = isLinkable(r.url)
        ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer noopener">${title}</a>`
        : `<span class="t">${title}</span>`;
      return `    <li class="${esc(r.status ?? 'none')}">${head}${badge}<div class="u">${esc(r.url)}</div></li>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(heading)}</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:system-ui,sans-serif;margin:0;background:#15151a;color:#e7e7ea}
  header{padding:20px 28px;border-bottom:1px solid #2a2a33;position:sticky;top:0;background:#1b1b22}
  h1{margin:0 0 4px;font-size:18px}
  .meta{color:#9a9aa6;font-size:13px}
  ul{list-style:none;margin:0;padding:8px 0}
  li{padding:8px 28px;border-bottom:1px solid #23232c}
  a,.t{color:#7fb0ff;text-decoration:none;font-size:14px}
  .t{color:#e7e7ea}
  a:hover{text-decoration:underline}
  .u{color:#6a6a76;font-size:11px;font-family:ui-monospace,monospace;margin-top:2px;word-break:break-all}
  .dead{color:#e0506a;font-weight:700;font-size:11px}
  .pay{color:#b07ad0;font-weight:700;font-size:11px}
  li.dead a{color:#caa}
  @media (prefers-color-scheme: light){
    body{background:#fafafc;color:#1c1c22}
    header{background:#fff;border-color:#e3e3ea}
    li{border-color:#ececf2}
    a{color:#2a55c8}.t{color:#1c1c22}.u{color:#7a7a88}.meta{color:#666672}
    li.dead a{color:#a66}
  }
</style></head>
<body>
<header><h1>${esc(heading)}</h1>
<div class="meta">${rows.length.toLocaleString()} link(s) · generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC</div></header>
<ul>
${items}
</ul>
</body></html>`;
}

/** Plain list of URLs, one per line. */
export function toUrlList(rows) {
  return rows.map((r) => r.url).join('\n');
}
