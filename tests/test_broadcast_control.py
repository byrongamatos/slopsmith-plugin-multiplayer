"""Phase 1c tests: broadcast control plane on the highway WS.

Covers PROTOCOL.md "Audio control messages":
  - broadcast_start with valid v1 params → broadcaster_changed to all peers
  - broadcast_start while another broadcaster is active → broadcaster_busy
  - broadcast_start with invalid params → broadcast_start_invalid error
  - broadcast_stop by the active broadcaster → broadcaster_changed null
  - broadcast_stop by a non-broadcaster → silently ignored
  - audio_quality forwarded to the broadcaster only
  - broadcaster_id surfaced in the connected snapshot for late joiners
  - broadcaster_changed null on session-end paths (grace expiry, leave, takeover)
"""

import time

import pytest
from starlette.websockets import WebSocketDisconnect


@pytest.fixture
def fast_grace(routes_module):
    routes_module.SESSION_GRACE_SEC = 0.5
    yield 0.5


def _create_room(client, name="Alice"):
    r = client.post("/api/plugins/multiplayer/rooms", json={"name": name})
    r.raise_for_status()
    body = r.json()
    return body["code"], body["player_id"]


def _join_room(client, code, name="Bob"):
    r = client.post(f"/api/plugins/multiplayer/rooms/{code}/join", json={"name": name})
    r.raise_for_status()
    return r.json()["player_id"]


def _highway_url(code, player_id, session_id):
    return (
        f"/ws/plugins/multiplayer/{code}"
        f"?player_id={player_id}&session_id={session_id}"
    )


def _audio_url(code, player_id, session_id):
    return (
        f"/ws/plugins/multiplayer/{code}/audio"
        f"?player_id={player_id}&session_id={session_id}"
    )


_VALID_PARAMS = {
    "interval_beats": 4,
    "sample_rate": 48000,
    "channel_count": 1,
    "codec": "opus",
    "bitrate": 96000,
}


def _drain_until(ws, predicate, max_msgs=20):
    """Read messages until one satisfies `predicate(msg)`. Returns the
    matching message. Pytest-timeout (configured in pyproject.toml)
    bounds the worst-case wall time; this loop bound prevents infinite
    iteration on simple bugs."""
    for _ in range(max_msgs):
        msg = ws.receive_json()
        if predicate(msg):
            return msg
    raise AssertionError(
        f"no matching message within {max_msgs} reads; predicate not satisfied"
    )


# ── broadcast_start happy path ────────────────────────────────────────────

def test_broadcast_start_emits_broadcaster_changed_to_peers(client, routes_module):
    code, host_pid = _create_room(client)
    bob_pid = _join_room(client, code, "Bob")

    with client.websocket_connect(_audio_url(code, host_pid, "host-sid")), \
         client.websocket_connect(_highway_url(code, host_pid, "host-sid")) as host_hw, \
         client.websocket_connect(_highway_url(code, bob_pid, "bob-sid")) as bob_hw:
        host_hw.receive_json()  # 'connected'
        bob_hw.receive_json()
        host_hw.receive_json()  # player_connected for bob

        host_hw.send_json({"type": "broadcast_start", **_VALID_PARAMS})

        # Bob receives broadcaster_changed.
        evt = _drain_until(bob_hw, lambda m: m.get("type") == "broadcaster_changed")
        assert evt["broadcaster_id"] == host_pid
        assert evt["interval_beats"] == 4
        assert evt["sample_rate"] == 48000
        assert evt["channel_count"] == 1
        assert evt["codec"] == "opus"
        assert evt["bitrate"] == 96000

        # Host also receives broadcaster_changed (they're a peer in the room).
        evt2 = _drain_until(host_hw, lambda m: m.get("type") == "broadcaster_changed")
        assert evt2["broadcaster_id"] == host_pid

        # Server state.
        room = routes_module._rooms[code]
        assert room["broadcaster_id"] == host_pid
        assert room["broadcast_params"] == {
            "interval_beats": 4,
            "sample_rate": 48000,
            "channel_count": 1,
            "codec": "opus",
            "bitrate": 96000,
        }


def test_broadcaster_id_surfaced_to_late_joiner_in_connected_snapshot(client):
    code, host_pid = _create_room(client)
    bob_pid = _join_room(client, code, "Bob")

    with client.websocket_connect(_audio_url(code, host_pid, "host-sid")), \
         client.websocket_connect(_highway_url(code, host_pid, "host-sid")) as host_hw:
        host_hw.receive_json()  # 'connected'
        host_hw.send_json({"type": "broadcast_start", **_VALID_PARAMS})
        host_hw.receive_json()  # broadcaster_changed

        # Bob joins LATE — broadcaster is already active. The 'connected'
        # snapshot must surface broadcaster_id so bob's UI activates the
        # listener pipeline immediately, without waiting for a fresh
        # broadcaster_changed event (per PROTOCOL.md Lifecycle §4).
        with client.websocket_connect(_highway_url(code, bob_pid, "bob-sid")) as bob_hw:
            snapshot = bob_hw.receive_json()
            assert snapshot["type"] == "connected"
            assert snapshot["room"]["broadcaster_id"] == host_pid
            assert snapshot["room"]["broadcast_params"]["bitrate"] == 96000


# ── broadcaster_busy ───────────────────────────────────────────────────────

def test_second_broadcaster_rejected_with_broadcaster_busy(client, routes_module):
    code, host_pid = _create_room(client)
    bob_pid = _join_room(client, code, "Bob")

    with client.websocket_connect(_audio_url(code, host_pid, "host-sid")), \
         client.websocket_connect(_audio_url(code, bob_pid, "bob-sid")), \
         client.websocket_connect(_highway_url(code, host_pid, "host-sid")) as host_hw, \
         client.websocket_connect(_highway_url(code, bob_pid, "bob-sid")) as bob_hw:
        host_hw.receive_json()
        bob_hw.receive_json()
        host_hw.receive_json()  # player_connected for bob

        host_hw.send_json({"type": "broadcast_start", **_VALID_PARAMS})
        host_hw.receive_json()  # broadcaster_changed (host)
        bob_hw.receive_json()   # broadcaster_changed (bob)

        # Bob tries to also broadcast.
        bob_hw.send_json({"type": "broadcast_start", **_VALID_PARAMS})
        evt = _drain_until(bob_hw, lambda m: m.get("type") == "error")
        assert evt["message"] == "broadcaster_busy"

        # Server state unchanged.
        assert routes_module._rooms[code]["broadcaster_id"] == host_pid


def test_active_broadcaster_can_re_send_broadcast_start(client, routes_module):
    """The same player re-issuing broadcast_start should NOT be treated as
    busy — that would lock them out after a transient disconnect-reconnect
    where they want to resume their broadcast. v1 server policy: only a
    DIFFERENT player_id triggers broadcaster_busy."""
    code, host_pid = _create_room(client)

    with client.websocket_connect(_audio_url(code, host_pid, "host-sid")), \
         client.websocket_connect(_highway_url(code, host_pid, "host-sid")) as host_hw:
        host_hw.receive_json()
        host_hw.send_json({"type": "broadcast_start", **_VALID_PARAMS})
        host_hw.receive_json()  # broadcaster_changed

        # Same player_id sends broadcast_start again with new params.
        new_params = {**_VALID_PARAMS, "bitrate": 64000}
        host_hw.send_json({"type": "broadcast_start", **new_params})
        evt = _drain_until(host_hw, lambda m: m.get("type") == "broadcaster_changed")
        assert evt["broadcaster_id"] == host_pid
        assert evt["bitrate"] == 64000
        assert routes_module._rooms[code]["broadcast_params"]["bitrate"] == 64000


# ── audio_ws_not_open rejection ───────────────────────────────────────────

def test_broadcast_start_rejected_when_audio_ws_not_open(client, routes_module):
    """Codex round 1 P1 (Phase 1c): broadcast_start MUST be rejected with
    audio_ws_not_open if the host's session has no live /audio socket.
    Otherwise peers (and late joiners) would see an active broadcaster
    even though no audio frames can ever arrive."""
    code, host_pid = _create_room(client)
    with client.websocket_connect(_highway_url(code, host_pid, "host-sid")) as host_hw:
        host_hw.receive_json()  # 'connected'
        # Audio NOT opened. broadcast_start must reject.
        host_hw.send_json({"type": "broadcast_start", **_VALID_PARAMS})
        evt = _drain_until(host_hw, lambda m: m.get("type") == "error")
        assert evt["message"] == "audio_ws_not_open"
        assert routes_module._rooms[code]["broadcaster_id"] is None


# ── broadcast_start invalid params ────────────────────────────────────────

@pytest.mark.parametrize("bad_overrides,expected_field", [
    ({"sample_rate": 44100}, "sample_rate"),
    ({"channel_count": 2}, "channel_count"),
    ({"codec": "vorbis"}, "codec"),
    ({"bitrate": 1000}, "bitrate"),       # below min
    ({"bitrate": 999_999}, "bitrate"),    # above max
    ({"bitrate": "96000"}, "bitrate"),    # string, not int
    ({"interval_beats": -1}, "interval_beats"),
    ({"interval_beats": "four"}, "interval_beats"),
])
def test_broadcast_start_with_invalid_params_returns_error(
    client, routes_module, bad_overrides, expected_field,
):
    code, host_pid = _create_room(client)
    with client.websocket_connect(_audio_url(code, host_pid, "host-sid")), \
         client.websocket_connect(_highway_url(code, host_pid, "host-sid")) as host_hw:
        host_hw.receive_json()
        params = {**_VALID_PARAMS, **bad_overrides}
        host_hw.send_json({"type": "broadcast_start", **params})
        evt = _drain_until(host_hw, lambda m: m.get("type") == "error")
        assert evt["message"].startswith("broadcast_start_invalid:")
        assert expected_field in evt["message"]
        # No broadcast became active.
        assert routes_module._rooms[code]["broadcaster_id"] is None


# ── broadcast_stop ─────────────────────────────────────────────────────────

def test_broadcaster_can_stop_their_own_broadcast(client, routes_module):
    code, host_pid = _create_room(client)
    bob_pid = _join_room(client, code, "Bob")

    with client.websocket_connect(_audio_url(code, host_pid, "host-sid")), \
         client.websocket_connect(_highway_url(code, host_pid, "host-sid")) as host_hw, \
         client.websocket_connect(_highway_url(code, bob_pid, "bob-sid")) as bob_hw:
        host_hw.receive_json()
        bob_hw.receive_json()
        host_hw.receive_json()  # player_connected for bob

        host_hw.send_json({"type": "broadcast_start", **_VALID_PARAMS})
        host_hw.receive_json()
        bob_hw.receive_json()  # broadcaster_changed

        host_hw.send_json({"type": "broadcast_stop"})
        evt = _drain_until(bob_hw, lambda m: m.get("type") == "broadcaster_changed")
        assert evt["broadcaster_id"] is None
        assert routes_module._rooms[code]["broadcaster_id"] is None
        assert routes_module._rooms[code]["broadcast_params"] is None


def test_broadcast_stop_from_non_broadcaster_is_silently_ignored(client, routes_module):
    code, host_pid = _create_room(client)
    bob_pid = _join_room(client, code, "Bob")

    with client.websocket_connect(_audio_url(code, host_pid, "host-sid")), \
         client.websocket_connect(_highway_url(code, host_pid, "host-sid")) as host_hw, \
         client.websocket_connect(_highway_url(code, bob_pid, "bob-sid")) as bob_hw:
        host_hw.receive_json()
        bob_hw.receive_json()
        host_hw.receive_json()  # player_connected for bob

        host_hw.send_json({"type": "broadcast_start", **_VALID_PARAMS})
        host_hw.receive_json()
        bob_hw.receive_json()

        # Bob (NOT the broadcaster) sends broadcast_stop. Server must
        # silently ignore — host's broadcast continues. We verify by
        # driving a deterministic exchange and checking no
        # broadcaster_changed event sneaks in.
        bob_hw.send_json({"type": "broadcast_stop"})
        bob_hw.send_json({"type": "set_arrangement", "arrangement": "Bass"})
        evt = _drain_until(host_hw, lambda m: m.get("type") == "arrangement_changed")
        assert evt["player_id"] == bob_pid
        # Broadcast still active.
        assert routes_module._rooms[code]["broadcaster_id"] == host_pid


# ── audio_quality ─────────────────────────────────────────────────────────

def test_audio_quality_forwarded_only_to_broadcaster(client):
    code, host_pid = _create_room(client)
    bob_pid = _join_room(client, code, "Bob")
    carol_pid = _join_room(client, code, "Carol")

    with client.websocket_connect(_audio_url(code, host_pid, "host-sid")), \
         client.websocket_connect(_highway_url(code, host_pid, "host-sid")) as host_hw, \
         client.websocket_connect(_highway_url(code, bob_pid, "bob-sid")) as bob_hw, \
         client.websocket_connect(_highway_url(code, carol_pid, "carol-sid")) as carol_hw:
        host_hw.receive_json()
        bob_hw.receive_json()
        carol_hw.receive_json()
        host_hw.receive_json()
        host_hw.receive_json()  # player_connected for bob, carol

        host_hw.send_json({"type": "broadcast_start", **_VALID_PARAMS})
        host_hw.receive_json()
        bob_hw.receive_json()
        carol_hw.receive_json()

        bob_hw.send_json({
            "type": "audio_quality",
            "broadcaster_id": host_pid,
            "intervals_received": 100,
            "intervals_late": 1,
            "intervals_dropped": 0,
            "decoder_underruns": 0,
            "report_period_ms": 30000,
        })

        # Host (the broadcaster) receives the report.
        evt = _drain_until(host_hw, lambda m: m.get("type") == "audio_quality")
        assert evt["from_player_id"] == bob_pid
        assert evt["broadcaster_id"] == host_pid
        assert evt["intervals_received"] == 100

        # Carol (a non-broadcaster peer) does NOT see it. Verify by
        # driving a deterministic event from carol that the host WILL
        # forward and asserting host's next message is THAT, not another
        # audio_quality.
        carol_hw.send_json({"type": "set_arrangement", "arrangement": "Lead"})
        next_evt = _drain_until(host_hw, lambda m: m.get("type") in {"audio_quality", "arrangement_changed"})
        assert next_evt["type"] == "arrangement_changed"


def test_audio_quality_with_stale_broadcaster_id_dropped(client):
    code, host_pid = _create_room(client)
    bob_pid = _join_room(client, code, "Bob")

    with client.websocket_connect(_audio_url(code, host_pid, "host-sid")), \
         client.websocket_connect(_highway_url(code, host_pid, "host-sid")) as host_hw, \
         client.websocket_connect(_highway_url(code, bob_pid, "bob-sid")) as bob_hw:
        host_hw.receive_json()
        bob_hw.receive_json()
        host_hw.receive_json()  # player_connected for bob

        host_hw.send_json({"type": "broadcast_start", **_VALID_PARAMS})
        host_hw.receive_json()
        bob_hw.receive_json()

        # Bob sends a quality report claiming a different broadcaster_id.
        # Server must drop it (stale telemetry).
        bob_hw.send_json({
            "type": "audio_quality",
            "broadcaster_id": "stale-id-not-host",
            "intervals_received": 100,
        })
        # Then bob sends a deterministic event so we can assert host's
        # NEXT message is that one (not the dropped audio_quality).
        bob_hw.send_json({"type": "set_arrangement", "arrangement": "Rhythm"})
        evt = _drain_until(host_hw, lambda m: m.get("type") in {"audio_quality", "arrangement_changed"})
        assert evt["type"] == "arrangement_changed"


# ── broadcaster_changed null on session-end paths ─────────────────────────

def test_broadcast_ends_on_grace_expiry(client, routes_module, fast_grace):
    code, host_pid = _create_room(client)
    bob_pid = _join_room(client, code, "Bob")

    with client.websocket_connect(_audio_url(code, host_pid, "host-sid")), \
         client.websocket_connect(_highway_url(code, host_pid, "host-sid")) as host_hw, \
         client.websocket_connect(_highway_url(code, bob_pid, "bob-sid")) as bob_hw:
        host_hw.receive_json()
        bob_hw.receive_json()
        host_hw.receive_json()  # player_connected for bob

        host_hw.send_json({"type": "broadcast_start", **_VALID_PARAMS})
        host_hw.receive_json()
        bob_hw.receive_json()

        # Host disconnects (context exit). Wait past grace.
    time.sleep(fast_grace * 2.5)

    # Bob's WS is now closed too (the with-block exit), so re-open to
    # check final state via a fresh connection.
    with client.websocket_connect(_highway_url(code, bob_pid, "bob-sid-2")) as bob_hw2:
        snapshot = bob_hw2.receive_json()
        assert snapshot["room"]["broadcaster_id"] is None
    assert routes_module._rooms[code]["broadcaster_id"] is None


def test_broadcast_ends_on_leave_room(client, routes_module):
    code, host_pid = _create_room(client)
    bob_pid = _join_room(client, code, "Bob")

    with client.websocket_connect(_audio_url(code, host_pid, "host-sid")), \
         client.websocket_connect(_highway_url(code, host_pid, "host-sid")) as host_hw, \
         client.websocket_connect(_highway_url(code, bob_pid, "bob-sid")) as bob_hw:
        host_hw.receive_json()
        bob_hw.receive_json()
        host_hw.receive_json()  # player_connected for bob

        host_hw.send_json({"type": "broadcast_start", **_VALID_PARAMS})
        host_hw.receive_json()
        bob_hw.receive_json()

        # Host explicitly leaves via REST.
        r = client.post(
            f"/api/plugins/multiplayer/rooms/{code}/leave",
            json={"player_id": host_pid},
        )
        r.raise_for_status()

        evt = _drain_until(bob_hw, lambda m: m.get("type") == "broadcaster_changed")
        assert evt["broadcaster_id"] is None
        assert routes_module._rooms[code]["broadcaster_id"] is None


def test_broadcast_ends_on_takeover_by_different_session(client, routes_module):
    code, host_pid = _create_room(client)
    bob_pid = _join_room(client, code, "Bob")

    with client.websocket_connect(_audio_url(code, host_pid, "host-sid")), \
         client.websocket_connect(_highway_url(code, host_pid, "host-sid")) as host_hw, \
         client.websocket_connect(_highway_url(code, bob_pid, "bob-sid")) as bob_hw:
        host_hw.receive_json()
        bob_hw.receive_json()
        host_hw.receive_json()  # player_connected for bob

        host_hw.send_json({"type": "broadcast_start", **_VALID_PARAMS})
        host_hw.receive_json()
        bob_hw.receive_json()

        # A different session_id for the SAME host_pid arrives — Rule 3
        # takeover. The new tab must explicitly re-issue broadcast_start
        # to resume; the old broadcast is ended.
        with client.websocket_connect(_highway_url(code, host_pid, "host-sid-NEW")) as host_hw_new:
            # Old socket was closed with 4409; ignore.
            try:
                host_hw.receive_json()
            except WebSocketDisconnect:
                pass

            host_hw_new.receive_json()  # 'connected'
            evt = _drain_until(bob_hw, lambda m: m.get("type") == "broadcaster_changed")
            assert evt["broadcaster_id"] is None
            assert routes_module._rooms[code]["broadcaster_id"] is None
