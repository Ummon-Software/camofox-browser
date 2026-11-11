/**
 * Identity plugin: keep the same browser fingerprint across launches.
 *
 * camofox-browser restarts Camoufox often (idle shutdown, memory limits,
 * crashes), and each launch used to bring a new fingerprint. Saved cookies
 * then came back on what looked like a new device. This plugin saves the
 * first launch's fingerprint and puts it back on every later launch.
 *
 * Configuration (camofox.config.json):
 *   { "plugins": { "identity": { "enabled": true, "file": "/data/identity.json" } } }
 *
 * The file can also be set with CAMOFOX_IDENTITY_FILE. Default:
 * ~/.camofox/identity.json. Delete the file to get a new identity.
 *
 * One browser serves every session, so every userId shares this identity.
 */

import os from 'node:os';
import path from 'node:path';
import {
  FILE_VERSION,
  claimedOS,
  fingerprintId,
  firefoxMajor,
  identityOf,
  load,
  pin,
  readConfig,
  save,
  writeConfig,
} from './identity.js';

const WEBGL2_PREF = 'webgl.enable-webgl2';

export async function register(_app, ctx, pluginConfig = {}) {
  const { events, log } = ctx;
  const file = process.env.CAMOFOX_IDENTITY_FILE
    || pluginConfig.file
    || path.join(os.homedir(), '.camofox', 'identity.json');

  log('info', 'identity plugin enabled', { file });

  events.on('browser:launching', async ({ options }) => {
    const fresh = readConfig(options.env);
    if (!fresh) {
      log('warn', 'identity: no Camoufox config in launch options; not pinning');
      return;
    }
    const prefs = (options.firefoxUserPrefs ||= {});

    let saved = null;
    try {
      saved = await load(file);
    } catch (err) {
      // Never overwrite a file we can't read: it may be the only copy.
      log('error', 'identity: cannot read identity file; launching unpinned', { file, error: err.message });
      return;
    }

    if (saved && claimedOS(saved.config) !== claimedOS(fresh)) {
      log('warn', 'identity: saved identity is for another OS; making a new one', {
        file, saved: claimedOS(saved.config), now: claimedOS(fresh),
      });
      await save(`${file}.${claimedOS(saved.config)}.bak`, saved);
      saved = null;
    }

    if (!saved) {
      const identity = identityOf(fresh);
      await save(file, {
        version: FILE_VERSION,
        createdAt: new Date().toISOString(),
        config: identity,
        prefs: { [WEBGL2_PREF]: prefs[WEBGL2_PREF] },
      });
      log('info', 'identity: saved new identity', {
        id: fingerprintId(identity), os: claimedOS(fresh), firefox: firefoxMajor(fresh),
      });
      return;
    }

    const { config, identity, added } = pin(fresh, saved, { proxy: !!options.proxy });
    writeConfig(options.env, config);
    if (saved.prefs && WEBGL2_PREF in saved.prefs) prefs[WEBGL2_PREF] = saved.prefs[WEBGL2_PREF];

    const from = firefoxMajor(saved.config);
    const to = firefoxMajor(fresh);
    if (added.length > 0 || from !== to) {
      // Save new keys and the new Firefox version, so they stay fixed from now on.
      await save(file, { ...saved, config: identity });
    }

    log('info', 'identity: pinned', {
      id: fingerprintId(identity),
      os: claimedOS(config),
      firefox: to,
      ...(from !== to ? { retargetedFrom: from } : {}),
      ...(added.length ? { added } : {}),
    });
  });
}
