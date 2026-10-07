/**
 * MCP Apps view for show_site_fci_trend: one self-contained HTML document.
 *
 * It runs in the host's sandboxed iframe with an empty CSP, so everything is
 * inline and nothing is fetched. Data arrives only through the
 * ui/notifications/tool-result message. Tenant text is written with
 * textContent, never innerHTML.
 */

// Mirrors FCI_BOUNDS and FCI_BAND_COLORS in src/lib/fci-bands.ts; apps.test.ts fails if they drift.
export const FCI_GOOD_BOUND = 0.05
export const FCI_FAIR_BOUND = 0.1
export const FCI_COLORS = {
  good: '#22c55e',
  fair: '#eab308',
  poor: '#ef4444',
  unknown: '#64748b',
} as const

export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26'

export const SITE_FCI_TREND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site FCI trend</title>
<style>
:root {
  color-scheme: light dark;
  --color-background-primary: #ffffff;
  --color-background-secondary: #f4f4f5;
  --color-text-primary: #18181b;
  --color-text-secondary: #52525b;
  --color-border-primary: #e4e4e7;
  --font-sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --band-alpha: 0.10;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-background-primary: #1f1f1e;
    --color-background-secondary: #2a2a28;
    --color-text-primary: #f4f4f5;
    --color-text-secondary: #a1a1aa;
    --color-border-primary: #3f3f46;
    --band-alpha: 0.16;
  }
}
:root[data-theme="dark"] {
  --color-background-primary: #1f1f1e;
  --color-background-secondary: #2a2a28;
  --color-text-primary: #f4f4f5;
  --color-text-secondary: #a1a1aa;
  --color-border-primary: #3f3f46;
  --band-alpha: 0.16;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--color-background-primary);
  color: var(--color-text-primary);
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.4;
  padding: 14px 16px 12px;
}
.head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.title { font-weight: 600; font-size: 14px; }
.sub { color: var(--color-text-secondary); font-size: 12px; }
.latest { display: flex; align-items: baseline; gap: 8px; }
.value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; color: #fff; }
.chart { position: relative; margin-top: 10px; }
svg { display: block; width: 100%; height: 220px; overflow: visible; }
.axis text { fill: var(--color-text-secondary); font-size: 10px; }
.grid { stroke: var(--color-border-primary); stroke-width: 1; }
.line { fill: none; stroke: var(--color-text-primary); stroke-width: 1.75; }
.tip {
  position: absolute; pointer-events: none; display: none; white-space: nowrap;
  background: var(--color-background-secondary); color: var(--color-text-primary);
  border: 1px solid var(--color-border-primary); border-radius: 6px;
  padding: 4px 8px; font-size: 11px; transform: translate(-50%, -120%);
}
.legend { display: flex; gap: 14px; margin-top: 6px; color: var(--color-text-secondary); font-size: 11px; flex-wrap: wrap; }
.sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.empty { color: var(--color-text-secondary); padding: 24px 0; }
</style>
</head>
<body>
<div class="head">
  <div>
    <div class="title" id="site">Site FCI trend</div>
    <div class="sub" id="range">Waiting for data</div>
  </div>
  <div class="latest" id="latest"></div>
</div>
<div class="chart" id="chart"></div>
<div class="legend">
  <span><span class="sw" style="background:${FCI_COLORS.good}"></span>Good &lt; ${FCI_GOOD_BOUND * 100}%</span>
  <span><span class="sw" style="background:${FCI_COLORS.fair}"></span>Fair ${FCI_GOOD_BOUND * 100}-${FCI_FAIR_BOUND * 100}%</span>
  <span><span class="sw" style="background:${FCI_COLORS.poor}"></span>Poor &ge; ${FCI_FAIR_BOUND * 100}%</span>
  <span>Lower is healthier</span>
</div>
<script>
(function () {
  var GOOD = ${FCI_GOOD_BOUND};
  var FAIR = ${FCI_FAIR_BOUND};
  var COLORS = ${JSON.stringify(FCI_COLORS)};
  var LABELS = { good: 'Good', fair: 'Fair', poor: 'Poor', unknown: 'No data' };
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var locale;

  var nextId = 1;
  var pending = {};
  function post(msg) { window.parent.postMessage(msg, '*'); }
  function request(method, params) {
    var id = nextId++;
    post({ jsonrpc: '2.0', id: id, method: method, params: params });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }

  function band(v) {
    if (v == null || isNaN(v)) return 'unknown';
    if (v < GOOD) return 'good';
    if (v < FAIR) return 'fair';
    return 'poor';
  }
  function pct(v) {
    return new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v);
  }
  function day(iso, withYear) {
    var opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
    if (withYear) opts.year = 'numeric';
    return new Intl.DateTimeFormat(locale, opts).format(new Date(iso + 'T00:00:00Z'));
  }
  function el(tag, attrs, parent) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.locale) locale = ctx.locale;
    if (ctx.theme === 'light' || ctx.theme === 'dark') document.documentElement.setAttribute('data-theme', ctx.theme);
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) {
      for (var key in vars) {
        if (key.indexOf('--') === 0 && typeof vars[key] === 'string') document.documentElement.style.setProperty(key, vars[key]);
      }
    }
  }

  function reportSize() {
    // documentElement.scrollHeight never drops below the iframe's current height, so measure the body.
    notify('ui/notifications/size-changed', { height: Math.ceil(document.body.getBoundingClientRect().height) });
  }

  function renderMessage(text) {
    var chart = document.getElementById('chart');
    clear(chart);
    var p = document.createElement('div');
    p.className = 'empty';
    p.textContent = text;
    chart.appendChild(p);
    reportSize();
  }

  function render(result) {
    if (!result) return;
    if (result.isError) {
      var msg = result.content && result.content[0] && result.content[0].text;
      document.getElementById('range').textContent = 'Could not load';
      renderMessage(msg || 'The tool returned an error.');
      return;
    }
    var data = result.structuredContent;
    if (!data || !data.site) return;
    document.getElementById('site').textContent = data.site.name || 'Site';
    var points = (data.points || []).filter(function (p) { return typeof p.fci === 'number' && p.date; });
    var latest = document.getElementById('latest');
    clear(latest);
    if (!points.length) {
      document.getElementById('range').textContent = 'Last ' + data.days + ' days';
      renderMessage('No FCI readings in this window. A site gets a reading only when at least half of its priced replacement value has a known remaining life.');
      return;
    }
    var first = points[0], last = points[points.length - 1];
    document.getElementById('range').textContent =
      'FCI, ' + day(first.date, true) + ' to ' + day(last.date, true) + ' (' + points.length + ' readings)';
    var value = document.createElement('span');
    value.className = 'value';
    value.textContent = pct(last.fci);
    var b = band(last.fci);
    var badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.background = COLORS[b];
    badge.textContent = LABELS[b];
    latest.appendChild(value);
    latest.appendChild(badge);
    drawChart(points);
  }

  function drawChart(points) {
    var chart = document.getElementById('chart');
    clear(chart);
    drawnWidth = chart.clientWidth;
    var W = Math.max(drawnWidth, 280), H = 220;
    var m = { l: 40, r: 10, t: 8, b: 22 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var maxV = 0;
    points.forEach(function (p) { if (p.fci > maxV) maxV = p.fci; });
    var yMax = Math.max(FAIR * 1.5, Math.ceil(maxV * 1.15 * 50) / 50);
    var t0 = Date.parse(points[0].date), t1 = Date.parse(points[points.length - 1].date);
    var span = Math.max(t1 - t0, 1);
    function x(p) { return m.l + (points.length === 1 ? iw / 2 : ((Date.parse(p.date) - t0) / span) * iw); }
    function y(v) { return m.t + ih - (Math.min(v, yMax) / yMax) * ih; }

    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'FCI over time' }, chart);
    [[0, GOOD, 'good'], [GOOD, FAIR, 'fair'], [FAIR, yMax, 'poor']].forEach(function (r) {
      el('rect', { x: m.l, y: y(r[1]), width: iw, height: y(r[0]) - y(r[1]), fill: COLORS[r[2]], style:'fill-opacity: var(--band-alpha)' }, svg);
    });
    var axis = el('g', { class: 'axis' }, svg);
    var step = yMax <= 0.2 ? 0.05 : yMax <= 0.5 ? 0.1 : 0.25;
    for (var v = 0; v <= yMax + 1e-9; v += step) {
      el('line', { class: 'grid', x1: m.l, x2: m.l + iw, y1: y(v), y2: y(v), 'stroke-opacity': 0.6 }, axis);
      var label = el('text', { x: m.l - 6, y: y(v) + 3, 'text-anchor': 'end' }, axis);
      label.textContent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(v);
    }
    var ticks = Math.min(5, points.length);
    for (var i = 0; i < ticks; i++) {
      var p = points[Math.round((i * (points.length - 1)) / Math.max(ticks - 1, 1))];
      var tx = el('text', { x: x(p), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle' }, axis);
      tx.textContent = day(p.date, false);
    }
    var d = points.map(function (p, i2) { return (i2 ? 'L' : 'M') + x(p).toFixed(1) + ' ' + y(p.fci).toFixed(1); }).join(' ');
    el('path', { class: 'line', d: d }, svg);
    var lastP = points[points.length - 1];
    el('circle', { cx: x(lastP), cy: y(lastP.fci), r: 3.5, fill: COLORS[band(lastP.fci)] }, svg);

    var focus = el('circle', { r: 4, fill: 'none', 'stroke-width': 2, visibility: 'hidden' }, svg);
    var tip = document.createElement('div');
    tip.className = 'tip';
    chart.appendChild(tip);
    svg.addEventListener('pointermove', function (ev) {
      var rect = svg.getBoundingClientRect();
      var px = ((ev.clientX - rect.left) / rect.width) * W;
      var best = points[0], bestD = Infinity;
      points.forEach(function (q) { var dd = Math.abs(x(q) - px); if (dd < bestD) { bestD = dd; best = q; } });
      focus.setAttribute('cx', x(best));
      focus.setAttribute('cy', y(best.fci));
      focus.setAttribute('stroke', COLORS[band(best.fci)]);
      focus.setAttribute('visibility', 'visible');
      tip.textContent = day(best.date, true) + '  ' + pct(best.fci) + '  ' + LABELS[band(best.fci)];
      tip.style.left = (x(best) / W) * rect.width + 'px';
      tip.style.top = (y(best.fci) / H) * rect.height + 'px';
      tip.style.display = 'block';
    });
    svg.addEventListener('pointerleave', function () {
      focus.setAttribute('visibility', 'hidden');
      tip.style.display = 'none';
    });
    reportSize();
  }

  var lastResult = null;
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id != null && !msg.method && pending[msg.id]) {
      var entry = pending[msg.id];
      delete pending[msg.id];
      if (msg.error) entry.reject(msg.error); else entry.resolve(msg.result);
      return;
    }
    if (msg.method === 'ui/notifications/tool-result') { lastResult = msg.params; render(lastResult); return; }
    if (msg.method === 'ui/notifications/host-context-changed') { applyContext(msg.params); render(lastResult); return; }
    if (msg.method === 'ui/resource-teardown' || msg.method === 'ping') {
      if (msg.id != null) post({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (msg.id != null && msg.method) {
      post({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
    }
  });

  var drawnWidth = 0;
  var resizeTimer;
  new ResizeObserver(function () {
    var w = document.getElementById('chart').clientWidth;
    if (!lastResult || Math.abs(w - drawnWidth) < 2) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { render(lastResult); }, 50);
  }).observe(document.getElementById('chart'));

  request('ui/initialize', {
    appInfo: { name: 'assetlab-site-fci-trend', version: '1.0.0' },
    appCapabilities: {},
    protocolVersion: '${MCP_APPS_PROTOCOL_VERSION}'
  }).then(function (res) {
    applyContext(res && res.hostContext);
    notify('ui/notifications/initialized');
  }, function () {
    notify('ui/notifications/initialized');
  });
})();
</script>
</body>
</html>
`
