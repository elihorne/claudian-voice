# Roadmap

Where Claudian Voice is going, and why. Tracks [YishenTu/claudian#1611](https://github.com/YishenTu/claudian/issues/1611).

## How to think about it

Obsidian is a folder of markdown with an editor, a workspace of panes, a command palette, and daily notes as the default capture surface. Claudian turns that folder into an agent's working directory, binds chat tabs to conversations, captures the editor selection at send time, runs slash commands and skills, and has an inline-edit flow that rewrites a selection with a diff. Voice is a modality across all of those surfaces, not a microphone attached to the chat.

Four rules follow from that. Anything that can be done inside Obsidian in milliseconds never goes through the agent. Voice sees what you see: the active note, the selection, the open chat. Spoken replies need a different register than written ones. Everything is interruptible and the state is readable from across the room.

## Done

- Hands-free loop: listen, send to the active Claudian tab, speak the reply, listen again.
- Streaming transcription (OpenAI Realtime) with semantic end-of-turn and live transcript in the indicator.
- Streaming speech (OpenAI `pcm`), sentences played as they arrive, next sentence synthesized while the current one plays.
- Hold to talk: dictate into the composer, or run inline edit on the selection with the spoken instruction.
- Read the current note aloud from the cursor, paragraph highlighted and scrolled as it is read; skip by heading.
- Local capture verbs ("note to self…", "remember…") appended to today's daily note without the agent.
- Active note attached to spoken prompts when it changed since the last voice turn; selection carried through Claudian's own capture.
- Glossary from settings and `.claudian/voice-glossary.md`, fed to the transcriber; command to add selected text.
- Echo-aware barge-in (off by default; headphones recommended).
- Spoken progress while the agent works silently; sound cues on start, listen, stop, error.
- Bridge abstraction: runs on the interim tab-handle API today and the maintainer's session API when it ships.

## Next

**Confirm window before sending.** After the transcript settles, show it for about a second with a filling ring; "wait" or "scratch that" cancels. Fixes the one trust problem voice has without making every turn two steps.

**Voice verbs while reading.** "Skip", "pause", "what did I mean here" (sends the current paragraph to the agent) spoken over the reading, using the barge-in monitor. Today these are commands.

**Session verbs.** "New topic" starts a tab; "back to the retro chat" switches by title; "what were we discussing" reads the last exchange. Needs session listing from the Claudian API.

**Skills by voice.** A phrase-to-command table in settings so "start my morning brief" runs `/morning` rather than handing a sentence to the agent.

**Approvals by voice.** Read a pending tool approval aloud and accept "yes" or "no". Needs pending-interaction events from the API.

**Journal mode.** "Journal" opens today's note and streams dictation straight into it as you talk; "tidy that up" hands the paragraph to the agent afterwards.

**Reply register that learns.** Track spoken reply length over time and adjust the hint rather than hoping a fixed sentence works.

**Transcript marker.** A mic glyph on messages that were spoken, so reading back a conversation you know which parts you said aloud. Needs a `source` tag on `send`.

**Realtime relay experiment.** Use OpenAI's speech-to-speech model as the voice layer with a single `ask_claudian` tool, for native audio understanding, built-in interruption and expressive delivery. Costs more and may paraphrase the agent; judge by ear against the chained path once that has had a fair hearing.

**Presence and privacy.** Auto-stop after idle, never record when Obsidian is not focused (optional), a mute word, and cost display since this bills two APIs.

## What we will ask of Claudian

Kept small, and mostly things the planned multi-session work needs anyway. To be posted as one grouped request once the experimental session API exists and this plugin runs against it.

- `cancel(sessionId)` so barge-in can cut a turn; the pending `send` resolves `interrupted`.
- List and switch sessions, for session verbs.
- An inline-edit entry point taking an instruction string, replacing the DOM-driven `InlineEditDriver`.
- Pending-interaction events with an answer method, for approvals by voice.
- An optional `source` tag on sent messages, for the transcript marker.
- Streaming partial text, if the maintainer is ever comfortable exposing it; the plugin works without it but speaks sooner with it.
