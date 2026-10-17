# VANGUARD (working title)

A light-hearted 3D third-person co-op superhero game for the browser (1-4 players).
TypeScript + Babylon.js client, Python/FastAPI server. All characters are original.
See [PLAN.md](PLAN.md) for the plan and [docs/](docs/) for short per-system docs.

**Status:** the Phase 1 vertical slice is built and passed its playtest (Gate 1): third-person controller, tether swing
and zip-pull, energy, shield-over-core health, melee combo, tether-snare, thug AI with waves, base pad and respawn, hit
feedback and synthesized sound. Phase 2 has started with a **multiplayer spike** ([docs/netcode.md](docs/netcode.md)):
several players can swing around together on a Python server. Next: the hero framework and RAMPART.

## Run it
```bash
npm install
npm run dev            # http://localhost:5173
```

### Play together (spike: movement only)
```bash
cd server && uv sync && uv run uvicorn app.main:app --port 8000      # terminal 1
npm run dev                                                          # terminal 2
# open two tabs, e.g. http://localhost:5173/?server=ws://localhost:8000/ws&name=Ann
# add &lag=100&jitter=30 to simulate a bad connection
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
PW_CHANNEL=msedge npm run test:e2e   # browser tests on the production build (use the chrome/msedge you have)
NET_E2E=1 PW_CHANNEL=msedge npm run test:e2e   # also runs the multiplayer tests (starts the Python server via uv)
cd server && uv sync && uv run pytest && uv run uvicorn app.main:app --reload
```
In CI, `npm run test:e2e` downloads its own Chromium.

## Layout
`client/` browser game · `server/` FastAPI game server · `shared/` data, schemas, levels (the numbers live here:
see [docs/TUNING.md](docs/TUNING.md)) · `docs/` system docs.
