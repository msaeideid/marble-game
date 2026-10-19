"""Networked combat: enemies, damage, weapons and waves run on the server and are streamed to clients in snapshots."""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from app.main import app, build_room
from app.rooms import Peer, Room, sanitize_intent
from app.sim.content import load_hero
from app.sim.controller import Intent
from app.sim.vec import Vec3


def room_with(waves: bool = False) -> Room:
    room = build_room(waves=waves)
    room.log = []  # type: ignore[attr-defined]  # every event of every tick (pending_events is cleared per snapshot)
    return room


def step(room: Room) -> None:
    room.step()
    room.log.extend(room.game.events)  # type: ignore[attr-defined]


def drive(room: Room, peer: Peer, ticks: int, **intent: object) -> None:
    for _ in range(ticks):
        room.enqueue_input(peer, peer.last_enqueued + 1, Intent(**intent))  # type: ignore[arg-type]
        step(room)


def frozen(room: Room, x: float, z: float):
    e = room.game.spawn_enemy("enemy.thug", Vec3(x, 0.01, z))
    e.snared_timer = 999.0
    return e


def types(room: Room) -> list[str]:
    return [e["type"] for e in room.log]


def test_waves_spawn_for_a_player_and_snapshots_describe_them() -> None:
    room = room_with(waves=True)
    room.add_peer("a")
    step(room)
    snap = room.snapshot()
    assert snap["wave"] == 1
    assert len(snap["enemies"]) == 3  # the arena's three spawns
    assert {"id", "type", "pos", "ai", "core", "shield"} <= set(snap["enemies"][0])
    assert snap["players"]["p1"]["combat"]["core"] > 0


def test_an_empty_room_is_frozen_and_resets() -> None:
    room = room_with(waves=True)
    for _ in range(10):
        room.step()
    assert room.game.wave == 0 and not room.game.enemies  # nobody here: no waves
    peer = room.add_peer("a")
    step(room)
    assert room.game.enemies
    room.remove_peer(peer.id)
    assert not room.game.enemies and room.game.wave == 0 and not room.pending_events


def test_a_melee_strike_hurts_an_enemy_and_the_events_are_recorded() -> None:
    room = room_with()
    peer = room.add_peer("a", load_hero("hero.bruiser"))
    peer.state.invulnerable = 0
    foe = frozen(room, 0, 1.5)
    before = foe.health.core
    drive(room, peer, 12, attackPressed=True, yaw=0.0)
    assert foe.health.core < before
    assert "melee" in types(room) and "damage" in types(room)
    melee = next(e for e in room.log if e["type"] == "melee")
    assert melee["attacker"] == peer.id and "pos" in melee


def test_events_are_sent_once_with_the_next_snapshot() -> None:
    room = room_with()
    peer = room.add_peer("a", load_hero("hero.bruiser"))
    frozen(room, 0, 1.5)
    drive(room, peer, 12, attackPressed=True, yaw=0.0)
    snaps = []
    while not peer.outbox.empty():
        snaps.append(peer.outbox.get_nowait())
    sent = [e["type"] for s in snaps for e in s["events"]]
    assert sent.count("melee") >= 1
    step(room)
    step(room)
    later = peer.outbox.get_nowait()
    assert all(e["type"] != "melee" for e in later["events"])


def test_enemies_hurt_players_and_the_health_is_in_the_snapshot() -> None:
    room = room_with()
    peer = room.add_peer("a", load_hero("hero.flyer"))
    peer.state.invulnerable = 0
    foe = room.game.spawn_enemy("enemy.thug", Vec3(0, 0.01, 1.8))
    assert foe.snared_timer == 0
    total = peer.state.health.shield + peer.state.health.core
    drive(room, peer, 60)
    assert peer.state.health.shield + peer.state.health.core < total
    assert "enemyAttack" in types(room)
    assert room.snapshot()["players"][peer.id]["combat"]["shield"] < peer.hero.health.shield.max


def test_a_defeated_player_cannot_act_and_respawns() -> None:
    room = room_with()
    peer = room.add_peer("a", load_hero("hero.flyer"))
    peer.state.invulnerable = 0
    room.game.damage_player(peer.id, 999.0, None)
    assert peer.state.defeated_timer is not None
    x = peer.state.pos.x
    drive(room, peer, 10, moveZ=1.0, fireHeld=True)
    assert peer.state.pos.x == x and "laser" not in types(room)  # the dead do nothing
    drive(room, peer, int(peer.hero.respawnDelay * 30) + 2)
    assert peer.state.defeated_timer is None
    assert peer.state.health.core == peer.hero.health.core.max
    assert "respawn" in types(room)


def test_metalhead_lasers_and_rockets_run_on_the_server() -> None:
    room = room_with()
    peer = room.add_peer("a", load_hero("hero.flyer"))
    foe = frozen(room, 0, 10)
    pitch = math.atan2(1.5 - 0.9, 10)
    drive(room, peer, 30, fireHeld=True, pitch=pitch)
    assert foe.health.core < 45 and "laser" in types(room)
    drive(room, peer, 1, rocketPressed=True, pitch=pitch)
    assert room.snapshot()["rockets"]
    drive(room, peer, 60)
    assert "explosion" in types(room)
    assert not room.snapshot()["rockets"]


def test_chain_lightning_and_storm_strikes_run_on_the_server() -> None:
    room = room_with()
    peer = room.add_peer("a", load_hero("hero.storm"))
    a = frozen(room, 0, 10)
    b = frozen(room, 3, 10)
    drive(room, peer, 1, chainPressed=True, pitch=math.atan2(1.45 - 0.9, 10))
    assert "chain" in types(room)
    assert a.ai_state == "stagger" and b.ai_state == "stagger"
    drive(room, peer, 1, stormPressed=True, pitch=math.atan2(1.45, 8))
    assert room.snapshot()["strikes"]
    drive(room, peer, 40)
    assert "strikeHit" in types(room)


def test_the_team_up_combo_works_between_two_players() -> None:
    room = room_with()
    tank = room.add_peer("tank", load_hero("hero.bruiser"))
    jet = room.add_peer("jet", load_hero("hero.flyer"))
    room.world.prop_spawns[:] = [{"type": "prop.car", "pos": [0, 0, 5]}]
    room.game.reset_world()
    tank.state.pos = Vec3(0, 0.01, 3.6)
    jet.state.pos = Vec3(4, 0.01, 2)
    for _ in range(6):
        step(room)
    group = [frozen(room, 0, 12.5), frozen(room, 1.6, 13)]
    drive(room, tank, 1, grabPressed=True)
    drive(room, tank, 20)  # the server only simulates a player when it has an input, as a real client sends every tick
    drive(room, tank, 1, grabPressed=True, pitch=-0.1)
    for _ in range(40):
        car = room.game.props.props[0]
        if car.mode == "thrown" and car.pos.z >= 10:  # over the group
            dx, dy, dz = car.pos.x - jet.state.pos.x, car.pos.y + 0.65 - 1.5, car.pos.z - jet.state.pos.z
            room.enqueue_input(
                jet,
                jet.last_enqueued + 1,
                Intent(fireHeld=True, yaw=math.atan2(dx, dz), pitch=-math.asin(dy / math.hypot(dx, dy, dz))),
            )
        step(room)
    boom = next(e for e in room.log if e["type"] == "detonate")
    assert boom["combo"] is True and boom["owner"] == jet.id and boom["thrower"] == tank.id
    assert all(g.health.core < 45 for g in group)


def test_sanitize_keeps_every_combat_button() -> None:
    raw = dict.fromkeys(("attackPressed", "snarePressed", "fireHeld", "rocketPressed", "chainPressed", "stormPressed"), True)
    i = sanitize_intent(raw)
    assert i is not None and all(getattr(i, k) for k in raw)
    j = sanitize_intent({})
    assert j is not None and not any(getattr(j, k) for k in raw)


def test_debug_spawn_exists_only_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    with TestClient(app) as client:
        assert client.post("/debug/spawn_enemy", json={"pos": [1, 0.01, 1]}).status_code == 404
        monkeypatch.setenv("VANGUARD_DEBUG", "1")
        r = client.post("/debug/spawn_enemy", json={"pos": [1, 0.01, 1], "snared": 50})
        assert r.status_code == 200 and r.json()["id"].startswith("enemy-")
        assert client.get("/health").json()["enemies"] >= 1
