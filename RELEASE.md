## Claudian Voice 0.1.0 (pre-release)

First public build. Talk to the Claudian agent in your Obsidian vault and hear it answer.

**Requires a Claudian build with the companion API.** The released Claudian (2.3.21) does not expose one yet; the maintainer's outside-client API is a follow-up to YishenTu/claudian#1623. Until it ships, build Claudian from `elihorne/claudian`, branch `feat/public-chat-api`, and copy `main.js`, `manifest.json` and `styles.css` over the community install. Steps are in the README.

### What works

- Hands-free conversation: streaming transcription with semantic end-of-turn, live transcript in the indicator, spoken replies as they stream, listen again. Start/stop with ⌘⇧V; interrupt with ⌘⇧. (period).
- The active note and the editor selection ride along as context, as they do for typed prompts.
- Hold ⌘⌥V to dictate into the composer without sending; hold ⌘⌥E to rewrite the selection by voice through Claudian's inline edit.
- Read the current note aloud from the cursor with the paragraph highlighted; skip by heading.
- "Note to self, …" appends to today's daily note without involving the agent.
- Vault-synced glossary (`.claudian/voice-glossary.md`) for names and jargon the transcriber should spell correctly.
- Spoken progress while the agent works silently; sound cues on start, listen, stop and error; idle auto-stop as a cost guard.

### Engines

OpenAI Realtime (`gpt-4o-mini-transcribe`) for transcription and OpenAI `tts-1` for speech by default, one API key for both. A Whisper-compatible HTTP engine (OpenAI, Groq, local whisper servers) and OS system voices are available as alternatives.

### Known limitations

- Hold-to-talk, inline edit, read aloud, capture and voice barge-in have had light testing. The conversation loop is the exercised path.
- Barge-in (interrupting by speaking) is off by default; it works best on headphones.
- Inline edit drives Claudian's modal directly until Claudian offers an entry point.
- macOS only tested so far. Windows and Linux should work but are unverified.

### Install

BRAT: add `elihorne/claudian-voice` as a beta plugin. Or clone and `npm install && npm run build` into your vault's plugins folder. Then set your OpenAI key under Settings → Claudian Voice.

Report problems at https://github.com/elihorne/claudian-voice/issues. Debug logging (Settings → Claudian Voice) writes `[claudian-voice]` lines to the developer console; include them.
