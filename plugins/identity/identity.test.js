import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';
import { register } from './index.js';
import { pin, readConfig, retarget, writeConfig } from './identity.js';

function config(major, extra = {}) {
  return {
    'navigator.userAgent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${major}.0) Gecko/20100101 Firefox/${major}.0`,
    'screen.width': 1512,
    'canvas:seed': 42,
    'audio:seed': 7,
    humanize: true,
    ...extra,
  };
}

// Stand-in for camoufox-js: a new random fingerprint on every call.
function launchOptions(major = 152, extra = {}) {
  const env = { OTHER: 'x' };
  writeConfig(env, config(major, {
    'canvas:seed': Math.floor(Math.random() * 1e9),
    'audio:seed': Math.floor(Math.random() * 1e9),
    'screen.width': 1000 + Math.floor(Math.random() * 1000),
    ...extra,
  }));
  return { env, firefoxUserPrefs: { 'webgl.enable-webgl2': Math.random() < 0.5 } };
}

describe('config env round trip', () => {
  test('reads chunks back in numeric order', () => {
    const env = {};
    const c = config(152, { fonts: Array.from({ length: 4000 }, (_, i) => `Font ${i}`) });
    writeConfig(env, c);
    expect(Object.keys(env).length).toBeGreaterThan(1);
    expect(readConfig(env)).toEqual(c);
  });

  test('writeConfig replaces old chunks', () => {
    const env = { CAMOU_CONFIG_1: '{"a":', CAMOU_CONFIG_2: '1}', KEEP: 'y' };
    writeConfig(env, { b: 2 });
    expect(env).toEqual({ CAMOU_CONFIG_1: '{"b":2}', KEEP: 'y' });
  });
});

describe('pin', () => {
  test('saved values win, launch keys stay current', () => {
    const saved = { config: config(152, { humanize: false }) };
    const fresh = config(152, { 'canvas:seed': 99, humanize: true });
    const { config: out } = pin(fresh, saved);
    expect(out['canvas:seed']).toBe(42);
    expect(out.humanize).toBe(true);
  });

  test('moves the saved user agent to the current Firefox', () => {
    const { config: out } = pin(config(153), { config: config(152) });
    expect(out['navigator.userAgent']).toContain('Firefox/153.0');
    expect(out['navigator.userAgent']).toContain('rv:153.0');
    expect(retarget('Firefox/1520.0', 152, 153)).toBe('Firefox/1520.0');
  });

  test('keeps keys a newer Camoufox adds', () => {
    const fresh = config(152, { 'fonts:spacing_seed': 5 });
    const { identity, added } = pin(fresh, { config: config(152) });
    expect(added).toEqual(['fonts:spacing_seed']);
    expect(identity['fonts:spacing_seed']).toBe(5);
  });

  test('with a proxy, location follows the proxy but is not saved', () => {
    const saved = { config: config(152, { timezone: 'America/Chicago', 'geolocation:latitude': 41 }) };
    const fresh = config(152, { timezone: 'Europe/Berlin', 'geolocation:latitude': 52 });
    const { config: out, identity } = pin(fresh, saved, { proxy: true });
    expect(out.timezone).toBe('Europe/Berlin');
    expect(out['geolocation:latitude']).toBe(52);
    expect(identity.timezone).toBe('America/Chicago');
  });
});

describe('identity plugin', () => {
  let dir, file, events, ctx;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-identity-'));
    file = path.join(dir, 'identity.json');
    events = createPluginEvents();
    ctx = { events, log: jest.fn() };
    await register(null, ctx, { file });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function launch(options) {
    await events.emitAsync('browser:launching', { options });
    return options;
  }

  test('every launch after the first gets the first identity', async () => {
    const first = await launch(launchOptions());
    const firstConfig = readConfig(first.env);
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);

    for (let i = 0; i < 5; i++) {
      const next = await launch(launchOptions());
      expect(readConfig(next.env)).toEqual(firstConfig);
      expect(next.firefoxUserPrefs['webgl.enable-webgl2']).toBe(first.firefoxUserPrefs['webgl.enable-webgl2']);
      expect(next.env.OTHER).toBe('x');
    }
  });

  test('a Camoufox upgrade keeps the identity and updates its version', async () => {
    const first = readConfig((await launch(launchOptions(152))).env);
    const next = readConfig((await launch(launchOptions(153))).env);
    expect(next['canvas:seed']).toBe(first['canvas:seed']);
    expect(next['navigator.userAgent']).toContain('Firefox/153.0');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(saved.config['navigator.userAgent']).toContain('Firefox/153.0');
  });

  test('a different OS starts a new identity and backs up the old one', async () => {
    await launch(launchOptions());
    const winUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0';
    const next = readConfig((await launch(launchOptions(152, { 'navigator.userAgent': winUA }))).env);
    expect(next['navigator.userAgent']).toBe(winUA);
    await expect(fs.stat(`${file}.macos.bak`)).resolves.toBeTruthy();
  });

  test('an unreadable file is left alone and the launch goes unpinned', async () => {
    await fs.writeFile(file, 'not json');
    const options = launchOptions();
    const before = readConfig(options.env);
    await launch(options);
    expect(readConfig(options.env)).toEqual(before);
    expect(await fs.readFile(file, 'utf8')).toBe('not json');
    expect(ctx.log).toHaveBeenCalledWith('error', expect.stringContaining('cannot read'), expect.anything());
  });
});
