# Heroes, ability kits, RAMPART, charge and breakable walls

## Hero framework
A hero is data, not code: `shared/data/heroes/<hero>.json` lists movement, energy, health and **which abilities it has**
(`abilities: ["ability.smash", "ability.charge"]`). Each ability is a file in `shared/data/abilities/` with a `kind`:

| kind | what it gives | heroes using it |
|---|---|---|
| `melee` | the attack combo (required by every hero) | all |
| `swing` + `zip` | tether swing and zip-pull (a zip needs a swing) | ZIPLASH |
| `snare` | hold one enemy | ZIPLASH |
| `charge` | straight-line rush that bowls over enemies and smashes weak walls | RAMPART |

`resolveHero()` (TS) and `load_hero()` (Python) flatten a hero plus its abilities into one params object. Kits a hero
does not have are simply absent, and the sim skips them: pressing swing as RAMPART does nothing and costs nothing, and
ZIPLASH ignores the charge button. Adding a hero is mostly a new JSON file plus whatever new mechanic it needs.

**Hero select:** the start screen has a button per hero (it reloads with `?hero=<id>`). The controls list shows only
the rows that hero has. Online, the page's hero is sent to the server (`&hero=` on the WebSocket URL) and each player is
drawn with their own hero.

Display names (ZIPLASH, RAMPART) live in the hero files; internal ids (`hero.swinger`, `hero.bruiser`) never change.

## RAMPART (`hero.bruiser`) - the powerhouse
Standout strength: toughness and force. Weakness: slow, short jump, no flight or swing, so ranged enemies and tall
buildings are other heroes' jobs.

| | ZIPLASH | RAMPART |
|---|---|---|
| Run speed | 9 | 7 |
| Jump height | ~1.8 m | ~1.35 m |
| Shield + core | 40 + 60 | 60 + 110 |
| Energy regen | 14 / s | 9 / s |
| Melee combo | 10, 10, 16 (36) | 16, 16, 28 (60), wider arc and reach |
| Special | tether swing, zip, snare | **charge** |

A full RAMPART combo (60) powers down a 45 HP thug.

### Charge (`ability.charge`, `Shift` or `C`, gamepad L1/LT)
Press to rush in the camera direction at 18 m/s for 0.8 s (about 14 m). It costs 25 energy and has a 3 s cooldown. While
charging you cannot jump and steering is locked. The charge:
- **bowls over every enemy** in the path once: 22 damage, knockback, and it always staggers them, poise or not;
- **smashes weak walls** (break tier at or below `breakPower`) and keeps going;
- **stops** at anything it cannot break (buildings, reinforced walls).

### Breakable walls (designed destruction)
Level colliders can carry `"breakable": <tier>` (kind `wall`). They are solid until a charge with enough `breakPower`
hits them; then they are gone for good (this session) and rays/tethers see through the gap. It is one yes/no state per
wall, not physics, so it is cheap and easy to network. The arena has three:
- tier 1 (warm brick), south corridor and west corridor: RAMPART's charge breaks them;
- tier 2 (dark concrete), in the south street behind the first wall: needs `breakPower: 2`, which is the hook for the
  "Breaker armor" upgrade in the design document.

Breaking is shown with a burst of tumbling debris, a camera shake and a crunch sound.

## Networking
Charging changes movement and the world, so it follows the project rule (decision D1): **any mechanic that changes the
authoritative state is ported to Python with conformance scenarios**.
- `server/app/sim/controller.py` has the charge and `world.py` the breakable colliders, mirroring the TypeScript.
- `shared/conformance/movement/` now has 21 scenarios, 8 of them RAMPART (charge through a weak wall, stopped by a
  reinforced wall and by a building, cooldown, two charges, chaos runs). Python and TypeScript agree to ~1e-12 and on the
  exact list of broken walls.
- Snapshots carry `broken` (all smashed wall ids) and each player's `hero`; the welcome message does too, so late
  joiners see the right world. Clients only ever *add* to their broken set from snapshots; if the server disagrees with a
  prediction the client adopts the server's world, replays its inputs and re-breaks what it should.
- Combat (melee, snare, enemy hits, a charge's damage to enemies) is still solo-only. When it is networked, those get
  their Python ports too.

## Tuning (`shared/data/abilities/charge.json`, `heroes/bruiser.json`, `abilities/smash.json`)
| Want | Change |
|---|---|
| Longer / faster rush | `charge.duration`, `charge.speed` |
| Use it more often | lower `charge.cooldown` or `charge.cost`, or raise `energy.regenPerSecond` |
| Harder-hitting charge | `charge.damage`, `charge.knockback` (upgrades may raise these by at most x1.1) |
| Wider bowling | `charge.hitRadius` |
| Break tougher walls | `charge.breakPower` (2 breaks the reinforced wall) |
| New breakable wall | add a collider with `"breakable": 1` or `2` and `"kind": "wall"` to the level |
