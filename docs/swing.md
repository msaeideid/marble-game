# Swing, zip and energy (S2)

All numbers live in `shared/data/heroes/swinger.json` (`energy`, `swing`, `zip`). Edit, reload, feel it.

## Controls
| Action | Keyboard / mouse | Gamepad |
|---|---|---|
| Swing (hold) | `E` or right mouse | RT / R1 |
| Reel in (hold) | `Shift` | LT / L1 |
| Zip-pull | `F` | X |

Aim with the camera crosshair. It turns **green** when a tether has something to grab within `maxRange`;
a marker shows exactly where.

## How the swing works (`sim/swing.ts`, `sim/controller.ts`)
- **Anchor:** a ray from the hand along the aim direction; the first surface hit is the anchor.
- **Rope:** a one-way distance constraint. Each tick the move is shortened so the hand stays within the rope
  length, and any velocity pointing away from the anchor is removed. Gravity does the rest, so it behaves like a
  pendulum (a test checks top speed against `sqrt(2·g·h)`).
- **Launch / auto-reel:** on attach the rope is shortened toward `anchor height - ground - arcClearance`, at
  `autoReelSpeed`, and the player is pulled along it. That yanks you off the ground and keeps the arc above
  the street. Holding reel shortens it further.
- **Air control:** while tethered, `airControl` steers; untethered, air control only *adds* speed toward the
  stick, so swing momentum is never bled off.
- **Release:** letting go keeps your velocity and adds `releaseBoost` along it.
- **Blocked rope:** if a building gets between hand and anchor, the tether lets go.

## Zip-pull
Pulls straight toward the anchor at `zip.speed`. Hitting a wall within `ledgeSnap` of its roof aims above the
roof instead, so the zip carries you up and over the edge. Ends within `arriveDistance`, with a small pop.

## Energy
One meter (`energy.max`). Attach costs `attachCost`, holding drains `drainPerSecond` (plus `reelDrainPerSecond`
while reeling), zip costs `cost`. At zero the tether lets go. Regeneration starts `regenDelay` seconds after the
last spend. This is the main balance lever for every hero.

## Tuning cheatsheet
- Swings feel floaty/slow: raise `movement.gravity`, raise `autoReelSpeed`.
- Not enough launch: lower `arcClearance`, raise `pullGain`.
- Too easy to run out: raise `regenPerSecond` or lower `drainPerSecond`.
- Want it faster overall: raise `maxSpeed` and `releaseBoost`.
