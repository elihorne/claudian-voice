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
- Runs on Claudian's plugin API (2.3.30+, #1798): prompts land as the user's own input, interrupt stops the turn, the final reply is read when `claudian:turn-ended` fires. The fork's tab-handle shim stays as a fallback for one release.
- Handover without clipping: zero gap after a reply, 700ms mic pre-roll sent ahead of live audio, non-blocking cue.
- First words sooner: first sentence spoken as soon as it completes, long openers start at a clause break. Needs streaming partials, so today only on the fork shim; the plugin API delivers the reply whole.
- Resilience: Realtime socket reconnects mid-listen, mic reacquired on device change, one shared AudioContext.
- Idle auto-stop (cost guard), cached audio for fixed phrases, language-code normalisation, settings migrations.

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

## What #1623 and #1798 changed

[#1623](https://github.com/YishenTu/claudian/pull/1623) (merged 2026-10-14) landed cross-session messaging in Claudian core: `send` with modes `queue`, `steer` (joins a running turn) and `interrupt` (stops it like the user's Stop), `read_session`, and session status `idle | running | awaiting-user`. Agent-to-agent only.

[#1798](https://github.com/YishenTu/claudian/pull/1798) (merged 2026-10-23, shipped in Claudian 2.3.30) opened it to other plugins as `app.plugins.getPlugin('realclaudian').api`, experimental at `version` 1:

- `getActiveSessionId()`: the session in the focused chat view.
- `send(sessionId, { text, mode })`: the text arrives as the user's own prompt, no "From session" envelope, whether the session is open in a tab or not. Resolves as soon as the text is accepted with `started | queued | steered | uncertain | interrupted | idle`. `{ mode: 'interrupt' }` without text only stops the session.
- `read(sessionId)`: the last finished turn's final answer as markdown, or `(interrupted)`, `(error)`, `(no reply)`.
- Workspace event `claudian:turn-ended` with `{ sessionId }`, for every session and turn.

Both things this plugin asked for arrived: companion sends are user input, and interrupt is exposed. What the API does not carry: streaming partials, composer access, editor selection (quoted into the prompt instead), and a way to ask whether a session is busy before sending. The bridge treats a `queued` status as "another turn ends first" and waits for the second `turn-ended`.

## What we will ask of Claudian

Kept small. To be posted as one grouped request on #1611 now that the plugin runs on the shipped API.

- Streaming partial text, or a per-text-block event. The biggest remaining gap: first words wait for the whole reply.
- A status query (`idle | running | awaiting-user`) for a session, so the bridge need not infer it from `queued`.
- List and switch sessions, for session verbs.
- An inline-edit entry point taking an instruction string, replacing the DOM-driven `InlineEditDriver`.
- Pending-interaction events with an answer method, for approvals by voice. Today a permission prompt stalls the spoken turn until it is answered on screen.
- An optional `source` tag on sent messages, for the transcript marker.
- Composer insert, so hold-to-talk dictation lands in the box instead of the clipboard.

## From the Obsidian plugin review

The listing sits in draft in Obsidian's developer portal; each release gets an automated review there.

Fixed in 0.1.1: `window.setTimeout` family for popout windows, no default hotkeys, `builtin-modules` replaced by `node:module`, unused variable, release workflow with build provenance attestations.

Fixed in 0.2.1:

- Declarative settings (`getSettingDefinitions`, Obsidian 1.13+), so every setting shows up in settings search. Rows the declarative controls cannot express (masked API key, a play button beside a control) use `render`.
- `ScriptProcessorNode` replaced by an `AudioWorklet` loaded from a Blob URL (`src/speech/pcmCaptureWorklet.ts`). Resampling and 16-bit conversion run off the main thread; the worklet posts 50ms chunks with their level.
- Bare `setTimeout` in the timers fallback: timers now go through `window` only, and the node test run aliases `window` to the global object.
- The `unknown`-in-union and `globalThis` findings went with the old bridge and the timers rewrite.

Left as is, on purpose:

- `fetch` in `OpenAISpeaker`: the speech endpoint streams PCM and `requestUrl` cannot stream a body.
- Clipboard access: hold-to-talk dictation copies the transcript to the clipboard because the plugin API has no composer insert.
- Release names must carry the version (`0.2.1`, not blank), or the review warns.
