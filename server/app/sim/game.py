"""The authoritative game simulation for the parts the server runs today (movement, walls, props).

Mirrors the player loop of client/src/sim/sim.ts (`Sim.step`): movement, grab/throw, base regeneration of energy,
void respawn, then the props. Combat (melee, snare, enemies, health) joins when it is networked.
"""

from __future__ import annotations

import dataclasses
from types import SimpleNamespace
from typing import Any

from .controller import Intent, PlayerState, create_player_state, step_player
from .props import PropSystem, carry_scales
from .vec import Vec3
from .world import World


class GameSim:
    def __init__(
        self,
        world: World,
        prop_defs: dict[str, SimpleNamespace],
        default_hero: SimpleNamespace,
    ) -> None:
        self.world = world
        self.prop_defs = prop_defs
        self.default_hero = default_hero
        self.players: dict[str, PlayerState] = {}
        self.heroes: dict[str, SimpleNamespace] = {}
        self.props: PropSystem | None = PropSystem(world, prop_defs) if world.prop_spawns else None
        self.events: list[dict[str, Any]] = []

    def reset_world(self) -> None:
        """Put the world back as the level defines it: walls rebuilt, props back at home."""
        self.world.set_broken([])
        self.props = PropSystem(self.world, self.prop_defs) if self.world.prop_spawns else None

    def add_player(self, pid: str, hero: SimpleNamespace | None = None) -> PlayerState:
        chosen = hero or self.default_hero
        state = create_player_state(self.world.spawn, chosen)
        self.players[pid] = state
        self.heroes[pid] = chosen
        return state

    def remove_player(self, pid: str) -> None:
        state = self.players.pop(pid, None)
        self.heroes.pop(pid, None)
        if state is not None and self.props is not None:
            self.props.drop_held_by(pid, state.pos)

    def _respawn(self, pid: str) -> None:
        """Reset a player in place (so references held elsewhere stay valid), dropping what they carried."""
        state = self.players[pid]
        if self.props is not None:
            self.props.drop_held_by(pid, state.pos)
        fresh = create_player_state(self.world.spawn, self.heroes[pid])
        for f in dataclasses.fields(PlayerState):
            setattr(state, f.name, getattr(fresh, f.name))
        self.events.append({"type": "respawn", "id": pid})

    def step_player(self, pid: str, intent: Intent, dt: float) -> None:
        """One player-tick. The server calls this once per processed input."""
        state = self.players[pid]
        hero = self.heroes[pid]
        carry = None
        if state.carrying is not None:
            carry = carry_scales(self.prop_defs.get(state.carrying[1]))
        for c in step_player(state, intent, hero, self.world, dt, carry):
            self.events.append({"type": "break", "id": c.id, "by": pid})
        if self.props is not None and intent.grabPressed:
            self.events.extend(self.props.handle_grab(pid, state, hero, intent.yaw, intent.pitch))
        base = self.world.base
        if base is not None and self.world.is_on_base(state.pos):
            state.energy = min(float(hero.energy.max), state.energy + base.regenPerSecond * 2 * dt)
        if state.pos.y < self.world.kill_y:
            self._respawn(pid)

    def step_world(self, dt: float) -> None:
        """Everything that is not a player: the props. Once per server tick."""
        if self.props is None:
            return

        def holder_top(pid: str) -> Vec3 | None:
            p = self.players.get(pid)
            if p is None:
                return None
            return Vec3(p.pos.x, p.pos.y + self.heroes[pid].movement.height + 0.05, p.pos.z)

        self.events.extend(self.props.step(dt, holder_top))

    def step(self, intents: dict[str, Intent], dt: float) -> None:
        """A whole tick for every player, then the world (what the TypeScript Sim.step does)."""
        self.events = []
        for pid in list(self.players):
            self.step_player(pid, intents.get(pid, Intent()), dt)
        self.step_world(dt)
