/**
 * Pinned browser identity.
 *
 * camoufox-js builds a fresh fingerprint on every launch: navigator, screen,
 * fonts, WebGL, and the canvas, audio and font-spacing noise seeds. The whole
 * result travels to the browser as JSON split across CAMOU_CONFIG_<n>
 * environment variables, plus one Firefox pref (webgl.enable-webgl2).
 *
 * These helpers read that config back out of the launch options, save it, and
 * put the saved one back on later launches, so the browser keeps presenting
 * the same device.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const FILE_VERSION = 1;

const CHUNK_RE = /^CAMOU_CONFIG_(\d+)$/;

// Keys that describe this launch rather than the device. The current launch
// keeps its own values for these.
const LAUNCH_KEYS = new Set(['humanize', 'humanize:maxTime', 'allowMainWorld']);

// Keys that follow the network location. With a proxy, they must match the
// proxy's exit IP, so the current launch wins.
const GEO_PREFIXES = ['geolocation:', 'locale:', 'webrtc:'];
const GEO_KEYS = new Set(['timezone']);

/** Read the Camoufox config out of the launch env. */
export function readConfig(env = {}) {
  const chunks = Object.keys(env)
    .map((k) => [k, CHUNK_RE.exec(k)])
    .filter(([, m]) => m)
    .sort((a, b) => Number(a[1][1]) - Number(b[1][1]))
    .map(([k]) => env[k]);
  if (chunks.length === 0) return null;
  return JSON.parse(chunks.join(''));
}

/** Replace the Camoufox config in the launch env. Mirrors camoufox-js chunking. */
export function writeConfig(env, config, platform = process.platform) {
  for (const k of Object.keys(env)) {
    if (CHUNK_RE.test(k)) delete env[k];
  }
  const size = platform === 'win32' ? 2047 : 32767;
  const s = JSON.stringify(config);
  for (let i = 0; i < s.length; i += size) {
    env[`CAMOU_CONFIG_${i / size + 1}`] = s.slice(i, i + size);
  }
}

/** The Firefox major version in the config's user agent, or null. */
export function firefoxMajor(config) {
  const m = /Firefox\/(\d+)/.exec(config?.['navigator.userAgent'] || '');
  return m ? Number(m[1]) : null;
}

/** The OS the config claims to be: windows, macos, linux, or null. */
export function claimedOS(config) {
  const ua = config?.['navigator.userAgent'] || '';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos';
  if (/Linux|X11/.test(ua)) return 'linux';
  return null;
}

/**
 * Rewrite Firefox version strings (Firefox/151.0, rv:151.0) from one major
 * version to another, so a saved identity keeps matching the engine after a
 * Camoufox upgrade.
 */
export function retarget(value, from, to) {
  if (from === to || from == null || to == null) return value;
  if (typeof value === 'string') {
    return value
      .replaceAll(`Firefox/${from}.`, `Firefox/${to}.`)
      .replaceAll(`rv:${from}.`, `rv:${to}.`);
  }
  if (Array.isArray(value)) return value.map((v) => retarget(v, from, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, retarget(v, from, to)]));
  }
  return value;
}

function isGeoKey(k) {
  return GEO_KEYS.has(k) || GEO_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * Merge a saved identity over a freshly generated config.
 *
 * The saved values win, except launch keys and, with a proxy, location keys.
 * Keys only the fresh config has (say, a seed added by a newer Camoufox) are
 * kept and listed in `added`.
 *
 * Returns the config to launch with, and the identity to save from now on:
 * the saved one, moved to the current Firefox version, plus the added keys.
 * A proxy's location never gets into the saved identity.
 */
export function pin(fresh, saved, { proxy = false } = {}) {
  const retargeted = retarget(saved.config, firefoxMajor(saved.config), firefoxMajor(fresh));
  const config = { ...fresh };
  for (const [k, v] of Object.entries(retargeted)) {
    if (LAUNCH_KEYS.has(k)) continue;
    if (proxy && isGeoKey(k)) continue;
    config[k] = v;
  }
  const added = Object.keys(fresh).filter((k) => !(k in retargeted) && !LAUNCH_KEYS.has(k));
  const identity = { ...retargeted };
  for (const k of added) identity[k] = fresh[k];
  return { config, identity, added };
}

/** The part of a config worth saving: everything but launch keys. */
export function identityOf(config) {
  return Object.fromEntries(Object.entries(config).filter(([k]) => !LAUNCH_KEYS.has(k)));
}

/** A short, stable hash of an identity, for logs. */
export function fingerprintId(config) {
  const keys = Object.keys(config).sort();
  const json = JSON.stringify(keys.map((k) => [k, config[k]]));
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 12);
}

export async function load(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const saved = JSON.parse(raw);
  if (saved?.version !== FILE_VERSION || !saved.config) {
    throw new Error(`unrecognised identity file ${file}`);
  }
  return saved;
}

export async function save(file, saved) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file);
}
