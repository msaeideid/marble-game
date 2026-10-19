from __future__ import annotations

import asyncio
import contextlib
import json
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect

from .rooms import MAX_PLAYERS, PROTOCOL_VERSION, TICK_RATE, Room, sanitize_intent
from .sim.content import hero_ids, load_hero, load_level
from .sim.vec import Vec3
from .sim.world import World

MAX_MESSAGE_BYTES = 4096
DEFAULT_HERO = "hero.swinger"


def build_room(waves: bool = False) -> Room:
    return Room(load_hero("hero.swinger"), World(load_level("arena")), waves=waves)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Waves of thugs are on unless VANGUARD_WAVES=0 (the movement end-to-end tests turn them off).
    room = build_room(waves=os.environ.get("VANGUARD_WAVES", "1") != "0")
    app.state.room = room
    room.start()
    try:
        yield
    finally:
        await room.stop()


app = FastAPI(title="VANGUARD server", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    room: Room = app.state.room
    return {
        "status": "ok",
        "protocol": PROTOCOL_VERSION,
        "tickRate": TICK_RATE,
        "players": len(room.peers),
        "enemies": len(room.game.enemies),
        "wave": room.game.wave,
        "tickMs": round(room.last_tick_ms, 3),
        "maxTickMs": round(room.max_tick_ms, 3),
    }


@app.post("/debug/spawn_enemy")
def debug_spawn_enemy(body: dict[str, Any]) -> dict[str, Any]:
    """Test hook: put an enemy in the room. Only exists when the server runs with VANGUARD_DEBUG=1."""
    if os.environ.get("VANGUARD_DEBUG") != "1":
        raise HTTPException(status_code=404)
    room: Room = app.state.room
    pos = body.get("pos", [0.0, 0.01, 0.0])
    enemy = room.game.spawn_enemy(str(body.get("type", "enemy.thug")), Vec3.from_list(pos))
    enemy.snared_timer = float(body.get("snared", 0))
    return {"id": enemy.id}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    room: Room = app.state.room
    await ws.accept()
    if room.is_full:
        await ws.send_text(json.dumps({"t": "full", "max": MAX_PLAYERS}))
        await ws.close()
        return

    name = ws.query_params.get("name", "")
    wanted = ws.query_params.get("hero", DEFAULT_HERO)
    hero = load_hero(wanted if wanted in hero_ids() else DEFAULT_HERO)
    peer = room.add_peer(name, hero)
    await ws.send_text(
        json.dumps(
            {
                "t": "welcome",
                "v": PROTOCOL_VERSION,
                "id": peer.id,
                "hero": hero.id,
                "broken": room.world.broken_list(),
                "tickRate": room.tick_rate,
                "snapshotEvery": 2,
                "spawn": room.world.spawn.to_list(),
            }
        )
    )

    async def writer() -> None:
        while True:
            msg = await peer.outbox.get()
            await ws.send_text(json.dumps(msg, separators=(",", ":")))

    writer_task = asyncio.create_task(writer())
    try:
        while True:
            text = await ws.receive_text()
            if len(text) > MAX_MESSAGE_BYTES:
                continue
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            kind = msg.get("t")
            if kind == "input":
                seq = msg.get("seq")
                intent = sanitize_intent(msg.get("intent"))
                if isinstance(seq, int) and not isinstance(seq, bool) and intent is not None:
                    room.enqueue_input(peer, seq, intent)
            elif kind == "ping":
                room.send_to(peer, {"t": "pong", "c": msg.get("c")})
    except WebSocketDisconnect:
        pass
    finally:
        # Leave the room first and unconditionally: the writer may already have died on a dead connection, and
        # awaiting it below would then re-raise its error and skip this (leaving a ghost player in the room).
        room.remove_peer(peer.id)
        writer_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await writer_task
