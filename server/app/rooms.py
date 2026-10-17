"""An authoritative game room: owns every player's state, advances it at a fixed tick, and broadcasts snapshots.

Networking model (see docs/netcode.md):
- Clients send one input per client sim tick (30 Hz), each tagged with a sequence number.
- The server simulates a player ONLY when it has an input for them, in order, never inventing ticks. A per-player
  time budget (one input per server tick, small burst allowance) lets jitter through but stops speed-hacking.
- Snapshots carry each player's state plus the last input sequence processed (`ack`), which is what the owning client
  needs to reconcile its prediction.
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import time
from collections import deque
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from .sim.controller import Intent, PlayerState, create_player_state, step_player, to_wire
from .sim.world import World

PROTOCOL_VERSION = 1
TICK_RATE = 30
SNAPSHOT_EVERY = 2  # ticks -> 15 Hz
MAX_PLAYERS = 4
MAX_QUEUE = 12  # inputs buffered per player; beyond this the client is too far ahead and new inputs are dropped
MAX_BUDGET = 3.0  # input-processing tokens a player can bank (absorbs network jitter)
OUTBOX_LIMIT = 64


def sanitize_intent(raw: Any) -> Intent | None:
    """Validate and clamp an untrusted intent dict. Returns None if it is malformed."""
    if not isinstance(raw, dict):
        return None

    def num(key: str, lo: float, hi: float) -> float | None:
        v = raw.get(key, 0.0)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            return None
        return max(lo, min(hi, float(v)))

    move_x, move_z = num("moveX", -1, 1), num("moveZ", -1, 1)
    yaw, pitch = num("yaw", -1e4, 1e4), num("pitch", -1.6, 1.6)
    if None in (move_x, move_z, yaw, pitch):
        return None
    return Intent(
        moveX=move_x,  # type: ignore[arg-type]
        moveZ=move_z,  # type: ignore[arg-type]
        yaw=yaw,  # type: ignore[arg-type]
        pitch=pitch,  # type: ignore[arg-type]
        jumpPressed=bool(raw.get("jumpPressed", False)),
        swingHeld=bool(raw.get("swingHeld", False)),
        reelHeld=bool(raw.get("reelHeld", False)),
        zipPressed=bool(raw.get("zipPressed", False)),
    )


@dataclass
class Peer:
    id: str
    name: str
    state: PlayerState
    queue: deque[tuple[int, Intent]] = field(default_factory=deque)
    outbox: asyncio.Queue[dict[str, Any]] = field(default_factory=asyncio.Queue)
    ack: int = 0  # last input sequence applied to `state`
    last_enqueued: int = 0
    budget: float = 1.0
    dropped_inputs: int = 0
    processed: int = 0  # inputs actually simulated (ack is a sequence number and can skip dropped ones)


class Room:
    def __init__(self, hero: SimpleNamespace, world: World, tick_rate: int = TICK_RATE) -> None:
        self.hero = hero
        self.world = world
        self.tick_rate = tick_rate
        self.dt = 1.0 / tick_rate
        self.tick = 0
        self.peers: dict[str, Peer] = {}
        self._next_id = 1
        self._task: asyncio.Task[None] | None = None
        self.last_tick_ms = 0.0
        self.max_tick_ms = 0.0

    # ---- membership ----
    @property
    def is_full(self) -> bool:
        return len(self.peers) >= MAX_PLAYERS

    def add_peer(self, name: str) -> Peer:
        pid = f"p{self._next_id}"
        self._next_id += 1
        peer = Peer(pid, name[:16] or pid, create_player_state(self.world.spawn, self.hero))
        self.peers[pid] = peer
        return peer

    def remove_peer(self, pid: str) -> None:
        self.peers.pop(pid, None)

    # ---- input ----
    def enqueue_input(self, peer: Peer, seq: int, intent: Intent) -> bool:
        """Queue an input. Sequence numbers must strictly increase; stale or overflowing inputs are dropped."""
        if seq <= peer.last_enqueued or len(peer.queue) >= MAX_QUEUE:
            peer.dropped_inputs += 1
            return False
        peer.last_enqueued = seq
        peer.queue.append((seq, intent))
        return True

    # ---- simulation ----
    def step(self) -> None:
        """Advance one server tick."""
        t0 = time.perf_counter()
        for peer in self.peers.values():
            peer.budget = min(MAX_BUDGET, peer.budget + 1.0)
            while peer.budget >= 1.0 and peer.queue:
                peer.budget -= 1.0
                seq, intent = peer.queue.popleft()
                self._apply(peer, intent)
                peer.ack = seq
                peer.processed += 1
        self.tick += 1
        if self.tick % SNAPSHOT_EVERY == 0:
            snap = self.snapshot()
            for peer in self.peers.values():
                self._send(peer, snap)
        self.last_tick_ms = (time.perf_counter() - t0) * 1000.0
        self.max_tick_ms = max(self.max_tick_ms, self.last_tick_ms)

    def _apply(self, peer: Peer, intent: Intent) -> None:
        """One player-tick, in the same order as Sim.step on the client (movement, base regen, void respawn)."""
        step_player(peer.state, intent, self.hero, self.world, self.dt)
        base = self.world.base
        if base is not None and self.world.is_on_base(peer.state.pos):
            peer.state.energy = min(
                float(self.hero.energy.max), peer.state.energy + base.regenPerSecond * 2 * self.dt
            )
        if peer.state.pos.y < self.world.kill_y:
            peer.state = create_player_state(self.world.spawn, self.hero)

    def snapshot(self) -> dict[str, Any]:
        return {
            "t": "snap",
            "tick": self.tick,
            "players": {
                pid: {"name": p.name, "ack": p.ack, "state": to_wire(p.state)} for pid, p in self.peers.items()
            },
        }

    def _send(self, peer: Peer, msg: dict[str, Any]) -> None:
        if peer.outbox.qsize() >= OUTBOX_LIMIT:
            with contextlib.suppress(asyncio.QueueEmpty):
                peer.outbox.get_nowait()  # slow client: drop the oldest message rather than grow forever
        peer.outbox.put_nowait(msg)

    def send_to(self, peer: Peer, msg: dict[str, Any]) -> None:
        self._send(peer, msg)

    # ---- loop ----
    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        next_time = loop.time()
        while True:
            self.step()
            next_time += self.dt
            delay = next_time - loop.time()
            if delay < -0.25:  # fell far behind (debugger, overload): resync instead of spiralling
                next_time = loop.time()
                delay = 0.0
            await asyncio.sleep(max(0.0, delay))

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self.run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
