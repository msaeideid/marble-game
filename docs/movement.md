# Movement and collision (S1)

**Sim conventions** (same as Babylon): +Y up, +Z forward at yaw 0, +X right; metres and seconds.
The sim runs at a fixed 30 Hz (`client/src/sim/fixedStep.ts`); rendering interpolates between ticks.

**Intent seam:** every character is driven by a `PlayerIntent` (`moveX`, `moveZ`, `yaw`, `jumpPressed`).
Keyboard/mouse/gamepad (`client/src/input/inputController.ts`) produce it today; AI teammates and network
clients will produce it later. The sim never reads input devices.

**Collision:** the player is an upright box (`halfWidth`, `height`) moved axis by axis against axis-aligned
collider boxes, in substeps of at most 0.4 m so fast movers cannot tunnel. No slopes or step-up yet.
Level collision lives in `shared/levels/*.json`; visuals are generated from the same boxes for now.

**Tuning:** `shared/data/heroes/swinger.json` -> `movement`. Change numbers, reload, no code changes.
- `runSpeed`, `groundAccel`, `airAccel`: how snappy running feels.
- `gravity`, `jumpSpeed`: jump height is `jumpSpeed^2 / (2 * gravity)`.
- `coyoteTime`, `jumpBufferTime`: forgiveness windows for late/early jump presses.

**Controls:** WASD/arrows move, Space jump, click the canvas to capture the mouse (or drag) to look;
gamepad left stick move, right stick look, A jump.

**Debugging:** `window.__vanguard` exposes the `Game`; `game.frame(dt)` advances one display frame, which
lets scripts drive the game even when the tab is hidden.
