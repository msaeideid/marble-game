# Thug AI, tether-snare and waves (S4)

## Thug behaviour (`sim/ai.ts`, data in `shared/data/enemies/thug.json`)
```
idle -> chase -> windup (telegraph) -> recovery -> chase
                    ^ a hit here cancels the attack (stagger)
```
- **Aggro:** the nearest living player within `aggroRange` is the target; none = idle.
- **Chase:** walks straight at the target at `move.speed` and spreads out from crowding thugs. There is no
  pathfinding yet, so a thug can get stuck behind a building. Fine in open streets; navigation comes later.
- **Telegraph:** the attack has a `windup` (the thug turns orange and pulses). The hit only lands if you are still
  within `range` (+0.6 m leniency) when it ends, so **stepping away dodges it**.
- **Hit reaction:** damage during chase/recovery/windup staggers the thug for `staggerTime` (cancelling a windup).
  Hits during a stagger do not extend it, and for `poiseTime` seconds afterwards hits do damage but cannot interrupt,
  so mashing cannot stun-lock a thug forever. Reaching a thug first and finishing the combo is a race you can win;
  getting caught mid-combo costs you.
- **Its hit:** `attack.damage` (shield first), plus `attack.knockback` shoving you away; the screen edges flash red.
- **Defeat:** a thug "powers down" (greys out, shrinks) for `powerDownTime`, then disappears. No gore.

## Tether-snare (`ability.snare`, key `Q`, gamepad B)
Aim at a thug (crosshair) and press: the nearest enemy within `radius` of the aim line (up to `range`, with a clear
line of sight) is **held for `duration` seconds**: it cannot move or attack, and turns cyan. Costs `cost` energy and
has a `cooldown`. Pressing with nothing in the line costs nothing. Great for pinning one thug while you deal with
another, or for escaping.

## Waves (`Sim` option `waves: true`, level `enemySpawns` + `waveDelay`)
Wave 1 spawns every spawn point. When the arena is clear, the next wave appears after `waveDelay` seconds with one
more thug each time, capped at 5. A "Wave N" banner announces it. (This is just the slice's way of keeping fights
coming; real missions replace it.)

## Tuning cheatsheet
- Thugs too easy: raise `attack.damage`, `move.speed`, `attack.range`; lower `attack.windup`; raise `health.core.max`.
- Too punishing: lengthen `windup` (more telegraph), raise `staggerTime`, lower `damage`.
- Stun-lock complaints: raise `poiseTime`. Combat feels floaty: lower `staggerTime`.
- With the stationary "stand and mash" test bot, waves 1-6 cost it roughly 30-50 of its 100 HP each, with no deaths.
