/** Minimal HTML HUD for the prototype: crosshair, energy bar, status line. */
export class Hud {
  private readonly crosshair = document.getElementById('crosshair') as HTMLElement;
  private readonly energyFill = document.getElementById('energy-fill') as HTMLElement;
  private readonly shieldFill = document.getElementById('shield-fill') as HTMLElement;
  private readonly coreFill = document.getElementById('core-fill') as HTMLElement;
  private readonly banner = document.getElementById('banner') as HTMLElement;
  private readonly snareChip = document.getElementById('snare-chip') as HTMLElement;
  private readonly hurt = document.getElementById('hurt') as HTMLElement;
  private hurtTimer = 0;
  private readonly waveText = document.getElementById('wave') as HTMLElement;
  private readonly status = document.getElementById('build') as HTMLElement;

  setEnergy(current: number, max: number): void {
    this.energyFill.style.width = `${Math.max(0, Math.min(1, current / max)) * 100}%`;
    this.energyFill.classList.toggle('low', current / max < 0.2);
  }

  setHealth(shield: number, shieldMax: number, core: number, coreMax: number): void {
    this.shieldFill.style.width = `${Math.max(0, Math.min(1, shield / shieldMax)) * 100}%`;
    this.coreFill.style.width = `${Math.max(0, Math.min(1, core / coreMax)) * 100}%`;
    this.coreFill.classList.toggle('low', core / coreMax < 0.3);
  }

  /** Shows a centred message, or hides it when null. */
  setBanner(text: string | null): void {
    this.banner.style.display = text ? 'block' : 'none';
    if (text) this.banner.textContent = text;
  }

  setSnareReady(ready: boolean): void {
    this.snareChip.classList.toggle('cooling', !ready);
  }

  /** Flash the screen edges red. Call `tick` each frame so it fades out. */
  hurtFlash(): void {
    this.hurt.classList.add('on');
    this.hurtTimer = 0.08;
  }

  tick(dt: number): void {
    if (this.hurtTimer > 0) {
      this.hurtTimer -= dt;
      if (this.hurtTimer <= 0) this.hurt.classList.remove('on');
    }
  }

  setWave(text: string): void {
    if (this.waveText.textContent !== text) this.waveText.textContent = text;
  }

  setAimValid(valid: boolean): void {
    this.crosshair.classList.toggle('valid', valid);
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }
}
