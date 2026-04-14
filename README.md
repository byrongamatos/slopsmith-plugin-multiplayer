# Multiplayer

A [Slopsmith](https://github.com/byrongamatos/slopsmith) plugin that lets multiple players join a room and play songs together with synced highways, a shared song queue, and optional post-song recording with a built-in mixer.

## Features

### Synced Rooms
- Create or join a room with a 6-character code
- Host controls playback (play/pause/seek/speed) — all players stay in sync
- NTP-style clock sync with playback drift correction (micro-adjusts playbackRate for smooth alignment)
- Automatic host promotion if the host disconnects
- Rooms are ephemeral — destroyed 60 seconds after the last player leaves

### Shared Song Queue
- Any player can search the library and add songs to the queue
- Drag to reorder, remove songs, vote to skip (majority rules)
- Auto-advance to the next song when one finishes
- Host can click any queued song to load it immediately

### Per-Player Arrangements
- Each player picks their arrangement (Lead/Rhythm/Bass)
- Everyone sees their own highway with their chosen arrangement
- Multiple players can pick the same arrangement

### Recording
- Host toggles "Record" — arms mic input on all connected players
- Recording starts automatically when the host hits play (not when armed)
- Each player's recording is uploaded to the server when recording stops
- Uses `getUserMedia` on web, JUCE audio engine on desktop

### Mini DAW Mixer
After recording, the host opens the Mixer to align and export:
- **Waveform display** for every track (stems in green, recordings in blue)
- **Drag tracks** left/right to visually align recordings with the stems
- **Nudge buttons** (-50ms, -10ms, +10ms, +50ms) for fine-tuning
- **Volume slider** per track
- **Mute (M)** and **Solo (S)** buttons per track
- **Preview** button to hear the mix in-browser via Web Audio
- **Export Mix** sends offsets, volumes, and mutes to the server for FFmpeg mixdown
- Download the result as MP3

## Requirements

- Slopsmith with WebSocket support (standard)
- For recording: browser mic access (Chrome/Edge recommended)
- For stem mixing: sloppak songs with split stems (use the Sloppak Converter plugin)
- FFmpeg available in the Docker container (included by default)

## Install

```bash
cd plugins
git clone https://github.com/byrongamatos/slopsmith-plugin-multiplayer.git multiplayer
```

Restart Slopsmith and the plugin will appear in the Plugins dropdown.

## Cross-Platform

Web app and desktop app players can be in the same room. The sync protocol is WebSocket-based and works identically for both. Desktop players record via JUCE (higher quality WAV), web players record via MediaRecorder (webm-opus converted to WAV on upload).
