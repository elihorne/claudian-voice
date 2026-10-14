# Claudian Voice

Talk to the agent in your vault and hear it answer. A companion plugin for [Claudian](https://github.com/YishenTu/claudian): it owns the microphone, speech-to-text, and text-to-speech, and drives Claudian through a small companion API, so no audio code lives in Claudian itself.

Status: early and under active development. Tracks [YishenTu/claudian#1611](https://github.com/YishenTu/claudian/issues/1611). See [ROADMAP.md](ROADMAP.md).

## Before you install: it needs a Claudian build with the companion API

The released Claudian does not yet expose an API for other plugins. The maintainer is building one: [#1623](https://github.com/YishenTu/claudian/pull/1623) lands cross-session messaging inside Claudian, and the outside-client API is its follow-up (see [#1611](https://github.com/YishenTu/claudian/issues/1611)). Until that ships, this plugin runs against an interim build:

```sh
cd ~/src   # anywhere outside your vault
git clone -b feat/public-chat-api https://github.com/elihorne/claudian.git
cd claudian && npm install && npm run build
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/realclaudian/
```

That overwrites the community-installed Claudian's three files (your settings in `data.json` are untouched). Claudian's updater will replace them again on its next release, so keep this folder around. When the maintainer's experimental API is published, the plugin will detect it and this step goes away.

## Install the plugin

```sh
cd /path/to/vault/.obsidian/plugins
git clone https://github.com/elihorne/claudian-voice.git
cd claudian-voice && npm install && npm run build
```

Reload Obsidian, enable **Claudian Voice** under Community plugins, then in its settings paste an OpenAI API key (used for transcription and speech). Set **Language** to your language code (`en`, `sv`, `de`) unless you mix languages, in which case leave it blank.

## What it does

**Conversation.** Start a session (⌘⇧V, the ribbon microphone, or the command palette). A rising chime, then an orb at the top of the chat view: red and breathing with your voice while it listens, your words appearing beside it as you speak; accent-coloured while the agent thinks; green bars while it talks. It sends when you sound finished (not after a fixed pause), speaks the reply as it streams, and listens again. ⌘⇧. interrupts and listens. Say "cancel" or "never mind" to drop an utterance. A tick means it is listening for your next prompt; a falling chime means the session ended.

**Context.** The note you are looking at is attached to your spoken prompt whenever it changed since your last voice turn, the same way Claudian's "Add to chat" does. Text you have selected goes through Claudian's own selection capture, exactly as if typed.

**Hold to talk.** Hold ⌘⌥V, speak, release: the transcript lands in the Claudian composer without sending, so you can add an `@mention` or fix a word first. Hold ⌘⌥E with text selected and say what to change: Claudian's inline edit opens with that instruction and shows its diff.

**Read aloud.** "Read the current note aloud" reads from the cursor's paragraph, highlighting and scrolling the editor as it goes. Skip by heading, stop to restore your selection. In a session, "read this note" does the same.

**Capture.** In a session, "note to self, call Nakul tomorrow" appends a timestamped line to today's daily note (Daily Notes or Periodic Notes folder and format respected) and says "Noted", without involving the agent. "Remember", "capture", and "jot down" work too.

**Glossary.** Names, products, and jargon the transcriber should spell correctly, from the settings box and from `.claudian/voice-glossary.md` in the vault so it syncs across machines. "Add selected text to voice glossary" appends to that file.

**While the agent works.** If it is busy with tools and has written nothing for a few seconds, the voice says "Working on it", then "Still working" every twenty seconds, so silence never means failure.

**When you walk away.** A session that hears nothing for 45 seconds ends itself with the falling chime, since streaming transcription is billed while the mic is open. The threshold is in settings; 0 keeps listening until you stop it.

**When something is off.** Settings → Debug logging writes transcription and session events to the developer console (⌘⌥I) as `[claudian-voice]` lines.

Hold to talk, inline edit, read aloud, capture, and voice barge-in landed recently and have had light testing; the conversation loop, streaming transcription, and speech are the parts that have been exercised most.

## Engines

Transcription defaults to OpenAI's Realtime API in transcription mode (`gpt-4o-mini-transcribe`): audio streams as you talk, interim text comes back within a few hundred milliseconds, and the server decides when your turn is over (semantic turn detection; a fixed-silence mode is available). A Whisper-compatible HTTP engine is also included and works with OpenAI, Groq, and local servers such as [faster-whisper-server](https://github.com/fedirz/faster-whisper-server) or [whisper.cpp](https://github.com/ggerganov/whisper.cpp), which keep audio on your machine.

Speech defaults to OpenAI (`tts-1`, consistent voice and exact speed control; `gpt-4o-mini-tts` is more expressive but can shift between short requests). Audio is streamed and played as it arrives. System voices through the OS are available as a free offline option; on macOS the better ones are under Accessibility → Spoken Content → System Voice → Manage Voices.

Interrupting by speaking over the reply ("barge-in") is off by default. It compares what the mic hears against the plugin's own playback level, which works well on headphones and reasonably on laptop speakers; turn it on in settings to try it. The ⌘⇧. command interrupts regardless.

## Privacy

Audio goes only to the transcription endpoint you configure, and only while a session or hold-to-talk is active. Reply text goes to the speech endpoint you configure. The API key is stored in Obsidian's plugin data folder like any other plugin setting. Nothing is logged.

## Development

```sh
cp .env.local.example .env.local   # set OBSIDIAN_VAULT to copy builds into a vault
npm run dev                         # watch build, copies into the vault on every change
npm run typecheck
npm test                            # pure-logic tests: speakable text, sentence cursor, PCM, glossary
```

For live reload, install the Hot Reload plugin and the `.hotreload` marker in the plugin folder makes it pick up each build.

## How it fits together

```
src/
├── main.ts                         # Commands, hotkeys, indicator, session lifecycle, context prefixes
├── settings.ts
├── claudian/
│   ├── bridge.ts                   # What the voice loop needs from Claudian, API-agnostic
│   ├── SessionApiBridge.ts         # Adapter for the maintainer's planned session API
│   ├── LocalShimBridge.ts          # Adapter for the interim tab-handle API (streams partials)
│   └── api.ts                      # Finds whichever API is present
├── speech/
│   ├── OpenAIRealtimeRecognizer.ts # Streaming STT over WebSocket, semantic turn detection
│   ├── WhisperHttpRecognizer.ts    # Record, detect silence, upload; hallucination filtering
│   ├── WebSpeechRecognizer.ts      # Chromium recogniser (does not work in Electron; kept for later)
│   ├── OpenAISpeaker.ts            # Streaming PCM playback with an output-level tap
│   ├── SynthesisSpeaker.ts         # OS voices
│   ├── BargeInMonitor.ts           # Echo-aware "user is talking over the reply" detector
│   ├── Earcons.ts                  # Start / listen / stop / error tones
│   ├── glossary.ts, GlossaryStore.ts
│   └── pcm.ts                      # Resample, encode, RMS
├── voice/
│   ├── VoiceSession.ts             # Listen → send → speak → listen loop
│   ├── HoldToTalk.ts               # Press-and-hold capture
│   ├── ReadAloud.ts                # Paragraph reader with editor highlighting
│   ├── LocalVerbs.ts               # Capture to daily note and other agent-free verbs
│   └── speakable.ts                # Markdown → speech text, sentence cursor, cancel phrases
├── obsidian/InlineEditDriver.ts    # Drives Claudian's inline-edit modal (until an API exists)
└── ui/VoiceIndicator.ts            # The orb
```

## License

MIT
