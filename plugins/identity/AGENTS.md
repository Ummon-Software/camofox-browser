# Identity Plugin — Agent Guide

Keeps the same browser fingerprint across Camoufox launches. Without it, every launch (idle shutdown, memory restart, crash) gets a new random fingerprint from camoufox-js, so saved cookies come back on what looks like a new device.

## How It Works

- `browser:launching` hook → reads the fingerprint camoufox-js generated (JSON split across `CAMOU_CONFIG_<n>` env vars, plus the `webgl.enable-webgl2` pref).
- First launch: saves it to the identity file.
- Later launches: puts the saved values back over the fresh ones. Launch settings (`humanize`, `allowMainWorld`) stay as the current launch sets them. With a proxy, location keys (`geolocation:*`, `locale:*`, `webrtc:*`, `timezone`) follow the proxy, and the saved identity keeps its own.
- After a Camoufox upgrade, `Firefox/<n>` and `rv:<n>` in the saved identity move to the new version. Keys a newer Camoufox adds are saved on first sight, then stay fixed.
- If the identity's OS doesn't match the launch (say `CAMOFOX_OS` changed), the old file is kept as `identity.json.<os>.bak` and a new identity is made.
- A file that can't be read is never overwritten; that launch goes unpinned and logs an error.

Keep `CAMOFOX_OS` at the host's OS. Camoufox can only render a stable canvas for the OS it runs on; for any other OS it randomises the canvas per launch by design, which no saved identity can fix.

One browser serves every session, so every `userId` shares this identity. Run one server per identity.

## Configuration

Enabled in `camofox.config.json`. File: `CAMOFOX_IDENTITY_FILE` env var, or `"file"` in the plugin config, default `~/.camofox/identity.json` (mode 0600). Delete the file for a new identity.

## Key Files

- `identity.js` — reading and writing the config env, merging, saving
- `index.js` — the `browser:launching` hook
- `identity.test.js` — unit tests

## Checking It

`node scripts/identity-check.mjs` restarts the browser five times and prints the fingerprint each time. Measured 2026-11-11 on macOS (Apple silicon) with the bundled Camoufox 152.0.4-beta.30: user agent, platform, cores, screen, window, WebGL renderer, canvas pixels, audio and fonts were identical across three pinned launches. Across two unpinned launches, most of them changed (the WebGL renderer happened to come up the same both times). Rerun it after upgrading Camoufox.

The PNG from `toDataURL`/`toBlob` still differs per launch, and so does the CreepJS ID that hashes it. Firefox's baseline fingerprinting protection adds a per-session chunk to exported PNGs; Camoufox keeps that on because stock Firefox does it. `canvas:seed` is saved but no Camoufox release reads it (camoufox issue #721).

Don't swap in a newer Camoufox through `CAMOUFOX_EXECUTABLE` without checking the user agent: camoufox-js 0.11.5 takes the Firefox version from its own install, so a 158 binary went out claiming Firefox 152.
