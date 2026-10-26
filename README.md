# Claudian Voice

Talk to the agent in your vault and hear it answer. A companion plugin for [Claudian](https://github.com/YishenTu/claudian): it owns the microphone, speech-to-text, and text-to-speech, and drives Claudian through its plugin API, so no audio code lives in Claudian itself.

Status: early and under active development. Tracks [YishenTu/claudian#1611](https://github.com/YishenTu/claudian/issues/1611). See [ROADMAP.md](ROADMAP.md).

## Requirements

Claudian 2.3.30 or later. That release added the plugin API this plugin runs on ([#1798](https://github.com/YishenTu/claudian/pull/1798), experimental, version 1): send a prompt to a session as the user's own input, stop it, and read the final reply when the turn ends. If you are behind, update Claudian under Community plugins.

If you built the `feat/public-chat-api` fork of Claudian for an earlier version of this plugin, updating Claudian from Community plugins replaces it, which is what you want. The fork is no longer needed. The plugin still recognises the fork's API when it finds one, and that path goes away in a later release.

## Install the plugin

The easy way is [BRAT](https://github.com/TfTHacker/obsidian42-brat): install BRAT from the community plugins, then in its settings choose "Add Beta plugin" and enter `elihorne/claudian-voice`. BRAT installs the latest pre-release and keeps it updated.

From source:

```sh
cd /path/to/vault/.obsidian/plugins
git clone https://github.com/elihorne/claudian-voice.git
cd claudian-voice && npm install && npm run build
```

Either way: reload Obsidian, enable **Claudian Voice** under Community plugins, then in its settings paste an OpenAI API key (used for transcription and speech). Set **Language** to your language code (`en`, `sv`, `de`) unless you mix languages, in which case leave it blank.

The plugin ships no default hotkeys (Obsidian's guideline). Under Settings → Hotkeys, search "Claudian Voice" and bind what you like; the ones used in this README are ⌘⇧V for start/stop, ⌘⇧. for interrupt, ⌘⌥V for hold-to-talk dictation and ⌘⌥E for hold-to-talk edit. Hold-to-talk works with any binding that includes a modifier.

## What it does

**Conversation.** Start a session (⌘⇧V, the ribbon microphone, or the command palette). A rising chime, then an orb at the top of the chat view: red and breathing with your voice while it listens, your words appearing beside it as you speak; accent-coloured while the agent thinks; green bars while it talks. It sends when you sound finished (not after a fixed pause), speaks the reply as soon as the agent's turn ends, and listens again. If the agent asks for a permission or a question, the turn waits until you answer it on screen. ⌘⇧. interrupts and listens. Say "cancel" or "never mind" to drop an utterance. A tick means it is listening for your next prompt; a falling chime means the session ended.

**Context.** The note you are looking at is attached to your spoken prompt whenever it changed since your last voice turn, the same way Claudian's "Add to chat" does. Text you have selected is quoted into the prompt.

**Hold to talk.** Hold ⌘⌥V, speak, release: the transcript is copied to the clipboard so you can paste it into the Claudian composer, add an `@mention` or fix a word, and send it yourself. (Claudian's plugin API has no composer access; on the fork build the text is inserted directly.) Hold ⌘⌥E with text selected and say what to change: Claudian's inline edit opens with that instruction and shows its diff.

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
npm test                            # node tests: voice loop with fakes, bridges, speakable text, PCM, glossary, verbs
```

For live reload, install the Hot Reload plugin and the `.hotreload` marker in the plugin folder makes it pick up each build.

## How it fits together

```
src/
├── main.ts                         # Commands, indicator, session lifecycle, context prefixes
├── settings.ts
├── claudian/
│   ├── bridge.ts                   # What the voice loop needs from Claudian, API-agnostic
│   ├── PluginApiBridge.ts          # Adapter for Claudian's plugin API (2.3.30+): send, turn-ended event, read
│   ├── LocalShimBridge.ts          # Adapter for the fork's interim tab-handle API (streams partials)
│   └── api.ts                      # Finds whichever API is present, plugin API first
├── speech/
│   ├── OpenAIRealtimeRecognizer.ts # Streaming STT over WebSocket, semantic turn detection
│   ├── pcmCaptureWorklet.ts        # AudioWorklet: mic → 24kHz pcm16 off the main thread
│   ├── WhisperHttpRecognizer.ts    # Record, detect silence, upload; hallucination filtering
│   ├── WebSpeechRecognizer.ts      # Chromium recogniser (does not work in Electron; kept for later)
│   ├── OpenAISpeaker.ts            # Streaming PCM playback with an output-level tap
│   ├── SynthesisSpeaker.ts         # OS voices
│   ├── BargeInMonitor.ts           # Echo-aware "user is talking over the reply" detector
│   ├── Earcons.ts                  # Start / listen / stop / error tones
│   ├── glossary.ts, GlossaryStore.ts
│   ├── microphone.ts               # getUserMedia with readable permission errors
│   └── pcm.ts                      # Resample, encode, RMS
├── voice/
│   ├── VoiceSession.ts             # Listen → send → speak → listen loop
│   ├── HoldToTalk.ts               # Press-and-hold capture
│   ├── ReadAloud.ts                # Paragraph reader with editor highlighting
│   ├── LocalVerbs.ts               # Capture to daily note and other agent-free verbs
│   └── speakable.ts                # Markdown → speech text, sentence cursor, cancel phrases
├── obsidian/
│   ├── InlineEditDriver.ts         # Drives Claudian's inline-edit modal (until an API exists)
│   └── dailyNote.ts                # Append to today's daily note through the vault API
└── ui/VoiceIndicator.ts            # The orb
```

## License

MIT
