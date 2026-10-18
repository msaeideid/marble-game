from __future__ import annotations

import json
import math
import random
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app, build_room
from app.rooms import MAX_BUDGET, MAX_PLAYERS, MAX_QUEUE, Room, sanitize_intent
from app.sim.content import load_hero, load_level
from app.sim.controller import Intent, create_player_state, step_player, to_wire
from app.sim.world import World


@pytest.fixture
def room() -> Room:
    return build_room()


def chaos_intents(n: int, seed: int = 7) -> list[Intent]:
    rnd = random.Random(seed)
    out: list[Intent] = []
    yaw = 0.0
    swinging = False
    for _ in range(n):
        yaw += (rnd.random() - 0.5) * 0.3
        if rnd.random() < 0.05:
            swinging = not swinging
        out.append(
            Intent(
                moveX=round(rnd.uniform(-1, 1), 2),
                moveZ=round(rnd.uniform(-1, 1), 2),
                yaw=yaw,
                pitch=round(rnd.uniform(-0.8, 0.8), 2),
                jumpPressed=rnd.random() < 0.1,
                swingHeld=swinging,
                reelHeld=rnd.random() < 0.2,
                zipPressed=rnd.random() < 0.02,
            )
        )
    return out


def test_server_state_equals_direct_replay_of_the_same_inputs(room: Room) -> None:
    hero, world = room.hero, room.world
    peer = room.add_peer("a")
    intents = chaos_intents(300)

    ref = create_player_state(world.spawn, hero)
    for i, intent in enumerate(intents, start=1):
        assert room.enqueue_input(peer, i, intent)
        room.step()  # one input per tick: never starved, never backed up
        step_player(ref, intent, hero, world, room.dt)
        # (base regen / void respawn also apply on the server, so compare only while on neither)
    assert peer.ack == 300
    # Movement state matches except for the server-only base regen of energy near the spawn pad.
    a, b = to_wire(peer.state), to_wire(ref)
    for key in ("pos", "vel"):
        assert a[key] == pytest.approx(b[key], abs=1e-6) or world.is_on_base(peer.state.pos)


def test_no_phantom_ticks_when_a_client_sends_nothing(room: Room) -> None:
    peer = room.add_peer("idle")
    for _ in range(30):
        room.step()
    before = to_wire(peer.state)
    for _ in range(60):
        room.step()
    assert to_wire(peer.state) == before
    assert peer.ack == 0


def test_budget_prevents_speed_hacking(room: Room) -> None:
    peer = room.add_peer("cheater")
    ticks = 60
    sent = 0
    for _ in range(ticks):
        for _ in range(4):  # a cheater sends 4 inputs per tick (4x speed)
            sent += 1
            room.enqueue_input(peer, sent, Intent(moveZ=1.0))
        room.step()
    # Processed inputs can never exceed one per tick plus the banked burst allowance.
    assert peer.processed <= ticks + MAX_BUDGET
    assert peer.processed >= ticks - 1  # ...but it is not starved either
    assert peer.dropped_inputs > 0


def test_jitter_burst_is_absorbed_without_dropping(room: Room) -> None:
    peer = room.add_peer("laggy")
    room.step()
    room.step()  # bank some budget while idle
    for seq in range(1, 4):
        room.enqueue_input(peer, seq, Intent(moveZ=1.0))
    room.step()
    assert peer.ack == 3  # a 3-input burst after a stall is processed in one tick


def test_stale_and_overflow_inputs_are_dropped(room: Room) -> None:
    peer = room.add_peer("p")
    assert room.enqueue_input(peer, 5, Intent())
    assert not room.enqueue_input(peer, 5, Intent())  # duplicate
    assert not room.enqueue_input(peer, 3, Intent())  # out of order
    for seq in range(6, 6 + MAX_QUEUE):
        room.enqueue_input(peer, seq, Intent())
    assert len(peer.queue) == MAX_QUEUE


def test_snapshots_go_to_everyone_with_acks(room: Room) -> None:
    a, b = room.add_peer("a"), room.add_peer("b")
    room.enqueue_input(a, 1, Intent(moveZ=1.0))
    for _ in range(2):
        room.step()
    msg = b.outbox.get_nowait()
    assert msg["t"] == "snap"
    assert set(msg["players"]) == {a.id, b.id}
    assert msg["players"][a.id]["ack"] == 1
    assert msg["players"][b.id]["ack"] == 0


def test_room_is_full_after_four_players(room: Room) -> None:
    for i in range(MAX_PLAYERS):
        room.add_peer(f"p{i}")
    assert room.is_full


def test_falling_into_the_void_respawns_at_the_spawn(room: Room) -> None:
    peer = room.add_peer("fall")
    peer.state.pos.x = 500.0  # far beyond the ground slab
    peer.state.pos.y = 5.0
    for seq in range(1, 120):
        room.enqueue_input(peer, seq, Intent())
        room.step()
    assert abs(peer.state.pos.x - room.world.spawn.x) < 5


class TestSanitize:
    def test_clamps_out_of_range_values(self) -> None:
        i = sanitize_intent({"moveX": 99, "moveZ": -99, "yaw": 1, "pitch": 9})
        assert i is not None
        assert (i.moveX, i.moveZ, i.pitch) == (1.0, -1.0, 1.6)

    @pytest.mark.parametrize(
        "bad",
        [None, 5, "x", [], {"moveX": "1"}, {"moveX": float("nan")}, {"yaw": float("inf")}, {"moveZ": True}],
    )
    def test_rejects_malformed(self, bad: object) -> None:
        assert sanitize_intent(bad) is None

    def test_missing_fields_default_to_neutral(self) -> None:
        i = sanitize_intent({})
        assert i is not None and i == Intent()


def test_hero_and_world_load() -> None:
    hero = load_hero("hero.swinger")
    world = World(load_level("arena"))
    assert hero.swing.maxRange > 0
    assert world.base is not None and len(world.colliders) > 20


class TestWebSocket:
    def test_round_trip_welcome_input_snapshot_ack(self) -> None:
        with TestClient(app) as client, client.websocket_connect("/ws?name=tester") as ws:
            welcome = ws.receive_json()
            assert welcome["t"] == "welcome" and welcome["id"].startswith("p")
            for seq in range(1, 11):
                ws.send_text(json.dumps({"t": "input", "seq": seq, "intent": {"moveZ": 1, "yaw": 0}}))
            deadline = time.time() + 3
            ack = 0
            last = None
            while time.time() < deadline and ack < 10:
                msg = ws.receive_json()
                if msg["t"] == "snap":
                    last = msg["players"][welcome["id"]]
                    ack = last["ack"]
            assert ack == 10
            assert last is not None and last["state"]["pos"][2] > 0.5  # it ran forward

    def test_ping_pong(self) -> None:
        with TestClient(app) as client, client.websocket_connect("/ws") as ws:
            ws.receive_json()
            ws.send_text(json.dumps({"t": "ping", "c": 123}))
            for _ in range(10):
                msg = ws.receive_json()
                if msg["t"] == "pong":
                    assert msg["c"] == 123
                    return
            pytest.fail("no pong")

    def test_garbage_messages_do_not_kill_the_connection(self) -> None:
        with TestClient(app) as client, client.websocket_connect("/ws") as ws:
            ws.receive_json()
            for junk in ["not json", "[]", '{"t":"input"}', '{"t":"input","seq":"x","intent":{}}', "x" * 5000]:
                ws.send_text(junk)
            ws.send_text(json.dumps({"t": "ping", "c": 1}))
            for _ in range(10):
                if ws.receive_json()["t"] == "pong":
                    return
            pytest.fail("connection died on junk input")

    def test_fifth_player_is_turned_away(self) -> None:
        with TestClient(app) as client:
            sockets = [client.websocket_connect("/ws") for _ in range(MAX_PLAYERS)]
            opened = [s.__enter__() for s in sockets]
            try:
                for ws in opened:
                    assert ws.receive_json()["t"] == "welcome"
                with client.websocket_connect("/ws") as extra:
                    assert extra.receive_json()["t"] == "full"
            finally:
                for s in sockets:
                    s.__exit__(None, None, None)

    def test_players_see_each_other(self) -> None:
        with (
            TestClient(app) as client,
            client.websocket_connect("/ws?name=a") as a,
            client.websocket_connect("/ws?name=b") as b,
        ):
            ida, idb = a.receive_json()["id"], b.receive_json()["id"]
            deadline = time.time() + 3
            seen: set[str] = set()
            while time.time() < deadline and seen != {ida, idb}:
                msg = a.receive_json()
                if msg["t"] == "snap":
                    seen = set(msg["players"])
            assert seen == {ida, idb}


class TestHeroes:
    def test_each_player_gets_the_hero_they_asked_for(self, room: Room) -> None:
        ziplash = room.add_peer("a", load_hero("hero.swinger"))
        rampart = room.add_peer("b", load_hero("hero.bruiser"))
        room.step()
        room.step()
        snap = room.snapshot()
        assert snap["players"][ziplash.id]["hero"] == "hero.swinger"
        assert snap["players"][rampart.id]["hero"] == "hero.bruiser"
        assert rampart.hero.movement.runSpeed < ziplash.hero.movement.runSpeed

    def test_unknown_hero_ids_fall_back_to_the_default_over_the_socket(self) -> None:
        with TestClient(app) as client, client.websocket_connect("/ws?hero=hero.nope") as ws:
            assert ws.receive_json()["hero"] == "hero.swinger"

    def test_welcome_reports_the_chosen_hero(self) -> None:
        with TestClient(app) as client, client.websocket_connect("/ws?hero=hero.bruiser") as ws:
            welcome = ws.receive_json()
            assert welcome["hero"] == "hero.bruiser"
            assert welcome["broken"] == []

    def test_a_charge_smashes_a_wall_for_everyone(self, room: Room) -> None:
        rampart = room.add_peer("b", load_hero("hero.bruiser"))
        other = room.add_peer("c", load_hero("hero.swinger"))
        rampart.state.pos.z = -2.0
        rampart.state.pos.y = 0.0
        for i in range(60):
            room.enqueue_input(rampart, i + 1, Intent(yaw=math.pi, chargePressed=(i == 10)))
            room.step()
        snap = room.snapshot()
        assert len(snap["broken"]) == 1  # the weak wall in the south corridor
        assert rampart.state.pos.z < -14.5  # and he ran straight through it
        # A snapshot is what a late-joining or watching client learns about the world from.
        assert snap["broken"] == room.world.broken_list()
        # Walls stay broken for later players too, and block nobody.
        other.state.pos.z = -2.0
        for i in range(120):
            room.enqueue_input(other, i + 1, Intent(yaw=math.pi, moveZ=1.0))
            room.step()
        assert other.state.pos.z < -14.5

    def test_unbroken_walls_still_block_other_heroes(self, room: Room) -> None:
        ziplash = room.add_peer("a", load_hero("hero.swinger"))
        ziplash.state.pos.z = -2.0
        for i in range(150):
            room.enqueue_input(ziplash, i + 1, Intent(yaw=math.pi, moveZ=1.0))
            room.step()
        assert ziplash.state.pos.z > -12.5  # stopped by the tier-1 wall (z -14 .. -12.5)
        assert room.world.broken_list() == []

    def test_charge_is_ignored_by_heroes_without_it(self, room: Room) -> None:
        ziplash = room.add_peer("a", load_hero("hero.swinger"))
        room.enqueue_input(ziplash, 1, Intent(yaw=math.pi, chargePressed=True))
        room.step()
        assert ziplash.state.charge is None


class TestProps:
    CAR_A = 0  # level prop 0: a car at (3, 0, -6)

    def _rampart(self, room: Room, x: float, z: float):
        peer = room.add_peer("r", load_hero("hero.bruiser"))
        peer.state.pos.x, peer.state.pos.y, peer.state.pos.z = x, 0.0, z
        return peer

    def _send(self, room: Room, peer, seq: int, intent: Intent) -> None:
        room.enqueue_input(peer, seq, intent)
        room.step()

    def test_snapshots_list_every_prop(self, room: Room) -> None:
        room.add_peer("a")
        room.step()
        room.step()
        props = room.snapshot()["props"]
        assert [p["id"] for p in props] == [0, 1, 2, 3, 4, 5]
        assert props[0]["def"] == "prop.car" and props[0]["mode"] == "resting"

    def test_a_rampart_player_lifts_a_car_and_is_slowed(self, room: Room) -> None:
        peer = self._rampart(room, 3.0, -3.6)
        self._send(room, peer, 1, Intent(grabPressed=True))
        assert peer.state.carrying == (self.CAR_A, "prop.car")
        snap = room.snapshot()
        assert snap["props"][self.CAR_A]["mode"] == "held"
        assert snap["props"][self.CAR_A]["holder"] == peer.id
        assert snap["players"][peer.id]["state"]["carrying"] == {"id": self.CAR_A, "def": "prop.car"}
        peer.state.pos.x, peer.state.pos.z = 30.0, 0.0
        for i in range(2, 60):
            self._send(room, peer, i, Intent(moveZ=1.0))
        slowed = math.hypot(peer.state.vel.x, peer.state.vel.z)
        assert slowed == pytest.approx(peer.hero.movement.runSpeed * room.game.prop_defs["prop.car"].carrySlow, abs=1e-3)

    def test_throwing_breaks_the_reinforced_wall_for_everyone(self, room: Room) -> None:
        peer = self._rampart(room, 0.0, -14.7)
        self._send(room, peer, 1, Intent(grabPressed=True, yaw=math.pi))
        assert peer.state.carrying == (1, "prop.car")  # the car between the two south walls
        for i in range(2, 22):
            self._send(room, peer, i, Intent(yaw=math.pi))
        self._send(room, peer, 22, Intent(grabPressed=True, yaw=math.pi, pitch=-0.05))
        for i in range(23, 80):
            self._send(room, peer, i, Intent(yaw=math.pi))
        assert 36 in room.world.broken_list()
        assert 36 in room.snapshot()["broken"]

    def test_disconnecting_drops_what_you_were_carrying(self, room: Room) -> None:
        peer = self._rampart(room, 3.0, -3.6)
        self._send(room, peer, 1, Intent(grabPressed=True))
        assert room.game.props is not None and room.game.props.props[self.CAR_A].mode == "held"
        room.remove_peer(peer.id)
        room.step()
        pr = room.game.props.props[self.CAR_A]
        assert pr.mode == "resting" and pr.holder is None

    def test_two_players_cannot_take_the_same_prop(self, room: Room) -> None:
        a = self._rampart(room, 3.0, -3.6)
        b = self._rampart(room, 3.4, -3.6)
        room.enqueue_input(a, 1, Intent(grabPressed=True))
        room.enqueue_input(b, 1, Intent(grabPressed=True))
        room.step()
        assert (a.state.carrying is not None) != (b.state.carrying is not None)

    def test_other_heroes_cannot_lift(self, room: Room) -> None:
        peer = room.add_peer("z", load_hero("hero.swinger"))
        peer.state.pos.x, peer.state.pos.z = 3.0, -3.6
        self._send(room, peer, 1, Intent(grabPressed=True))
        assert peer.state.carrying is None

    def test_sanitize_keeps_the_grab_button(self) -> None:
        i = sanitize_intent({"grabPressed": True})
        assert i is not None and i.grabPressed is True


class TestFlight:
    """METALHEAD's jet flight runs on the server like any other movement."""

    def _fly(self, room: Room):
        peer = room.add_peer("m", load_hero("hero.flyer"))
        seq = 0

        def send(intent: Intent, ticks: int = 1) -> None:
            nonlocal seq
            for i in range(ticks):
                seq += 1
                edge = i == 0
                room.enqueue_input(
                    peer,
                    seq,
                    Intent(
                        jumpPressed=intent.jumpPressed and edge,
                        jumpHeld=intent.jumpHeld,
                        descendHeld=intent.descendHeld,
                        moveZ=intent.moveZ,
                    ),
                )
                room.step()

        send(Intent(), 6)  # land
        send(Intent(jumpPressed=True, jumpHeld=True))
        send(Intent(), 8)
        send(Intent(jumpPressed=True, jumpHeld=True))
        return peer, send

    def test_a_second_jump_press_in_the_air_lights_the_jets_and_everyone_sees_it(self, room: Room) -> None:
        peer, _ = self._fly(room)
        assert peer.state.flying is True
        snap = room.snapshot()
        assert snap["players"][peer.id]["hero"] == "hero.flyer"
        assert snap["players"][peer.id]["state"]["flying"] is True

    def test_climbing_hovering_and_landing(self, room: Room) -> None:
        peer, send = self._fly(room)
        y0 = peer.state.pos.y
        send(Intent(jumpHeld=True), 30)
        assert peer.state.pos.y - y0 > 5
        send(Intent(), 15)
        y1 = peer.state.pos.y
        send(Intent(), 30)
        assert abs(peer.state.pos.y - y1) < 0.05  # hovering
        send(Intent(descendHeld=True), 200)
        assert peer.state.flying is False and peer.state.grounded is True

    def test_flight_drains_energy_until_the_jets_cut_out(self, room: Room) -> None:
        peer, send = self._fly(room)
        send(Intent(jumpHeld=True), 300)  # a long climb burns the whole tank
        assert peer.state.flying is False
        assert peer.state.energy < 15

    def test_voltage_glides_slower_and_cheaper_than_metalhead(self, room: Room) -> None:
        metal, volt = load_hero("hero.flyer"), load_hero("hero.storm")
        assert volt.flight.speed < metal.flight.speed
        assert volt.flight.hoverDrainPerSecond < metal.flight.hoverDrainPerSecond
        peer = room.add_peer("v", volt)
        for seq, intent in enumerate(
            [Intent()] * 6
            + [Intent(jumpPressed=True, jumpHeld=True)]
            + [Intent()] * 8
            + [Intent(jumpPressed=True, jumpHeld=True)]
            + [Intent(jumpHeld=True)] * 20,
            start=1,
        ):
            room.enqueue_input(peer, seq, intent)
            room.step()
        assert peer.state.flying is True
        assert room.snapshot()["players"][peer.id]["hero"] == "hero.storm"

    def test_other_heroes_cannot_fly(self, room: Room) -> None:
        peer = room.add_peer("z", load_hero("hero.swinger"))
        for seq, edge in enumerate([True] + [False] * 8 + [True], start=1):
            room.enqueue_input(peer, seq, Intent(jumpPressed=edge))
            room.step()
        assert peer.state.flying is False

    def test_sanitize_keeps_the_climb_and_descend_buttons(self) -> None:
        i = sanitize_intent({"jumpHeld": True, "descendHeld": True})
        assert i is not None and i.jumpHeld is True and i.descendHeld is True
        j = sanitize_intent({})
        assert j is not None and j.jumpHeld is False and j.descendHeld is False


def test_the_world_resets_when_the_last_player_leaves(room: Room) -> None:
    a = room.add_peer("a", load_hero("hero.bruiser"))
    b = room.add_peer("b", load_hero("hero.swinger"))
    room.world.break_collider(34)
    assert room.game.props is not None
    room.game.props.props[0].pos.x = 50.0
    room.remove_peer(a.id)
    assert room.world.broken_list() == [34]  # someone is still here: the world carries on
    room.remove_peer(b.id)
    assert room.world.broken_list() == []
    assert room.game.props is not None
    assert room.game.props.props[0].pos.x == 3.0  # back at home
