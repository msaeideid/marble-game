# Netcode spike (movement only)

Goal (PLAN.md D4): learn whether server-authoritative multiplayer with a **Python** server is workable before building
three more heroes. Scope: 2-4 players swing, run, jump and zip in the arena and see each other. No enemies, combat
or upgrades online yet.

## How it works
```
client (TypeScript)                           server (Python / FastAPI, 30 Hz)
 sample input -> sim.step (predict)  --input {seq, intent}-->  queue per player
 keep pending inputs                                          step ONE input per tick per player (time budget)
                                    <--snapshot {ack, state}-- every 2nd tick (15 Hz), all players
 compare server state with our prediction for `ack`
   same -> do nothing
   differs -> adopt server state, replay unacked inputs, ease the visual offset away
 draw other players ~100 ms in the past, interpolated between snapshots
```
- **Input-driven:** the server only simulates a player when it has an input for them, in order. It never invents
  ticks, so the server state is always exactly "the result of inputs 1..ack" and prediction can be checked exactly.
- **Anti speed-hack:** a per-player budget (one input per server tick, banked up to 3) absorbs jitter but caps the
  sustained rate at 30 inputs/s. Queues are bounded; stale or duplicate sequence numbers are dropped; every intent is
  validated and clamped (NaN, wrong types, out-of-range values are rejected). Rooms hold 4 players.
- **Wire format:** `client/src/sim/wire.ts` (TypeScript) and `to_wire` in `server/app/sim/controller.py` (Python) describe
  the same `PlayerWire` JSON. The conformance scenarios use it too.
- **Where:** `server/app/rooms.py` (room + tick), `server/app/main.py` (`/ws`, `/health`), `client/src/net/*`
  (connection with lag simulation, prediction `session.ts`, `interpolation.ts`, `online.ts`).

## Try it
```bash
cd server && uv sync && uv run uvicorn app.main:app --port 8000        # terminal 1
npm run dev                                                            # terminal 2
# open two tabs:
#   http://localhost:5173/?server=ws://localhost:8000/ws&name=Ann
#   http://localhost:5173/?server=ws://localhost:8000/ws&name=Bo&lag=100&jitter=30   (simulated latency)
```
The bottom-left line shows players, ping and prediction corrections. `corrections 0` means the server never
disagreed with the client's prediction. `/health` on the server shows tick cost.

## Findings (these answer decision D1)
| Question | Result |
|---|---|
| Can the Python port match the TypeScript sim? | Yes. 13 conformance scenarios (6 random 900-tick runs with swinging, zipping, jumping and wall hits, plus 7 designed ones) agree to **about 1e-13** (tolerance 1e-9), and every discrete event (tether, zip, grounded) is identical. |
| How much code was the port? | About 550 lines of Python for the movement sim (`server/app/sim/`), written by mirroring the TypeScript line by line. |
| Does client prediction agree with the real server? | Yes. Two real browsers against the live server: **0 corrections**, max prediction error ~1e-14, with no lag and with 100 ms lag + 30 ms jitter. |
| Does reconciliation work when they disagree? | Yes (unit tests inject server-only impulses: the client rewinds, replays, converges to the server state, and the visual offset eases away). |
| Is Python fast enough? | A full room of 4 players, all swinging (the costliest movement): median **0.08 ms**, worst **0.39 ms** per tick against a 33 ms budget. |
| What went wrong along the way? | My lag simulator reordered messages (timer rounding). The server correctly dropped the late input and the client recovered by reconciling; fixed with an ordered delay queue. Real TCP does not reorder. |

### What it costs to keep two sims
Every mechanic that affects the authoritative state must exist in both languages: movement is done; combat, enemy AI,
abilities of three more heroes, projectiles and destruction are not. The safeguards are cheap and effective: shared JSON
data and level files, the shared wire format, and conformance scenarios that fail CI the moment either side drifts
(`client/tests/conformance.test.ts` regenerates/validates, `server/tests/test_conformance.py` replays).

## Decision on D1: confirmed (2026-10-17)
The project keeps the **Python port with conformance tests** (option a). The spike shows it is accurate, fast and testable. The cost
is real but linear and bounded: roughly one extra port + one conformance scenario per new mechanic. Switching to a
Node room server (option b) would remove that duplication, but would change your locked backend and the spike gives no
reason to. Revisit only if porting the combat/AI layer proves much slower than the movement layer did.

## Update: heroes and breakable walls
The server now runs a different hero per player (`&hero=` on the socket URL) and shares the world's broken walls in every
snapshot. See [heroes.md](heroes.md). The conformance suite grew to 21 scenarios.

## Update: props
Lift-and-throw props run on the server only (the client's local sim has props switched off when online). The server loop
is now `GameSim` (`server/app/sim/game.py`), a Python mirror of the TypeScript `Sim` player loop: movement, grab/throw,
base energy regeneration, void respawn, then the props once per tick. Conformance scenarios run through the whole
thing (28 scenarios, props included). Each lift and throw causes one small correction on the thrower's client because
`carrying` is decided by the server. The room resets its world when the last player leaves.

## Known limits / next steps
- Movement only. Combat, enemies, health and waves are solo-only for now.
- One global room, guest names only, no accounts, no reconnect, JSON messages (switch to MessagePack when stable).
- Remote players are interpolated 100 ms behind and not extrapolated: a stalled connection freezes them in place.
- Player-vs-player collision is not simulated.
- `server/Dockerfile` now builds from the repo root (it needs `shared/`); it has not been built here.
- GitHub Actions runs the multiplayer tests (`NET_E2E=1`), starting the server via `uv`.
