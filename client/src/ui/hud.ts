/** Minimal HTML HUD for the prototype: crosshair, energy bar, status line. */
export class Hud {
  private readonly crosshair = document.getElementById('crosshair') as HTMLElement;
  private readonly energyFill = document.getElementById('energy-fill') as HTMLElement;
  private readonly status = document.getElementById('build') as HTMLElement;

  setEnergy(current: number, max: number): void {
    this.energyFill.style.width = `${Math.max(0, Math.min(1, current / max)) * 100}%`;
    this.energyFill.classList.toggle('low', current / max < 0.2);
  }

  setAimValid(valid: boolean): void {
    this.crosshair.classList.toggle('valid', valid);
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }
}
