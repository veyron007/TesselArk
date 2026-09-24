# TesselArk public page — 2026-09-24

## Scope

The public React page uses the existing Manrope / DM Sans typography, blue/white/ink palette and brand mark. It adds an editorial hero, a larger synthetic product specimen, accessible workflow tabs, a three-layer scope model and explicit demo coverage. Header Sign in and Sign up, hero, workflow and footer CTAs all lead to `/demo`; prepared-account entry and `/app` are unchanged.

The page describes the build snapshot as 40 partly implemented groups / 45 planned groups. This is not live coverage data: reconcile these figures with the in-app register when merging later domain work.

GSAP is imported after mount, scopes selectors to this landing instance and reverts its matchMedia context. It settles the product window as it scrolls into view, reveals editorial sections and applies restrained depth movement to the final brand mark. The Three.js renderer loads near the scope section, renders only on scroll or resize, separates company/registration/branch surfaces and disposes GPU resources on unmount or reduced-motion changes. HTML diagram and legend remain available without WebGL, on context loss, with reduced motion or data saving enabled.

## Verification

- `npm run build`: passed. Vite warns about the separate 525 KB minified Three.js chunk (130 KB gzip); it is loaded only near the scope section. No Flute code, preview or synthetic scene fixture is present in production assets.
- `npm test`: 273 passed, 0 failed.
- `npm audit`: 0 vulnerabilities.
- `LANDING_URL=http://127.0.0.1:5187 node qa/public-landing.browser.mjs`: passed with local Chrome headless at 1440×1000 and a 390×844 overflow/hero check.
- Browser checks cover header links, hash navigation, keyboard tabs, chooser entry as the selected user, `/orders` bookmark, WebGL context loss, unavailable WebGL, reduced-motion preference changes and page/console errors.
- Scroll verification: product-window CSS transform and Three.js rendered pixels change with scroll. Production smoke confirms Three.js is deferred until the scope section and the Flute query cannot load studio in the built app.
- Visual inspection: initial hero, platform, workflow, scope model, final CTA, demo chooser and selected workspace. Full responsive workflow QA remains lower priority and is not claimed.
- Servers for this worktree: Vite 5187, demo API 3039. Flute preview Vite 5186. Neither main nor the parent checkout was changed.

## Screenshots

Local browser output: `/tmp/tesselark-public-qa/`.

- `01-hero.png`
- `02-platform.png`
- `03-workflow.png`
- `04-scope-three.png`
- `05-context-loss-fallback.png`
- `06-final-cta.png`
- `07-demo-chooser.png`
- `08-selected-workspace.png`
- `09-reduced-motion.png`
- `10-mobile.png`
- `11-no-webgl.png`

## Flute development scene

Preview: <http://127.0.0.1:5186/?flute-preview=1&flute-scene=workspace-trail>

`workspace-trail` renders the real `PrismDashboard` with a scene-local synthetic API adapter and an 11.2-second oblique close-to-wide camera move. UI styles and production dashboard code are reused. Dashboard controls are inert for capture; an explicit header link opens the interactive demo chooser. Scene data never comes from a session or the network. A PNG thumbnail is embedded in the scene recipe.

The installed `npx flute guide --json` and repository documentation were consulted. `reviewAuthoring` reports a valid scene without issues. The preview, camera playback, reduced-motion paused state and explicit demo CTA were checked without page errors.

The existing `.flute/project.json` uses `adapter: react`, so this installed CLI rejects `flute snapshot` for the manual-preview adapter. The PNG was captured using Flute's canonical `__FLUTE_CAPTURE__.seek` bridge instead. No shared integration files were changed to work around that limitation. Opening/midpoint/final frames are `/tmp/tesselark-flute-opening.png`, `/tmp/tesselark-flute-midpoint.png`, `/tmp/tesselark-flute-final.png`. The scene remains development-only and does not replace the live landing page.
