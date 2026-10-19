# Heroes, ability kits, RAMPART, METALHEAD, VOLTAGE, charge, flight and breakable walls

## Hero framework
A hero is data, not code: `shared/data/heroes/<hero>.json` lists movement, energy, health and **which abilities it has**
(`abilities: ["ability.smash", "ability.charge"]`). Each ability is a file in `shared/data/abilities/` with a `kind`:

| kind | what it gives | heroes using it |
|---|---|---|
| `melee` | the attack combo (required by every hero) | all |
| `swing` + `zip` | tether swing and zip-pull (a zip needs a swing) | ZIPLASH |
| `snare` | hold one enemy | ZIPLASH |
| `charge` | straight-line rush that bowls over enemies and smashes weak walls | RAMPART |
| `lift` | lift a car, crate or dumpster overhead and throw it | RAMPART |
| `flight` | jet flight: no gravity, climb and descend with buttons, drains energy | METALHEAD |
| `laser` | hold to fire hitscan bolts, each costing a little energy | METALHEAD |
| `rockets` | homing rocket that locks the enemy nearest the crosshair and bursts | METALHEAD |
| `chain` | lightning to the enemy under the crosshair that jumps to nearby enemies, shocking each | VOLTAGE |
| `tempest` | storm strike: lightning lands on the spot you aim at after a visible delay | VOLTAGE |

`resolveHero()` (TS) and `load_hero()` (Python) flatten a hero plus its abilities into one params object. Kits a hero
does not have are simply absent, and the sim skips them: pressing swing as RAMPART does nothing and costs nothing, and
ZIPLASH ignores the charge button. Adding a hero is mostly a new JSON file plus whatever new mechanic it needs.

**Hero select:** the start screen has a button per hero (it reloads with `?hero=<id>`). The controls list shows only
the rows that hero has. Online, the page's hero is sent to the server (`&hero=` on the WebSocket URL) and each player is
drawn with their own hero.

Display names (ZIPLASH, RAMPART, METALHEAD, VOLTAGE) live in the hero files; internal ids (`hero.swinger`, `hero.bruiser`) never change.

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

## Props: lift and throw (`ability.lift`, `E` or `G`, gamepad B)
Level props (`shared/data/props/*.json`, placed in the level's `props` list) are designed objects with four states, not
physics: **resting**, **held**, **thrown**, **destroyed**.
- **Lift:** press near a resting prop (within `liftRange` plus the prop's size). It rides on top of your head. While
  carrying you are slower (`carrySlow`: car 0.4, dumpster 0.55, crate 0.75; the jump suffers less than the run), cannot
  charge and cannot strike.
- **Throw:** press again (after a 0.5 s cooldown) to throw it along your aim, arced up a little. It flies, then lands and
  rests where it fell.
- **Impacts:** a hard stop (6+ m/s) or an enemy hit costs the prop a hit point; at zero it shatters and **respawns at its
  home after `respawnTime`** (car 20 s, crate 12 s). Cars and dumpsters survive two.
- **Enemies:** a thrown prop damages and staggers each enemy it hits once (car 40, dumpster 30, crate 20).
- **Walls:** thrown at 8+ m/s it smashes breakable walls up to its `breakPower`: crates and dumpsters break tier-1
  walls, **a car breaks the reinforced tier-2 wall that a charge cannot**. In the arena there is a car trapped between the two
  south walls for exactly this.
- A carrier who is defeated, respawns or disconnects drops the prop where they stood.
- Heroes without the `lift` kit (ZIPLASH) cannot lift anything.

Props are not solid for characters yet (you can walk through a resting car); only walls collide.

## METALHEAD (`hero.flyer`) - the flyer
Standout strength: the sky and ranged firepower. Weakness: the most fragile hero, the weakest melee, and **one energy
bar pays for everything** (jets, laser and rockets), so you cannot hover and spray forever.

| | ZIPLASH | RAMPART | METALHEAD |
|---|---|---|---|
| Run speed | 9 | 7 | 7.5 (flight 11) |
| Shield + core | 40 + 60 | 60 + 110 | 30 + 50 |
| Energy regen | 14 / s | 9 / s | 12 / s (only once the jets are off) |
| Melee combo | 36 | 60 | 30 (jab) |
| Special | swing, zip, snare | charge, lift/throw | **flight, laser, homing rockets** |

### Jet flight (`ability.flight`, `Space` in the air)
Jump, then **press Space again in the air** to light the jets (6 energy). While flying there is no gravity:
- the stick steers at 11 m/s (camera-relative, eased), **hold Space** to climb (7 m/s), **hold Shift / C** to descend
  (10 m/s), release both to hover;
- hovering costs 7 energy/s, climbing 6 more; energy does not regenerate while the jets are on;
- the jets cut out when the energy is gone (you fall and cannot relight with under 6 energy), when you touch the ground,
  or when you are defeated.

A full tank is about 7 seconds of climbing or 14 of hovering. Buildings stop you like they stop anyone (you can fly up
their walls and over the roof).

### Pulse laser (`ability.laser`, hold `K` or left-click with the mouse captured, gamepad RT)
Hitscan from the hands along the aim direction, one bolt every 0.2 s for 1.5 energy and 5 damage (25 damage/s, 7.5
energy/s). It stops at the first wall and hits the nearest enemy within 0.45 m of the line (aim assist), but **never
staggers**: a steady beam wears enemies down while they keep coming, so a flyer has to keep moving. A thug (45) takes
under two seconds of fire.

### Homing rockets (`ability.rockets`, `R` or right-mouse, gamepad Y)
Fires a rocket (22 energy, 3.5 s recharge) at the enemy closest to the crosshair, within 18 degrees and 45 m with a clear
line of sight. **A red ring shows the current lock.** The rocket flies at 20 m/s and turns up to 3.2 rad/s toward its
target; with no lock it flies straight. It bursts on an enemy, a wall, the ground or after 3 s: 35 damage at the centre
falling to 30% at the 1.8 m edge, a shove away from the blast, and survivors are always staggered. There is no friendly
fire. Rockets do not break walls (that stays RAMPART's job).

Weapons are in `client/src/sim/weapons.ts` (`traceLaser`, `pickRocketTarget`, `RocketSystem`) and the Sim wires them up
next to melee and snare.

## VOLTAGE (`hero.storm`) - the storm-caller
Standout strength: **crowd control**. Weakness: almost no single-target damage, and a slower, shorter glide than
METALHEAD. It makes a group easy for the team to finish rather than finishing it itself.

| | ZIPLASH | RAMPART | METALHEAD | VOLTAGE |
|---|---|---|---|---|
| Run speed | 9 | 7 | 7.5 | 8 |
| Shield + core | 40 + 60 | 60 + 110 | 30 + 50 | 40 + 70 |
| Melee combo | 36 | 60 | 30 | 38 (conductor gauntlets) |
| Flight | none | none | 11 m/s, climbs 7, hovers 7 energy/s | **8.5 m/s, climbs 5.5, hovers 4 energy/s** |
| Special | swing, zip, snare | charge, lift | laser, rockets | **chain lightning, storm strike** |

It uses the same `flight` kit as METALHEAD with different numbers (`abilities/stormflight.json`), which is the point of
the data-driven kits: a new flyer is a JSON file.

### Chain lightning (`ability.chain`, `R` or right-mouse, gamepad Y)
Picks the enemy closest to the crosshair (red lock ring, within 20 degrees and 30 m, clear line of sight), then jumps to
the nearest unhit enemy within 5 m of the last, up to 4 in all, never through walls. Each is hit for 10 damage, then x0.8
per jump, and **stunned for 0.8 s** (cannot move or attack, poise does not help). 16 energy, 1.8 s cooldown. With no
target it does nothing and costs nothing.

### Storm strike (`ability.tempest`, `Q`, gamepad B)
A yellow ring on the ground shows where it would land (dimmer while it is recharging). Pressing Q calls it: after a
**0.9 s warning** (the ring fills up) lightning hits everything within 2.5 m: 28 damage and a **1.5 s stun**. Enemies
can walk out of the ring during the warning. 30 energy, 8 s cooldown. Aimed at the sky it does nothing.

Neither power staggers through damage: the stun is the effect. A thug (45) survives any one of them, and a stunned thug
is free damage for a teammate (RAMPART's combo, METALHEAD's laser). Solo, VOLTAGE is slower going and has to use the
melee gauntlets.

Code: `traceChain`, `StrikeSystem` and `strikePoint` in `client/src/sim/weapons.ts`; the Sim wires them up next to the
other combat. They are solo-only like all combat (`chainPressed` and `stormPressed` are not sent online).

## The team-up combo: car bomb
RAMPART throws a car, METALHEAD shoots it **while it is in the air**, and it explodes.

- A **thrown** car or dumpster is *volatile*. A laser bolt through it, or a rocket bursting next to it, detonates it. A
  prop sitting on the ground or held in someone's hands is safe, and crates are not volatile.
- **Blast** (`props/*.json` -> `detonation`): car 55 damage within 4.2 m (down to half at the edge), 1.5 s stun,
  knockback, and it breaks walls up to tier 2 in range; dumpster 32 damage within 3.2 m, tier 1 walls. The thrown car
  alone only does 40 to whatever it hits, so the combo is worth far more than either hero acting alone. Nobody on the
  team is hurt. The prop respawns at home like any destroyed prop.
- The event says whether it was a **combo** (someone other than the thrower set it off): the game shows "TEAM-UP COMBO!"
  and a fanfare.
- A thrown car lands about 12 m away, so the shooter has well under a second to hit it; the laser's aim assist (it is
  hitscan) makes that fair. Rockets are slower than the car, so for them it works as a "burst near it" bonus.

**Playing it solo:** the start screen has an **AI teammate** picker (or `?buddy=<hero id>`). Pick RAMPART as your
teammate and play METALHEAD (you shoot the cars it throws), or play RAMPART with a METALHEAD teammate (it shoots the
cars you throw). `client/src/sim/buddy.ts` is a deliberately simple AI: it produces a normal `PlayerIntent`, follows you,
fights with its hero's kit, and knows both halves of the combo. The sim now supports a different hero per player
(`sim.addPlayer(id, hero)`), which is what makes any of this possible.

Like all combat, detonation is **solo-only** until combat is networked, and will be ported to Python then.

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
- Props are **server-authoritative**: the server runs lifting, carrying, throwing, landing and respawning (ported to
  Python, in the conformance suite), and snapshots carry every prop's state; clients just draw them (held props ride on the
  carrier's drawn head). The carrier's own `carrying` state is *not* predicted, so a lift or a throw costs one small
  reconciliation correction when the server confirms it. When the last player leaves, the world (broken walls, props)
  resets.
- **Flight is movement, so it is ported:** `flying` is part of the synced player state, the climb/descend buttons
  (`jumpHeld`, `descendHeld`) are part of the networked intent, and 9 METALHEAD scenarios (take-off, hover, cruise, landing,
  running out of fuel, flying into a tower, 4 random runs) agree between TypeScript and Python. Other players see the
  jet flames from the `flying` flag. The laser and rockets are weapons, so like all combat they are **offline-only until
  combat is networked** (`fireHeld` and `rocketPressed` are not sent).
- VOLTAGE's glide uses the same ported flight kit; 3 more scenarios cover it (40 in total). Its lightning is combat and
  stays offline for now.
- Combat (melee, snare, laser, rockets, chain lightning, storm strike, enemy hits, a charge's or a thrown prop's damage to enemies) is still solo-only. When it is networked, those get
  their Python ports too.

## Tuning (`abilities/charge.json`, `heroes/bruiser.json`, `abilities/smash.json`, and for METALHEAD `heroes/flyer.json`, `abilities/flight.json`, `laser.json`, `rockets.json`)
| Want | Change |
|---|---|
| Longer / faster rush | `charge.duration`, `charge.speed` |
| Use it more often | lower `charge.cooldown` or `charge.cost`, or raise `energy.regenPerSecond` |
| Harder-hitting charge | `charge.damage`, `charge.knockback` (upgrades may raise these by at most x1.1) |
| Wider bowling | `charge.hitRadius` |
| Break tougher walls | `charge.breakPower` (2 breaks the reinforced wall) |
| New breakable wall | add a collider with `"breakable": 1` or `2` and `"kind": "wall"` to the level |
| Fly faster / climb faster | `flight.speed`, `flight.climbSpeed`, `flight.descendSpeed` |
| Longer flights | lower `flight.hoverDrainPerSecond` / `climbDrainPerSecond`, or raise `heroes/flyer.json` `energy.max` (the same bar also pays for weapons) |
| Laser dps / energy | `laser.damage`, `fireInterval`, `shotCost`, `aimAssist` (dps = damage / fireInterval) |
| Rocket power | `rockets.damage`, `splashRadius`, `edgeFalloff`, `knockback`, `cost`, `cooldown` |
| Rocket homing | `rockets.turnRate`, `lockAngleDegrees` (a bigger cone is more forgiving), `lockRange`, `speed` |
| Chain reach / size | `chain.jumpRadius`, `maxTargets`, `lockAngleDegrees`, `range` |
| Chain stun / damage | `chain.stunTime`, `damage`, `damageFalloff` |
| Storm strike power | `tempest.radius`, `damage`, `stunTime`, `cooldown`, `cost` |
| Storm strike warning | `tempest.delay` (longer = easier to dodge) |
| VOLTAGE glide | `abilities/stormflight.json` (same fields as METALHEAD's flight) |
| Car bomb power | `props/car.json` -> `detonation.radius`, `damage`, `stunTime`, `knockback`, `breakPower` |
| Which props explode | give a prop a `detonation` block (crates have none) |
