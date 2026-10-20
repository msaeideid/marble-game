# Campaign structure

The story from the brief: a **city tutorial** (learn the mechanics fighting thugs) -> **free roam** (challenges, scrap and XP,
upgrades at the base) -> the turning-point boss **VASTOR, the Worldbreaker** ("win but costly": the team lands real hits and
wins the encounter, but he escapes in a cutscene; it is *not* an unwinnable scripted loss) -> **3 worlds**, each a chapter
with a mini-boss and a new upgrade -> a genuinely **winnable final battle**.

Everything here is **data** (`shared/`), so names, text, numbers and layouts can change without touching code. The creative
parts below are my placeholders; they are yours to change (see "Decisions for you").

## The loop
fight / objectives -> **scrap + XP** -> back at the **upgrade bay** -> spend -> a harder mission.

- **Scrap** is the currency; **XP** gives a **level** (shown in the menu). Both come from defeated enemies
  (`enemy.reward`) and from finishing missions (`mission.reward`).
- **Upgrades** widen options and never inflate raw power (the validator already enforces this). Some need a level or a
  story flag (a world you have beaten), which is how "each world gives a new upgrade" works.
- **Saves** are local (`localStorage`, key `vanguard.save.v1`). Guest-only, nothing leaves the browser.

## Missions (`shared/data/missions/*.json`, `shared/schemas/mission.schema.json`)
A mission is a level plus a **sequence of objectives**, optional enemy spawns that trigger at the start or when an objective
starts or completes, dialogue lines, and a reward.

| Objective | Completes when |
|---|---|
| `do` | you have moved / jumped / struck / used a special / flown / swung enough (the tutorial) |
| `defeat` | N enemies are defeated (optionally of one type) |
| `reach` | you stand inside a marked spot |
| `survive` | N seconds pass |
| `boss` | the tagged boss is defeated, or (`escapeAt`) drops below a health fraction and escapes |

**Challenges** are missions with `kind: "challenge"`: usually a `timeLimit` and/or `noDamage`. Failing one just lets you
retry. They live in the free-roam city and inside each world.

## Chapters and flow
| Chapter | Missions |
|---|---|
| **Brightport** (the city) | Training Day (tutorial) -> free roam with 3 challenges -> **The Worldbreaker** (VASTOR escapes) |
| **Sugarworks** (world 1) | the main path ending in the mini-boss **Big Batch**, plus 4 side challenges |
| **Cloudspire** (world 2) | main path, mini-boss **Gale Warden**, 4 side challenges |
| **Gearhollow** (world 3) | main path, mini-boss **The Clockwork Duchess**, 4 side challenges |
| **The Shard Engine** (finale) | VASTOR again, this time to the end |

Menu -> **Campaign** shows the chapters; missions are locked until their requirements are met (earlier missions, a level,
a story flag). Picking one loads its level. A finished mission shows the story card, the rewards, and returns to the menu,
where the **upgrade bay** is.

## "Win but costly"
VASTOR is built so the first fight can be won with what you have, but only barely: he has **armor** (a flat reduction on
every hit, so light attacks barely scratch him; rockets, storm strikes and car bombs work) and he calls shard minions. At
about a third of his health he **escapes**: the mission completes, `vastorEscaped` is set, and the city changes
(the damaged hub). In the finale he has the same moves and no escape.

## Bosses
Data on the enemy definition (`enemy.boss`): a list of **phases**, each with a health threshold and an attack pattern.
Attacks: `slam` (telegraphed ring on the ground), `charge` (a rush in a straight line), `summon` (minions). Bosses resist
stuns and snares (`resist`) so crowd control helps but cannot lock them down, and have a boss health bar on screen.

## Levels
`shared/levels/*.json` plus a `theme` (ground, building and sky colours) so each place looks different. They are generated
by `tools/gen_content.py` from templates (deterministic), so they can be regenerated or hand-edited later.
All have a **ground route** every hero can walk; swingers and flyers get shortcuts over rooftops.

## What is built
All five parts exist and are tested (`client/src/campaign/`, `client/src/sim/boss.ts`, `client/src/ui/`):
1. **Mission engine**: `MissionRunner`, schema in `shared/schemas/mission.schema.json`.
2. **Progression**: `progress.ts` (wallet, XP, unlock rules, shop rules, defensive save) and 21 upgrades.
3. **Boss framework**: phases of slam, charge and summon, armor, stun/snare/knockback resistance, never staggered.
4. **Content**: `tools/gen_content.py` writes the levels and missions; integrity tests check every spawn and marker is
   standable and walkable from the start, each world has a ground route to its boss, and the unlock graph can be finished.
5. **Game flow**: the Campaign and Upgrade Bay tabs, the mission briefing, objective list, clock, dialogue, boss bar,
   goal beacon and results card, plus free roam that pays scrap and XP.

## Tuning the campaign
| Want | Change |
|---|---|
| A boss is too easy or hard | `data/enemies/<boss>.json`: `health.core.max`, `armor`, the phase `attacks` (`windup`, `cooldown`, `damage`, `radius`) |
| Light attacks should hurt VASTOR more or less | his `armor` (every hit loses this much, never more than 80%) |
| Bosses are stunned too easily | `resist.stun`, `resist.snare`, `resist.knockback` (1 = no resistance) |
| The VASTOR fight comes too early or late | `missions/vastor.json` -> `requires.level` (XP for level n is 50 * (n-1)^2) |
| He escapes sooner or later | the boss objective's `escapeAt` (fraction of health) |
| More or less loot | enemy `reward`, mission `reward`, upgrade `cost` |
| New missions or places | edit `tools/gen_content.py` and re-run it, or edit the JSON directly |

After adding new data files, a stale cache can hide them from the unit tests; delete `node_modules/.vitest-cache` and
`client/node_modules/.vite` once.

## Limits for now
- **Offline only** (solo, with the AI teammate). The campaign director and bosses live in the TypeScript sim; online co-op
  campaign needs them ported to Python with conformance scenarios, like combat was. That is the next step after this.
- Placeholder art, text and music. Boss "cutscenes" are story cards plus an effect, not animation.

## Decisions for you
These were mine to guess; change them in the data whenever you like.
1. **World themes and names** (Sugarworks, Cloudspire, Gearhollow) and the mini-boss names. All original placeholders.
2. **VASTOR's look and moves** (a towering armored figure; slam, charge, shard summons) and the city's name (Brightport).
3. **What "costly" means.** I chose: he escapes and the city is damaged afterwards. Alternatives: lose the base for one
   mission, or lose a teammate for a chapter.
4. **The level gate** on the VASTOR fight (level 3, so you have had time to earn upgrades).
5. **Upgrade list.** Each hero gets three or four upgrades within the existing "widen, don't inflate" rule. New abilities
   (a beam overcharge, a bigger storm) are real mechanics, so they are a later step, not part of this one.
6. **Online co-op campaign** after the offline one works (recommended), versus doing both at once.
