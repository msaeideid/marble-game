"""A busy fight (four heroes using every ability against a wave) must still fit the 33 ms tick comfortably."""

from __future__ import annotations

import random
import statistics
import time

from app.main import build_room
from app.sim.content import load_hero
from app.sim.controller import Intent


def test_four_heroes_in_a_wave_fight_stay_inside_the_tick_budget() -> None:
    room = build_room(waves=True)
    heroes = ["hero.bruiser", "hero.flyer", "hero.storm", "hero.swinger"]
    peers = [room.add_peer(f"p{i}", load_hero(h)) for i, h in enumerate(heroes)]
    rnd = random.Random(5)
    for peer in peers:
        peer.state.energy = 1e9  # keep everyone firing
        peer.state.invulnerable = 1e9  # and alive, so the fight (and the cost) keeps going
    costs: list[float] = []
    most_enemies = 0
    yaw = [0.0] * 4
    for tick in range(900):
        for i, peer in enumerate(peers):
            yaw[i] += (rnd.random() - 0.5) * 0.4
            room.enqueue_input(
                peer,
                tick + 1,
                Intent(
                    moveZ=1.0 if rnd.random() < 0.6 else 0.0,
                    yaw=yaw[i],
                    pitch=0.2,
                    attackPressed=rnd.random() < 0.3,
                    fireHeld=True,
                    rocketPressed=rnd.random() < 0.1,
                    chainPressed=rnd.random() < 0.2,
                    stormPressed=rnd.random() < 0.05,
                    chargePressed=rnd.random() < 0.05,
                    snarePressed=rnd.random() < 0.1,
                    grabPressed=rnd.random() < 0.1,
                ),
            )
        t0 = time.perf_counter()
        room.step()
        costs.append((time.perf_counter() - t0) * 1000.0)
        most_enemies = max(most_enemies, len(room.game.enemies))
        for peer in peers:  # drain outboxes like a real writer would
            while not peer.outbox.empty():
                peer.outbox.get_nowait()
    costs.sort()
    p50, p99, worst = statistics.median(costs), costs[int(len(costs) * 0.99)], costs[-1]
    print(f"\n4 heroes, wave fight, 900 ticks: p50 {p50:.2f} ms, p99 {p99:.2f} ms, max {worst:.2f} ms (budget 33.3 ms)")
    assert most_enemies >= 3
    assert p50 < 6.0
    assert p99 < 18.0
