# Data pipeline, health and combat (S3)

## Where the numbers live
```
shared/data/heroes/*.json      who a hero is: movement, energy, health, respawnDelay, ability ids
shared/data/abilities/*.json   what each ability does (kind: swing | zip | melee)
shared/data/enemies/*.json     enemy health, speed, attack
shared/data/upgrades/*.json    modifiers applied to a hero (path + mul/add)
shared/schemas/*.schema.json   JSON Schema for all of the above
```
Balancing means editing these files. `npm test` validates every file against its schema, checks that every ability
id a hero references exists, and that every upgrade path points at a real numeric field, so a typo fails CI instead
of the game. (TypeScript types are hand-written for now and mirror the schemas; they will be generated once the
server needs them, see PLAN.md D1.)

`client/src/data/content.ts` loads the files; `resolveHero()` flattens a hero plus its abilities into the
`HeroParams` the sim uses. A hero may have at most one ability per kind for now.

## Health: shield over core
- Damage hits the **shield** first; the rest hits the **core**. Core at 0 = defeated.
- Shield regenerates after `shield.regenDelay` seconds without damage. The core regenerates slower and later
  (`core.regenPerSecond`, `core.regenDelay`). Any damage restarts both delays.
- Defeated players are down for `respawnDelay` seconds, then respawn at the base spawn with full health and
  energy. Falling into the void respawns immediately.

## Damage pipeline
`Sim.damagePlayer / damageEnemy` -> `applyDamage` (pure) -> a `SimEvent` (`damage`, `defeated`, `respawn`, `melee`).
Views use events for flashes and banners; netcode will broadcast them.

## Strike (melee)
`ability.strike`: windup -> hit lands -> recovery. Pressing again inside `comboWindow` continues the combo
(`steps[]`, each with `damage` and `knockback`); a press up to `inputBuffer` seconds early is remembered, so mashing
works but the rate is capped by `windup + recovery`. The hit lands on everything in the frontal arc
(`arcDegrees`, `range`, `verticalReach`) toward the camera heading. A full 3-hit combo does 36 damage; a thug has 45 HP, so it takes a combo and a bit more.

Controls: `J`, or left-click while the mouse is captured; gamepad X (zip moved to Y).

## Upgrades
`modifiers: [{ path, op: mul|add, value }]` applied by `applyUpgrades()`. The rule "widen, don't inflate" is
enforced by `validateUpgrade()`: damage/knockback/health/shield/max paths may grow by at most x1.1 per upgrade
and never by a flat add; utility paths (range, regen, cost, speed) are unrestricted. A test runs it on every shipped
upgrade.
