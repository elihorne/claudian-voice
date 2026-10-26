## Claudian Voice 0.2.1

Housekeeping release from the Obsidian plugin review of 0.2.0. No change to what the plugin does.

- **Settings are searchable.** The settings tab moved to Obsidian's declarative settings API (1.13+), so every Claudian Voice setting appears in the settings search box. Same settings, same layout.
- **Microphone capture runs in an AudioWorklet.** Resampling to 24kHz and 16-bit conversion now happen off the main thread, replacing the deprecated `ScriptProcessorNode`. Audio reaches the transcriber in 50ms chunks instead of about 85ms.
- Timers are window-bound throughout, as Obsidian asks for popout windows.

Requires Claudian 2.3.30 or later, as 0.2.0 did.

## Claudian Voice 0.2.0

Talk to the Claudian agent in your Obsidian vault and hear it answer.

### What's new in 0.2.0

**Runs on Claudian's own plugin API.** Claudian 2.3.30 added an experimental API for other plugins ([YishenTu/claudian#1798](https://github.com/YishenTu/claudian/pull/1798)): send a prompt to a session as the user's own input, stop it, and read the final reply when the turn ends. This release drives Claudian through it. No fork build, no copying files over the community install.

**Requires Claudian 2.3.30 or later.** Update Claudian under Community plugins. If you built the `feat/public-chat-api` fork for 0.1.x, the update replaces it, which is what you want. 0.1.x against Claudian 2.3.30 or later fails every voice turn with "text is required unless mode is interrupt"; this release fixes that.

What changes in use:

- **Replies are spoken when the turn ends**, not as they stream. The API delivers the final answer only. Streaming partials are the first thing on the list to ask Claudian for.
- **Hold-to-talk dictation copies to the clipboard** instead of inserting into the composer, which the API does not expose. Paste, edit, send.
- **Selected text is quoted into the prompt** rather than captured by Claudian at send time. Same effect for the agent.
- **A permission prompt or question from the agent pauses the spoken turn** until you answer it on screen. The voice loop keeps saying "still working" meanwhile.
- The fork's tab-handle API is still recognised if present, with streaming and composer insert as before. That fallback goes away in a later release.

### What works

- Hands-free conversation: streaming transcription with semantic end-of-turn, live transcript in the indicator, spoken reply, listen again. Bind hotkeys under Settings → Hotkeys (none ship by default); the README suggests ⌘⇧V to start/stop and ⌘⇧. to interrupt.
- The active note and the editor selection ride along as context.
- Hold-to-talk commands: dictate to the clipboard, or rewrite the selection by voice through Claudian's inline edit. Bind each to a hotkey and hold it while speaking.
- Read the current note aloud from the cursor with the paragraph highlighted; skip by heading.
- "Note to self, …" appends to today's daily note without involving the agent.
- Vault-synced glossary (`.claudian/voice-glossary.md`) for names and jargon the transcriber should spell correctly.
- Spoken progress while the agent works silently; sound cues on start, listen, stop and error; idle auto-stop as a cost guard.

### Engines

OpenAI Realtime (`gpt-4o-mini-transcribe`) for transcription and OpenAI `tts-1` for speech by default, one API key for both. A Whisper-compatible HTTP engine (OpenAI, Groq, local whisper servers) and OS system voices are available as alternatives.

### Known limitations

- The plugin API is experimental and may change in Claudian minor releases while its `version` is 1. The plugin checks the version and says so if it moves.
- Hold-to-talk, inline edit, read aloud, capture and voice barge-in have had light testing. The conversation loop is the exercised path.
- Barge-in (interrupting by speaking) is off by default; it works best on headphones.
- Inline edit drives Claudian's modal directly until Claudian offers an entry point.
- macOS only tested so far. Windows and Linux should work but are unverified.

### Install

BRAT: add `elihorne/claudian-voice` as a beta plugin. Or clone and `npm install && npm run build` into your vault's plugins folder. Then set your OpenAI key under Settings → Claudian Voice.

Report problems at https://github.com/elihorne/claudian-voice/issues. Debug logging (Settings → Claudian Voice) writes `[claudian-voice]` lines to the developer console; include them.
