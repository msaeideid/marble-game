# Base pad, respawn and hit feedback (S5)

## Base and respawn
- `shared/levels/arena.json` -> `base: { pos, radius, regenPerSecond }`. It is the glowing cyan disc at the spawn point.
- **Defeat** -> down for `respawnDelay` seconds -> respawn on the pad with full health/energy and
  `respawnInvulnerable` seconds of spawn protection (the hero blinks). Field revive comes with multiplayer.
- **Recovery:** standing on the pad refills **energy** at 2x `regenPerSecond`, and **shield** (and core, at a quarter
  of the rate) at `regenPerSecond` - but **only out of combat**, i.e. after the normal damage-regen delay. It is a
  place to recover, not to tank (a test checks that three thugs can still take you down on the pad).

## Level
The arena now has the 4x4 street grid (8-33 m roofs), four tall towers (50-72 m) outside it for long swings, mid-rise
rooftops around the edge so there is always something to grab, a jump staircase east of the base, and cover crates
south-west of it. Edit `shared/levels/arena.json` to change it; the sim and the visuals both read it.

## Feedback (nothing here changes the sim)
| Feedback | Where |
|---|---|
| Hit-stop (50 ms light, 90 ms finisher) and camera shake on landing a strike | `game/game.ts` |
| Slash arc sweeping in the attack direction (gold on the finisher) | `render/effects.ts` |
| Floating damage numbers; enemy health bars (shown once damaged; cyan while snared) | `ui/worldLabels.ts` |
| Orange pulse = thug windup; white flash = hit; cyan = snared; grey shrink = powering down | `render/enemyView.ts` |
| Red screen-edge flash + shake when you are hit | `ui/hud.ts`, `game/game.ts` |
| Wave counter, "Wave N" banner, "Down! Back at base in N" banner, snare-ready chip | `ui/hud.ts` |
| Synthesized sound effects (swing, hit, hurt, windup, tether attach, zip, snare, power-down, down, respawn, wave) | `audio/sfx.ts` |
| Click-to-play screen with controls; `P`/`Esc` pause, `M` mute; pauses when focus is lost | `game/game.ts` |

Sounds are generated with WebAudio, so there are no audio files yet. They are placeholders for real audio later.
Browsers require a click or key press before audio can play, which the start screen provides.

## Tuning
- Hit-stop / shake strength: constants at the top of `game/game.ts` and the `shake()` calls in `handleEvents`.
- Base healing: `base.regenPerSecond` in the level file. Spawn protection: `respawnInvulnerable` in the hero file.
