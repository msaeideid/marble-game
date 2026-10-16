const LOOK_SENSITIVITY = 0.0025; // radians per pixel
const PAD_LOOK_SPEED = 2.8; // radians per second at full stick
const DEADZONE = 0.15;
const MIN_PITCH = -0.15;
const MAX_PITCH = 1.3;

export interface MoveInput {
  moveX: number;
  moveZ: number;
  jumpPressed: boolean;
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
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture?.(e.pointerId);
    });
    const endDrag = () => (this.dragging = false);
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
    const jumpPressed = this.jumpLatch;
    this.jumpLatch = false;
    return { moveX: Math.max(-1, Math.min(1, x)), moveZ: Math.max(-1, Math.min(1, z)), jumpPressed };
  }
}
