# Tuning guide

Almost everything that decides how the game *feels* is a number in a JSON file under `shared/`. Edit, save, reload
the page (the dev server reloads by itself). No code changes, no rebuild. `npm test` checks the files against their
schemas, so a typo is caught immediately.

| I want to change... | File -> field | Notes |
|---|---|---|
| Run speed / snappiness | `heroes/swinger.json` -> `movement.runSpeed`, `groundAccel` | |
| Jump height | `movement.jumpSpeed`, `movement.gravity` | height = `jumpSpeed^2 / (2*gravity)` |
| Forgiving jumps | `movement.coyoteTime`, `jumpBufferTime` | seconds |
| Max HP | `health.shield.max`, `health.core.max` | |
| How fast shield / core come back | `health.shield.regenPerSecond`, `regenDelay`; `health.core.*` | delay restarts on any hit |
| Energy budget | `energy.max`, `regenPerSecond`, `regenDelay` | the main balance lever |
| Time down / spawn protection | `respawnDelay`, `respawnInvulnerable` | |
| Swing range / reach | `abilities/swing.json` -> `swing.maxRange` | |
| Swing launch strength | `swing.autoReelSpeed`, `pullGain`, `arcClearance` | lower clearance = lower, faster swings |
| Swing speed cap / release boost | `swing.maxSpeed`, `releaseBoost` | |
| Swing energy cost | `swing.attachCost`, `drainPerSecond`, `reelDrainPerSecond` | |
| Zip power | `abilities/zip.json` -> `zip.speed`, `cost`, `ledgeSnap` | `ledgeSnap` = how close to a roof edge counts as "up and over" |
| Strike damage / combo | `abilities/strike.json` -> `melee.steps[]`, `windup`, `recovery`, `comboWindow` | |
| Strike reach / arc | `melee.range`, `arcDegrees` | player reach should stay above thug attack range |
| Snare | `abilities/snare.json` -> `snare.duration`, `cooldown`, `cost`, `radius`, `range` | |
| Thug toughness | `enemies/thug.json` -> `health.core.max`, `staggerTime`, `poiseTime` | |
| Thug threat | `attack.damage`, `attack.range`, `attack.windup`, `move.speed`, `attack.knockback` | longer windup = easier to dodge |
| RAMPART charge | `abilities/charge.json` -> `charge.speed`, `duration`, `cooldown`, `cost`, `damage`, `breakPower` | `breakPower` 2 breaks the reinforced wall |
| RAMPART toughness / melee | `heroes/bruiser.json`, `abilities/smash.json` | see docs/heroes.md |
| METALHEAD flight | `abilities/flight.json` -> `speed`, `climbSpeed`, `hoverDrainPerSecond`, `climbDrainPerSecond`, `startCost` | one energy bar also pays for weapons |
| METALHEAD laser | `abilities/laser.json` -> `damage`, `fireInterval`, `shotCost`, `aimAssist`, `propAssist` (how generous the aim is on a thrown car; raise it if the online combo is too hard) | dps = damage / fireInterval; never staggers |
| METALHEAD rockets | `abilities/rockets.json` -> `damage`, `splashRadius`, `turnRate`, `lockAngleDegrees`, `cost`, `cooldown` | wider lock cone = more forgiving |
| METALHEAD fragility | `heroes/flyer.json` -> `health`, `energy` | the design rule: fragile, weak melee, shared energy |
| VOLTAGE chain lightning | `abilities/chain.json` -> `stunTime`, `jumpRadius`, `maxTargets`, `damage`, `cooldown`, `cost` | stun is the effect; damage stays low |
| VOLTAGE storm strike | `abilities/tempest.json` -> `radius`, `delay`, `damage`, `stunTime`, `cooldown`, `cost` | longer `delay` = easier to dodge |
| VOLTAGE glide | `abilities/stormflight.json` | same fields as METALHEAD's `flight.json` |
| Car bomb (team-up combo) | `props/car.json`, `props/dumpster.json` -> `detonation` (`radius`, `damage`, `stunTime`, `knockback`, `breakPower`) | crates have none; the combo should beat either hero alone |
| Prop weight / throw | `props/<type>.json` -> `carrySlow`, `throwSpeed`, `throwDamage`, `throwKnockback`, `breakPower`, `hp`, `respawnTime` | `carrySlow` 1 = no slowdown |
| Lift reach / cooldown | `abilities/lift.json` -> `liftRange`, `cooldown`, `strength` | `strength` scales every throw speed |
| Where props are | `levels/arena.json` -> `props` | type + position; they respawn there |
| Wave pacing | `levels/arena.json` -> `waveDelay`, `enemySpawns` | wave n adds one thug, cap 5 |
| Base pad healing | `levels/arena.json` -> `base.regenPerSecond`, `base.radius` | |
| Level layout | `levels/arena.json` -> `colliders` | boxes; visuals follow automatically |

Hit-stop, camera shake and slash visuals are constants in `client/src/game/game.ts` and `render/effects.ts`.

## Rules of thumb
- Change one thing at a time and play for a minute before changing the next.
- Keep strike reach (`melee.range + 0.4`) above thug `attack.range`, or fights turn into pure tanking.
- Upgrades must widen options, not inflate power: `validateUpgrade()` in `sim/upgrades.ts` enforces it in tests.
- Reference point for difficulty: a stationary player who only mashes strike loses roughly 30-50 of 100 HP per wave
  (waves 1-6) and does not die. Real play (dodging, snaring, swinging) should do better.

Campaign numbers (bosses, armor, rewards, the level gate) are in [CAMPAIGN.md](CAMPAIGN.md#tuning-the-campaign).
