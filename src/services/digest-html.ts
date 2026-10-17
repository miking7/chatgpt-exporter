import type { Chat } from './digest-service.js';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

/** The digest's index.html: every chat's title and typed messages, searchable, in one offline file. */
export function renderHtml(chats: Chat[], root: string): string {
  // One chat per line keeps `git diff` readable; "<" is escaped so no text can close the script tag.
  const records = chats.map((c) => ({
    title: c.title, url: c.url, date: c.date, created: c.created, updated: c.updated, file: c.file,
    ...(c.project ? { project: c.project } : {}),
    ...(c.archived ? { archived: true } : {}),
    replies: c.assistantTurns,
    turns: c.turns.map((t) => [t.line, t.text]),
    ...(c.fallback ? { opener: [c.fallback.line, c.fallback.text] } : {}),
  }));
  const data = `[\n${records.map((r) => JSON.stringify(r)).join(',\n')}\n]`.replace(/</g, '\\u003c');
  return HTML.replace('__ROOT__', () => escapeHtml(root)).replace('__DATA__', () => data);
}

// Client code avoids backticks and "${" so it can live in this String.raw template.
const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChatGPT archive</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #e5e5ea; --soft: #f2f2f7; --accent: #0a63d6; --mark: #ffe58a; --markfg: #1d1d1f; }
@media (prefers-color-scheme: dark) { :root { --bg: #151517; --fg: #ececf0; --muted: #9b9ba3; --line: #2d2d33; --soft: #222227; --accent: #7fb0ff; --mark: #6b5600; --markfg: #fff6cc; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.bar { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: 1px solid var(--line); padding: 10px 16px; }
h1 { font-size: 16px; margin: 0 0 8px; }
h1 span { color: var(--muted); font-weight: 400; font-size: 14px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
#q { flex: 1 1 320px; min-width: 0; font: inherit; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); color: inherit; }
select, input[type=month] { font: inherit; font-size: 14px; padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: inherit; }
label { font-size: 14px; color: var(--muted); display: inline-flex; gap: 5px; align-items: center; }
#count { font-size: 13px; color: var(--muted); }
#chips { padding: 8px 16px 4px; font-size: 13px; }
.year { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; align-items: center; }
#chips button { font: inherit; border: 1px solid var(--line); background: var(--soft); color: inherit; border-radius: 999px; padding: 1px 8px; cursor: pointer; }
#chips button span { color: var(--muted); }
#chips .ylabel { font-weight: 600; background: none; border-color: transparent; min-width: 3.6em; text-align: left; padding-left: 0; }
#chips button.on { background: var(--accent); border-color: var(--accent); color: var(--bg); }
#chips button.on span { color: inherit; }
#chips button.zero { opacity: .4; }
main { padding: 0 16px 40px; }
details { border-bottom: 1px solid var(--line); }
summary { list-style: none; cursor: pointer; padding: 8px 0; }
summary::-webkit-details-marker { display: none; }
.head { display: block; }
.head::before { content: "▸"; display: inline-block; width: 1em; color: var(--muted); }
details[open] .head::before { content: "▾"; }
.date { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 8px; }
.title { font-weight: 600; }
.badge { font-size: 12px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; margin-left: 6px; white-space: nowrap; }
.preview { display: block; margin: 2px 0 0 1em; color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
.body { margin: 0 0 12px 1em; font-size: 14px; }
.turns { margin: 4px 0 8px; padding: 0; list-style: none; }
.turns li { margin: 0 0 8px; overflow-wrap: anywhere; }
.ln { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 6px; }
.acts { font-size: 12px; white-space: nowrap; margin-left: 4px; }
.acts button { font: inherit; border: 0; padding: 0; background: none; color: var(--accent); cursor: pointer; }
.muted { color: var(--muted); font-size: 13px; }
mark { background: var(--mark); color: var(--markfg); border-radius: 2px; }
#more { display: block; margin: 16px auto; font: inherit; padding: 6px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); color: inherit; cursor: pointer; }
.empty { color: var(--muted); padding: 24px 0; }
@media (max-width: 600px) { .bar { position: static; } #q { flex-basis: 100%; } .controls { gap: 6px 10px; } }
</style>
</head>
<body data-root="__ROOT__">
<header class="bar">
<h1>ChatGPT archive <span id="summary"></span></h1>
<div class="controls">
<input id="q" type="search" placeholder="Search titles and your questions… quotes for a phrase" autocomplete="off" spellcheck="false" autofocus>
<label><input id="titles" type="checkbox"> titles only</label>
<select id="project" aria-label="Project"><option value="">All projects</option></select>
<label>from <input id="from" type="month" placeholder="YYYY-MM"></label>
<label>to <input id="to" type="month" placeholder="YYYY-MM"></label>
<select id="sort" aria-label="Sort"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="turns">Most turns</option></select>
<span id="count"></span>
</div>
</header>
<nav id="chips" aria-label="Months"></nav>
<main><div id="list"></div><button id="more" type="button" hidden></button></main>
<noscript><p>This page needs JavaScript to list and filter the conversations.</p></noscript>
<script id="data" type="application/json">__DATA__</script>
<script>
(function () {
  'use strict';
  var chats = JSON.parse(document.getElementById('data').textContent);
  var root = document.body.getAttribute('data-root'); // absolute archive path, for vscode:// links
  function $(id) { return document.getElementById(id); }
  var q = $('q'), titlesOnly = $('titles'), project = $('project'), from = $('from'), to = $('to'), sort = $('sort');
  var list = $('list'), count = $('count'), chips = $('chips'), more = $('more');
  var LIMIT = 400, NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var terms = [], showAll = false, timer = 0, months = [], projects = [];

  function fmt(n) { return n.toLocaleString('en-AU'); }
  function plural(n, one, many) { return fmt(n) + ' ' + (n === 1 ? one : many || one + 's'); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clip(s, n) { if (s.length <= n) return s; var cut = s.slice(0, n), sp = cut.lastIndexOf(' '); return (sp > n * 0.6 ? cut.slice(0, sp) : cut) + '…'; }
  function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

  // Escape first, then wrap the matched ranges, so a term can never land inside an entity.
  function hl(s) {
    var low = s.toLowerCase(), ranges = [], out = '', pos = 0;
    if (!terms.length || low.length !== s.length) return esc(s);
    terms.forEach(function (t) { for (var i = low.indexOf(t); i >= 0; i = low.indexOf(t, i + t.length)) ranges.push([i, i + t.length]); });
    ranges.sort(function (a, b) { return a[0] - b[0]; }).forEach(function (r) {
      if (r[1] <= pos) return;
      var start = Math.max(r[0], pos);
      out += esc(s.slice(pos, start)) + '<mark>' + esc(s.slice(start, r[1])) + '</mark>';
      pos = r[1];
    });
    return out + esc(s.slice(pos));
  }

  chats.forEach(function (c, i) {
    c.i = i;
    c.month = c.date.slice(0, 7);
    c.texts = c.turns.length ? c.turns : c.opener ? [c.opener] : [];
    c.lowTitle = c.title.toLowerCase();
    c.hay = [c.title].concat(c.texts.map(function (t) { return t[1]; })).join('\n').toLowerCase();
    if (months.indexOf(c.month) < 0) months.push(c.month);
    if (c.project && projects.indexOf(c.project) < 0) projects.push(c.project);
  });
  months.sort().reverse();
  projects.sort().forEach(function (p) { var o = document.createElement('option'); o.value = o.textContent = p; project.appendChild(o); });
  if (chats.length) $('summary').textContent = '· ' + plural(chats.length, 'conversation') + ' · ' + months[months.length - 1] + ' to ' + months[0];

  // Words must all appear (any order); "quoted phrases" must appear as written.
  function parse(s) {
    var out = [], re = /"([^"]*)"|(\S+)/g, m;
    while ((m = re.exec(s))) {
      var t = (m[1] !== undefined ? m[1] : m[2].replace(/"/g, '')).trim().toLowerCase();
      if (t && out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }
  function monthOf(input) { return /^\d{4}-\d{2}$/.test(input.value) ? input.value : ''; }

  function update() {
    terms = parse(q.value);
    var lo = monthOf(from), hi = monthOf(to), key = titlesOnly.checked ? 'lowTitle' : 'hay', perMonth = {}, hits = [];
    if (lo && hi && lo > hi) { var x = lo; lo = hi; hi = x; }
    chats.forEach(function (c) {
      if (project.value && c.project !== project.value) return;
      for (var k = 0; k < terms.length; k++) if (c[key].indexOf(terms[k]) < 0) return;
      perMonth[c.month] = (perMonth[c.month] || 0) + 1; // chip counts ignore the date range
      if ((!lo || c.month >= lo) && (!hi || c.month <= hi)) hits.push(c);
    });
    if (sort.value === 'oldest') hits.reverse();
    else if (sort.value === 'turns') hits.sort(function (a, b) { return b.turns.length - a.turns.length || a.i - b.i; });
    renderChips(perMonth, lo, hi);
    var shown = showAll ? hits : hits.slice(0, LIMIT);
    list.innerHTML = shown.length ? shown.map(row).join('') : '<p class="empty">No conversations match.</p>';
    count.textContent = fmt(hits.length) + ' of ' + plural(chats.length, 'conversation');
    more.hidden = shown.length === hits.length;
    more.textContent = 'Show all ' + fmt(hits.length);
    saveHash();
  }

  function renderChips(perMonth, lo, hi) {
    var html = '<div class="year"><button type="button"' + (!lo && !hi ? ' class="on"' : '') + '>All</button></div>', year = '';
    months.forEach(function (m) {
      var y = m.slice(0, 4), n = perMonth[m] || 0;
      if (y !== year) {
        html += (year ? '</div>' : '') + '<div class="year"><button type="button" data-year="' + y + '" class="ylabel' + (lo === y + '-01' && hi === y + '-12' ? ' on' : '') + '">' + y + '</button>';
        year = y;
      }
      html += '<button type="button" data-month="' + m + '" title="' + m + '"' + (lo === m && hi === m ? ' class="on"' : n ? '' : ' class="zero"') + '>' + NAMES[+m.slice(5) - 1] + ' <span>' + fmt(n) + '</span></button>';
    });
    chips.innerHTML = html + (year ? '</div>' : '');
  }

  function row(c) {
    var badges = (c.project ? '<span class="badge">' + esc(c.project) + '</span>' : '') + (c.archived ? '<span class="badge">archived</span>' : '') +
      '<span class="badge">' + plural(c.turns.length, 'turn') + '</span>';
    return '<details data-i="' + c.i + '"><summary><span class="head"><span class="date">' + c.date + '</span><a class="title" href="' + esc(c.url) +
      '" target="_blank" rel="noopener">' + hl(c.title || 'Untitled') + '</a>' + badges + '</span><span class="preview">' + preview(c) +
      '</span></summary><div class="body"></div></details>';
  }

  // The first message, or, when a search term only matches further in, a snippet around the match.
  function preview(c) {
    if (!c.texts.length) return '(empty conversation)';
    var lead = c.turns.length ? '' : '<i>(no typed questions; assistant opened with)</i> ';
    if (terms.length && !titlesOnly.checked) {
      for (var k = 0; k < c.texts.length; k++) {
        var text = c.texts[k][1], low = text.toLowerCase(), at = -1;
        terms.forEach(function (t) { var i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; });
        if (at < 0) continue;
        if (k === 0 && at < 120) break;
        var start = 0;
        if (at > 60) { var sp = text.indexOf(' ', at - 60); start = sp >= 0 && sp < at ? sp + 1 : at - 60; }
        return lead + (k ? '<span class="ln">L' + c.texts[k][0] + '</span>' : '') + (start ? '…' : '') + hl(clip(text.slice(start), 160));
      }
    }
    return lead + hl(clip(c.texts[0][1], 160));
  }

  function expand(c) {
    var abs = root + '/' + c.file;
    var items = c.texts.map(function (t) {
      return '<li><span class="ln">L' + t[0] + '</span>' + hl(t[1]) + ' <span class="acts"><a href="' + esc('vscode://file' + encPath(abs) + ':' + t[0]) +
        '">VS Code</a> · <button type="button" data-copy="' + esc(abs + ':' + t[0]) + '">copy path:line</button></span></li>';
    }).join('');
    return (c.turns.length ? '' : '<p class="muted">No typed questions; this is how the assistant opened.</p>') + '<ol class="turns">' + items + '</ol>' +
      '<div class="muted">' + plural(c.replies, 'reply', 'replies') + ' · created ' + esc(c.created.replace('T', ' ')) + ' · updated ' + esc(c.updated.replace('T', ' ')) +
      ' · <a href="../' + esc(encPath(c.file)) + '">file</a> · <a href="' + esc(c.url) + '" target="_blank" rel="noopener">ChatGPT</a></div>';
  }

  // "toggle" doesn't bubble, so listen in the capture phase; rows fill in when first opened.
  list.addEventListener('toggle', function (e) {
    var d = e.target;
    if (d.tagName !== 'DETAILS' || !d.open) return;
    var body = d.querySelector('.body');
    if (!body.childNodes.length) body.innerHTML = expand(chats[+d.getAttribute('data-i')]);
  }, true);

  list.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-copy]');
    if (!b) return;
    var text = b.getAttribute('data-copy'), done = function () { b.textContent = 'copied'; setTimeout(function () { b.textContent = 'copy path:line'; }, 1200); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
    else { legacyCopy(text); done(); }
  });
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (err) { /* nothing more to try */ }
    ta.remove();
  }

  // A month chip selects that month, a year label the whole year; clicking the active one clears it.
  chips.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    var m = b.getAttribute('data-month'), y = b.getAttribute('data-year'), lo = m || (y ? y + '-01' : ''), hi = m || (y ? y + '-12' : '');
    if (from.value === lo && to.value === hi) lo = hi = '';
    from.value = lo; to.value = hi; showAll = false; update();
  });

  // The search lives in the URL hash, so a reload (or a bookmark) keeps it.
  var FIELDS = { q: q, project: project, from: from, to: to, sort: sort };
  function saveHash() {
    var p = new URLSearchParams();
    Object.keys(FIELDS).forEach(function (k) { var v = FIELDS[k].value; if (v && !(k === 'sort' && v === 'newest')) p.set(k, v); });
    if (titlesOnly.checked) p.set('titles', '1');
    var h = p.toString();
    if (h === location.hash.slice(1)) return;
    try { history.replaceState(null, '', h ? '#' + h : location.pathname + location.search); } catch (err) { location.replace('#' + h); }
  }
  function loadHash() {
    var p = new URLSearchParams(location.hash.slice(1));
    Object.keys(FIELDS).forEach(function (k) { FIELDS[k].value = p.get(k) || (k === 'sort' ? 'newest' : ''); });
    titlesOnly.checked = p.get('titles') === '1';
  }

  q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { showAll = false; update(); }, 120); });
  [titlesOnly, project, from, to, sort].forEach(function (el) { el.addEventListener('change', function () { showAll = false; update(); }); });
  more.addEventListener('click', function () { showAll = true; update(); });
  window.addEventListener('hashchange', function () { loadHash(); showAll = false; update(); }); // edited URL, back/forward
  document.addEventListener('keydown', function (e) {
    var a = document.activeElement, typing = a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); q.focus(); q.select(); }
    else if (e.key === 'Escape' && a === q && q.value) { q.value = ''; showAll = false; update(); }
  });
  loadHash();
  update();
})();
</script>
</body>
</html>
`;
