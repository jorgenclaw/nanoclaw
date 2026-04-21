---
name: add-voice-transcription
description: Add voice message transcription to NanoClaw V2. Local whisper.cpp first, OpenAI Whisper API fallback. Works with any channel (Signal, Watch, WhatsApp, Telegram). Linux and macOS.
---

# Add Voice Transcription (V2)

Automatic voice message transcription for NanoClaw V2. Uses local whisper.cpp for zero-cost, zero-latency transcription with automatic fallback to OpenAI's Whisper API if local transcription fails.

**Channel-agnostic:** Works with any channel adapter that passes audio files through `transcribeAudio()` — Signal, T-Watch, WhatsApp, Telegram, or any future channel.

**Supersedes:** The V1 `add-voice-transcription` (OpenAI-only) and `use-local-whisper` (macOS-only) skills. This V2 version combines both into one module that works on Linux and macOS.

## Prerequisites

### ffmpeg (required)

Converts audio formats to WAV for Whisper:

```bash
# Debian/Ubuntu
sudo apt install -y ffmpeg
# macOS
brew install ffmpeg
```

### whisper.cpp (recommended — free, local, fast)

```bash
# Option A: Build from source (Linux)
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp && cmake -B build && cmake --build build --config Release
cp build/bin/whisper-cli ~/.local/bin/

# Option B: Homebrew (macOS)
brew install whisper-cpp
```

Download a model:

```bash
mkdir -p ~/.local/share/whisper/models
curl -fsSL https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
  -o ~/.local/share/whisper/models/ggml-base.en.bin
```

`ggml-base.en` (142MB) is the recommended starting point — fast and accurate for English. For multilingual, use `ggml-base` (no `.en` suffix).

### OpenAI API key (optional fallback)

If local Whisper isn't installed, transcription falls back to OpenAI Whisper API:

```bash
# Add to .env
OPENAI_API_KEY=sk-your-key-here
```

Without either whisper-cli or OPENAI_API_KEY, voice messages are delivered as raw audio with no transcript.

## Install

### Phase 1: Pre-flight

```bash
test -f src/transcription.ts && echo "Already installed" || echo "Ready to install"
```

### Phase 2: Apply

```bash
git fetch origin skill/voice-transcription-v2
git checkout origin/skill/voice-transcription-v2 -- src/transcription.ts
```

Add config exports to `src/config.ts` (inside the `readEnvFile` call and as exports):

```typescript
// In the readEnvFile array, add:
'WHISPER_BIN',
'WHISPER_MODEL',

// Add exports:
export const WHISPER_BIN =
  process.env.WHISPER_BIN ?? envConfig.WHISPER_BIN ?? path.join(HOME_DIR, '.local', 'bin', 'whisper-cli');
export const WHISPER_MODEL =
  process.env.WHISPER_MODEL ??
  envConfig.WHISPER_MODEL ??
  path.join(HOME_DIR, '.local', 'share', 'whisper', 'models', 'ggml-base.en.bin');
```

No npm dependencies needed if using local Whisper only. For the OpenAI fallback, `openai` is already in NanoClaw's dependencies.

### Phase 3: Build and restart

```bash
pnpm run build
systemctl --user restart nanoclaw     # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

## Verify

Send a voice note via any connected channel. Check logs:

```bash
tail -f logs/nanoclaw.log | grep -i "transcrib"
```

You should see either `Transcribed locally` or `Local whisper failed, falling back to OpenAI`.

## How it works

```
Voice note arrives (any channel)
  -> transcribeAudio(filePath)
  -> toWav() via ffmpeg (16kHz mono WAV)
  -> Try local whisper-cli (WHISPER_BIN + WHISPER_MODEL)
  -> On failure: fall back to OpenAI Whisper API
  -> Return transcript text to channel adapter
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_BIN` | `~/.local/bin/whisper-cli` | Path to whisper.cpp binary. Empty = skip local. |
| `WHISPER_MODEL` | `~/.local/share/whisper/models/ggml-base.en.bin` | Path to GGML model file |
| `OPENAI_API_KEY` | (none) | OpenAI API key for Whisper fallback |

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| No transcript | Neither whisper-cli nor OPENAI_API_KEY | Install whisper.cpp or set API key |
| `ffmpeg: not found` | ffmpeg not installed | `sudo apt install ffmpeg` |
| Garbled transcript | Model too small | Try `ggml-small.en` for better accuracy |

## Removal

```bash
rm src/transcription.ts
# Remove WHISPER_BIN, WHISPER_MODEL exports from src/config.ts
pnpm run build
```
