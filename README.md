# Health Log

A private, offline health tracker that runs entirely in the browser. No accounts, no
servers, no dependencies — all data stays on your device.

**Live app:** https://michellefeliciano.github.io/health-tracker/

## Features

- **Today / History / Trends / Patterns / Settings** — daily logging, a browsable history,
  charts, and plain-language pattern cards that stay cautious ("no clear pattern yet"
  rather than claiming "no link") until there is enough data.
- **Caffeine tracking** — drink presets, unit conversion, daily totals, and a baseline period.
- **Apple Health import** — reads the full "Export All Health Data" zip in the browser
  (streamed in slices, never loaded whole into memory) plus daily Shortcut CSV files.
- **Backup and restore** — export/import your data with a versioned file format and
  merge rules (newer edit wins, deletes propagate).
- **Installable and offline** — a PWA with a service worker, so it works without a connection.

## Privacy by design

The page's Content Security Policy sets `connect-src 'none'`, so the app cannot make
network requests at all. Data is stored in the browser's IndexedDB.

## Tech

Plain HTML, CSS, and JavaScript — no frameworks, no build step, no external dependencies.
IndexedDB for storage, Web Workers for large imports, `DecompressionStream` for reading
the Apple Health zip.

## Running locally

Open `index.html` in a browser, or serve the folder with any static file server.
