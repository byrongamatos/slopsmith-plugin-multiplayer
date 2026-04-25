// Multiplayer plugin — synced rooms, shared queue, optional mixdown

(function () {
'use strict';

// ── State ──────────────────────────────────────────────────────────────
let _ws = null;
let _roomCode = null;
let _playerId = null;
let _sessionId = null;
let _playerName = '';
let _isHost = false;
let _room = null;

// Clock sync
let _clockOffset = 0;       // local_time - server_time in ms
let _pendingSyncResolve = null;

// Playback sync
let _heartbeatInterval = null;
let _driftResetTimer = null;
let _songLoading = false;

// Recording
let _mediaStream = null;
let _mediaRecorder = null;
let _recordedChunks = [];
let _isRecording = false;
let _recStartServerTime = 0;  // server time (ms) when recording started

// Reconnection
let _reconnectAttempts = 0;
let _reconnectTimer = null;
let _intentionalClose = false;

// Audio WebSocket (Phase 2a — connection lifecycle only; the listener +
// broadcast pipelines that actually consume / produce audio frames land
// in Phase 2b). The audio WS runs in parallel to the highway WS, sharing
// the same session_id, with its own independent reconnect timer because
// PROTOCOL.md "Per-endpoint grace" treats the two endpoints' liveness
// independently.
let _audioWs = null;
let _audioReconnectAttempts = 0;
let _audioReconnectTimer = null;

// Idempotency guard for _onSessionEnded: when a 4408 (grace expired) close
// fires, BOTH endpoint handlers see it. Resetting session_id twice would
// produce two different new ids, and the two reconnects would then collide
// (one would arrive as session A, the other as session B → server treats
// it as a Rule 3 takeover loop). _resetMarker remembers the new id we just
// minted; the second handler sees _sessionId == _resetMarker and skips.
//
// _resetMarker stays armed until BOTH endpoints have committed to the
// new session_id (highway received its `connected` message AND audio's
// onopen fired). Clearing on the first endpoint's commit alone reopens
// the race: a late 4408 from the still-stale OTHER endpoint would see
// _resetMarker == null and mint a SECOND fresh session_id, invalidating
// the recovery.
let _resetMarker = null;
let _highwayAuthedAfterReset = true;  // initially true — no reset has happened
let _audioOpenedAfterReset = true;

// Original functions (saved for restore on leave)
let _origTogglePlay = null;
let _origSeekBy = null;
let _origSetSpeed = null;

const STORAGE_KEY = 'slopsmith_mp';
const SESSION_STORAGE_KEY = 'mp_session';
const SYNC_ROUNDS = 5;
const HEARTBEAT_HZ = 100;  // ms between heartbeats

// Close codes from PROTOCOL.md "Endpoints" / "v1 server policy".
const CLOSE_GRACE_EXPIRED = 4408;
const CLOSE_SUPERSEDED = 4409;
const CLOSE_REPLACED = 4410;

function _mintSessionId() {
    // crypto.randomUUID is widely available; fall back through getRandomValues
    // if available, then to Math.random as last resort. Every reference to
    // `crypto` is gated by `typeof crypto !== 'undefined'` so environments
    // without Web Crypto don't throw a ReferenceError.
    const hasCrypto = typeof crypto !== 'undefined';
    if (hasCrypto && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (hasCrypto && typeof crypto.getRandomValues === 'function') {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function _getOrMintSessionId() {
    let sid = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!sid) {
        sid = _mintSessionId();
        sessionStorage.setItem(SESSION_STORAGE_KEY, sid);
    }
    return sid;
}

function _resetSessionId() {
    _sessionId = _mintSessionId();
    sessionStorage.setItem(SESSION_STORAGE_KEY, _sessionId);
}

function _onSessionEnded() {
    // Idempotent across concurrent handlers — see _resetMarker comment above.
    if (_resetMarker !== null && _resetMarker === _sessionId) {
        return;
    }
    _resetSessionId();
    _resetMarker = _sessionId;
    // Both endpoints must re-confirm BEFORE we'll consider the recovery
    // complete and clear the dedupe marker. See _maybeClearResetMarker.
    _highwayAuthedAfterReset = false;
    _audioOpenedAfterReset = false;
}

function _maybeClearResetMarker() {
    if (_highwayAuthedAfterReset && _audioOpenedAfterReset) {
        _resetMarker = null;
    }
}

// ── Lobby ──────────────────────────────────────────────────────────────

function _loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        _playerName = s.name || '';
        const nameCreate = document.getElementById('mp-create-name');
        const nameJoin = document.getElementById('mp-join-name');
        if (nameCreate) nameCreate.value = _playerName;
        if (nameJoin) nameJoin.value = _playerName;
    } catch (e) { /* ignore */ }
}

function _saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        name: _playerName,
    }));
}

let _lobbyErrorTimer = null;
function _showError(msg) {
    const el = document.getElementById('mp-lobby-error');
    if (el) {
        // Cancel any pending hide-timer from a prior error so the new message
        // gets a fresh 5-second window (otherwise an older error's timer can
        // hide a new message early — e.g. a takeover notice arriving moments
        // after a failed join attempt).
        if (_lobbyErrorTimer !== null) clearTimeout(_lobbyErrorTimer);
        el.textContent = msg;
        el.classList.remove('hidden');
        _lobbyErrorTimer = setTimeout(() => {
            el.classList.add('hidden');
            _lobbyErrorTimer = null;
        }, 5000);
    }
}

window.mpCreateRoom = async function () {
    const nameInput = document.getElementById('mp-create-name');
    const name = (nameInput?.value || '').trim();
    if (!name) { _showError('Enter your name'); return; }
    _playerName = name;
    _saveSettings();

    try {
        const resp = await fetch('/api/plugins/multiplayer/rooms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        const data = await resp.json();
        if (data.error) { _showError(data.error); return; }

        _roomCode = data.code;
        _playerId = data.player_id;
        _isHost = true;
        // Fresh join: always start with a new session_id so we can't accidentally
        // collide with a stale session left over from a previous tab.
        _resetSessionId();
        _resetMarker = null;  // fresh session — clear the 4408 dedupe marker
        sessionStorage.setItem('mp_room', _roomCode);
        sessionStorage.setItem('mp_player', _playerId);
        _connectWS();
        _connectAudioWs();
        _showRoomView();
    } catch (e) {
        _showError('Failed to create room');
    }
};

window.mpJoinRoom = async function () {
    const nameInput = document.getElementById('mp-join-name');
    const codeInput = document.getElementById('mp-join-code');
    const name = (nameInput?.value || '').trim();
    const code = (codeInput?.value || '').trim().toUpperCase();
    if (!name) { _showError('Enter your name'); return; }
    if (!code || code.length < 4) { _showError('Enter a valid room code'); return; }
    _playerName = name;
    _saveSettings();

    try {
        const resp = await fetch(`/api/plugins/multiplayer/rooms/${code}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        const data = await resp.json();
        if (data.error) { _showError(data.error); return; }

        _roomCode = data.code;
        _playerId = data.player_id;
        _isHost = false;
        _room = data.room;
        _resetSessionId();
        _resetMarker = null;
        sessionStorage.setItem('mp_room', _roomCode);
        sessionStorage.setItem('mp_player', _playerId);
        _connectWS();
        _connectAudioWs();
        _showRoomView();
    } catch (e) {
        _showError('Failed to join room');
    }
};

window.mpLeaveRoom = async function () {
    if (!_roomCode || !_playerId) return;
    _intentionalClose = true;

    try {
        await fetch(`/api/plugins/multiplayer/rooms/${_roomCode}/leave`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ player_id: _playerId }),
        });
    } catch (e) { /* ignore */ }

    _cleanup();
    _showLobbyView();
};

function _cleanup() {
    _stopRecording();
    _stopHeartbeat();
    _restorePlaybackControls();
    // Set _intentionalClose BEFORE closing either socket so neither close
    // handler triggers a reconnect during teardown.
    _intentionalClose = true;
    if (_ws) {
        try { _ws.close(); } catch (e) { /* ignore */ }
        _ws = null;
    }
    if (_audioWs) {
        try { _audioWs.close(); } catch (e) { /* ignore */ }
        _audioWs = null;
    }
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    if (_audioReconnectTimer) {
        clearTimeout(_audioReconnectTimer);
        _audioReconnectTimer = null;
    }
    _roomCode = null;
    _playerId = null;
    _sessionId = null;
    _isHost = false;
    _room = null;
    _reconnectAttempts = 0;
    _audioReconnectAttempts = 0;
    _resetMarker = null;
    _highwayAuthedAfterReset = true;
    _audioOpenedAfterReset = true;
    sessionStorage.removeItem('mp_room');
    sessionStorage.removeItem('mp_player');
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

// ── Views ──────────────────────────────────────────────────────────────

function _showLobbyView() {
    const lobby = document.getElementById('mp-lobby-view');
    const room = document.getElementById('mp-room-view');
    const mixer = document.getElementById('mp-mixer-view');
    // If the mixer was open and previewing, stop the preview before hiding it —
    // otherwise AudioBufferSourceNodes keep playing with no UI to stop them.
    // _mixerStop is a no-op if no preview is active. Wrapped in a try guard so
    // that early lobby renders (before the mixer module is wired up) can't
    // throw and leave the lobby unrendered.
    if (mixer && !mixer.classList.contains('hidden')) {
        try { _mixerStop(); } catch (e) { /* ignore */ }
    }
    if (lobby) lobby.classList.remove('hidden');
    if (room) room.classList.add('hidden');
    if (mixer) mixer.classList.add('hidden');
}

function _showRoomView() {
    const lobby = document.getElementById('mp-lobby-view');
    const room = document.getElementById('mp-room-view');
    if (lobby) lobby.classList.add('hidden');
    if (room) room.classList.remove('hidden');

    const codeEl = document.getElementById('mp-room-code');
    if (codeEl) codeEl.textContent = _roomCode || '';

    _renderPlayers();
    _renderQueue();
    _updateControls();
}

// ── WebSocket ──────────────────────────────────────────────────────────

function _connectWS() {
    // Stale-out the old socket BEFORE closing it. If onclose fires synchronously
    // (or before we reassign _ws below), the early-return `if (ws !== _ws)` in
    // the close handler catches it and avoids touching state for a connection
    // we're intentionally replacing.
    if (_ws) {
        const old = _ws;
        _ws = null;
        try { old.close(); } catch (e) { /* */ }
    }
    _intentionalClose = false;
    if (!_sessionId) _sessionId = _getOrMintSessionId();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/plugins/multiplayer/${_roomCode}`
        + `?player_id=${encodeURIComponent(_playerId)}`
        + `&session_id=${encodeURIComponent(_sessionId)}`;
    const ws = new WebSocket(url);
    _ws = ws;

    const statusEl = document.getElementById('mp-connection-status');

    ws.onopen = () => {
        _reconnectAttempts = 0;
        if (statusEl) statusEl.textContent = 'Connected';
        // Clock sync starts when we receive 'connected' message
    };

    ws.onmessage = (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            _handleMessage(msg);
        } catch (e) {
            console.error('[MP] Bad message:', e);
        }
    };

    ws.onclose = (ev) => {
        // If a newer connection has already replaced _ws, this is the OLD socket
        // closing — don't touch global state or trigger reconnect.
        if (ws !== _ws) return;
        _stopHeartbeat();

        if (ev && ev.code === CLOSE_REPLACED) {
            // Same-session reconnect performed by us elsewhere; new socket has
            // already taken over (or is about to). Nothing to do here.
            if (statusEl) statusEl.textContent = 'Connection replaced';
            return;
        }
        if (ev && ev.code === CLOSE_SUPERSEDED) {
            // Different tab took over the session. Per PROTOCOL.md, we MUST NOT
            // auto-reconnect (would just steal back). Run the full cleanup path
            // (clears _room, _isHost, _roomCode/_playerId/_sessionId, restores
            // playback controls, removes sessionStorage keys) and bounce back to
            // the lobby so the UI doesn't keep showing the room view, host
            // controls, OR mixer view for a session this tab no longer owns.
            _cleanup();
            _showLobbyView();
            // Surface the takeover notice via the lobby-visible error element;
            // #mp-connection-status lives inside the now-hidden room view.
            _showError('Session moved to another tab');
            return;
        }
        if (ev && ev.code === CLOSE_GRACE_EXPIRED) {
            // Grace expired without reattach. The held session is dead; mint a
            // fresh session_id (idempotently — _onSessionEnded handles the
            // race with the audio WS handler that also sees 4408) and let
            // the reconnect path open a new one.
            _onSessionEnded();
            if (statusEl) statusEl.textContent = 'Reconnecting…';
            if (!_intentionalClose && _roomCode) {
                _scheduleReconnect();
                _scheduleAudioReconnect();
            }
            return;
        }

        if (statusEl) statusEl.textContent = 'Disconnected';
        if (!_intentionalClose && _roomCode) {
            _scheduleReconnect();
        }
    };

    ws.onerror = () => {
        if (statusEl) statusEl.textContent = 'Connection error';
    };
}

function _scheduleReconnect() {
    if (_reconnectTimer) return;
    _reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, _reconnectAttempts - 1), 30000);
    const statusEl = document.getElementById('mp-connection-status');
    if (statusEl) statusEl.textContent = `Reconnecting in ${Math.round(delay / 1000)}s...`;
    _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        if (_roomCode && _playerId) {
            _connectWS();
        }
    }, delay);
}

// ── Audio WS (Phase 2a) ───────────────────────────────────────────────────
//
// Lifecycle parallels _connectWS / _scheduleReconnect on the highway side.
// Per PROTOCOL.md "Per-endpoint grace", the audio WS has its own grace
// window and reconnect cadence independent of the highway. Phase 2a wires
// the connection lifecycle only — frame send / receive land in Phase 2b.

function _connectAudioWs() {
    // Stale-out the old socket BEFORE closing it so a synchronous onclose
    // for the OLD ws hits the early-return `if (ws !== _audioWs)` and
    // doesn't try to reconnect / mutate state we're intentionally
    // replacing. (Same pattern as _connectWS.)
    if (_audioWs) {
        const old = _audioWs;
        _audioWs = null;
        try { old.close(); } catch (e) { /* */ }
    }
    if (!_roomCode || !_playerId) return;
    if (!_sessionId) _sessionId = _getOrMintSessionId();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/plugins/multiplayer/${_roomCode}/audio`
        + `?player_id=${encodeURIComponent(_playerId)}`
        + `&session_id=${encodeURIComponent(_sessionId)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    _audioWs = ws;

    ws.onopen = () => {
        // PROTOCOL.md "Implementation note (client side)": open is NOT proof
        // of auth on the audio WS. Don't surface "ready" UI here — the
        // user-visible "audio is live" signal lives in the highway WS
        // control plane (broadcaster_changed) and the first inbound frame.
        _audioReconnectAttempts = 0;
        // Audio side of a session-recovery has reattached. _maybeClearResetMarker
        // only clears the dedupe marker once the highway side has ALSO
        // reattached. See _resetMarker comment.
        _audioOpenedAfterReset = true;
        _maybeClearResetMarker();
    };

    ws.onmessage = (ev) => {
        // Phase 2a: no listener pipeline yet. Phase 2b will parse the SMAU
        // header and feed frames into the decoder. For now, drop binary
        // frames silently and ignore any text frames the server might
        // someday send (spec is binary-only in v1).
        // Intentionally a no-op.
    };

    ws.onclose = (ev) => {
        if (ws !== _audioWs) return;

        if (ev && ev.code === CLOSE_REPLACED) {
            // Same-session reconnect of the audio slot — a new audio ws has
            // already taken over. Nothing to do here.
            return;
        }
        if (ev && ev.code === CLOSE_SUPERSEDED) {
            // Different tab took over the whole session. Normally the
            // highway-side 4409 handler runs the lobby bounce — the server
            // closes both endpoints simultaneously, and the highway path
            // gets there first. But the spec explicitly allows audio-only
            // sessions during per-endpoint grace, so this audio close may
            // be the ONLY 4409 we see. If the highway socket is already
            // gone (or never attached), run the cleanup ourselves;
            // otherwise leave it to the highway handler.
            const highwayDead = (
                _ws === null
                || _ws.readyState === WebSocket.CLOSING
                || _ws.readyState === WebSocket.CLOSED
            );
            if (highwayDead) {
                _cleanup();
                _showLobbyView();
                _showError('Session moved to another tab');
            }
            return;
        }
        if (ev && ev.code === CLOSE_GRACE_EXPIRED) {
            // Grace expired. Reset session_id idempotently (the highway
            // 4408 handler may have already done it) and reconnect both
            // endpoints under the new session_id.
            _onSessionEnded();
            if (!_intentionalClose && _roomCode) {
                _scheduleReconnect();
                _scheduleAudioReconnect();
            }
            return;
        }
        // 4401 (auth fail), 1009 (frame too big), 1011 (server error), or
        // a transient drop. For 4401 we don't auto-reconnect — the highway
        // side rejection is the primary signal and will handle UI cleanup.
        // For 1009 we also don't auto-reconnect (we sent a bad frame). For
        // everything else (including 1006 abnormal close), reconnect.
        if (ev && (ev.code === 4401 || ev.code === 1009)) return;
        if (!_intentionalClose && _roomCode) _scheduleAudioReconnect();
    };

    ws.onerror = () => {
        // Errors that aren't followed by a close event are rare; the close
        // handler does the recovery work. Don't duplicate it here.
    };
}

function _scheduleAudioReconnect() {
    if (_audioReconnectTimer) return;
    _audioReconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, _audioReconnectAttempts - 1), 30000);
    _audioReconnectTimer = setTimeout(() => {
        _audioReconnectTimer = null;
        if (_roomCode && _playerId) {
            _connectAudioWs();
        }
    }, delay);
}

// ── Message Handling ───────────────────────────────────────────────────

function _handleMessage(msg) {
    switch (msg.type) {
        case 'connected':
            _room = msg.room;
            _isHost = _room.host === _playerId;
            _renderPlayers();
            _renderQueue();
            _updateControls();
            _doClockSync();
            // Highway side of the recovery is confirmed. _maybeClearResetMarker
            // only clears the dedupe marker once the audio side has ALSO
            // reattached — see _resetMarker comment for the race this guards.
            _highwayAuthedAfterReset = true;
            _maybeClearResetMarker();
            break;

        case 'clock_sync_response':
            if (_pendingSyncResolve) {
                _pendingSyncResolve(msg);
                _pendingSyncResolve = null;
            }
            break;

        case 'player_joined':
            if (_room) {
                _room.players[msg.player_id] = {
                    name: msg.name,
                    arrangement: msg.arrangement || 'Lead',
                    connected: false,
                };
                _renderPlayers();
            }
            break;

        case 'player_left':
            if (_room) {
                delete _room.players[msg.player_id];
                _renderPlayers();
            }
            break;

        case 'player_connected':
            if (_room && _room.players[msg.player_id]) {
                _room.players[msg.player_id].connected = true;
                _renderPlayers();
            }
            break;

        case 'player_disconnected':
            if (_room && _room.players[msg.player_id]) {
                _room.players[msg.player_id].connected = false;
                _renderPlayers();
            }
            break;

        case 'host_changed':
            if (_room) {
                _room.host = msg.new_host_id;
                _isHost = _room.host === _playerId;
                if (_isHost) _startHeartbeat();
                else _stopHeartbeat();
                _renderPlayers();
                _updateControls();
            }
            break;

        case 'arrangement_changed':
            if (_room && _room.players[msg.player_id]) {
                _room.players[msg.player_id].arrangement = msg.arrangement;
                _renderPlayers();
            }
            break;

        case 'playback_state':
            if (!_isHost) _onPlaybackState(msg);
            if (_room) {
                _room.state = msg.state;
                _room.time = msg.time;
                _room.speed = msg.speed;
            }
            break;

        case 'heartbeat':
            if (!_isHost) _onHeartbeat(msg);
            break;

        case 'queue_updated':
            if (_room) {
                _room.queue = msg.queue;
                _room.now_playing = msg.now_playing;
                _renderQueue();
            }
            break;

        case 'song_changed':
            if (_room) {
                _room.now_playing = msg.now_playing;
                _room.state = 'stopped';
                _room.time = 0;
                _renderQueue();
                _updateNowPlaying();
                // Host already called _loadSong in mpLoadSong — skip to avoid double-load
                if (!_isHost && msg.queue_item) _loadSong(msg.queue_item);
            }
            break;

        case 'queue_finished':
            if (_room) {
                _room.now_playing = -1;
                _room.state = 'stopped';
                _renderQueue();
                _updateNowPlaying();
            }
            break;

        case 'vote_skip':
            _updateSkipCount(msg.votes, msg.needed);
            break;

        case 'recording_state':
            if (_room) _room.recording = msg.recording;
            _onRecordingState(msg.recording);
            break;

        case 'recording_uploaded':
            if (_room) {
                if (!_room.recordings_received) _room.recordings_received = [];
                if (msg.player_id && !_room.recordings_received.includes(msg.player_id)) {
                    _room.recordings_received.push(msg.player_id);
                }
            }
            _updateRecordingStatus(msg);
            break;

        case 'mixdown_ready':
            _onMixdownReady(msg.url);
            break;

        case 'room_destroyed':
            _cleanup();
            _showLobbyView();
            _showError('Room was closed');
            break;

        case 'error':
            console.error('[MP] Server error:', msg.message);
            break;
    }
}

// ── Clock Sync ─────────────────────────────────────────────────────────

async function _doClockSync() {
    const rounds = [];

    for (let i = 0; i < SYNC_ROUNDS; i++) {
        const t1 = performance.now();
        _ws.send(JSON.stringify({ type: 'clock_sync_request', client_t1: t1 }));

        const result = await new Promise((resolve) => {
            _pendingSyncResolve = resolve;
            setTimeout(() => {
                if (_pendingSyncResolve === resolve) {
                    _pendingSyncResolve = null;
                    resolve(null);
                }
            }, 2000);
        });

        if (result) {
            const t4 = performance.now();
            const rtt = (t4 - result.client_t1) - (result.server_t3 - result.server_t2);
            const offset = ((result.server_t2 - result.client_t1) + (result.server_t3 - t4)) / 2;
            rounds.push({ rtt, offset });
        }

        await new Promise(r => setTimeout(r, 50));
    }

    if (rounds.length >= 3) {
        rounds.sort((a, b) => a.rtt - b.rtt);
        const mid = Math.floor(rounds.length / 2);
        _clockOffset = rounds[mid].offset;
    }

    console.log(`[MP] Clock sync: offset=${_clockOffset.toFixed(1)}ms (${rounds.length} rounds)`);

    // If host, start heartbeat
    if (_isHost) _startHeartbeat();

    // Intercept playback controls
    _interceptPlaybackControls();
}

// ── Playback Sync ──────────────────────────────────────────────────────

function _startHeartbeat() {
    _stopHeartbeat();
    _heartbeatInterval = setInterval(() => {
        if (!_ws || _ws.readyState !== WebSocket.OPEN || !_isHost) return;
        const audio = document.getElementById('audio');
        if (!audio || audio.paused) return;
        _ws.send(JSON.stringify({
            type: 'heartbeat',
            time: audio.currentTime,
            client_time: performance.now(),
        }));
    }, HEARTBEAT_HZ);
}

function _stopHeartbeat() {
    if (_heartbeatInterval) {
        clearInterval(_heartbeatInterval);
        _heartbeatInterval = null;
    }
}

function _onPlaybackState(msg) {
    const audio = document.getElementById('audio');
    if (!audio) return;

    if (msg.state === 'playing') {
        audio.currentTime = msg.time;
        audio.playbackRate = msg.speed || 1.0;
        audio.play().catch(() => {});
        if (typeof isPlaying !== 'undefined') isPlaying = true;
        const btn = document.getElementById('btn-play');
        if (btn) btn.textContent = '\u23F8 Pause';
        const mpBtn = document.getElementById('mp-btn-play');
        if (mpBtn) mpBtn.textContent = 'Pause';
        _startRecordingNow();
    } else if (msg.state === 'paused') {
        audio.currentTime = msg.time;
        audio.pause();
        if (typeof isPlaying !== 'undefined') isPlaying = false;
        const btn = document.getElementById('btn-play');
        if (btn) btn.textContent = '\u25B6 Play';
        const mpBtn = document.getElementById('mp-btn-play');
        if (mpBtn) mpBtn.textContent = 'Play';
    }

    // Update speed UI
    const speedLabel = document.getElementById('mp-speed-label');
    const speedSlider = document.getElementById('mp-speed');
    if (speedLabel) speedLabel.textContent = (msg.speed || 1.0).toFixed(2) + 'x';
    if (speedSlider) speedSlider.value = Math.round((msg.speed || 1.0) * 100);
}

function _onHeartbeat(msg) {
    if (_isHost || _songLoading) return;
    const audio = document.getElementById('audio');
    if (!audio || audio.paused) return;

    const drift = audio.currentTime - msg.time;
    const absDrift = Math.abs(drift);

    if (absDrift > 0.5) {
        // Hard seek
        audio.currentTime = msg.time;
        if (typeof highway !== 'undefined') highway.setTime(msg.time);
    } else if (absDrift > 0.05) {
        // Micro-adjust: if ahead slow down, if behind speed up
        const baseSpeed = (_room && _room.speed) || 1.0;
        const correction = drift > 0 ? -0.002 : 0.002;
        audio.playbackRate = baseSpeed + correction;

        if (_driftResetTimer) clearTimeout(_driftResetTimer);
        _driftResetTimer = setTimeout(() => {
            audio.playbackRate = baseSpeed;
            _driftResetTimer = null;
        }, 500);
    }
}

// ── Playback Interception ──────────────────────────────────────────────

function _injectPlayerRecBtn() {
    const c = document.getElementById('player-controls');
    if (!c || document.getElementById('mp-player-rec-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'mp-player-rec-btn';
    btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
    btn.textContent = 'REC';
    btn.title = _isHost ? 'Toggle recording' : 'Recording controlled by host';
    btn.disabled = !_isHost;
    btn.style.opacity = _isHost ? '' : '0.5';
    btn.onclick = () => {
        if (!_isHost || !_ws) return;
        const isRec = _room && _room.recording;
        _ws.send(JSON.stringify({ type: isRec ? 'stop_recording' : 'start_recording' }));
    };
    // Update appearance based on current state
    if (_room && _room.recording) {
        btn.className = 'px-3 py-1.5 bg-red-900/50 hover:bg-red-800/50 rounded-lg text-xs text-red-400 transition';
        btn.textContent = '⏺ REC';
    }
    const separator = c.querySelector('span.text-gray-700');
    if (separator) c.insertBefore(btn, separator);
    else c.appendChild(btn);
}

function _removePlayerRecBtn() {
    const btn = document.getElementById('mp-player-rec-btn');
    if (btn) btn.remove();
}

function _updatePlayerRecBtn(recording) {
    const btn = document.getElementById('mp-player-rec-btn');
    if (!btn) return;
    if (recording) {
        btn.className = 'px-3 py-1.5 bg-red-900/50 hover:bg-red-800/50 rounded-lg text-xs text-red-400 transition';
        btn.textContent = '⏺ REC';
    } else {
        btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
        btn.textContent = 'REC';
    }
}

function _interceptPlaybackControls() {
    if (_origTogglePlay) return; // already intercepted
    _injectPlayerRecBtn();
    _origTogglePlay = window.togglePlay;
    _origSeekBy = window.seekBy;
    _origSetSpeed = window.setSpeed;

    window.togglePlay = function () {
        if (_roomCode) {
            if (_isHost) {
                mpTogglePlay();
            }
            // Non-host: no-op
        } else if (_origTogglePlay) {
            _origTogglePlay();
        }
    };

    window.seekBy = function (s) {
        if (_roomCode) {
            if (_isHost) mpSeek(s);
        } else if (_origSeekBy) {
            _origSeekBy(s);
        }
    };

    window.setSpeed = function (v) {
        if (_roomCode) {
            if (_isHost) mpSetSpeed(v);
        } else if (_origSetSpeed) {
            _origSetSpeed(v);
        }
    };
}

function _restorePlaybackControls() {
    if (_origTogglePlay) { window.togglePlay = _origTogglePlay; _origTogglePlay = null; }
    if (_origSeekBy) { window.seekBy = _origSeekBy; _origSeekBy = null; }
    if (_origSetSpeed) { window.setSpeed = _origSetSpeed; _origSetSpeed = null; }
    _removePlayerRecBtn();
}

// ── Host Playback Controls ─────────────────────────────────────────────

function mpTogglePlay() {
    const audio = document.getElementById('audio');
    if (!audio || !_ws || !_isHost) return;

    if (audio.paused) {
        audio.play().catch(() => {});
        if (typeof isPlaying !== 'undefined') isPlaying = true;
        _ws.send(JSON.stringify({
            type: 'play',
            time: audio.currentTime,
            speed: audio.playbackRate,
        }));
        const btn = document.getElementById('mp-btn-play');
        if (btn) btn.textContent = 'Pause';
        const mainBtn = document.getElementById('btn-play');
        if (mainBtn) mainBtn.textContent = '\u23F8 Pause';
        _startRecordingNow();
    } else {
        audio.pause();
        if (typeof isPlaying !== 'undefined') isPlaying = false;
        _ws.send(JSON.stringify({
            type: 'pause',
            time: audio.currentTime,
        }));
        const btn = document.getElementById('mp-btn-play');
        if (btn) btn.textContent = 'Play';
        const mainBtn = document.getElementById('btn-play');
        if (mainBtn) mainBtn.textContent = '\u25B6 Play';
    }
}
window.mpTogglePlay = mpTogglePlay;

function mpSeek(delta) {
    const audio = document.getElementById('audio');
    if (!audio || !_ws || !_isHost) return;
    audio.currentTime = Math.max(0, audio.currentTime + delta);
    _ws.send(JSON.stringify({
        type: 'seek',
        time: audio.currentTime,
    }));
}
window.mpSeek = mpSeek;

function mpSetSpeed(val) {
    const audio = document.getElementById('audio');
    if (!audio || !_ws || !_isHost) return;
    const speed = parseFloat(val) / 100;
    audio.playbackRate = speed;
    _ws.send(JSON.stringify({
        type: 'set_speed',
        speed: speed,
    }));
    const label = document.getElementById('mp-speed-label');
    if (label) label.textContent = speed.toFixed(2) + 'x';
}
window.mpSetSpeed = mpSetSpeed;

// ── Song Loading ───────────────────────────────────────────────────────

async function _loadSong(queueItem) {
    _songLoading = true;

    // Find arrangement index matching this player's chosen arrangement
    const myArrangement = (_room && _room.players[_playerId])
        ? _room.players[_playerId].arrangement : 'Lead';
    let arrIndex;
    const arrs = queueItem.arrangements || [];
    const idx = arrs.findIndex(a =>
        (typeof a === 'string' ? a : a.name) === myArrangement
    );
    if (idx >= 0) arrIndex = idx;

    // Call global playSong (await to let the full plugin chain set up)
    if (typeof playSong === 'function') {
        await playSong(queueItem.filename, arrIndex);
    }

    // Give plugins time to finish async setup (stems, highway _onReady, etc.)
    await new Promise(r => setTimeout(r, 2000));
    _songLoading = false;

    if (!_isHost) {
        const audio = document.getElementById('audio');
        if (audio) {
            audio.pause();
            if (typeof isPlaying !== 'undefined') isPlaying = false;
        }
    }
}

// Host loads and starts a song from the queue
window.mpLoadSong = function (index) {
    if (!_isHost || !_ws) return;
    _ws.send(JSON.stringify({ type: 'load_song', index: index }));
    // Also load locally
    if (_room && _room.queue[index]) {
        _room.now_playing = index;
        _room.state = 'stopped';
        _room.time = 0;
        _renderQueue();
        _updateNowPlaying();
        _loadSong(_room.queue[index]);
    }
};

// ── Queue UI ───────────────────────────────────────────────────────────

window.mpSearchSongs = async function () {
    const q = document.getElementById('mp-search')?.value.trim();
    if (!q) return;
    const resp = await fetch(`/api/library?q=${encodeURIComponent(q)}&page=0&size=10&sort=artist`);
    const data = await resp.json();
    const container = document.getElementById('mp-search-results');
    if (!container) return;

    if (!data.songs || data.songs.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-xs py-2">No results</p>';
        return;
    }

    container.innerHTML = data.songs.map(s => {
        const arrs = (s.arrangements || []).map(a => a.name || a);
        const arrsJson = JSON.stringify(arrs).replace(/'/g, "\\'").replace(/"/g, '&quot;');
        return `<div class="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-dark-700/50 transition">
            <div class="flex-1 min-w-0">
                <span class="text-sm text-white">${esc(s.title)}</span>
                <span class="text-xs text-gray-500 ml-2">${esc(s.artist)}</span>
            </div>
            <button onclick="mpAddToQueue('${encodeURIComponent(s.filename)}','${esc(s.title).replace(/'/g,"\\'")}','${esc(s.artist).replace(/'/g,"\\'")}', '${arrsJson}')"
                class="px-3 py-1 bg-dark-600 hover:bg-accent/30 rounded text-xs text-gray-300 hover:text-white transition flex-shrink-0">+ Add</button>
        </div>`;
    }).join('');
};

window.mpAddToQueue = async function (filename, title, artist, arrsJson) {
    if (!_roomCode || !_playerId) return;
    let arrangements = [];
    try { arrangements = JSON.parse(arrsJson.replace(/&quot;/g, '"')); } catch (e) { /* */ }
    await fetch(`/api/plugins/multiplayer/rooms/${_roomCode}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            player_id: _playerId,
            filename: decodeURIComponent(filename),
            title, artist, arrangements,
        }),
    });
};

window.mpRemoveFromQueue = async function (index) {
    if (!_roomCode) return;
    await fetch(`/api/plugins/multiplayer/rooms/${_roomCode}/queue/${index}?player_id=${_playerId}`, {
        method: 'DELETE',
    });
};

window.mpVoteSkip = async function () {
    if (!_roomCode || !_playerId) return;
    await fetch(`/api/plugins/multiplayer/rooms/${_roomCode}/vote-skip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: _playerId }),
    });
};

function _renderQueue() {
    if (!_room) return;
    const container = document.getElementById('mp-queue-list');
    const countEl = document.getElementById('mp-queue-count');
    if (!container) return;

    if (countEl) countEl.textContent = _room.queue.length ? `${_room.queue.length} song${_room.queue.length !== 1 ? 's' : ''}` : '';

    if (_room.queue.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-sm">No songs in queue.</p>';
        _updateNowPlaying();
        return;
    }

    container.innerHTML = _room.queue.map((item, i) => {
        const isCurrent = i === _room.now_playing;
        const addedBy = _findPlayerName(item.added_by);
        return `<div class="flex items-center gap-3 ${isCurrent ? 'bg-accent/10 border-accent/30' : 'bg-dark-700/30 border-gray-800/30'} border rounded-lg p-3 transition">
            <span class="text-xs ${isCurrent ? 'text-accent' : 'text-gray-600'} w-6 text-center font-mono">${isCurrent ? '\u25B6' : i + 1}</span>
            <div class="flex-1 min-w-0 ${_isHost && i !== _room.now_playing ? 'cursor-pointer' : ''}"
                 ${_isHost && i !== _room.now_playing ? `onclick="mpLoadSong(${i})"` : ''}>
                <span class="text-sm text-white truncate block">${esc(item.title || item.filename)}</span>
                <span class="text-xs text-gray-500">${esc(item.artist || '')}${addedBy ? ' \u00B7 added by ' + esc(addedBy) : ''}</span>
            </div>
            <button onclick="mpRemoveFromQueue(${i})"
                class="px-2 py-1 text-gray-600 hover:text-red-400 transition text-xs flex-shrink-0">\u2715</button>
        </div>`;
    }).join('');

    _updateNowPlaying();
}

function _updateNowPlaying() {
    const infoEl = document.getElementById('mp-now-playing-info');
    if (!infoEl || !_room) return;

    if (_room.now_playing >= 0 && _room.now_playing < _room.queue.length) {
        const item = _room.queue[_room.now_playing];
        infoEl.innerHTML = `
            <div class="text-white font-semibold">${esc(item.title || item.filename)}</div>
            <div class="text-xs text-gray-500 mt-0.5">${esc(item.artist || '')}</div>
        `;
    } else {
        infoEl.textContent = 'No song loaded. Add songs to the queue below.';
    }
}

function _updateSkipCount(votes, needed) {
    const el1 = document.getElementById('mp-skip-count');
    const el2 = document.getElementById('mp-skip-count-guest');
    const text = `(${votes}/${needed})`;
    if (el1) el1.textContent = text;
    if (el2) el2.textContent = text;
}

function _findPlayerName(playerId) {
    if (!_room || !playerId) return '';
    const p = _room.players[playerId];
    return p ? p.name : '';
}

// ── Player List ────────────────────────────────────────────────────────

function _renderPlayers() {
    const container = document.getElementById('mp-player-list');
    if (!container || !_room) return;

    const pids = Object.keys(_room.players);
    container.innerHTML = pids.map(pid => {
        const p = _room.players[pid];
        const isMe = pid === _playerId;
        const isPlayerHost = pid === _room.host;
        return `<div class="flex items-center gap-3 bg-dark-800/50 rounded-lg p-3 ${isMe ? 'ring-1 ring-accent/30' : ''}">
            <div class="w-2 h-2 rounded-full flex-shrink-0 ${p.connected ? 'bg-green-400' : 'bg-gray-600'}"></div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                    <span class="text-sm text-white truncate">${esc(p.name)}</span>
                    ${isPlayerHost ? '<span class="text-[10px] bg-amber-900/40 text-amber-400 px-1.5 py-0.5 rounded">Host</span>' : ''}
                    ${isMe ? '<span class="text-[10px] bg-accent/20 text-accent-light px-1.5 py-0.5 rounded">You</span>' : ''}
                </div>
            </div>
            ${isMe
                ? `<select onchange="mpSetArrangement(this.value)"
                    class="bg-dark-700 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-accent/50">
                    <option value="Lead" ${p.arrangement === 'Lead' ? 'selected' : ''}>Lead</option>
                    <option value="Rhythm" ${p.arrangement === 'Rhythm' ? 'selected' : ''}>Rhythm</option>
                    <option value="Bass" ${p.arrangement === 'Bass' ? 'selected' : ''}>Bass</option>
                  </select>`
                : `<span class="text-xs text-gray-500">${esc(p.arrangement)}</span>`
            }
        </div>`;
    }).join('');
}

window.mpSetArrangement = function (arr) {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
    _ws.send(JSON.stringify({ type: 'set_arrangement', arrangement: arr }));
    if (_room && _room.players[_playerId]) {
        _room.players[_playerId].arrangement = arr;
    }
};

// ── Controls Visibility ────────────────────────────────────────────────

function _updateControls() {
    const hostControls = document.getElementById('mp-host-controls');
    const guestControls = document.getElementById('mp-guest-controls');
    const recSection = document.getElementById('mp-recording-section');

    if (hostControls) hostControls.classList.toggle('hidden', !_isHost);
    if (guestControls) guestControls.classList.toggle('hidden', _isHost);
    if (recSection) recSection.classList.toggle('hidden', !_isHost);
}

// ── Copy Room Code ─────────────────────────────────────────────────────

window.mpCopyCode = function () {
    if (!_roomCode) return;
    navigator.clipboard.writeText(_roomCode).then(() => {
        const toast = document.getElementById('mp-copy-toast');
        if (toast) {
            toast.classList.remove('opacity-0');
            toast.classList.add('opacity-100');
            setTimeout(() => {
                toast.classList.remove('opacity-100');
                toast.classList.add('opacity-0');
            }, 1500);
        }
    }).catch(() => {});
};

// ── Recording ──────────────────────────────────────────────────────────

window.mpToggleRecording = function () {
    if (!_isHost || !_ws) return;
    const toggle = document.getElementById('mp-rec-toggle');
    const enabling = toggle?.checked;
    _ws.send(JSON.stringify({
        type: enabling ? 'start_recording' : 'stop_recording',
    }));
};

let _recArmed = false;  // armed but not yet recording (waiting for play)

function _onRecordingState(recording) {
    const indicator = document.getElementById('mp-rec-indicator');
    const recToggle = document.getElementById('mp-rec-toggle');
    const guestRec = document.getElementById('mp-guest-rec-status');

    if (indicator) indicator.classList.toggle('hidden', !recording);
    if (recToggle) recToggle.checked = recording;
    _updatePlayerRecBtn(recording);

    if (recording) {
        _armRecording();
        if (!_isHost && guestRec) guestRec.classList.remove('hidden');
    } else {
        _recArmed = false;
        _stopAndUploadRecording();
        if (guestRec) setTimeout(() => guestRec.classList.add('hidden'), 3000);
    }
}

async function _armRecording() {
    // Get mic access and prepare MediaRecorder, but don't start yet — wait for play.
    try {
        // Use desktop bridge if available
        if (window.slopsmithDesktop?.audio?.startRecording) {
            _recArmed = true;
            const statusEl = _isHost
                ? document.getElementById('mp-rec-status')
                : document.getElementById('mp-guest-rec-info');
            if (statusEl) statusEl.textContent = 'Armed — will record when song plays';
            return;
        }

        _mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            }
        });
        _recordedChunks = [];

        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus' : 'audio/webm';
        _mediaRecorder = new MediaRecorder(_mediaStream, { mimeType });

        _mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) _recordedChunks.push(e.data);
        };

        // Don't start yet — armed and waiting for playback
        _recArmed = true;

        const statusEl = _isHost
            ? document.getElementById('mp-rec-status')
            : document.getElementById('mp-guest-rec-info');
        if (statusEl) statusEl.textContent = 'Armed — will record when song plays';
    } catch (e) {
        console.error('[MP] getUserMedia failed:', e);
        const statusEl = _isHost
            ? document.getElementById('mp-rec-status')
            : document.getElementById('mp-guest-rec-info');
        if (statusEl) statusEl.textContent = 'Mic access denied: ' + e.message;
    }
}

function _startRecordingNow() {
    // Actually start the MediaRecorder — called when playback begins.
    if (!_recArmed || _isRecording) return;

    // Capture the song position when recording starts — this is the shared
    // reference both host and client agree on (synced via heartbeat).
    const audio = document.getElementById('audio');
    _recStartServerTime = audio ? audio.currentTime * 1000 : 0;  // ms into song

    if (window.slopsmithDesktop?.audio?.startRecording) {
        window.slopsmithDesktop.audio.startRecording();
        _isRecording = true;
        return;
    }

    if (_mediaRecorder && _mediaRecorder.state === 'inactive') {
        _recordedChunks = [];
        _mediaRecorder.start(1000);
        _isRecording = true;
        console.log('[MP] Recording started at song position:', (_recStartServerTime / 1000).toFixed(3), 's');

        const statusEl = _isHost
            ? document.getElementById('mp-rec-status')
            : document.getElementById('mp-guest-rec-info');
        if (statusEl) statusEl.textContent = 'Recording...';
    }
}

function _stopRecording() {
    _isRecording = false;
    if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
        try { _mediaRecorder.stop(); } catch (e) { /* */ }
    }
    if (_mediaStream) {
        _mediaStream.getTracks().forEach(t => t.stop());
        _mediaStream = null;
    }
    _mediaRecorder = null;
}

async function _stopAndUploadRecording() {
    if (!_isRecording) return;

    // Desktop bridge
    if (window.slopsmithDesktop?.audio?.stopRecording) {
        const blob = await window.slopsmithDesktop.audio.stopRecording();
        _isRecording = false;
        if (blob) await _uploadBlob(blob, 'recording.wav');
        return;
    }

    if (!_mediaRecorder || _mediaRecorder.state === 'inactive') {
        _isRecording = false;
        return;
    }

    _mediaRecorder.stop();
    if (_mediaStream) {
        _mediaStream.getTracks().forEach(t => t.stop());
        _mediaStream = null;
    }

    // Wait for final chunks
    await new Promise(resolve => {
        _mediaRecorder.onstop = resolve;
    });

    _isRecording = false;

    if (_recordedChunks.length === 0) return;
    const blob = new Blob(_recordedChunks, { type: 'audio/webm' });
    _recordedChunks = [];

    await _uploadBlob(blob, 'recording.webm');
}

async function _uploadBlob(blob, filename) {
    const progressContainer = _isHost
        ? document.getElementById('mp-upload-progress')
        : document.getElementById('mp-guest-upload-progress');
    const progressBar = _isHost
        ? document.getElementById('mp-upload-bar')
        : document.getElementById('mp-guest-upload-bar');

    if (progressContainer) progressContainer.classList.remove('hidden');

    const formData = new FormData();
    formData.append('file', blob, filename);
    formData.append('player_id', _playerId);
    formData.append('start_server_time', String(_recStartServerTime));

    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/plugins/multiplayer/rooms/${_roomCode}/upload`);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && progressBar) {
                progressBar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
            }
        };
        xhr.onload = () => {
            if (progressBar) progressBar.style.width = '100%';
            setTimeout(() => {
                if (progressContainer) progressContainer.classList.add('hidden');
            }, 2000);
            resolve();
        };
        xhr.onerror = () => {
            console.error('[MP] Upload failed');
            if (progressContainer) progressContainer.classList.add('hidden');
            resolve();
        };
        xhr.send(formData);
    });
}

function _updateRecordingStatus(msg) {
    if (!_isHost) return;
    const statusEl = document.getElementById('mp-rec-status');
    const mixSection = document.getElementById('mp-mixdown-section');
    const mixStatus = document.getElementById('mp-mixdown-status');

    if (statusEl) {
        statusEl.textContent = `${msg.total_uploads}/${msg.total_players} recordings received`;
    }

    if (mixSection && msg.total_uploads > 0) {
        mixSection.classList.remove('hidden');
        if (mixStatus) {
            mixStatus.textContent = `${msg.total_uploads} track${msg.total_uploads !== 1 ? 's' : ''} ready to mix`;
        }
        _renderStemToggles();
    }
}

function _renderStemToggles() {
    const container = document.getElementById('mp-stem-toggles');
    if (!container) return;

    // Get stem names from the song info
    const info = (typeof highway !== 'undefined' && highway.getSongInfo) ? highway.getSongInfo() : null;
    const stems = (info && info.stems) || [];
    if (stems.length === 0) {
        container.innerHTML = '';
        return;
    }

    // Also list player recordings
    const players = (_room && _room.players) || {};

    container.innerHTML =
        '<div class="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Include in mixdown</div>' +
        stems.map(s => {
            const id = s.id || s;
            return `<label class="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input type="checkbox" class="mp-stem-cb accent-accent" data-stem="${esc(id)}" checked>
                ${esc(id)}
            </label>`;
        }).join('') +
        Object.keys(players).filter(pid => _room.recordings_received && _room.recordings_received.includes(pid)).map(pid => {
            const p = players[pid];
            return `<label class="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input type="checkbox" class="mp-rec-cb accent-accent" data-player="${pid}" checked>
                ${esc(p.name)} (recording)
            </label>`;
        }).join('');
}

// ── Mixdown ────────────────────────────────────────────────────────────

window.mpTriggerMixdown = async function () {
    if (!_isHost || !_roomCode || !_playerId) return;
    const btn = document.getElementById('mp-btn-mixdown');
    if (btn) { btn.disabled = true; btn.textContent = 'Mixing...'; }

    // Read stem/recording checkboxes
    const includedStems = [];
    document.querySelectorAll('.mp-stem-cb').forEach(cb => {
        if (cb.checked) includedStems.push(cb.dataset.stem);
    });
    const includedRecordings = [];
    document.querySelectorAll('.mp-rec-cb').forEach(cb => {
        if (cb.checked) includedRecordings.push(cb.dataset.player);
    });

    try {
        const resp = await fetch(`/api/plugins/multiplayer/rooms/${_roomCode}/mixdown`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                player_id: _playerId,
                include_stems: includedStems,
                include_recordings: includedRecordings,
            }),
        });
        const data = await resp.json();
        if (data.error) {
            if (btn) { btn.disabled = false; btn.textContent = 'Mix & Download'; }
            console.error('[MP] Mixdown failed:', data.error);
            return;
        }
        if (data.url) _onMixdownReady(data.url);
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Mix & Download'; }
        console.error('[MP] Mixdown error:', e);
    }
};

function _onMixdownReady(url) {
    const btn = document.getElementById('mp-btn-mixdown');
    const link = document.getElementById('mp-mixdown-link');
    const mixSection = document.getElementById('mp-mixdown-section');

    if (btn) { btn.disabled = false; btn.textContent = 'Mix & Download'; }
    if (mixSection) mixSection.classList.remove('hidden');
    if (link) {
        link.href = url;
        link.classList.remove('hidden');
        link.textContent = 'Download Mixdown (MP3)';
    }
}

// ── Mini DAW Mixer ────────────────────────────────────────────────────

let _mixerCtx = null;       // AudioContext for preview
let _mixerTracks = [];      // [{id, label, type, url, buffer, source, gain, offset, volume, muted, waveCanvas}]
let _mixerPlaying = false;
let _mixerStartTime = 0;
let _mixerDuration = 0;
let _mixerRaf = null;
let _mixerDragTrack = null;
let _mixerDragStartX = 0;
let _mixerDragStartOffset = 0;

window.mpOpenMixer = async function () {
    if (!_roomCode) return;

    // Show mixer, hide room
    document.getElementById('mp-room-view').classList.add('hidden');
    document.getElementById('mp-mixer-view').classList.remove('hidden');

    // Fetch tracks
    try {
        const resp = await fetch(`/api/plugins/multiplayer/rooms/${_roomCode}/tracks`);
        const data = await resp.json();
        if (data.error) { console.error('[MP] Tracks error:', data.error); return; }
        await _mixerLoadTracks(data.tracks);
    } catch (e) {
        console.error('[MP] Failed to load tracks:', e);
    }
};

window.mpCloseMixer = function () {
    _mixerStop();
    document.getElementById('mp-mixer-view').classList.add('hidden');
    document.getElementById('mp-room-view').classList.remove('hidden');
};

async function _mixerLoadTracks(trackList) {
    if (!_mixerCtx) _mixerCtx = new (window.AudioContext || window.webkitAudioContext)();

    _mixerTracks = [];
    const container = document.getElementById('mp-mixer-tracks');
    container.innerHTML = '<div class="p-4 text-xs text-gray-500">Loading audio tracks...</div>';

    for (const t of trackList) {
        const track = {
            id: t.id,
            label: t.label,
            type: t.type,
            url: t.url,
            buffer: null,
            source: null,
            gain: null,
            offset: t.start_ms || 0,  // ms offset from song start
            volume: 1.0,
            muted: false,
        };

        // Fetch and decode audio
        try {
            const resp = await fetch(t.url);
            const arrayBuf = await resp.arrayBuffer();
            track.buffer = await _mixerCtx.decodeAudioData(arrayBuf);
        } catch (e) {
            console.warn(`[MP] Failed to decode ${t.label}:`, e);
            continue;
        }

        _mixerTracks.push(track);
    }

    // Find max duration including offsets
    _mixerDuration = 0;
    for (const t of _mixerTracks) {
        const end = (t.offset / 1000) + t.buffer.duration;
        if (end > _mixerDuration) _mixerDuration = end;
    }

    _mixerRenderTracks();
    _mixerDrawRuler();
}

function _mixerRenderTracks() {
    const container = document.getElementById('mp-mixer-tracks');
    container.innerHTML = '';

    for (const t of _mixerTracks) {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-3 px-3 py-2';
        row.dataset.trackId = t.id;

        // Label + controls
        const controls = document.createElement('div');
        controls.className = 'w-40 flex-shrink-0 space-y-1';
        controls.innerHTML = `
            <div class="text-xs text-white font-medium truncate" title="${esc(t.label)}">${esc(t.label)}</div>
            <div class="flex items-center gap-2">
                <button onclick="mpMixerToggleMute('${t.id}')" class="mp-mute-btn text-[10px] px-1.5 py-0.5 rounded ${t.muted ? 'bg-red-900/50 text-red-400' : 'bg-dark-600 text-gray-400'}" data-track="${t.id}">M</button>
                <button onclick="mpMixerSolo('${t.id}')" class="text-[10px] px-1.5 py-0.5 rounded bg-dark-600 text-gray-400 hover:bg-amber-900/50 hover:text-amber-400">S</button>
                <input type="range" min="0" max="100" value="${Math.round(t.volume * 100)}"
                    class="w-16 accent-accent" oninput="mpMixerSetVolume('${t.id}', this.value)">
                <span class="text-[10px] text-gray-500 w-8 mp-vol-label" data-track="${t.id}">${Math.round(t.volume * 100)}%</span>
            </div>
            <div class="flex items-center gap-1">
                <span class="text-[10px] text-gray-600">Offset:</span>
                <button onclick="mpMixerNudge('${t.id}', -50)" class="text-[10px] px-1 rounded bg-dark-600 text-gray-400 hover:bg-dark-500">-50ms</button>
                <button onclick="mpMixerNudge('${t.id}', -10)" class="text-[10px] px-1 rounded bg-dark-600 text-gray-400 hover:bg-dark-500">-10</button>
                <span class="text-[10px] text-gray-400 w-14 text-center mp-offset-label" data-track="${t.id}">${t.offset}ms</span>
                <button onclick="mpMixerNudge('${t.id}', 10)" class="text-[10px] px-1 rounded bg-dark-600 text-gray-400 hover:bg-dark-500">+10</button>
                <button onclick="mpMixerNudge('${t.id}', 50)" class="text-[10px] px-1 rounded bg-dark-600 text-gray-400 hover:bg-dark-500">+50ms</button>
            </div>`;
        row.appendChild(controls);

        // Waveform canvas (draggable)
        const waveWrap = document.createElement('div');
        waveWrap.className = 'flex-1 h-14 relative bg-dark-800 rounded overflow-hidden cursor-grab';
        const canvas = document.createElement('canvas');
        canvas.className = 'w-full h-full';
        canvas.style.display = 'block';
        waveWrap.appendChild(canvas);
        row.appendChild(waveWrap);
        container.appendChild(row);

        t.waveCanvas = canvas;

        // Drag to offset
        waveWrap.addEventListener('mousedown', (e) => {
            _mixerDragTrack = t;
            _mixerDragStartX = e.clientX;
            _mixerDragStartOffset = t.offset;
            waveWrap.style.cursor = 'grabbing';
            e.preventDefault();
        });

        // Draw waveform after layout
        requestAnimationFrame(() => _mixerDrawWaveform(t));
    }

    // Global mouse handlers for drag
    document.addEventListener('mousemove', _mixerOnDrag);
    document.addEventListener('mouseup', _mixerOnDragEnd);
}

function _mixerDrawWaveform(track) {
    const canvas = track.waveCanvas;
    if (!canvas || !track.buffer) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;
    const data = track.buffer.getChannelData(0);
    const dur = track.buffer.duration;
    const totalW = _mixerDuration > 0 ? W : W;
    const pxPerSec = W / _mixerDuration;
    const offsetPx = (track.offset / 1000) * pxPerSec;
    const trackW = dur * pxPerSec;

    ctx.clearRect(0, 0, W, H);

    // Background for track extent
    const color = track.type === 'recording' ? '#2563eb' : '#059669';
    ctx.fillStyle = color + '20';
    ctx.fillRect(offsetPx, 0, trackW, H);

    // Waveform
    ctx.fillStyle = color + '80';
    const samples = data.length;
    const samplesPerPx = Math.max(1, Math.floor(samples / trackW));
    const mid = H / 2;

    for (let px = 0; px < trackW && px + offsetPx < W; px++) {
        const start = Math.floor((px / trackW) * samples);
        const end = Math.min(start + samplesPerPx, samples);
        let max = 0;
        for (let i = start; i < end; i++) {
            const v = Math.abs(data[i]);
            if (v > max) max = v;
        }
        const h = max * mid * 0.9;
        ctx.fillRect(offsetPx + px, mid - h, 1, h * 2);
    }

    // Label
    ctx.fillStyle = '#fff8';
    ctx.font = '10px sans-serif';
    ctx.fillText(track.label, offsetPx + 4, 12);
}

function _mixerOnDrag(e) {
    if (!_mixerDragTrack) return;
    const t = _mixerDragTrack;
    const canvas = t.waveCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const pxPerMs = rect.width / (_mixerDuration * 1000);
    const dx = e.clientX - _mixerDragStartX;
    t.offset = Math.max(0, Math.round(_mixerDragStartOffset + dx / pxPerMs));
    const label = document.querySelector(`.mp-offset-label[data-track="${t.id}"]`);
    if (label) label.textContent = t.offset + 'ms';
    _mixerDrawWaveform(t);
}

function _mixerOnDragEnd() {
    if (_mixerDragTrack) {
        const wrap = _mixerDragTrack.waveCanvas?.parentElement;
        if (wrap) wrap.style.cursor = 'grab';
        _mixerDragTrack = null;
    }
}

function _mixerDrawRuler() {
    const canvas = document.getElementById('mp-mixer-ruler-canvas');
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, W, H);

    const step = _mixerDuration > 60 ? 10 : _mixerDuration > 20 ? 5 : 1;
    ctx.fillStyle = '#888';
    ctx.font = '9px sans-serif';
    for (let t = 0; t <= _mixerDuration; t += step) {
        const x = (t / _mixerDuration) * W;
        ctx.fillRect(x, H - 4, 1, 4);
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        ctx.fillText(`${m}:${String(s).padStart(2, '0')}`, x + 2, H - 5);
    }
}

// ── Mixer playback (Web Audio) ──

function _mixerPlay() {
    if (!_mixerCtx || _mixerTracks.length === 0) return;
    if (_mixerCtx.state === 'suspended') _mixerCtx.resume();

    _mixerStartTime = _mixerCtx.currentTime;

    for (const t of _mixerTracks) {
        if (!t.buffer || t.muted) continue;
        const source = _mixerCtx.createBufferSource();
        source.buffer = t.buffer;
        const gain = _mixerCtx.createGain();
        gain.gain.value = t.volume;
        source.connect(gain).connect(_mixerCtx.destination);
        const offsetSec = t.offset / 1000;
        source.start(_mixerCtx.currentTime + offsetSec);
        t.source = source;
        t.gain = gain;
    }

    _mixerPlaying = true;
    _mixerUpdatePlayhead();
}

function _mixerStop() {
    for (const t of _mixerTracks) {
        if (t.source) {
            try { t.source.stop(); } catch (e) { /* */ }
            t.source = null;
        }
    }
    _mixerPlaying = false;
    if (_mixerRaf) { cancelAnimationFrame(_mixerRaf); _mixerRaf = null; }
    const playhead = document.getElementById('mp-mixer-playhead');
    if (playhead) playhead.style.left = '0%';
    const timeEl = document.getElementById('mp-mixer-time');
    if (timeEl) timeEl.textContent = '0:00.0';
    const btn = document.getElementById('mp-mixer-play');
    if (btn) btn.textContent = 'Preview';
}

function _mixerUpdatePlayhead() {
    if (!_mixerPlaying) return;
    const elapsed = _mixerCtx.currentTime - _mixerStartTime;
    const pct = Math.min(100, (elapsed / _mixerDuration) * 100);
    const playhead = document.getElementById('mp-mixer-playhead');
    if (playhead) playhead.style.left = pct + '%';
    const timeEl = document.getElementById('mp-mixer-time');
    if (timeEl) {
        const m = Math.floor(elapsed / 60);
        const s = (elapsed % 60).toFixed(1);
        timeEl.textContent = `${m}:${s.padStart(4, '0')}`;
    }
    if (elapsed >= _mixerDuration) {
        _mixerStop();
        return;
    }
    _mixerRaf = requestAnimationFrame(_mixerUpdatePlayhead);
}

window.mpMixerPlayPause = function () {
    if (_mixerPlaying) {
        _mixerStop();
    } else {
        _mixerPlay();
        const btn = document.getElementById('mp-mixer-play');
        if (btn) btn.textContent = 'Stop';
    }
};

window.mpMixerSeek = function (e) {
    // Not implemented for buffer sources (would need to restart all)
};

window.mpMixerToggleMute = function (trackId) {
    const t = _mixerTracks.find(t => t.id === trackId);
    if (!t) return;
    t.muted = !t.muted;
    if (t.gain) t.gain.gain.value = t.muted ? 0 : t.volume;
    const btn = document.querySelector(`.mp-mute-btn[data-track="${trackId}"]`);
    if (btn) {
        btn.className = `mp-mute-btn text-[10px] px-1.5 py-0.5 rounded ${t.muted ? 'bg-red-900/50 text-red-400' : 'bg-dark-600 text-gray-400'}`;
    }
};

window.mpMixerSolo = function (trackId) {
    // Mute everything except this track
    for (const t of _mixerTracks) {
        t.muted = (t.id !== trackId);
        if (t.gain) t.gain.gain.value = t.muted ? 0 : t.volume;
        const btn = document.querySelector(`.mp-mute-btn[data-track="${t.id}"]`);
        if (btn) {
            btn.className = `mp-mute-btn text-[10px] px-1.5 py-0.5 rounded ${t.muted ? 'bg-red-900/50 text-red-400' : 'bg-dark-600 text-gray-400'}`;
        }
    }
};

window.mpMixerSetVolume = function (trackId, val) {
    const t = _mixerTracks.find(t => t.id === trackId);
    if (!t) return;
    t.volume = parseFloat(val) / 100;
    if (t.gain && !t.muted) t.gain.gain.value = t.volume;
    const label = document.querySelector(`.mp-vol-label[data-track="${trackId}"]`);
    if (label) label.textContent = Math.round(t.volume * 100) + '%';
};

window.mpMixerNudge = function (trackId, deltaMs) {
    const t = _mixerTracks.find(t => t.id === trackId);
    if (!t) return;
    t.offset = Math.max(0, t.offset + deltaMs);
    const label = document.querySelector(`.mp-offset-label[data-track="${trackId}"]`);
    if (label) label.textContent = t.offset + 'ms';
    _mixerDrawWaveform(t);
};

window.mpMixerExport = async function () {
    if (!_roomCode || !_playerId) return;
    const btn = document.getElementById('mp-mixer-export');
    if (btn) { btn.disabled = true; btn.textContent = 'Exporting...'; }

    // Collect mixer state
    const track_offsets = {};
    const track_volumes = {};
    const track_mutes = [];
    for (const t of _mixerTracks) {
        track_offsets[t.id] = t.offset;
        track_volumes[t.id] = t.volume;
        if (t.muted) track_mutes.push(t.id);
    }

    try {
        const resp = await fetch(`/api/plugins/multiplayer/rooms/${_roomCode}/mixdown`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                player_id: _playerId,
                track_offsets,
                track_volumes,
                track_mutes,
            }),
        });
        const data = await resp.json();
        if (btn) { btn.disabled = false; btn.textContent = 'Export Mix'; }
        if (data.error) {
            console.error('[MP] Export failed:', data.error);
            return;
        }
        if (data.url) {
            const link = document.getElementById('mp-mixer-download');
            if (link) {
                link.href = data.url;
                link.classList.remove('hidden');
                link.textContent = 'Download Mixdown (MP3)';
            }
        }
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Export Mix'; }
        console.error('[MP] Export error:', e);
    }
};

// ── Audio ended hook (host sends song_ended) ───────────────────────────

(function () {
    const audio = document.getElementById('audio');
    if (audio) {
        audio.addEventListener('ended', () => {
            if (_isHost && _ws && _ws.readyState === WebSocket.OPEN && _room && _room.now_playing >= 0) {
                _ws.send(JSON.stringify({ type: 'song_ended' }));
            }
        });
    }
})();

// ── Screen show/hide hook ──────────────────────────────────────────────

(function () {
    const origShowScreen = window.showScreen;
    window.showScreen = function (id) {
        origShowScreen(id);
        if (id === 'plugin-multiplayer') {
            _loadSettings();
            // Check if we have an active room
            const savedRoom = sessionStorage.getItem('mp_room');
            const savedPlayer = sessionStorage.getItem('mp_player');
            if (savedRoom && savedPlayer && _ws && _ws.readyState === WebSocket.OPEN) {
                _showRoomView();
            } else if (savedRoom && savedPlayer && !_ws) {
                // Try to reconnect both WSs under the same persisted
                // session_id (sessionStorage carried it over the screen
                // switch). _connectWS / _connectAudioWs read _sessionId
                // via _getOrMintSessionId on connect.
                _roomCode = savedRoom;
                _playerId = savedPlayer;
                _connectWS();
                _connectAudioWs();
                _showRoomView();
            } else {
                _showLobbyView();
            }
        }
    };
})();

})();
