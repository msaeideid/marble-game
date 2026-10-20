import { Sfx } from '../audio/sfx';
import { content, getHero } from '../data';
import { InputController } from '../input/inputController';
import { OnlineClient, onlineOptionsFromUrl } from '../net/online';
import { PropViews } from '../render/propView';
import { RocketViews } from '../render/rocketView';
import type { PropWire } from '../sim/props';
import { Effects } from '../render/effects';
import { EnemyView } from '../render/enemyView';
import { FollowCamera } from '../render/followCamera';
import { buildBaseView, buildLevelView, type LevelView } from '../render/levelView';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { PlayerView } from '../render/playerView';
import { createGameView, type GameView } from '../render/scene';
import { aimDir } from '../sim/aim';
import { BuddyBrain } from '../sim/buddy';
import { CampaignSession } from '../campaign/session';
import { has, loadSave, ownedFor, writeSave, type SaveData } from '../campaign/progress';
import { MissionHud } from '../ui/missionHud';
import { buildMenu } from '../ui/menu';
import { applyUpgrades } from '../sim/upgrades';
import type { MissionEvent } from '../campaign/missions';
import { createPlayerState, handPos } from '../sim/controller';
import type { AiState } from '../sim/enemy';
import { FixedStepper, SIM_DT } from '../sim/fixedStep';
import type { HeroParams } from '../sim/params';
import { Sim, type SimEvent } from '../sim/sim';
import { pickSwingAnchor } from '../sim/swing';
import { pickLockTarget, strikePoint } from '../sim/weapons';
import type { PlayerIntent } from '../sim/types';
import { applyWire } from '../sim/wire';
import { World } from '../sim/world';
import { Hud } from '../ui/hud';
import { WorldLabels } from '../ui/worldLabels';

const LOCAL_ID = 'local';
const BUDDY_ID = 'buddy';
const DEFAULT_HERO = 'hero.swinger';
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
  private readonly hero: HeroParams;
  /** The AI teammate (solo only), chosen with ?buddy=<hero id>. */
  private readonly buddy: { brain: BuddyBrain; hero: HeroParams; view: PlayerView } | null = null;
  private readonly levelView: LevelView;
  private readonly propViews: PropViews;
  private readonly rocketViews: RocketViews;
  private readonly overlay = document.getElementById('overlay') as HTMLElement;
  private frameCount = 0;
  private clock = 0;
  private hitStop = 0;
  private bannerTimer = 0;
  private bannerText: string | null = null;
  private hadTether = false;
  private hadZip = false;
  private hadCharge = false;
  private hadFlying = false;
  private readonly shownBreaks = new Set<number>();
  private wasLocked = false;

  /** The campaign layer (missions, scrap, XP, the save); null in plain sandbox play and online. */
  readonly session: CampaignSession | null;
  private save: SaveData;
  private readonly params: URLSearchParams;
  private readonly missionHud = new MissionHud();

  constructor(private readonly canvas: HTMLCanvasElement) {
    const params = new URLSearchParams(window.location.search);
    this.params = params;
    const heroId = params.get('hero') ?? DEFAULT_HERO;
    const baseHero = getHero(heroId in content.heroes ? heroId : DEFAULT_HERO);
    const onlineOpts = onlineOptionsFromUrl(window.location.search);
    this.save = loadSave();
    const mission = !onlineOpts && params.get('mission') ? (content.missions[params.get('mission')!] ?? null) : null;
    const campaign = !onlineOpts && (mission !== null || params.has('campaign'));
    // In the campaign your hero wears the upgrades you bought; the plain sandbox always uses the base kit.
    this.hero = campaign ? applyUpgrades(baseHero, ownedFor(this.save, baseHero.id, content.upgrades)) : baseHero;
    const levelId = mission ? mission.level : campaign && has(this.save, 'vastorEscaped') ? 'arena_damaged' : 'arena';
    const levelData = content.levels[levelId] ?? content.levels['arena']!;
    const world = new World(levelData);
    // Online play is server-authoritative: enemies, waves, props and every ability run on the server. The local sim
    // only predicts the local player's movement, and the client draws what the server streams.
    this.sim = new Sim(world, this.hero, content.enemies, {
      waves: !onlineOpts && !mission,
      props: !onlineOpts,
      combat: !onlineOpts,
      propDefs: content.props,
    });
    this.sim.addPlayer(LOCAL_ID);
    this.session = campaign
      ? new CampaignSession({
          sim: this.sim,
          content,
          hud: this.missionHud,
          localId: LOCAL_ID,
          mission,
          save: this.save,
          params,
          onEnd: () => this.setPaused(true),
        })
      : null;
    window.addEventListener('pagehide', () => this.session?.flush());
    this.online = onlineOpts ? new OnlineClient(this.sim, LOCAL_ID, onlineOpts) : null;

    this.view = createGameView(canvas, levelData.theme?.sky);
    this.levelView = buildLevelView(this.view.scene, world, levelData.theme);
    buildBaseView(this.view.scene, world);
    const m = this.hero.movement;
    this.playerView = new PlayerView(this.view.scene, m.height, m.halfWidth, m.handHeight, undefined, this.hero.id);
    const buddyId = new URLSearchParams(window.location.search).get('buddy');
    if (buddyId && buddyId in content.heroes && !onlineOpts) {
      const bh = getHero(buddyId);
      const state = this.sim.addPlayer(BUDDY_ID, bh);
      state.pos.x += 2;
      state.prevPos.x += 2;
      this.buddy = {
        brain: new BuddyBrain(BUDDY_ID, LOCAL_ID),
        hero: bh,
        view: new PlayerView(this.view.scene, bh.movement.height, bh.movement.halfWidth, bh.movement.handHeight, new Color3(1, 0.55, 0.25), bh.id),
      };
    }
    this.cam = new FollowCamera(this.view.scene);
    this.effects = new Effects(this.view.scene);
    this.propViews = new PropViews(this.view.scene, content.props);
    this.rocketViews = new RocketViews(this.view.scene, this.effects);
    this.labels = new WorldLabels(document.getElementById('labels') as HTMLElement, this.view.scene, this.view.engine, canvas);
    this.input = new InputController(canvas);
    this.bindUi();
    this.setPaused(true);
  }

  private bindUi(): void {
    // Hero selection: each button reloads the page with ?hero=..., keeping any other URL parameters.
    const select = document.getElementById('hero-select');
    if (select) {
      for (const h of Object.values(content.heroes)) {
        const q = new URLSearchParams(window.location.search);
        q.set('hero', h.id);
        const a = document.createElement('a');
        a.href = `?${q.toString()}`;
        a.textContent = h.displayName;
        a.classList.toggle('selected', h.id === this.hero.id);
        a.addEventListener('click', (e) => e.stopPropagation()); // do not also start the game
        select.appendChild(a);
      }
    }
    this.bindMenu();
    const buddySelect = document.getElementById('buddy-select');
    if (buddySelect && !this.online) {
      const current = new URLSearchParams(window.location.search).get('buddy');
      const options: [string, string][] = [['', 'None'], ...Object.values(content.heroes).map((h): [string, string] => [h.id, h.displayName])];
      for (const [id, label] of options) {
        const q = new URLSearchParams(window.location.search);
        if (id) q.set('buddy', id);
        else q.delete('buddy');
        const a = document.createElement('a');
        a.href = `?${q.toString()}`;
        a.textContent = label;
        a.classList.toggle('selected', (current ?? '') === id);
        a.addEventListener('click', (e) => e.stopPropagation());
        buddySelect.appendChild(a);
      }
    } else if (buddySelect) {
      document.getElementById('buddy-label')?.remove();
    }
    const kits = new Set<string>(['melee']);
    if (this.hero.swing) kits.add('swing');
    if (this.hero.zip) kits.add('zip');
    if (this.hero.snare) kits.add('snare');
    if (this.hero.charge) kits.add('charge');
    if (this.hero.lift) kits.add('lift');
    if (this.hero.flight) kits.add('flight');
    if (this.hero.laser) kits.add('laser');
    if (this.hero.rockets) kits.add('rockets');
    if (this.hero.chain) kits.add('chain');
    if (this.hero.tempest) kits.add('tempest');
    document.querySelectorAll<HTMLElement>('#overlay tr[data-kit]').forEach((row) => {
      row.style.display = kits.has(row.dataset.kit ?? '') ? '' : 'none';
    });

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

  /** The start screen's Campaign and Upgrade Bay tabs, or the mission briefing when a mission is loaded. */
  private bindMenu(): void {
    const mission = this.session?.runner?.mission;
    if (this.session) {
      // Playing the campaign: show the briefing instead of the tabs.
      for (const id of ['menu-tabs', 'tab-campaign', 'tab-bay']) document.getElementById(id)?.style.setProperty('display', 'none');
      const brief = document.getElementById('brief')!;
      brief.style.display = 'block';
      const h = document.createElement('h2');
      h.textContent = mission ? mission.title : 'Free roam in Brightport';
      const p = document.createElement('p');
      p.textContent = mission ? mission.summary : 'Fight waves of thugs for scrap and XP. Spend them in the Upgrade Bay.';
      const back = document.createElement('a');
      back.className = 'back';
      back.textContent = '\u2190 Back to the menu';
      const q = new URLSearchParams();
      for (const k of ['hero', 'buddy']) if (this.params.get(k)) q.set(k, this.params.get(k)!);
      q.set('tab', 'campaign');
      back.href = `?${q.toString()}`;
      back.addEventListener('click', (e) => e.stopPropagation());
      brief.replaceChildren(h, p, back);
      return;
    }
    if (this.online) {
      for (const id of ['menu-tabs', 'tab-campaign', 'tab-bay']) document.getElementById(id)?.style.setProperty('display', 'none');
      return;
    }
    buildMenu({
      content,
      save: this.save,
      onSave: (s) => {
        this.save = s;
        writeSave(s);
      },
      params: this.params,
      tab: this.params.get('tab') ?? 'play',
    });
  }

  setPaused(paused: boolean): void {
    if (this.session?.over) paused = true; // a finished mission stays finished
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
    const missionEvents: MissionEvent[] = [];
    const alpha = this.stepper.advance(simDt, (stepDt) => {
      const m = this.input.sample();
      const intent: PlayerIntent = { ...m, yaw: this.input.yaw, pitch: this.input.pitch };
      intent.chargePressed = m.chargePressed;
      intent.grabPressed = m.grabPressed;
      const intents = new Map<string, PlayerIntent>([[LOCAL_ID, intent]]);
      if (this.buddy) intents.set(BUDDY_ID, this.buddy.brain.think(this.sim));
      this.sim.step(stepDt, intents);
      this.online?.onLocalStep(intent);
      events.push(...this.sim.events);
      if (this.session) missionEvents.push(...this.session.onStep(this.sim.events, stepDt));
    });

    const me = this.sim.players.get(LOCAL_ID)!;
    if (this.online) {
      // Enemies, rockets and what happened come from the server.
      this.online.mirrorEnemies(content.enemies);
      events.push(...this.online.takeEvents());
    }
    this.handleEvents(events);
    this.handleMissionEvents(missionEvents);
    this.session?.frame(dt);
    this.trackMovementSounds();
    this.syncEnemies(alpha, dt);
    const aimAnchor = this.previewAnchor();
    this.playerView.update(me, alpha, me.tether || me.zip ? null : aimAnchor, this.clock, this.online?.session.renderOffset);
    if (this.buddy) this.buddy.view.update(this.sim.players.get(BUDDY_ID)!, alpha, null, this.clock);
    const p = me.prevPos;
    this.online?.session.update(dt);
    const off = this.online?.session.renderOffset ?? { x: 0, y: 0, z: 0 };
    const focus = {
      x: p.x + (me.pos.x - p.x) * alpha + off.x,
      y: p.y + (me.pos.y - p.y) * alpha + off.y,
      z: p.z + (me.pos.z - p.z) * alpha + off.z,
    };
    this.syncRemotePlayers();
    this.syncProps(dt, focus);
    this.rocketViews.update(this.online ? this.online.rocketStates() : (this.sim.rocketSystem?.rockets ?? []), alpha, dt);
    this.levelView.sync(this.sim.world);
    this.cam.update(focus, this.input.yaw, this.input.pitch, this.sim.world, dt);
    const target = this.session?.runner?.objective;
    this.effects.setBeacon(target?.kind === 'reach' && !this.session?.over ? this.session!.runner!.marker() : null, target?.kind === 'reach' ? target.radius : 4);
    this.effects.update(dt);
    scene.render();
    this.labels.update(dt);

    this.updateHud(me, dt, aimAnchor !== null);
    if (++this.frameCount % 15 === 0) {
      const speed = Math.hypot(me.vel.x, me.vel.y, me.vel.z).toFixed(1);
      const mode = me.zip ? 'zipping' : me.tether ? 'swinging' : me.flying ? 'flying' : me.grounded ? 'grounded' : 'airborne';
      const net = this.online ? ` · ${this.online.describe()}` : '';
      this.hud.setStatus(`${engine.getFps().toFixed(0)} fps · speed ${speed} m/s · ${mode}${net}`);
    }
  }

  /** Draw props from their synced state; derive sounds and debris from mode changes (so remote throws are heard too). */
  private syncProps(dt: number, localFocus: { x: number; y: number; z: number }): void {
    const wires: readonly PropWire[] = this.online ? this.online.propWires() : this.sim.propWires;
    if (wires.length === 0) return;
    const remote = this.online?.remotePlayers() ?? {};
    const me = this.sim.players.get(LOCAL_ID)!;
    const myHeight = this.hero.movement.height;
    const transitions = this.propViews.update(wires, dt, (holder) => {
      // Held props ride on the carrier's *drawn* head, so they never lag behind the smoothed character.
      if (holder === (this.online?.serverId ?? LOCAL_ID)) {
        return { x: localFocus.x, y: localFocus.y + myHeight + 0.05, z: localFocus.z };
      }
      const r = remote[holder];
      if (!r) return null;
      const h = getHero(r.hero in content.heroes ? r.hero : DEFAULT_HERO).movement.height;
      return { x: r.state.pos[0], y: r.state.pos[1] + h + 0.05, z: r.state.pos[2] };
    });
    for (const t of transitions) {
      const size = t.def.size;
      const at = { x: t.wire.pos[0], y: t.wire.pos[1], z: t.wire.pos[2] };
      const color = new Color3(t.def.color[0]!, t.def.color[1]!, t.def.color[2]!);
      if (t.cur === 'held') this.sfx.attach();
      else if (t.cur === 'thrown') this.sfx.charge();
      else if (t.prev === 'thrown' && t.cur === 'resting') {
        this.sfx.hit(1);
        if (Math.hypot(at.x - me.pos.x, at.z - me.pos.z) < 25) this.cam.shake(0.08);
      } else if (t.cur === 'destroyed') {
        this.effects.debris(
          { x: at.x - size.halfWidth, y: at.y, z: at.z - size.halfWidth },
          { x: at.x + size.halfWidth, y: at.y + size.height, z: at.z + size.halfWidth },
          color,
        );
        this.sfx.smash();
        this.cam.shake(0.12);
      }
    }
  }

  /** Other players: interpolated snapshots drawn with the same hero model in a different colour. */
  private syncRemotePlayers(): void {
    if (!this.online) return;
    const samples = this.online.remotePlayers();
    for (const [id, sample] of Object.entries(samples)) {
      let view = this.remoteViews.get(id);
      const theirs = getHero(sample.hero in content.heroes ? sample.hero : DEFAULT_HERO);
      const m = theirs.movement;
      if (!view) {
        const hue = this.remoteViews.size % 3;
        const colors = [new Color3(1, 0.55, 0.25), new Color3(0.75, 0.45, 1), new Color3(1, 0.85, 0.3)];
        view = new PlayerView(this.view.scene, m.height, m.halfWidth, m.handHeight, colors[hue], theirs.id);
        this.remoteViews.set(id, view);
      }
      const ghost = createPlayerState(this.sim.world.spawn, theirs);
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
    this.hud.setSnare(!!this.hero.snare, me.snareCooldown <= 0 && me.energy >= (this.hero.snare?.cost ?? 0));
    const carried = me.carrying ? content.props[me.carrying.def] : undefined;
    this.hud.setCarrying(carried ? carried.displayName : null);
    this.hud.setCharge(
      !!this.hero.charge,
      !me.charge && me.chargeCooldown <= 0 && me.energy >= (this.hero.charge?.cost ?? 0),
    );
    this.hud.setFlyer(
      { flight: !!this.hero.flight, laser: !!this.hero.laser, rockets: !!this.hero.rockets },
      me.flying,
      me.rocketCooldown <= 0 && me.energy >= (this.hero.rockets?.cost ?? 0),
    );
    this.hud.setStorm(
      { chain: !!this.hero.chain, tempest: !!this.hero.tempest },
      me.chainCooldown <= 0 && me.energy >= (this.hero.chain?.cost ?? 0),
      me.stormCooldown <= 0 && me.energy >= (this.hero.tempest?.cost ?? 0),
    );
    this.labels.setLock(this.paused ? null : this.rocketLock(me));
    const storm = this.hero.tempest;
    this.effects.setStormAim(
      storm && !this.paused && me.defeatedTimer === null
        ? strikePoint(this.sim.world, handPos(me, this.hero), aimDir(this.input.yaw, this.input.pitch), storm)
        : null,
      storm?.radius ?? 1,
      me.stormCooldown <= 0 && me.energy >= (storm?.cost ?? 0),
    );
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
    const wave = this.online ? this.online.wave : this.sim.currentWave;
    this.hud.setWave(this.session?.runner ? '' : `Wave ${wave} · ${alive} thug${alive === 1 ? '' : 's'} left`);
  }

  private handleMissionEvents(events: readonly MissionEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'objectiveDone') this.sfx.respawn();
      if (ev.type === 'bossEscape') {
        this.cam.shake(0.45);
        this.sfx.explosion(1.4);
        this.bannerText = 'He escapes!';
        this.bannerTimer = 3;
      }
      if (ev.type === 'missionComplete' && !ev.escaped) this.sfx.combo();
    }
  }

  /** The hero a player id belongs to: ours or the buddy's from the sim, another online player's from the snapshot. */
  private heroFor(id: string): HeroParams {
    if (this.sim.players.has(id)) return this.sim.heroOf(id);
    const remote = this.online?.remotePlayers()[id];
    return remote && remote.hero in content.heroes ? getHero(remote.hero) : this.hero;
  }

  private handleEvents(events: readonly SimEvent[]): void {
    const me = this.sim.players.get(LOCAL_ID)!;
    for (const ev of events) {
      switch (ev.type) {
        case 'melee': {
          const at = ev.pos ?? this.sim.players.get(ev.attacker)?.pos;
          if (!at) break;
          const melee = this.heroFor(ev.attacker).melee;
          this.effects.slash(at, ev.yaw, ev.step, melee.range);
          this.sfx.swing(ev.step);
          if (ev.hits.length > 0) {
            const heavy = ev.step >= melee.steps.length - 1;
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
            if (ev.amount >= 6) this.labels.damageNumber(
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
        case 'break': {
          if (this.shownBreaks.has(ev.id)) break; // we may have predicted it ourselves and then heard it from the server too
          this.shownBreaks.add(ev.id);
          const c = this.sim.world.colliders[ev.id];
          if (c) this.effects.debris(c.min, c.max, c.breakable === 2 ? new Color3(0.45, 0.47, 0.55) : new Color3(0.85, 0.45, 0.3));
          this.cam.shake(0.22);
          this.sfx.smash();
          break;
        }
        case 'charge':
          this.cam.shake(0.14);
          this.hitStop = HITSTOP_HEAVY;
          this.sfx.hit(2);
          break;
        case 'laser':
          this.effects.laser(ev.from, ev.to);
          if (ev.hit) this.effects.spark(ev.to);
          this.sfx.laser();
          break;
        case 'rocketLaunch':
          this.sfx.rocket();
          break;
        case 'explosion': {
          this.effects.explosion(ev.pos, ev.radius);
          const d = Math.hypot(ev.pos.x - me.pos.x, ev.pos.z - me.pos.z);
          this.sfx.explosion(Math.max(0.2, 1 - d / 40));
          this.cam.shake(Math.max(0.05, 0.22 - d * 0.01));
          if (ev.hits.length > 0) this.hitStop = HITSTOP_LIGHT;
          break;
        }
        case 'detonate': {
          // A car bomb: a big white-hot fireball, a heavy shake, and a banner when two heroes did it together.
          this.effects.explosion(ev.pos, ev.radius, new Color3(1, 0.85, 0.5));
          this.effects.explosion(ev.pos, ev.radius * 0.6, new Color3(1, 0.45, 0.15));
          const d = Math.hypot(ev.pos.x - me.pos.x, ev.pos.z - me.pos.z);
          this.sfx.explosion(Math.max(0.4, 1.3 - d / 40));
          this.cam.shake(Math.max(0.1, 0.4 - d * 0.015));
          this.hitStop = HITSTOP_HEAVY;
          if (ev.combo) {
            this.bannerText = 'TEAM-UP COMBO!';
            this.bannerTimer = 2;
            this.sfx.combo();
          }
          break;
        }
        case 'bossTelegraph':
          // A red warning on the ground: get out of the ring (or out of the way) before it fills.
          if (ev.radius > 0) this.effects.strikeWarning(ev.pos, ev.radius, ev.delay, new Color3(1, 0.3, 0.3));
          this.sfx.strikeCharge();
          break;
        case 'bossStrike':
          if (ev.kind === 'summon') {
            this.sfx.wave();
            break;
          }
          this.effects.explosion(ev.pos, Math.max(1.5, ev.radius * 0.6), new Color3(1, 0.4, 0.3));
          this.cam.shake(ev.kind === 'slam' ? 0.35 : 0.2);
          this.sfx.explosion(1.2);
          if (ev.hits.includes(LOCAL_ID)) this.hitStop = HITSTOP_HEAVY;
          break;
        case 'bossPhase': {
          const boss = this.sim.enemies.get(ev.id);
          const name = boss ? (content.enemies[boss.typeId]?.displayName ?? 'The boss') : 'The boss';
          this.bannerText = `${name} is getting serious!`;
          this.bannerTimer = 2.5;
          this.sfx.wave();
          break;
        }
        case 'chain':
          this.effects.lightning(ev.points);
          this.sfx.zap();
          this.cam.shake(0.06);
          break;
        case 'strikeStart':
          this.effects.strikeWarning(ev.pos, ev.radius, ev.delay);
          this.sfx.strikeCharge();
          break;
        case 'strikeHit': {
          this.effects.strikeBolt(ev.pos, ev.radius);
          const d = Math.hypot(ev.pos.x - me.pos.x, ev.pos.z - me.pos.z);
          this.sfx.zap(Math.max(0.3, 1 - d / 40));
          this.cam.shake(Math.max(0.05, 0.25 - d * 0.01));
          if (ev.hits.length > 0) this.hitStop = HITSTOP_LIGHT;
          break;
        }
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
    if (me.charge && !this.hadCharge) this.sfx.charge();
    if (me.flying && !this.hadFlying) this.sfx.jets();
    this.hadFlying = me.flying;
    this.hadCharge = me.charge !== null;
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

  /** The point to draw the rocket lock ring at: the enemy a rocket fired right now would chase, or null. */
  private rocketLock(me: ReturnType<Sim['players']['get']> & object): { x: number; y: number; z: number } | null {
    const p = this.hero.rockets ?? (this.hero.chain && { lockRange: this.hero.chain.range, lockAngleDegrees: this.hero.chain.lockAngleDegrees });
    if (!p || me.defeatedTimer !== null) return null;
    const t = pickLockTarget(
      this.sim.world,
      handPos(me, this.hero),
      aimDir(this.input.yaw, this.input.pitch),
      p,
      this.sim.liveTargets(),
    );
    return t ? { x: t.pos.x, y: t.pos.y + t.height / 2, z: t.pos.z } : null;
  }

  /** Where a swing would attach right now, for the aim marker and crosshair colour. */
  private previewAnchor() {
    const swing = this.hero.swing;
    if (!swing) return null;
    const me = this.sim.players.get(LOCAL_ID)!;
    return pickSwingAnchor(
      this.sim.world,
      handPos(me, this.hero),
      aimDir(this.input.yaw, this.input.pitch),
      swing.maxRange,
    );
  }
}
