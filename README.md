# Claudian Voice

Talk to the agent in your vault and hear it answer. A companion plugin for [Claudian](https://github.com/YishenTu/claudian): it owns the microphone, speech-to-text, and text-to-speech, and drives Claudian through its public companion API, so no audio code lives in Claudian itself.

Status: early. Tracks [YishenTu/claudian#1611](https://github.com/YishenTu/claudian/issues/1611).

## What it does

Start a session from the ribbon microphone or the command palette. The plugin listens until you pause, sends the transcript to the active Claudian tab, speaks the reply sentence by sentence as it streams, and then listens again. Say "cancel" or "never mind" to drop an utterance before it sends. Run "Interrupt reply and listen" (bind it to a hotkey) to cut the reply off and talk over it. Turn off "Send automatically" to use it as a dictation tool that drops the transcript into the composer for editing.

Speech is tied to the tab the prompt went to. A background tab finishing a turn never speaks.

## Requirements

- Obsidian desktop with Claudian installed and enabled, at a version that exposes `app.plugins.plugins.realclaudian.api` (version 1).
- A microphone.
- For speech-to-text, a Whisper-compatible HTTP endpoint. The default is OpenAI's `/v1/audio/transcriptions` with your API key; the same request shape works with Groq and with local servers such as [faster-whisper-server](https://github.com/fedirz/faster-whisper-server) or [whisper.cpp](https://github.com/ggerganov/whisper.cpp)'s server, which keep audio on your machine.
- For spoken replies, nothing extra: the plugin uses the voices your operating system provides.

Chromium's built-in Web Speech recogniser is available as an experimental engine, but Electron does not bundle the keys it needs, so in Obsidian it usually fails with a network error. It is there for the day that changes.

## Privacy

Audio goes only to the transcription endpoint you configure. Nothing is recorded until you start a session, and recording stops when the utterance ends. Reply text is spoken locally. The plugin stores your API key in Obsidian's plugin data folder like any other plugin setting.

## Install from source

```sh
cd /path/to/vault/.obsidian/plugins
git clone https://github.com/elihorne/claudian-voice.git
cd claudian-voice
npm install
npm run build
```

Enable it under Settings → Community plugins, then set the transcription endpoint and key under Settings → Claudian Voice.

## Development

```sh
npm run dev        # watch build
npm run typecheck
npm test           # pure logic tests (sentence chunking, speakable text, cancel phrases)
```

`src/claudian/api.ts` is the only file that knows Claudian's API shape. If Claudian changes the surface, that file changes and nothing else should.

## How it fits together

```
src/
├── main.ts                      # Commands, ribbon, status bar, session lifecycle
├── settings.ts
├── claudian/api.ts              # Mirror of Claudian's companion API and version check
├── speech/
│   ├── WhisperHttpRecognizer.ts # MediaRecorder + silence detection + HTTP transcription
│   ├── WebSpeechRecognizer.ts   # Chromium recogniser (experimental)
│   └── SynthesisSpeaker.ts      # speechSynthesis output
└── voice/
    ├── VoiceSession.ts          # Listen → submit → speak → listen loop, barge-in
    └── speakable.ts             # Markdown → speech text, sentence cursor, cancel phrases
```

## License

MIT
