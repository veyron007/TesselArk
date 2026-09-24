# TesselArk cinematic public page — 2026-09-24

## Result

The opening now places a live Three.js scope model beside the editorial headline. The model shows company foundation, GST registration, and separate branch grants. Scrolling separates the layers and changes the camera angle. The model is preceded by an immediate CSS diagram, so the first paint and no-WebGL view stay readable. The public page uses TesselArk's light blue/white/ink palette, Manrope/DM Sans hierarchy, brand mark and real demo path.

The next chapter keeps a synthetic product specimen in view while GSAP settles its perspective into a flat working record. A later decision trail shows matching, local ITC review, internal approval and the boundary before official filing as separate steps. The counts beside Build Status are derived from the same feature and implementation maps as the application. Every prominent Sign in, Sign up or demo link reaches `/demo`; prepared account selection enters `/app`.

## Verification

- `npm run build`: passed. The Three.js chunk is 525 KB minified / 130 KB gzip and loads after the first paint. Flute studio/scene code stays outside production assets.
- `npm test`: 295 passed, 0 failed after integrating the recurring-work slice.
- `npm audit`: 0 vulnerabilities.
- `LANDING_URL=http://127.0.0.1:3001 npm run qa:landing`: passed at desktop 1440×1000 plus 390×844 overflow check against the combined production build. This is the browser QA gate; start the app server first.
- Browser coverage: opening 3D, rendered pixel change with scroll, product-window GSAP transform, section anchors, keyboard workflow tabs, final CTA, chooser and selected account, `/orders` bookmark, WebGL context loss, unavailable WebGL, reduced-motion preference changes, and no page/console errors.
- Production browser smoke: heading paints before 3D download; the model loads after idle; `?flute-preview=1` cannot load the studio in the built page.
- Combined-checkout production browser smoke on port 3002 passed the same landing script after integration with the recurring-work page and Inbox changes.
- The dev API ran in explicit demo mode on port 3044. A worktree Vite server ran on 5193; Flute preview ran on 5192. This branch starts at main commit `ef4819a`, which already includes the prior public landing work and synchronized coverage counts. Uncommitted WORK-02 code in the saved main checkout was untouched.

## Visual evidence

Previous opening: `/tmp/tesselark-hero.png` (headline beside text; scope model appeared much later). Revised live screenshots:

- `/tmp/tesselark-cinematic-opening.png` — opening 3D and hero CTA
- `/tmp/tesselark-cinematic-layered.png` — scope model after scroll
- `/tmp/tesselark-cinematic-product-mid.png` — held product window during the GSAP chapter
- `/tmp/tesselark-cinematic-review.png` — separate decision states
- `/tmp/tesselark-cinematic-final.png` — final CTA
- `/tmp/tesselark-cinematic-qa/09-demo-chooser.png` — prepared accounts
- `/tmp/tesselark-cinematic-qa/11-reduced-motion.png` and `13-no-webgl.png` — static fallbacks

## Flute development scene

Preview: <http://127.0.0.1:5192/?flute-preview=1&flute-scene=workspace-trail>

`workspace-trail` reuses the actual `PrismDashboard` React component with scene-local synthetic data. A second real React context plane sits behind it. Camera travel moves from a close review detail across the dashboard to a readable full-workspace view, with focus shifting as the visual hierarchy changes. The real dashboard remains capture-only and its explicit link opens the interactive demo chooser.

The installed `npx flute guide --json` and `FLUTE.md` were consulted. `reviewAuthoring` reports valid metadata with no issues. The scene preview had no browser errors; the opening, middle and final frames were inspected at `/tmp/tesselark-flute-revised-{opening,mid,final}.png`. A midpoint PNG snapshot is embedded in the recipe. The project's existing manual React adapter makes this Flute version reject the CLI `snapshot` command; the same canonical capture bridge was used to save the real rendered PNG. The studio is development-only and is not needed by the live landing.
