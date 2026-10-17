# VANGUARD (working title) — Project Plan v0.2 (browser edition)

Status: **Plan approved. Phase 1 slice S0-S6 built (see README); next: Gate 1 playtest (docs/PLAYTEST.md).**
v0.2 replaces v0.1 (Unity). The platform changed to a browser game: TypeScript + WebGL client, Python/FastAPI server.

## 0. Decisions so far

| Topic | Decision | Source |
|---|---|---|
| Platform | Browser game, PC first, mobile-capable later. No VR | brief |
| Client | TypeScript + **Babylon.js** (rationale §2.1), Vite, Vitest | brief |
| Server | Python (FastAPI), asyncio WebSockets, SQLite→Postgres, pytest | brief |
| Multiplayer | 2–4 co-op, server-authoritative over WSS; solo + AI teammates | brief |
| Worlds | One free-roam **city hub** + **3 chapter worlds**, each a *mini-open-world* (bounded explorable zone, main path, side challenges, one mini-boss) | your earlier answer |
| Art | **Low-poly / flat-shaded**, bright colours | your earlier answer |
| Hero names | SNARE, TITAN, ELECTRO-MAN get **renamed** to original names (names still needed, §9) | your earlier answer |
| Monetization | None in v1 | brief |

The Unity-specific answers (Unity version, install steps) no longer apply.

**Your machine (checked):** Node 24, npm 11, Python 3.14.4, Git 2.53, Git LFS 3.7, GitHub CLI 2.102, Docker 28. No Python 3.12 (I'll install it via `uv`, a Python manager, so we match your brief); pnpm isn't installed (I'll use npm workspaces). This folder isn't a git repo yet, and I'll `git init` it only once the plan is approved.

## 1. IP-safety rules (applied from day one)

- **Internal IDs are neutral and permanent:** `hero.swinger`, `hero.bruiser`, `hero.flyer`, `hero.stormcaller`. Display names live in one data table, so a rename touches no code.
- **SNARE:** energy tethers or grapple ribbons instead of "webs" (the web-slinger is the Spider-Man core fantasy). No spider motifs, no red/blue suit.
- **TITAN:** no green skin, no torn-pants look, no "smash" catchphrase.
- **METALHEAD:** no glowing chest reactor, no red/gold colours.
- **ELECTRO-MAN:** a hammer + lightning + flight combo reads as Thor. I recommend a different weapon (gauntlets, conductor rod, oversized wrench). Your call, §9.
- **VASTOR / "Worldbreaker"** and **VANGUARD:** keep for now, run a trademark and similarity check before any public launch.
- **Assets:** every third-party asset's licence is logged in `docs/ASSET_LICENSES.md`. AI-generated assets: check the tool's commercial-use terms.

## 2. Architecture

### 2.1 Engine choice: Babylon.js (not Three.js)
Babylon bundles what this game needs: GLB loading with animation groups, a scene inspector for debugging, an in-engine particle system, instancing, a WebGPU/WebGL2 path, and touch/gamepad input helpers. Three.js is lighter but we'd assemble all of that ourselves. **I will not use engine physics for gameplay.** Swinging, collision and combat run in our own deterministic simulation (§2.2), because the server must reproduce it. Babylon is the renderer and asset pipeline.

### 2.2 Core principles
1. **Simulation is separate from rendering.** `client/src/sim` has zero Babylon or DOM imports: a fixed-timestep (30 Hz) world with entities, movement, swing solver, energy, health, abilities, damage and enemy AI. Rendering reads sim state and interpolates. This keeps the sim testable in plain Vitest and portable.
2. **Intent seam.** Humans, AI teammates and network clients all produce a `PlayerIntent` (move, look, jump, ability pressed/held, target) per tick. The sim consumes only intents.
3. **Static data / save data / runtime state are separate.**
   - *Design data:* JSON in `shared/data/`, validated by JSON Schema. Read-only at runtime.
   - *Save data:* versioned JSON with migrations (local storage first, server saves later).
   - *Networked runtime state:* sim snapshots only.
4. **One source of truth for types.** JSON Schemas in `shared/schemas/` generate both TypeScript types and Python Pydantic models. The server loads the same `shared/data/*.json` as the client, so it validates against the same numbers.
5. **Level collision is simple primitives** (boxes, cylinders, planes) in level JSON. Visual GLB meshes are separate. The same primitives can be loaded by Python.
6. **Upgrades widen, never inflate.** An executable validator test rejects any upgrade whose raw damage/health multiplier exceeds an allowed envelope.
7. **Designed destruction:** pre-authored breakable objects with 1–3 states and a fixed debris animation; only the state change is networked.
8. **HUD in HTML/CSS** overlaid on the canvas (accessible, easy for mobile layouts), not engine GUI.

### 2.3 Netcode model (Phase 3; the seams exist from Phase 1)
- Client sends input packets with sequence numbers at 30 Hz. Server simulates at 30 Hz and sends snapshots at ~15–20 Hz.
- Local player: client-side prediction + reconciliation. Other players and enemies: interpolation ~100 ms behind.
- Server owns positions, health, damage, energy, destruction and pickups. No lag compensation needed (co-op vs AI).
- Networked entity budget: ≤ ~40 (4 players + enemies + props).
- Protocol versioned, JSON first, binary (MessagePack) once stable.
- Rooms: create/join by short code first; matchmaking later.

### 2.4 ⚠️ The biggest structural risk: two simulations
Server-authoritative positions with a Python server means the movement/combat rules exist in **TypeScript (solo + prediction) and Python (server)**. Mitigations I'd use:
- keep the sim **small and data-driven**, with a few effect primitives implemented in both languages;
- **conformance tests:** scenario files in `shared/conformance/` (initial state + per-tick inputs + expected results) run by both Vitest and pytest, so the two ports can't drift;
- both languages use IEEE doubles, so reconciliation tolerates tiny differences; we need *near*-identical, not bit-identical.

The alternative is a Node/TS room server running the same sim code, with FastAPI keeping accounts/saves/lobby. That removes the duplication but changes your locked backend. **Phase 1 is identical either way** (a pure-TS sim), so this can be decided at Gate 2 with real measurements. See D1 in §9.

## 3. Repo structure (monorepo, this folder is the root)

```
client/        Vite + TS + Babylon
  src/{sim,render,input,net,ui,audio,game,data}/
  public/assets/ (.glb, textures, audio via Git LFS)
  tests/ (Vitest unit + conformance; Playwright smoke)
server/        FastAPI app
  app/{api,rooms,sim,models,db}/   tests/ (pytest)
shared/
  data/{heroes,abilities,enemies,upgrades,missions,challenges}/*.json
  schemas/*.schema.json   protocol/   conformance/   levels/
docs/          one short doc per system, TUNING.md, ASSET_LICENSES.md
.github/workflows/   ci.yml (lint+test), deploy.yml
.gitattributes (LFS)   .editorconfig   README.md
```

Tooling: npm workspaces; ESLint + Prettier; Vitest; Playwright (headless Chromium with software WebGL, so I can check that the scene renders and take screenshots myself); Python 3.12 via `uv`; ruff + pytest; Dockerfile for the server.

## 4. Systems in build order

| # | System | Phase |
|---|---|---|
| 1 | Monorepo, CI, deploy of an empty 3D scene | 1 |
| 2 | Babylon scene, fixed-step loop, input → `PlayerIntent`, follow camera | 1 |
| 3 | Kinematic capsule controller + primitive-collider world | 1 |
| 4 | **Tether-swing traversal** (anchor pick, rope constraint, reel, release boost, zip-pull) | 1 |
| 5 | Energy meter | 1 |
| 6 | Shield + core health | 1 |
| 7 | Data-driven ability system + damage pipeline (JSON + schemas) | 1 |
| 8 | Combat: melee combo + tether-snare | 1 |
| 9 | One enemy (melee thug, steering/AI, "power down" on defeat) | 1 |
| 10 | Respawn at base, HUD | 1 |
| 11 | Remaining 3 heroes (one per milestone) | 2 |
| 12 | AI teammates (same `PlayerIntent`) | 2 |
| 13 | Upgrades, base hub, scrap/XP, local save | 2 |
| 14 | Challenges, ping wheel, emotes, designed destruction, throwables, team-up combos | 2 |
| 15 | **Multiplayer:** server sim, WSS, prediction, rooms, accounts, cloud save | 3 |
| 16 | Campaign: city story, Vastor fight, 3 worlds, final battle | 4 |

## 5. Milestones and gates

- **Phase 1: Vertical slice (browser, PC, solo), deployed to a URL.** Gate 1: "Is swinging fun and is a fight readable?"
- **Phase 2: Full roster + sandbox loop.** Gate 2: "Do the 4 heroes feel distinct? Does the sim port look manageable (D1)?"
- **Phase 3: Online co-op.** Gate 3: 2–4 players on different networks fight and swing smoothly.
- **Phase 4: Content and polish.** Story, Vastor fight, 3 worlds, audio, accessibility, safety/legal review.

I recommend a **2-player netcode spike at the end of Phase 1** (two capsules, shared swing, one enemy through a thin Python server) to de-risk the biggest unknown early.

## 6. Phase 1 vertical slice (proposed)

**Goal:** prove the core is fun in a browser on PC, with placeholder art, before any content or art investment.

**In scope**
1. Monorepo, CI (lint + tests), client deployed to a public URL; server skeleton (`/health` + pytest) containerised.
2. Babylon scene, 3rd-person camera, keyboard/mouse + gamepad input.
3. **Swinger hero:** tether-swing, zip-pull, tether-snare on an enemy.
4. Energy meter gating swing/zip/snare, with regen and a readable HUD bar.
5. Shield + core health with regen delay.
6. Heroes, abilities and enemy defined in schema-validated JSON.
7. One enemy type: melee thug, chases, telegraphs, staggers, "powers down" (no gore).
8. Defeat → respawn at base after a short delay.
9. Greybox arena (rooftops, street, base pad) defined in level JSON, with primitive-built visuals. **No art needed.**
10. Vitest tests for the sim (swing solver, damage/shield, energy, upgrade validator) + a Playwright smoke test (page boots, canvas renders).

**Out of scope:** other heroes, upgrades/shop, multiplayer, destruction, story, real art, audio polish.

**"Done" =** swinging across the arena feels good with no tutorial text, 3–5 thugs are fun to fight, the HUD is understandable at a glance, and the URL works for you and 2–3 testers. `docs/TUNING.md` lists which JSON fields change swing feel.

**Slice milestones:** S0 skeleton + CI + deploy · S1 scene/camera/input/controller · S2 swing v1 (make-or-break, most iteration) · S3 energy/health/ability data pipeline · S4 enemy + combat · S5 respawn + HUD + arena · S6 polish + deploy + Gate 1 playtest.

## 7. What I need from you

**Phase 1 needs very little, because I can build, run and test everything myself.**
- Approve the plan and answer the §9 questions.
- Accounts for deploy (only when we reach S0 deploy): a GitHub account (for the repo, CI and Pages) and, later, a host for the Python server. I'll ask before creating or pushing anything.
- Playtest feedback at S2 and S6 (a link plus a few lines on how it feels).

**Assets (not needed for Phase 1; primitives first)**
- Low-poly rigged humanoid GLBs with idle/run/jump/punch/hit animations. Free CC0 options: Kenney, Quaternius; Mixamo for animation (check its terms); or AI-generated (check licences).
- A short sound list (~15 SFX) before polish.

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Two sims (TS + Python) drift | Desyncs, double work | Small data-driven sim, shared conformance scenarios, option to use Node room server (D1) |
| Swing feel is bad | Core fantasy fails | Tunable JSON, pure-math solver with tests, Gate 1, iterate with you |
| Prediction/reconciliation complexity | Jittery co-op | Early netcode spike, fixed step 30 Hz, interpolate rendering |
| Python server tick performance | Rubber-banding under load | Few networked entities, 30 Hz budget measured early, profiling in the spike |
| Browser perf on weak laptops | Low FPS | Low-poly, instancing, draw-call budget (<300), quality settings, measure on iGPU |
| Git LFS bandwidth/storage limits | Blocked pushes | Keep assets small (GLB < 5 MB each), monitor quota, consider alternate storage |
| Child safety / privacy law (COPPA, GDPR-K) | Launch block | Guest-only accounts, preset quick-chat, no free text, **legal review before online release** (yours) |
| IP resemblance | Takedown | §1 rules, trademark check, distinct silhouettes/colours |
| Scope creep (3 mini-open-worlds) | Never ships | Hard per-world budget: 1 mini-boss, 4–6 challenges, 1 upgrade |
| Browser audio/pointer-lock quirks, mobile Safari limits | Late surprises | Click-to-start gate, test on mobile early in Phase 2 |

## 9. Decisions and questions for you

**Hard to reverse (yours)**
- **D1. Authoritative sim implementation.** (a) Dual TS + Python with conformance tests (matches your brief); (b) Node/TS room server for the sim, FastAPI for accounts/saves/lobby (no duplication, changes your backend lock); (c) decide at Gate 2. **I recommend (c)**: Phase 1 is the same either way.
- **D2. Accounts in v1.** Guest-only (anonymous token, display name from a preset list) vs email accounts. Guest-only avoids collecting personal data from under-13s and simplifies COPPA.
- **D3. Hosting.** Client on static hosting (GitHub Pages or Cloudflare Pages, both free) and the server on a container host that supports WebSockets (e.g. Fly.io, Render; small monthly cost). Repo on GitHub, private.
- **D4. Netcode spike** at the end of Phase 1 (recommended).

**Names and design (not needed before Phase 1 code)**
- **N1. Hero names**, pick or supply:
  - wall-slinger: TETHER, ZIPLASH, DRIFT
  - powerhouse: BULWARK, RAMPART, BOULDER
  - storm-caller: TEMPEST, VOLTAGE, STORMWARD
- **N2. Storm-caller weapon:** swap the hammer, or keep it?
- **N3. "Mini-open-world" size:** is my reading in §0 right?

On approval I start S0: `git init`, workspace scaffold, CI, an empty Babylon scene, and the first deploy.

## 10. Decision log (updated 2026-10-17)

| Date | Decision | Notes |
|---|---|---|
| 2026-10-16 | Browser stack: TypeScript + Babylon.js client, Python/FastAPI server | locked in the v0.2 brief |
| 2026-10-16 | Guest-only accounts; GitHub repo + Pages; D1 deferred to Gate 2 | answered during planning |
| 2026-10-17 | **Gate 1 passed** (swinging scored 4+ in playtest) | docs/PLAYTEST.md |
| 2026-10-17 | Hero names: **ZIPLASH** (wall-slinger), **RAMPART** (powerhouse), **METALHEAD** (flyer), **VOLTAGE** (storm-caller) | internal ids stay `hero.swinger` etc. |
| 2026-10-17 | Storm-caller weapon: **conductor gauntlets** (not a hammer) | avoids the Thor read |
| 2026-10-17 | Netcode spike done before the other heroes (D4) | docs/netcode.md |
| 2026-10-17 | Phase 2 order: hero framework + RAMPART first | |
| **open** | **D1: authoritative sim.** Spike says the Python port + conformance tests works (see docs/netcode.md); recommendation: keep it. | needs your confirmation |
