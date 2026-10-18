/**
 * Procedural sound effects (WebAudio synth), so the prototype has audio feedback with no asset files.
 * Browsers only allow audio after a user gesture, so call `unlock()` from a click or key press.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  muted = false;

  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  private tone(f0: number, f1: number, dur: number, type: OscillatorType, gain: number, delay = 0): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, gain: number, freq: number, q = 1, delay = 0): void {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  swing(step: number): void {
    this.noise(0.12, 0.25, 1400 + step * 500, 0.8);
  }
  hit(step: number): void {
    this.tone(180 - step * 20, 60, 0.12, 'square', 0.22);
    this.noise(0.08, 0.3, 900, 1);
    if (step >= 2) this.tone(90, 40, 0.25, 'sawtooth', 0.25);
  }
  hurt(): void {
    this.tone(220, 70, 0.22, 'sawtooth', 0.3);
    this.noise(0.15, 0.25, 500, 0.7);
  }
  windup(volume = 1): void {
    this.tone(300, 520, 0.2, 'triangle', 0.08 * volume);
  }
  snare(): void {
    this.tone(900, 300, 0.18, 'sine', 0.2);
    this.tone(450, 900, 0.12, 'triangle', 0.12, 0.08);
  }
  attach(): void {
    this.tone(500, 1400, 0.08, 'triangle', 0.15);
    this.noise(0.05, 0.12, 3000, 2);
  }
  zip(): void {
    this.tone(300, 1800, 0.25, 'sawtooth', 0.1);
  }
  powerDown(): void {
    this.tone(500, 60, 0.45, 'triangle', 0.2);
  }
  down(): void {
    this.tone(400, 50, 0.7, 'sawtooth', 0.25);
  }
  respawn(): void {
    this.tone(260, 520, 0.12, 'sine', 0.2);
    this.tone(390, 780, 0.12, 'sine', 0.2, 0.1);
    this.tone(520, 1040, 0.2, 'sine', 0.2, 0.2);
  }
  /** A wall giving way: a low crunch plus a burst of noise. */
  smash(): void {
    this.noise(0.35, 0.5, 300, 0.6);
    this.tone(120, 35, 0.4, 'sawtooth', 0.3);
    this.noise(0.2, 0.3, 1800, 1, 0.05);
  }
  charge(): void {
    this.tone(140, 420, 0.3, 'sawtooth', 0.18);
    this.noise(0.3, 0.2, 700, 0.8);
  }
  /** One laser bolt: a quick bright zap. */
  laser(): void {
    this.tone(1500, 500, 0.09, 'square', 0.07);
  }
  rocket(): void {
    this.noise(0.4, 0.3, 1200, 0.7);
    this.tone(220, 520, 0.35, 'sawtooth', 0.12);
  }
  explosion(volume = 1): void {
    this.noise(0.5, 0.55 * volume, 220, 0.5);
    this.tone(110, 30, 0.5, 'sawtooth', 0.35 * volume);
    this.noise(0.25, 0.3 * volume, 1500, 1, 0.04);
  }
  /** Lightning crack. */
  zap(volume = 1): void {
    this.noise(0.18, 0.45 * volume, 3500, 1.2);
    this.tone(900, 120, 0.2, 'sawtooth', 0.16 * volume);
  }
  /** The charging hum of a storm strike's warning. */
  strikeCharge(): void {
    this.tone(120, 700, 0.9, 'triangle', 0.1);
  }
  /** Jets lighting: a rising whoosh. */
  jets(): void {
    this.noise(0.45, 0.25, 900, 0.5);
    this.tone(120, 320, 0.4, 'triangle', 0.1);
  }
  wave(): void {
    this.tone(330, 330, 0.15, 'square', 0.12);
    this.tone(440, 440, 0.15, 'square', 0.12, 0.17);
    this.tone(660, 660, 0.3, 'square', 0.12, 0.34);
  }
}
