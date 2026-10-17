const LOOK_SENSITIVITY = 0.0025; // radians per pixel
const PAD_LOOK_SPEED = 2.8; // radians per second at full stick
const DEADZONE = 0.15;
const MIN_PITCH = -0.85; // looking well up, to aim tethers at rooftops
const MAX_PITCH = 1.3;

export interface MoveInput {
  moveX: number;
  moveZ: number;
  jumpPressed: boolean;
  swingHeld: boolean;
  reelHeld: boolean;
  zipPressed: boolean;
  attackPressed: boolean;
  snarePressed: boolean;
  chargePressed: boolean;
  grabPressed: boolean;
  jumpHeld: boolean;
  descendHeld: boolean;
  fireHeld: boolean;
  rocketPressed: boolean;
}

function deadzone(v: number): number {
  return Math.abs(v) < DEADZONE ? 0 : v;
}

/**
 * Keyboard + mouse + gamepad -> movement input and camera look angles.
 * Edge events (jump) are latched until the next sim tick samples them, so a press between
 * ticks is never lost even though the sim runs slower than the display.
 */
export class InputController {
  yaw = 0;
  pitch = 0.4;

  private readonly keys = new Set<string>();
  private jumpLatch = false;
  private zipLatch = false;
  private attackLatch = false;
  private snareLatch = false;
  private chargeLatch = false;
  private grabLatch = false;
  private rocketLatch = false;
  private lmbHeld = false;
  private padChargeHeld = false;
  private padSnareHeld = false;
  private padAttackHeld = false;
  private swingLatch = false;
  private rmbHeld = false;
  private padZipHeld = false;
  private padJumpHeld = false;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') {
        this.jumpLatch = true;
        e.preventDefault();
      }
      if (e.code === 'KeyE') {
        this.swingLatch = true;
        this.grabLatch = true;
      }
      if (e.code === 'KeyG') this.grabLatch = true;
      if (e.code === 'KeyR') this.rocketLatch = true;
      if (e.code === 'KeyF') this.zipLatch = true;
      if (e.code === 'KeyJ') this.attackLatch = true;
      if (e.code === 'KeyQ') this.snareLatch = true;
      if (e.code === 'KeyC' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.chargeLatch = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    // Click focuses the canvas and tries to capture the mouse. Some embedded browsers refuse
    // pointer lock, so dragging with the mouse button held always works as a fallback.
    canvas.addEventListener('click', () => {
      canvas.focus();
      if (document.pointerLockElement !== canvas) {
        try {
          const req = canvas.requestPointerLock() as Promise<void> | undefined;
          req?.catch?.(() => {});
        } catch {
          // ignored: drag-to-look still works
        }
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2) {
        this.rmbHeld = true;
        this.swingLatch = true;
        this.grabLatch = true;
        this.rocketLatch = true; // right-mouse: swing / lift / rockets, depending on the hero
        return;
      }
      if (document.pointerLockElement === canvas) {
        this.attackLatch = true;
        this.lmbHeld = true; // left-mouse: strike, and hold to fire the laser
      }
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture?.(e.pointerId);
    });
    const endDrag = (e: PointerEvent) => {
      if (e.button === 2) this.rmbHeld = false;
      else {
        this.dragging = false;
        this.lmbHeld = false;
      }
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('pointermove', (e) => {
      if (document.pointerLockElement === canvas) {
        this.look(e.movementX * LOOK_SENSITIVITY, e.movementY * LOOK_SENSITIVITY);
      } else if (this.dragging) {
        this.look((e.clientX - this.lastX) * LOOK_SENSITIVITY, (e.clientY - this.lastY) * LOOK_SENSITIVITY);
      }
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
  }

  private look(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch + dPitch));
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p?.connected) return p;
    return null;
  }

  /** Call once per rendered frame: applies right-stick camera look. */
  pollLook(dtSeconds: number): void {
    const pad = this.pad();
    if (!pad) return;
    const rx = deadzone(pad.axes[2] ?? 0);
    const ry = deadzone(pad.axes[3] ?? 0);
    this.look(rx * PAD_LOOK_SPEED * dtSeconds, ry * PAD_LOOK_SPEED * dtSeconds);
    const jumpDown = pad.buttons[0]?.pressed ?? false;
    if (jumpDown && !this.padJumpHeld) this.jumpLatch = true;
    this.padJumpHeld = jumpDown;
    const zipDown = pad.buttons[3]?.pressed ?? false;
    if (zipDown && !this.padZipHeld) {
      this.zipLatch = true;
      this.rocketLatch = true; // Y: zip for ZIPLASH, rockets for METALHEAD
    }
    this.padZipHeld = zipDown;
    const attackDown = pad.buttons[2]?.pressed ?? false;
    if (attackDown && !this.padAttackHeld) this.attackLatch = true;
    this.padAttackHeld = attackDown;
    const snareDown = pad.buttons[1]?.pressed ?? false;
    if (snareDown && !this.padSnareHeld) this.snareLatch = true;
    if (snareDown && !this.padSnareHeld) this.grabLatch = true; // B: snare for ZIPLASH, lift/throw for RAMPART
    this.padSnareHeld = snareDown;
    const chargeDown = (pad.buttons[4]?.pressed || pad.buttons[6]?.pressed) ?? false;
    if (chargeDown && !this.padChargeHeld) this.chargeLatch = true;
    this.padChargeHeld = chargeDown;
  }

  /** Call once per sim tick. Consumes the jump latch. */
  sample(): MoveInput {
    let x = 0;
    let z = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    const pad = this.pad();
    if (pad) {
      x += deadzone(pad.axes[0] ?? 0);
      z -= deadzone(pad.axes[1] ?? 0);
    }
    const padSwing = (pad?.buttons[7]?.pressed || pad?.buttons[5]?.pressed) ?? false;
    const padReel = (pad?.buttons[6]?.pressed || pad?.buttons[4]?.pressed) ?? false;
    // A quick tap between sim ticks still counts as held for one tick.
    const swingHeld = this.keys.has('KeyE') || this.rmbHeld || padSwing || this.swingLatch;
    const reelHeld = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || padReel;
    const jumpHeld = this.keys.has('Space') || (pad?.buttons[0]?.pressed ?? false);
    const descendHeld = reelHeld || this.keys.has('KeyC') || this.keys.has('ControlLeft');
    // Hold fire: K, left-mouse (while the mouse is captured), or the gamepad's right trigger.
    const fireHeld = this.keys.has('KeyK') || this.lmbHeld || (pad?.buttons[7]?.pressed ?? false);
    const jumpPressed = this.jumpLatch;
    const zipPressed = this.zipLatch;
    const attackPressed = this.attackLatch;
    const snarePressed = this.snareLatch;
    const chargePressed = this.chargeLatch;
    this.chargeLatch = false;
    const grabPressed = this.grabLatch;
    this.grabLatch = false;
    const rocketPressed = this.rocketLatch;
    this.rocketLatch = false;
    this.snareLatch = false;
    this.attackLatch = false;
    this.jumpLatch = false;
    this.zipLatch = false;
    this.swingLatch = false;
    return {
      moveX: Math.max(-1, Math.min(1, x)),
      moveZ: Math.max(-1, Math.min(1, z)),
      jumpPressed,
      swingHeld,
      reelHeld,
      zipPressed,
      attackPressed,
      snarePressed,
      chargePressed,
      grabPressed,
      jumpHeld,
      descendHeld,
      fireHeld,
      rocketPressed,
    };
  }
}
