# Venti Damage Lab (web)

The calculator as a static web app. There's no server: the engine (`engine/`)
runs in the browser, in Web Workers, so the page stays responsive during long
calculations and the Cost Scamming optimizer can use every CPU core.

## Running it

Host this folder on any static file host (GitHub Pages, Netlify, Cloudflare
Pages, ...), or serve it locally:

    python -m http.server --directory web 8000

then open <http://localhost:8000/>. Opening `index.html` straight from disk
(`file://`) won't work: browsers refuse to load JavaScript modules and
workers from `file://` pages.

Your last build is saved in the browser (localStorage) and restored on the next
visit. Open the page with `?reset` (e.g. `http://localhost:8000/?reset`) to
start again from the defaults.

## Layout

- `index.html`, `styles.css`, `app.js` -- the interface. It never computes
  damage itself; it sends requests to the engine and renders what comes back.
- `engine/client.js` -- the page's side of the engine: the same `/api/...`
  requests the old Python server answered, now handled locally.
- `engine/worker.js` -- the Web Worker that runs the engine.
- `engine/state.js` -- UI state <-> engine objects, the stat panel, debug data.
- `engine/optimizer.js` -- the Cost Scamming search.
- `engine/team.js`, `rotation.js`, `timeline.js`, `artifacts.js`,
  `substats.js`, `combat.js`, `formulas.js`, `characters/*.js` -- the damage
  engine, one module per Python module it was ported from.
- `engine/py.js` -- exact re-implementations of the Python built-ins the
  engine relies on (`sum`, `round`, `%`, `//`, ...), so every number matches
  the original Python calculator bit for bit.

## Checking against the Python original

`tools/parity_check.py` runs thousands of randomized builds through both the
Python calculator (`team-builder/`) and this engine and requires identical
output:

    python tools/parity_check.py             # 400 random builds
    python tools/parity_check.py --optimize  # also compares optimizer runs (slow)
