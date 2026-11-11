// Checks that the identity plugin keeps the fingerprint across browser
// restarts: three pinned launches, then two with the identity file deleted
// (the unpinned control). Starts its own server on 127.0.0.1:9388.
//
// Usage: node scripts/identity-check.mjs [repo dir]
//
// Expect every column but "canvas" and "creep" to hold steady across the
// pinned runs and to change across the unpinned ones. Firefox adds a
// per-session chunk to exported PNGs, so the PNG hash (and CreepJS, which
// hashes it) changes every launch on real Firefox too; "pixels" is the
// canvas itself.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const repo = process.argv[2] || new URL('..', import.meta.url).pathname;
const dir = '/tmp/camofox-idtest';
const port = 9388;
const base = `http://127.0.0.1:${port}`;
const adminKey = crypto.randomBytes(16).toString('hex');
const identityFile = `${dir}/identity.json`;
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const server = spawn('node', ['server.js'], {
  cwd: repo,
  env: {
    ...process.env,
    CAMOFOX_PORT: String(port),
    CAMOFOX_BIND_HOST: '127.0.0.1',
    CAMOFOX_ADMIN_KEY: adminKey,
    CAMOFOX_IDENTITY_FILE: identityFile,
    CAMOFOX_PROFILE_DIR: `${dir}/profiles`,
    CAMOFOX_COOKIES_DIR: `${dir}/cookies`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logs = [];
for (const s of [server.stdout, server.stderr]) s.on('data', (d) => logs.push(...d.toString().split('\n')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body, headers = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${text.slice(0, 300)}`);
  return data;
}

const PROBE_SRC = `(async () => { try {
  const sha = async (s) => {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 12);
  };
  const c = document.createElement('canvas'); c.width = 300; c.height = 80;
  const x = c.getContext('2d');
  x.textBaseline = 'top'; x.font = '16px Arial'; x.fillStyle = '#f60'; x.fillRect(100, 1, 62, 20);
  x.fillStyle = '#069'; x.fillText('camofox fingerprint \\u{1F56F}', 2, 15);
  x.fillStyle = 'rgba(102,204,0,0.7)'; x.beginPath(); x.arc(200, 40, 30, 0, Math.PI * 2); x.fill();
  const canvas = await sha(c.toDataURL());
  const px = x.getImageData(0, 0, c.width, c.height).data;
  const pb = await crypto.subtle.digest('SHA-256', px);
  const pixels = [...new Uint8Array(pb)].map((v) => v.toString(16).padStart(2, '0')).join('').slice(0, 12);
  let gl = {};
  try {
    const g = document.createElement('canvas').getContext('webgl');
    const e = g.getExtension('WEBGL_debug_renderer_info');
    gl = { vendor: g.getParameter(e.UNMASKED_VENDOR_WEBGL), renderer: g.getParameter(e.UNMASKED_RENDERER_WEBGL) };
  } catch (err) { gl = { error: String(err) }; }
  let audio = null;
  try {
    const a = new OfflineAudioContext(1, 5000, 44100);
    const o = a.createOscillator(); o.type = 'triangle'; o.frequency.value = 10000;
    const k = a.createDynamicsCompressor(); o.connect(k); k.connect(a.destination); o.start(0);
    const buf = await a.startRendering();
    audio = await sha(Array.from(buf.getChannelData(0).slice(4500)).join(','));
  } catch (err) { audio = String(err); }
  const fonts = ['Arial', 'Helvetica Neue', 'Menlo', 'Segoe UI', 'Calibri', 'Ubuntu', 'Futura', 'Avenir', 'Courier New', 'Georgia'];
  const s = document.createElement('span'); s.textContent = 'mmmmmmmmmwwwwwwwlli'; s.style.fontSize = '72px';
  document.body.appendChild(s);
  const widths = fonts.map((f) => { s.style.fontFamily = '"' + f + '", monospace'; return s.offsetWidth; });
  s.remove();
  return {
    ua: navigator.userAgent, platform: navigator.platform, cpus: navigator.hardwareConcurrency,
    screen: [screen.width, screen.height, screen.availWidth, screen.availHeight, devicePixelRatio].join('x'),
    window: [outerWidth, outerHeight].join('x'), tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    langs: navigator.languages.join(','), gl: gl.renderer || gl.error, canvas, pixels, audio, fonts: await sha(widths.join(',')),
  };
} catch (e) { return { error: String(e) }; } })()`;
const PROBE = `(() => { delete document.documentElement.dataset.fp; const s = document.createElement('script'); s.textContent = 'Promise.resolve(' + ${JSON.stringify(PROBE_SRC)} + ').then(r => { document.documentElement.dataset.fp = JSON.stringify(r); })'; document.head.appendChild(s); return true; })()`;
const READ = `document.documentElement.dataset.fp || null`;

async function creepId(tabId) {
  await call('POST', `/tabs/${tabId}/navigate`, { userId: 'idtest', url: 'https://abrahamjuliot.github.io/creepjs/' });
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const { result } = await call('POST', `/tabs/${tabId}/evaluate`, {
      userId: 'idtest',
      expression: `(() => { const m = document.body.innerText.match(/FP ID:\\s*([0-9a-f]{8,})/i); return m ? m[1] : null; })()`,
    });
    if (result) return result.slice(0, 12);
  }
  return 'not found';
}

async function probeOnce() {
  const { tabId } = await call('POST', '/tabs', { userId: 'idtest', sessionKey: 'probe', url: 'https://example.com/' });
  await call('POST', `/tabs/${tabId}/evaluate`, { userId: 'idtest', expression: PROBE });
  let result = null;
  for (let i = 0; i < 20 && !result; i++) {
    await sleep(500);
    const r = await call('POST', `/tabs/${tabId}/evaluate`, { userId: 'idtest', expression: READ });
    if (r.result) result = JSON.parse(r.result);
  }
  if (!result) throw new Error('probe produced nothing');
  result.creep = await creepId(tabId);
  return result;
}

async function restart() {
  await call('POST', '/stop', null, { 'x-admin-key': adminKey });
  await sleep(1500);
}

const rows = [];
try {
  for (let i = 0; i < 60; i++) {
    try { await call('GET', '/health'); break; } catch { await sleep(1000); }
  }
  for (let i = 1; i <= 3; i++) {
    rows.push({ run: `pinned ${i}`, ...(await probeOnce()) });
    await restart();
  }
  for (let i = 1; i <= 2; i++) {
    fs.rmSync(identityFile, { force: true });
    rows.push({ run: `unpinned ${i}`, ...(await probeOnce()) });
    await restart();
  }
} catch (err) {
  console.error('FAILED:', err.message);
} finally {
  server.kill('SIGTERM');
}

const cols = ['run', 'ua', 'platform', 'cpus', 'screen', 'window', 'tz', 'gl', 'canvas', 'pixels', 'audio', 'fonts', 'creep'];
for (const r of rows) console.log(JSON.stringify(Object.fromEntries(cols.map((c) => [c, r[c]]))));
console.log('--- identity log lines');
for (const l of logs) if (/identity|camoufox launched|launch attempt failed|error/i.test(l)) console.log(l.slice(0, 400));
await sleep(2000);
process.exit(0);
