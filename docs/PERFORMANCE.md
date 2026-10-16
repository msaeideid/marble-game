# Performance

Budget (PLAN.md section 8): 60 fps on a mid-range laptop integrated GPU, fewer than 300 draw calls.

## Measured (Edge, headless, software WebGL - the worst case for GPU cost)
Source: the `performance budget` end-to-end test (`client/e2e/smoke.spec.ts`), which prints the numbers each run.

| Metric | Value | Budget |
|---|---|---|
| Draw calls per frame | 14 | < 300 |
| Meshes in scene / active this frame | 49 / 25 | active < 300 |
| CPU time per frame (sim + render submit) | ~3.4 ms | 16.6 ms for 60 fps |
| Production bundle (main chunk) | ~1.0 MB (about 243 KB gzipped) | - |

Why it is cheap: the whole level is instanced boxes sharing a few materials; effects are a handful of short-lived
meshes; HUD, health bars and damage numbers are HTML, not 3D; there are no textures or shadows yet.

## What will cost more later (watch these)
- Real character/enemy models and skinned animation (budget: GLB < 5 MB each, shared materials, instancing).
- Shadows and post-processing (keep behind a quality setting).
- Server-synced entity count: the plan caps networked entities around 40.
- Mobile: touch controls and a lower resolution scale are not built yet.

## Re-measuring
`PW_CHANNEL=msedge npm run test:e2e` locally (Edge or Chrome), or `npm run test:e2e` in CI. For real frame
rates, open the game and read the fps in the bottom-left status line.
