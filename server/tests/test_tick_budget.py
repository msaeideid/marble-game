"""How expensive is a server tick with a full room? The budget is 33 ms (30 Hz); we want to be far below it."""

from __future__ import annotations

import statistics
import time

from app.main import build_room
from app.sim.controller import Intent
from tests.test_rooms import chaos_intents


def test_full_room_tick_cost_is_well_inside_the_30hz_budget() -> None:
    room = build_room()
    peers = [room.add_peer(f"p{i}") for i in range(4)]
    scripts = [chaos_intents(900, seed=100 + i) for i in range(4)]
    for peer in peers:
        peer.state.energy = 1e9  # keep everyone swinging, which is the most expensive thing they can do
    costs: list[float] = []
    for tick in range(900):
        for peer, script in zip(peers, scripts, strict=True):
            intent: Intent = script[tick]
            intent.swingHeld = True
            room.enqueue_input(peer, tick + 1, intent)
        t0 = time.perf_counter()
        room.step()
        costs.append((time.perf_counter() - t0) * 1000.0)
        for peer in peers:  # drain outboxes like a real writer would
            while not peer.outbox.empty():
                peer.outbox.get_nowait()
    costs.sort()
    p50, p99, worst = statistics.median(costs), costs[int(len(costs) * 0.99)], costs[-1]
    print(f"\n4 players, 900 ticks: p50 {p50:.2f} ms, p99 {p99:.2f} ms, max {worst:.2f} ms (budget 33.3 ms)")
    assert p50 < 5.0
    assert p99 < 15.0
