# VANGUARD (working title)

A light-hearted 3D third-person co-op superhero game for the browser (1-4 players).
TypeScript + Babylon.js client, Python/FastAPI server. All characters are original.
See [PLAN.md](PLAN.md) for the plan and [docs/](docs/) for short per-system docs.

**Status:** the Phase 1 vertical slice is built and passed its playtest (Gate 1): third-person controller, tether swing
and zip-pull, energy, shield-over-core health, melee combo, tether-snare, thug AI with waves, base pad and respawn, hit
feedback and synthesized sound. Phase 2 has started with a **multiplayer spike** ([docs/netcode.md](docs/netcode.md)):
several players can swing around together on a Python server. Heroes are data ([docs/heroes.md](docs/heroes.md)): ZIPLASH, the powerhouse RAMPART (charge through breakable walls) the flyer METALHEAD (jets, laser, homing rockets) and the storm-caller VOLTAGE (chain lightning, storm strike) are playable.
RAMPART can lift and throw props, METALHEAD flies and shoots, VOLTAGE stuns crowds. The team-up combo works (RAMPART throws a car, METALHEAD shoots it mid-air) with an AI teammate to play it solo. Next: networked combat, or more teammate AI.

## Run it
```bash
npm install
npm run dev            # http://localhost:5173
```

### Play together (1-4 players, server-authoritative: enemies, waves and every ability run on the server)
```bash
cd server && uv sync && uv run uvicorn app.main:app --port 8000      # terminal 1
npm run dev                                                          # terminal 2
# open two tabs, e.g. http://localhost:5173/?server=ws://localhost:8000/ws&name=Ann
# add &lag=100&jitter=30 to simulate a bad connection, &hero=hero.flyer to pick a hero
# the server runs waves of thugs; VANGUARD_WAVES=0 turns them off, VANGUARD_DEBUG=1 adds test hooks
```

## Controls
| | |
|---|---|
| WASD / Space | move / jump |
| Mouse | look (click to capture, or hold the button and drag) |
| *Pick a hero on the start screen* | ZIPLASH (wall-slinger), RAMPART (powerhouse), METALHEAD (flyer) or VOLTAGE (storm-caller) |
| E or right-mouse (hold) | ZIPLASH: swing from the green aim marker; Shift to reel in |
| F | ZIPLASH: zip-pull (aim just under a roof edge to climb up) |
| J or left-click | strike (tap in rhythm for a 3-hit combo) |
| Q | ZIPLASH: snare a thug in your sights |
| Shift / C | RAMPART: charge - bulldoze enemies and smash weak (orange) walls |
| E / G | RAMPART: lift the nearest car, crate or dumpster; press again to throw it (a car breaks the reinforced wall) |
| Space, then Space again in the air | METALHEAD: light the jets; hold Space to climb, Shift / C to descend, touch down to land |
| K or hold left-click | METALHEAD: pulse laser (hold) |
| R or right-mouse | METALHEAD: homing rocket at the enemy under the red lock ring |
| R or right-mouse | VOLTAGE: chain lightning (stuns the enemy under the red ring and its neighbours) |
| Q | VOLTAGE: storm strike where the yellow ring is (warning, then a stunning blast) |
| *AI teammate picker on the start screen* | or `?buddy=hero.bruiser` etc.; try RAMPART + METALHEAD for the car-bomb combo |
| P / Esc, M | pause, mute |

Gamepad: left stick move, right stick look, A jump (hold to climb), X strike, Y zip / rockets / chain, B snare / lift / storm, RT swing / laser, LT reel / charge / descend.

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
