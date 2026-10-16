# VANGUARD (working title)

A light-hearted 3D third-person co-op superhero game for the browser (1-4 players).
TypeScript + Babylon.js client, Python/FastAPI server. All characters are original.
See [PLAN.md](PLAN.md) for the plan and [docs/](docs/) for short per-system docs.

**Status:** Phase 1 vertical slice (single-player) is built: third-person controller, tether swing and zip-pull,
energy, shield-over-core health, melee combo, tether-snare, thug AI with waves, base pad and respawn, hit feedback,
and synthesized sound. Next is the Gate 1 playtest ([docs/PLAYTEST.md](docs/PLAYTEST.md)).

## Run it
```bash
npm install
npm run dev            # http://localhost:5173
```

## Controls
| | |
|---|---|
| WASD / Space | move / jump |
| Mouse | look (click to capture, or hold the button and drag) |
| E or right-mouse (hold) | swing from the green aim marker; Shift to reel in |
| F | zip-pull (aim just under a roof edge to climb up) |
| J or left-click | strike (tap in rhythm for a 3-hit combo) |
| Q | snare a thug in your sights |
| P / Esc, M | pause, mute |

Gamepad: left stick move, right stick look, A jump, X strike, Y zip, B snare, RT swing, LT reel.

## Test
```bash
npm test                       # unit tests (Vitest): sim, AI, data schemas
npm run typecheck && npm run lint
PW_CHANNEL=msedge npm run test:e2e   # browser smoke tests on the production build (use chrome/msedge you have)
cd server && uv sync && uv run pytest && uv run uvicorn app.main:app --reload
```
In CI, `npm run test:e2e` downloads its own Chromium.

## Layout
`client/` browser game · `server/` FastAPI skeleton · `shared/` data, schemas, levels (the numbers live here:
see [docs/TUNING.md](docs/TUNING.md)) · `docs/` system docs.
