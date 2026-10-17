import arena from '@shared/levels/arena.json';
import { Sfx } from '../audio/sfx';
import { content, getHero } from '../data';
import { InputController } from '../input/inputController';
import { OnlineClient, onlineOptionsFromUrl } from '../net/online';
import { Effects } from '../render/effects';
import { EnemyView } from '../render/enemyView';
import { FollowCamera } from '../render/followCamera';
import { buildBaseView, buildLevelView } from '../render/levelView';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { PlayerView } from '../render/playerView';
import { createGameView, type GameView } from '../render/scene';
import { aimDir } from '../sim/aim';
import { createPlayerState, handPos } from '../sim/controller';
import type { AiState } from '../sim/enemy';
import { FixedStepper, SIM_DT } from '../sim/fixedStep';
import { Sim, type SimEvent } from '../sim/sim';
import { pickSwingAnchor } from '../sim/swing';
import type { PlayerIntent } from '../sim/types';
import { applyWire } from '../sim/wire';
import { World } from '../sim/world';
import { Hud } from '../ui/hud';
import { WorldLabels } from '../ui/worldLabels';

const LOCAL_ID = 'local';
const HITSTOP_LIGHT = 0.05;
const HITSTOP_HEAVY = 0.09;

/** Wires sim + input + rendering + feedback together for the single-player prototype. */
export class Game {
  readonly view: GameView;
  readonly sim: Sim;
  readonly input: InputController;
  readonly sfx = new Sfx();
  /** Set when the page URL has ?server=...; null for solo play. */
  readonly online: OnlineClient | null;
  paused = true;

  private readonly stepper = new FixedStepper(SIM_DT);
  private readonly playerView: PlayerView;
  private readonly enemyViews = new Map<string, EnemyView>();
  private readonly enemyAi = new Map<string, AiState>();
  private readonly remoteViews = new Map<string, PlayerView>();
  private readonly cam: FollowCamera;
  private readonly effects: Effects;
  private readonly labels: WorldLabels;
  private readonly hud = new Hud();
  private readonly hero = getHero('hero.swinger');
  private readonly overlay = document.getElementById('overlay') as HTMLElement;
  private frameCount = 0;
  private clock = 0;
  private hitStop = 0;
  private bannerTimer = 0;
  private bannerText: string | null = null;
  private hadTether = false;
  private hadZip = false;
  private wasLocked = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const world = new World(arena);
    const onlineOpts = onlineOptionsFromUrl(window.location.search);
    // Online play is movement-only for now: no enemies or waves, just players swinging around together.
    this.sim = new Sim(world, this.hero, content.enemies, { waves: !onlineOpts });
    this.sim.addPlayer(LOCAL_ID);
    this.online = onlineOpts ? new OnlineClient(this.sim, LOCAL_ID, onlineOpts) : null;

    this.view = createGameView(canvas);
    buildLevelView(this.view.scene, world);
    buildBaseView(this.view.scene, world);
    const m = this.hero.movement;
    this.playerView = new PlayerView(this.view.scene, m.height, m.halfWidth, this.hero.swing.handHeight);
    this.cam = new FollowCamera(this.view.scene);
    this.effects = new Effects(this.view.scene);
    this.labels = new WorldLabels(document.getElementById('labels') as HTMLElement, this.view.scene, this.view.engine, canvas);
    this.input = new InputController(canvas);
    this.bindUi();
    this.setPaused(true);
  }

  private bindUi(): void {
    this.overlay.addEventListener('click', () => {
      this.setPaused(false);
      this.canvas.focus();
      try {
        const req = this.canvas.requestPointerLock() as Promise<void> | undefined;
        req?.catch?.(() => {});
      } catch {
        // pointer lock is optional; dragging still works
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'KeyP' || e.code === 'Escape') this.setPaused(!this.paused);
      if (e.code === 'KeyM') this.sfx.toggleMute();
      this.sfx.unlock();
    });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.canvas;
      if (this.wasLocked && !locked && !this.paused) this.setPaused(true);
      this.wasLocked = locked;
    });
    window.addEventListener('blur', () => this.setPaused(true));
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.overlay.classList.toggle('hidden', !paused);
    if (!paused) this.sfx.unlock();
  }

  start(): void {
    this.view.engine.runRenderLoop(() => this.frame(this.view.engine.getDeltaTime() / 1000));
  }

  /** One display frame: sample input, advance the sim in fixed steps, render. Public so tests can drive it. */
  frame(dt: number): void {
    const { engine, scene } = this.view;
    this.clock += dt;
    const waitingForServer = this.online !== null && !this.online.ready;
    const simDt = this.paused || this.hitStop > 0 || waitingForServer ? 0 : dt;
    this.hitStop = Math.max(0, this.hitStop - dt);
    if (!this.paused) this.input.pollLook(dt);

    const events: SimEvent[] = [];
    const alpha = this.stepper.advance(simDt, (stepDt) => {
      const m = this.input.sample();
      const intent: PlayerIntent = { ...m, yaw: this.input.yaw, pitch: this.input.pitch };
      if (this.online) {
        intent.attackPressed = false; // combat is not networked yet
        intent.snarePressed = false;
      }
      this.sim.step(stepDt, new Map([[LOCAL_ID, intent]]));
      this.online?.onLocalStep(intent);
      events.push(...this.sim.events);
    });

    const me = this.sim.players.get(LOCAL_ID)!;
    this.handleEvents(events);
    this.trackMovementSounds();
    this.syncEnemies(alpha, dt);
    const aimAnchor = this.previewAnchor();
    this.playerView.update(me, alpha, me.tether || me.zip ? null : aimAnchor, this.clock, this.online?.session.renderOffset);
    const p = me.prevPos;
    this.online?.session.update(dt);
    const off = this.online?.session.renderOffset ?? { x: 0, y: 0, z: 0 };
    const focus = {
      x: p.x + (me.pos.x - p.x) * alpha + off.x,
      y: p.y + (me.pos.y - p.y) * alpha + off.y,
      z: p.z + (me.pos.z - p.z) * alpha + off.z,
    };
    this.syncRemotePlayers();
    this.cam.update(focus, this.input.yaw, this.input.pitch, this.sim.world, dt);
    this.effects.update(dt);
    scene.render();
    this.labels.update(dt);

    this.updateHud(me, dt, aimAnchor !== null);
    if (++this.frameCount % 15 === 0) {
      const speed = Math.hypot(me.vel.x, me.vel.y, me.vel.z).toFixed(1);
      const mode = me.zip ? 'zipping' : me.tether ? 'swinging' : me.grounded ? 'grounded' : 'airborne';
      const net = this.online ? ` · ${this.online.describe()}` : '';
      this.hud.setStatus(`${engine.getFps().toFixed(0)} fps · speed ${speed} m/s · ${mode}${net}`);
    }
  }

  /** Other players: interpolated snapshots drawn with the same hero model in a different colour. */
  private syncRemotePlayers(): void {
    if (!this.online) return;
    const samples = this.online.remotePlayers();
    const m = this.hero.movement;
    for (const [id, sample] of Object.entries(samples)) {
      let view = this.remoteViews.get(id);
      if (!view) {
        const hue = this.remoteViews.size % 3;
        const colors = [new Color3(1, 0.55, 0.25), new Color3(0.75, 0.45, 1), new Color3(1, 0.85, 0.3)];
        view = new PlayerView(this.view.scene, m.height, m.halfWidth, this.hero.swing.handHeight, colors[hue]);
        this.remoteViews.set(id, view);
      }
      const ghost = createPlayerState(this.sim.world.spawn, this.hero);
      applyWire(ghost, sample.state);
      ghost.invulnerable = 0;
      view.update(ghost, 1, null, this.clock);
    }
    for (const [id, view] of this.remoteViews) {
      if (!(id in samples)) {
        view.dispose();
        this.remoteViews.delete(id);
      }
    }
  }

  private updateHud(me: ReturnType<Sim['players']['get']> & object, dt: number, aimValid: boolean): void {
    this.hud.setEnergy(me.energy, this.hero.energy.max);
    this.hud.setHealth(me.health.shield, this.hero.health.shield.max, me.health.core, this.hero.health.core.max);
    this.hud.setAimValid(aimValid);
    this.hud.setSnareReady(me.snareCooldown <= 0 && me.energy >= this.hero.snare.cost);
    this.hud.tick(dt);
    this.bannerTimer = Math.max(0, this.bannerTimer - dt);
    const net = this.online;
    this.hud.setBanner(
      net && net.status !== 'online'
        ? net.status === 'connecting'
          ? 'Connecting to server…'
          : net.status === 'full'
            ? 'Server is full'
            : 'Disconnected from server'
        : me.defeatedTimer !== null
        ? `Down! Back at base in ${Math.ceil(me.defeatedTimer)}…`
        : this.bannerTimer > 0
          ? this.bannerText
          : null,
    );
    const alive = [...this.sim.enemies.values()].filter((e) => e.defeatedTimer === null).length;
    this.hud.setWave(`Wave ${this.sim.currentWave} · ${alive} thug${alive === 1 ? '' : 's'} left`);
  }

  private handleEvents(events: readonly SimEvent[]): void {
    const me = this.sim.players.get(LOCAL_ID)!;
    for (const ev of events) {
      switch (ev.type) {
        case 'melee': {
          if (ev.attacker !== LOCAL_ID) break;
          this.effects.slash(me.pos, ev.yaw, ev.step, this.hero.melee.range);
          this.sfx.swing(ev.step);
          if (ev.hits.length > 0) {
            const heavy = ev.step >= this.hero.melee.steps.length - 1;
            this.hitStop = heavy ? HITSTOP_HEAVY : HITSTOP_LIGHT;
            this.cam.shake(heavy ? 0.14 : 0.06);
            this.sfx.hit(ev.step);
          }
          break;
        }
        case 'damage': {
          const enemy = this.sim.enemies.get(ev.target);
          if (enemy) {
            const def = content.enemies[enemy.typeId]!;
            this.enemyViews.get(ev.target)?.hit();
            this.labels.damageNumber(
              { x: enemy.pos.x, y: enemy.pos.y + def.move.height + 0.2, z: enemy.pos.z },
              String(Math.round(ev.amount)),
              ev.amount >= 15,
            );
          } else if (ev.target === LOCAL_ID) {
            this.hud.hurtFlash();
            this.cam.shake(0.16);
            this.sfx.hurt();
          }
          break;
        }
        case 'defeated':
          if (ev.id === LOCAL_ID) this.sfx.down();
          else this.sfx.powerDown();
          break;
        case 'snare':
          if (ev.source === LOCAL_ID) this.sfx.snare();
          break;
        case 'respawn':
          if (ev.id === LOCAL_ID) this.sfx.respawn();
          break;
        case 'wave':
          this.bannerText = `Wave ${ev.wave}`;
          this.bannerTimer = 2;
          this.sfx.wave();
          break;
        default:
          break;
      }
    }
  }

  private trackMovementSounds(): void {
    const me = this.sim.players.get(LOCAL_ID)!;
    if (me.tether && !this.hadTether) this.sfx.attach();
    if (me.zip && !this.hadZip) this.sfx.zip();
    this.hadTether = me.tether !== null;
    this.hadZip = me.zip !== null;
  }

  private syncEnemies(alpha: number, dt: number): void {
    const { scene } = this.view;
    const me = this.sim.players.get(LOCAL_ID)!;
    for (const e of this.sim.enemies.values()) {
      if (!this.enemyViews.has(e.id)) {
        this.enemyViews.set(e.id, new EnemyView(scene, e.id, content.enemies[e.typeId]!));
      }
    }
    for (const [id, v] of this.enemyViews) {
      const e = this.sim.enemies.get(id);
      if (!e) {
        v.dispose();
        this.enemyViews.delete(id);
        this.enemyAi.delete(id);
        this.labels.removeBar(id);
        continue;
      }
      v.update(e, alpha, dt);

      const def = content.enemies[e.typeId]!;
      const prev = this.enemyAi.get(id);
      if (e.aiState === 'windup' && prev !== 'windup') {
        const d = Math.hypot(e.pos.x - me.pos.x, e.pos.z - me.pos.z);
        this.sfx.windup(Math.max(0, 1 - d / 25));
      }
      this.enemyAi.set(id, e.aiState);

      const max = def.health.core.max + def.health.shield.max;
      const frac = (e.health.core + e.health.shield) / max;
      if (e.defeatedTimer !== null || (frac >= 1 && e.snaredTimer <= 0)) {
        this.labels.hideBar(id);
      } else {
        this.labels.setBar(id, { x: e.pos.x, y: e.pos.y + def.move.height + 0.5, z: e.pos.z }, frac, e.snaredTimer > 0);
      }
    }
  }

  /** Where a swing would attach right now, for the aim marker and crosshair colour. */
  private previewAnchor() {
    const me = this.sim.players.get(LOCAL_ID)!;
    return pickSwingAnchor(
      this.sim.world,
      handPos(me, this.hero),
      aimDir(this.input.yaw, this.input.pitch),
      this.hero.swing.maxRange,
    );
  }
}
