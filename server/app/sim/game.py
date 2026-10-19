"""The authoritative game simulation: players, enemies, waves, combat, props.

A line-for-line port of client/src/sim/sim.ts (`Sim`). The conformance scenarios in shared/conformance/ replay the same
inputs through both and require the same results.

The TypeScript `Sim.step` does everything for one tick. Here it is split in two so the server can run each player's
input as it arrives (`step_player`) and then the rest of the world once per server tick (`step_world`); `step` does
both, in the TypeScript order, for tests and conformance.
"""

from __future__ import annotations

import dataclasses
import math
from types import SimpleNamespace
from typing import Any

from .ai import AiTarget, step_enemy_ai
from .combat import Candidate, melee_targets, pick_snare_target, step_melee
from .controller import Intent, PlayerState, create_player_state, hand_pos, step_player
from .enemy import EnemyState, create_enemy, enemy_wire, step_enemy_physics
from .energy import try_spend
from .health import apply_damage, regen_health
from .props import PropHooks, PropSystem, carry_scales
from .swing import aim_dir
from .vec import Vec3, vec
from .weapons import (
    RocketHooks,
    RocketSystem,
    StrikeHooks,
    StrikeSystem,
    Target,
    pick_lock_target,
    strike_point,
    trace_chain,
    trace_laser,
)
from .world import World


class GameSim:
    def __init__(
        self,
        world: World,
        prop_defs: dict[str, SimpleNamespace],
        default_hero: SimpleNamespace,
        enemy_defs: dict[str, SimpleNamespace] | None = None,
        waves: bool = False,
    ) -> None:
        self.world = world
        self.prop_defs = prop_defs
        self.default_hero = default_hero
        self.enemy_defs = enemy_defs or {}
        self.waves = waves
        self.players: dict[str, PlayerState] = {}
        self.heroes: dict[str, SimpleNamespace] = {}
        self.enemies: dict[str, EnemyState] = {}
        self.props: PropSystem | None = PropSystem(world, prop_defs) if world.prop_spawns else None
        self.rocket_system: RocketSystem | None = None
        self.strike_system: StrikeSystem | None = None
        self.events: list[dict[str, Any]] = []
        self.tick = 0
        self.wave = 0
        self._wave_timer = 0.0
        self._next_enemy_id = 1

    # ---- membership ----
    def reset_world(self) -> None:
        """Put the world back as the level defines it: walls rebuilt, props home, no enemies, wave 0."""
        self.world.set_broken([])
        self.props = PropSystem(self.world, self.prop_defs) if self.world.prop_spawns else None
        self.enemies = {}
        self.rocket_system = None
        self.strike_system = None
        self.wave = 0
        self._wave_timer = 0.0
        self._next_enemy_id = 1
        for hero in self.heroes.values():
            self._ensure_systems(hero)

    def _ensure_systems(self, hero: SimpleNamespace) -> None:
        """Rockets and storm strikes exist as soon as any hero in the world can use them."""
        if getattr(hero, "rockets", None) is not None and self.rocket_system is None:
            self.rocket_system = RocketSystem(self.world, hero.rockets)
        if getattr(hero, "tempest", None) is not None and self.strike_system is None:
            self.strike_system = StrikeSystem(hero.tempest)

    def add_player(self, pid: str, hero: SimpleNamespace | None = None) -> PlayerState:
        chosen = hero or self.default_hero
        state = create_player_state(self.world.spawn, chosen)
        self.players[pid] = state
        self.heroes[pid] = chosen
        self._ensure_systems(chosen)
        return state

    def remove_player(self, pid: str) -> None:
        state = self.players.pop(pid, None)
        self.heroes.pop(pid, None)
        if state is not None and self.props is not None:
            self.props.drop_held_by(pid, state.pos)

    def spawn_enemy(self, type_id: str, pos: Vec3) -> EnemyState:
        d = self.enemy_defs.get(type_id)
        if d is None:
            raise KeyError(f"Unknown enemy type {type_id}")
        eid = f"enemy-{self._next_enemy_id}"
        self._next_enemy_id += 1
        e = create_enemy(eid, d, pos)
        self.enemies[eid] = e
        return e

    def live_targets(self) -> list[Target]:
        """Enemies a weapon can hit right now."""
        out: list[Target] = []
        for e in self.enemies.values():
            if e.defeated_timer is not None:
                continue
            m = self.enemy_defs[e.type_id].move
            out.append(Target(e.id, e.pos, float(m.halfWidth), float(m.height)))
        return out

    def volatile_targets(self) -> list[Target]:
        return self.props.volatile_targets() if self.props is not None else []

    # ---- one player's tick (the player loop body of the TypeScript Sim.step) ----
    def step_player(self, pid: str, intent: Intent, dt: float) -> None:
        state = self.players[pid]
        hero = self.heroes[pid]
        if state.defeated_timer is not None:
            state.defeated_timer -= dt
            if state.defeated_timer <= 0:
                self._respawn(pid)
            return
        carry = carry_scales(self.prop_defs.get(state.carrying[1])) if state.carrying is not None else None
        for c in step_player(state, intent, hero, self.world, dt, carry):
            self.events.append({"type": "break", "id": c.id, "by": pid})
        self._step_charge(pid, state, hero)
        if self.props is not None and intent.grabPressed:
            self.events.extend(self.props.handle_grab(pid, state, hero, intent.yaw, intent.pitch))
        # Hands are full: no striking while carrying.
        self._step_melee(pid, state, hero, intent.attackPressed and state.carrying is None, intent.yaw, dt)
        self._step_snare(pid, state, hero, intent, dt)
        self._step_laser(pid, state, hero, intent, dt)
        self._step_rockets(pid, state, hero, intent, dt)
        self._step_chain(pid, state, hero, intent, dt)
        self._step_storm(pid, state, hero, intent, dt)
        regen_health(state.health, hero.health, dt)
        state.invulnerable = max(0.0, state.invulnerable - dt)
        self._apply_base_regen(state, hero, dt)
        if state.pos.y < self.world.kill_y:
            self._respawn(pid)

    # ---- everything that is not a player (once per server tick) ----
    def step_world(self, dt: float) -> None:
        targets = [AiTarget(pid, p.pos) for pid, p in self.players.items() if p.defeated_timer is None]
        crowd = list(self.enemies.values())
        for eid, enemy in list(self.enemies.items()):
            d = self.enemy_defs[enemy.type_id]
            if enemy.defeated_timer is not None:
                enemy.defeated_timer -= dt
                if enemy.defeated_timer <= 0:
                    del self.enemies[eid]
                continue
            step_enemy_ai(enemy, d, targets, crowd, dt, lambda tid, e=enemy, dd=d: self._enemy_hits_player(e, dd, tid))
            step_enemy_physics(enemy, d, self.world, dt)
            regen_health(enemy.health, d.health, dt)
        self._step_waves(dt)
        self._step_props(dt)
        self._step_rockets_in_flight(dt)
        self._step_strikes(dt)
        self.tick += 1

    def begin_tick(self) -> None:
        """Forget last tick's events. The server calls this before processing a tick's inputs."""
        self.events = []

    def step(self, intents: dict[str, Intent], dt: float) -> None:
        """A whole tick for every player, then the world (what the TypeScript Sim.step does)."""
        self.begin_tick()
        for pid in list(self.players):
            self.step_player(pid, intents.get(pid, Intent()), dt)
        self.step_world(dt)

    # ---- player abilities ----
    def _step_charge(self, pid: str, player: PlayerState, hero: SimpleNamespace) -> None:
        """A charging hero bowls over each enemy it runs into, once per charge."""
        charge = getattr(hero, "charge", None)
        if charge is None or player.charge is None:
            return
        struck: list[str] = []
        for e in self.enemies.values():
            if e.defeated_timer is not None or e.id in player.charge_hits:
                continue
            half = self.enemy_defs[e.type_id].move.halfWidth
            dx = e.pos.x - player.pos.x
            dz = e.pos.z - player.pos.z
            ahead = dx * player.charge.dir_x + dz * player.charge.dir_z > -0.5  # not behind the rusher
            if not ahead or math.hypot(dx, dz) > charge.hitRadius + half or abs(e.pos.y - player.pos.y) > 2:
                continue
            player.charge_hits.append(e.id)
            struck.append(e.id)
            e.vel.x += player.charge.dir_x * charge.knockback
            e.vel.z += player.charge.dir_z * charge.knockback
            self._damage_enemy(e, float(charge.damage), pid)
            e.ai_state = "stagger"  # a charge always knocks the enemy off balance, poise or not
            e.ai_timer = float(self.enemy_defs[e.type_id].staggerTime)
        if struck:
            self.events.append({"type": "charge", "id": pid, "hits": struck})

    def _step_melee(self, pid: str, player: PlayerState, hero: SimpleNamespace, pressed: bool, yaw: float, dt: float) -> None:
        melee = hero.melee
        hit_step = step_melee(player.melee, pressed, melee, dt, lambda cost: try_spend(player, cost, hero.energy))
        if hit_step is None:
            return
        step = melee.steps[hit_step]
        live = [
            Candidate(e, e.pos, float(self.enemy_defs[e.type_id].move.halfWidth))
            for e in self.enemies.values()
            if e.defeated_timer is None
        ]
        struck = melee_targets(player.pos, yaw, melee, live)
        for c in struck:
            e = c.obj
            dx = e.pos.x - player.pos.x
            dz = e.pos.z - player.pos.z
            d = math.hypot(dx, dz) or 1.0
            e.vel.x += (dx / d) * step.knockback
            e.vel.z += (dz / d) * step.knockback
            self._damage_enemy(e, float(step.damage), pid)
        self.events.append(
            {
                "type": "melee",
                "attacker": pid,
                "step": hit_step,
                "yaw": yaw,
                "pos": vec(player.pos),
                "hits": [c.obj.id for c in struck],
            }
        )

    def _step_snare(self, pid: str, player: PlayerState, hero: SimpleNamespace, intent: Intent, dt: float) -> None:
        player.snare_cooldown = max(0.0, player.snare_cooldown - dt)
        p = getattr(hero, "snare", None)
        if p is None or not intent.snarePressed or player.snare_cooldown > 0:
            return
        candidates = []
        for e in self.enemies.values():
            if e.defeated_timer is not None:
                continue
            m = self.enemy_defs[e.type_id].move
            candidates.append(Candidate(e, e.pos, float(m.halfWidth), float(m.height)))
        origin = hand_pos(player, hero)
        hit = pick_snare_target(self.world, origin, aim_dir(intent.yaw, intent.pitch), p, candidates)
        if hit is None or not try_spend(player, p.cost, hero.energy):
            return
        e = hit.obj
        player.snare_cooldown = float(p.cooldown)
        e.snared_timer = float(p.duration)
        if e.ai_state == "windup":
            e.ai_state = "chase"
        self.events.append({"type": "snare", "source": pid, "target": e.id})

    def _step_laser(self, pid: str, player: PlayerState, hero: SimpleNamespace, intent: Intent, dt: float) -> None:
        """Holding fire shoots a bolt every `fireInterval`, each costing a little energy from the shared pool."""
        player.laser_cooldown = max(0.0, player.laser_cooldown - dt)
        p = getattr(hero, "laser", None)
        if p is None or not intent.fireHeld or player.laser_cooldown > 0 or player.carrying is not None:
            return
        if not try_spend(player, p.shotCost, hero.energy):
            return
        player.laser_cooldown = float(p.fireInterval)
        origin = hand_pos(player, hero)
        end, hit = trace_laser(
            self.world, origin, aim_dir(intent.yaw, intent.pitch), p, [*self.live_targets(), *self.volatile_targets()]
        )
        if hit is not None and hit.id.startswith("prop:"):
            # A bolt through a thrown car or dumpster sets it off: the team-up combo.
            self._detonate_prop(int(hit.id[5:]), pid)
        elif hit is not None:
            e = self.enemies.get(hit.id)
            # A steady beam wears enemies down without stunning them, so they keep coming.
            if e is not None:
                self._damage_enemy(e, float(p.damage), pid, stagger=False)
        self.events.append(
            {"type": "laser", "owner": pid, "from": vec(origin), "to": vec(end), "hit": hit.id if hit is not None else None}
        )

    def _step_rockets(self, pid: str, player: PlayerState, hero: SimpleNamespace, intent: Intent, dt: float) -> None:
        player.rocket_cooldown = max(0.0, player.rocket_cooldown - dt)
        p = getattr(hero, "rockets", None)
        if (
            p is None
            or self.rocket_system is None
            or not intent.rocketPressed
            or player.rocket_cooldown > 0
            or player.carrying is not None
        ):
            return
        if not try_spend(player, p.cost, hero.energy):
            return
        player.rocket_cooldown = float(p.cooldown)
        hand = hand_pos(player, hero)
        d = aim_dir(intent.yaw, intent.pitch)
        lock = pick_lock_target(self.world, hand, d, p.lockRange, p.lockAngleDegrees, self.live_targets())
        muzzle = Vec3(hand.x + d.x * 0.8, hand.y + d.y * 0.8, hand.z + d.z * 0.8)
        self.events.append(self.rocket_system.launch(pid, muzzle, d, lock.id if lock is not None else None))

    def _step_chain(self, pid: str, player: PlayerState, hero: SimpleNamespace, intent: Intent, dt: float) -> None:
        """Chain lightning: shock the enemy under the crosshair and the ones near it. No target, no cost."""
        player.chain_cooldown = max(0.0, player.chain_cooldown - dt)
        p = getattr(hero, "chain", None)
        if p is None or not intent.chainPressed or player.chain_cooldown > 0 or player.carrying is not None:
            return
        hand = hand_pos(player, hero)
        hits = trace_chain(self.world, hand, aim_dir(intent.yaw, intent.pitch), p, self.live_targets())
        if not hits or not try_spend(player, p.cost, hero.energy):
            return
        player.chain_cooldown = float(p.cooldown)
        points: list[dict[str, float]] = [vec(hand)]
        for i, t in enumerate(hits):
            points.append({"x": t.pos.x, "y": t.pos.y + t.height / 2, "z": t.pos.z})
            e = self.enemies.get(t.id)
            if e is None:
                continue
            self._damage_enemy(e, p.damage * p.damageFalloff**i, pid, stagger=False)
            self._stun(e, float(p.stunTime))
        self.events.append({"type": "chain", "owner": pid, "points": points, "hits": [t.id for t in hits]})

    def _step_storm(self, pid: str, player: PlayerState, hero: SimpleNamespace, intent: Intent, dt: float) -> None:
        """Storm strike: call lightning down on the spot you aim at (the sky does nothing)."""
        player.storm_cooldown = max(0.0, player.storm_cooldown - dt)
        p = getattr(hero, "tempest", None)
        if (
            p is None
            or self.strike_system is None
            or not intent.stormPressed
            or player.storm_cooldown > 0
            or player.carrying is not None
        ):
            return
        at = strike_point(self.world, hand_pos(player, hero), aim_dir(intent.yaw, intent.pitch), p)
        if at is None or not try_spend(player, p.cost, hero.energy):
            return
        player.storm_cooldown = float(p.cooldown)
        self.events.append(self.strike_system.call(pid, at))

    def _apply_base_regen(self, player: PlayerState, hero: SimpleNamespace, dt: float) -> None:
        """Standing on the base pad refills shield and energy fast and core health slowly, but only out of combat."""
        base = self.world.base
        if base is None or not self.world.is_on_base(player.pos):
            return
        if player.health.shield_delay <= 0:
            player.health.shield = min(float(hero.health.shield.max), player.health.shield + base.regenPerSecond * dt)
            player.health.core = min(float(hero.health.core.max), player.health.core + base.regenPerSecond * 0.25 * dt)
        player.energy = min(float(hero.energy.max), player.energy + base.regenPerSecond * 2 * dt)

    # ---- the rest of the world ----
    def _step_props(self, dt: float) -> None:
        if self.props is None:
            return

        def holder_top(pid: str) -> Vec3 | None:
            p = self.players.get(pid)
            if p is None or p.defeated_timer is not None:
                return None
            return Vec3(p.pos.x, p.pos.y + self.heroes[pid].movement.height + 0.05, p.pos.z)

        def hit_enemy(eid: str, damage: float, dir_x: float, dir_z: float, knockback: float) -> None:
            e = self.enemies.get(eid)
            if e is None:
                return
            e.vel.x += dir_x * knockback
            e.vel.z += dir_z * knockback
            self._damage_enemy(e, damage, "prop")
            if e.defeated_timer is None:
                e.ai_state = "stagger"  # a car to the face always knocks them off balance
                e.ai_timer = float(self.enemy_defs[e.type_id].staggerTime)

        self.events.extend(self.props.step(dt, PropHooks(holder_top, self.live_targets, hit_enemy)))

    def _step_rockets_in_flight(self, dt: float) -> None:
        if self.rocket_system is None:
            return

        def blast(eid: str, amount: float, dir_x: float, dir_z: float, knockback: float) -> None:
            e = self.enemies.get(eid)
            if e is None:
                return
            e.vel.x += dir_x * knockback
            e.vel.z += dir_z * knockback
            self._damage_enemy(e, amount, "rocket")
            if e.defeated_timer is None:
                e.ai_state = "stagger"  # a rocket always knocks them off balance
                e.ai_timer = float(self.enemy_defs[e.type_id].staggerTime)

        hooks = RocketHooks(
            targets=self.live_targets,
            props=self.volatile_targets,
            detonate=lambda prop_id, owner: self._detonate_prop(int(prop_id[5:]), owner),
            blast=blast,
        )
        self.events.extend(self.rocket_system.step(dt, hooks))

    def _step_strikes(self, dt: float) -> None:
        if self.strike_system is None:
            return

        def shock(eid: str, damage: float, stun_time: float, dir_x: float, dir_z: float, knockback: float) -> None:
            e = self.enemies.get(eid)
            if e is None:
                return
            e.vel.x += dir_x * knockback
            e.vel.z += dir_z * knockback
            self._damage_enemy(e, damage, "storm", stagger=False)
            self._stun(e, stun_time)

        self.events.extend(self.strike_system.step(dt, StrikeHooks(self.live_targets, shock)))

    def _step_waves(self, dt: float) -> None:
        spawns = self.world.enemy_spawns
        if not self.waves or not spawns:
            return
        if self.enemies:
            self._wave_timer = self.world.wave_delay
            return
        self._wave_timer -= dt
        if self._wave_timer > 0 and self.wave > 0:
            return
        self.wave += 1
        count = min(5, len(spawns) + self.wave - 1)
        for i in range(count):
            type_id, pos = spawns[i % len(spawns)]
            ring = i // len(spawns)
            self.spawn_enemy(type_id, Vec3(pos.x + ring * 1.6, pos.y, pos.z))
        self.events.append({"type": "wave", "wave": self.wave})

    # ---- damage ----
    def _stun(self, e: EnemyState, seconds: float) -> None:
        """Shock an enemy still: it cannot move or attack for `seconds`, even if it had poise."""
        if e.defeated_timer is not None:
            return
        e.ai_timer = max(e.ai_timer, seconds) if e.ai_state == "stagger" else seconds
        e.ai_state = "stagger"

    def _damage_enemy(self, e: EnemyState, amount: float, source: str | None, stagger: bool = True) -> None:
        if e.defeated_timer is not None:
            return
        d = self.enemy_defs[e.type_id]
        shield_lost, core_lost, defeated = apply_damage(e.health, amount, d.health)
        self.events.append(
            {"type": "damage", "target": e.id, "source": source, "amount": amount, "shieldLost": shield_lost, "coreLost": core_lost}
        )
        if defeated:
            e.defeated_timer = float(d.powerDownTime)
            self.events.append({"type": "defeated", "id": e.id})
        elif amount > 0 and stagger and e.ai_state != "stagger" and e.poise_timer <= 0:
            e.ai_state = "stagger"
            e.ai_timer = float(d.staggerTime)

    def damage_player(self, pid: str, amount: float, source: str | None) -> None:
        hero = self.heroes[pid]
        player = self.players.get(pid)
        if player is None or player.defeated_timer is not None or player.invulnerable > 0:
            return
        shield_lost, core_lost, defeated = apply_damage(player.health, amount, hero.health)
        self.events.append(
            {"type": "damage", "target": pid, "source": source, "amount": amount, "shieldLost": shield_lost, "coreLost": core_lost}
        )
        if defeated:
            player.defeated_timer = float(hero.respawnDelay)
            player.tether = None
            player.zip = None
            player.flying = False
            if self.props is not None:
                self.props.drop_held_by(pid, player.pos)
            player.carrying = None
            self.events.append({"type": "defeated", "id": pid})

    def _enemy_hits_player(self, enemy: EnemyState, d: SimpleNamespace, target_id: str) -> None:
        player = self.players.get(target_id)
        if player is None or player.defeated_timer is not None:
            return
        dx = player.pos.x - enemy.pos.x
        dz = player.pos.z - enemy.pos.z
        dist = math.hypot(dx, dz) or 1.0
        player.vel.x += (dx / dist) * d.attack.knockback
        player.vel.z += (dz / dist) * d.attack.knockback
        self.events.append({"type": "enemyAttack", "id": enemy.id, "target": target_id})
        self.damage_player(target_id, float(d.attack.damage), enemy.id)

    def _respawn(self, pid: str) -> None:
        """Reset a player in place (so references held elsewhere stay valid), dropping what they carried."""
        state = self.players[pid]
        if self.props is not None:
            self.props.drop_held_by(pid, state.pos)
        fresh = create_player_state(self.world.spawn, self.heroes[pid])
        for f in dataclasses.fields(PlayerState):
            setattr(state, f.name, getattr(fresh, f.name))
        self.events.append({"type": "respawn", "id": pid})

    # ---- thrown cars and dumpsters going off ----
    def _detonate_prop(self, prop_index: int, owner: str) -> None:
        """A thrown car or dumpster goes off: enemies in the blast are hurt (less at the edge) and stunned, weak walls break."""
        if self.props is None:
            return
        r = self.props.detonate(prop_index)
        if r is None:
            return
        centre, defn, thrower, events = r
        det = defn.detonation
        self.events.extend(events)
        hits: list[str] = []
        for e in self.enemies.values():
            if e.defeated_timer is not None:
                continue
            m = self.enemy_defs[e.type_id].move
            dx = e.pos.x - centre.x
            dy = e.pos.y + m.height / 2 - centre.y
            dz = e.pos.z - centre.z
            dist = max(0.0, math.hypot(dx, dy, dz) - m.halfWidth)
            if dist > det.radius:
                continue
            frac = dist / det.radius
            flat = math.hypot(dx, dz) or 1.0
            hits.append(e.id)
            e.vel.x += (dx / flat) * det.knockback * (1 - 0.5 * frac)
            e.vel.z += (dz / flat) * det.knockback * (1 - 0.5 * frac)
            self._damage_enemy(e, det.damage * (1 - 0.5 * frac), owner, stagger=False)
            self._stun(e, float(det.stunTime))
        for c in list(self.world.active):
            if c.breakable is None or c.breakable > det.breakPower:
                continue
            cx = max(c.min.x, min(centre.x, c.max.x))
            cy = max(c.min.y, min(centre.y, c.max.y))
            cz = max(c.min.z, min(centre.z, c.max.z))
            if math.hypot(cx - centre.x, cy - centre.y, cz - centre.z) <= det.radius and self.world.break_collider(c.id):
                self.events.append({"type": "break", "id": c.id, "by": f"prop:{prop_index}"})
        self.events.append(
            {
                "type": "detonate",
                "id": prop_index,
                "pos": vec(centre),
                "radius": float(det.radius),
                "owner": owner,
                "thrower": thrower,
                "hits": hits,
                "combo": thrower is not None and thrower != owner,
            }
        )

    # ---- what clients and conformance scenarios see ----
    def enemy_wires(self) -> list[dict[str, Any]]:
        return [enemy_wire(e) for e in self.enemies.values()]
