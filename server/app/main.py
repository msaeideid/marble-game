from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .rooms import MAX_PLAYERS, PROTOCOL_VERSION, TICK_RATE, Room, sanitize_intent
from .sim.content import hero_ids, load_hero, load_level
from .sim.world import World

MAX_MESSAGE_BYTES = 4096
DEFAULT_HERO = "hero.swinger"


def build_room() -> Room:
    return Room(load_hero("hero.swinger"), World(load_level("arena")))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    room = build_room()
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
        "tickMs": round(room.last_tick_ms, 3),
        "maxTickMs": round(room.max_tick_ms, 3),
    }


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
        writer_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await writer_task
        room.remove_peer(peer.id)
