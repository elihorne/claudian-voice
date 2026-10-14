import { type Editor, Notice, Plugin, setIcon } from 'obsidian';

import { describeBridgeFailure, resolveClaudianBridge } from './claudian/api';
import { ClaudianVoiceSettingTab, type ClaudianVoiceSettings, DEFAULT_SETTINGS, normalizeLanguage } from './settings';
import { BargeInMonitor } from './speech/BargeInMonitor';
import { Earcons } from './speech/Earcons';
import { GlossaryStore } from './speech/GlossaryStore';
import { OpenAIRealtimeRecognizer } from './speech/OpenAIRealtimeRecognizer';
import { OpenAISpeaker } from './speech/OpenAISpeaker';
import { SynthesisSpeaker } from './speech/SynthesisSpeaker';
import type { Speaker, SpeechRecognizer } from './speech/types';
import { WebSpeechRecognizer } from './speech/WebSpeechRecognizer';
import { WhisperHttpRecognizer } from './speech/WhisperHttpRecognizer';
import { InlineEditDriver } from './obsidian/InlineEditDriver';
import { labelFor, VoiceIndicator } from './ui/VoiceIndicator';
import { HoldToTalk } from './voice/HoldToTalk';
import { appendToDailyNote } from './obsidian/dailyNote';
import type { LocalVerb } from './voice/LocalVerbs';
import { ReadAloud } from './voice/ReadAloud';
import { VoiceSession, type VoiceState } from './voice/VoiceSession';

export default class ClaudianVoicePlugin extends Plugin {
  settings: ClaudianVoiceSettings = { ...DEFAULT_SETTINGS };
  #session: VoiceSession | null = null;
  #statusEl: HTMLElement | null = null;
  #ribbonEl: HTMLElement | null = null;
  #indicator: VoiceIndicator | null = null;
  #hold: HoldToTalk | null = null;
  #reader: ReadAloud | null = null;
  readonly #inlineEdit = new InlineEditDriver(this.app);
  readonly #earcons = new Earcons(() => this.settings.soundCues);
  /** Conversations that already got the spoken-length hint, and the note last attached to each. */
  readonly #hintedSessions = new Set<string>();
  readonly #lastNoteBySession = new Map<string, string>();
  readonly #glossary = new GlossaryStore(this.app, {
    getSettingsTerms: () => this.settings.glossaryTerms,
    getFilePath: () => this.settings.glossaryFile,
  });

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ClaudianVoiceSettingTab(this.app, this));

    this.#indicator = new VoiceIndicator(this.app, () => this.stopSession());
    this.registerEvent(this.app.workspace.on('layout-change', () => this.#indicator?.refresh()));

    this.#statusEl = this.addStatusBarItem();
    this.#statusEl.addClass('claudian-voice-status');
    this.#renderState({ phase: 'idle' });

    this.#ribbonEl = this.addRibbonIcon('mic', 'Claudian Voice: start or stop conversation', () => this.toggleConversation());

    // Suggested defaults only; Obsidian lets the user override or clear them under Hotkeys.
    this.addCommand({
      id: 'toggle-conversation',
      name: 'Start or stop voice conversation',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'v' }],
      callback: () => this.toggleConversation(),
    });
    this.addCommand({
      id: 'dictate-once',
      name: 'Dictate one prompt',
      callback: () => this.startSession({ conversation: false }),
    });
    this.addCommand({
      id: 'interrupt',
      name: 'Interrupt reply and listen',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: '.' }],
      callback: () => this.#session?.interrupt(),
    });
    this.addCommand({
      id: 'stop',
      name: 'Stop listening and speaking',
      callback: () => this.stopSession(),
    });
    this.addCommand({
      id: 'hold-to-talk-dictate',
      name: 'Hold to talk: dictate into the chat (hold the hotkey)',
      hotkeys: [{ modifiers: ['Mod', 'Alt'], key: 'v' }],
      callback: () => { void this.holdToTalk('v', 'dictate'); },
    });
    this.addCommand({
      id: 'hold-to-talk-edit',
      name: 'Hold to talk: edit the selection (hold the hotkey)',
      hotkeys: [{ modifiers: ['Mod', 'Alt'], key: 'e' }],
      callback: () => { void this.holdToTalk('e', 'edit'); },
    });
    this.addCommand({
      id: 'read-note',
      name: 'Read the current note aloud (from the cursor)',
      callback: () => { void this.readAloud().then(ok => { if (!ok) new Notice('Open a Markdown note to read it aloud.'); }); },
    });
    this.addCommand({
      id: 'read-skip',
      name: 'Reading: skip to the next section',
      callback: () => this.#reader?.skip(),
    });
    this.addCommand({
      id: 'read-stop',
      name: 'Reading: stop',
      callback: () => this.#reader?.stop(),
    });
    this.addCommand({
      id: 'add-to-glossary',
      name: 'Add selected text to voice glossary',
      editorCheckCallback: (checking: boolean, editor: Editor) => {
        const selection = editor.getSelection().trim();
        if (!selection || !this.settings.glossaryFile.trim()) return false;
        if (!checking) {
          void this.#glossary.addToFile(selection.split(/[\n,]/).map(term => term.trim()).filter(Boolean))
            .then(() => new Notice(`Added to voice glossary: ${selection.slice(0, 60)}`))
            .catch(error => new Notice(`Could not update glossary: ${error instanceof Error ? error.message : String(error)}`));
        }
        return true;
      },
    });
  }

  onunload(): void {
    this.stopSession();
    this.#reader?.stop();
    this.#indicator?.unmount();
    this.#sharedSpeaker?.speaker.dispose?.();
    this.#sharedSpeaker = null;
  }

  toggleConversation(): void {
    if (this.#session?.isRunning) {
      this.stopSession();
      return;
    }
    this.startSession({ conversation: this.settings.conversationMode });
  }

  startSession(options: { conversation: boolean }): void {
    if (this.#session?.isRunning) return;
    const status = resolveClaudianBridge(this.app);
    if (!status.ok) {
      new Notice(describeBridgeFailure(status));
      return;
    }
    if (!status.bridge.getActiveSessionId()) {
      new Notice('Open a Claudian chat first.');
      return;
    }
    void this.#glossary.refresh();
    const recognizer = this.#createRecognizer();
    if (!recognizer.isAvailable()) {
      new Notice(recognizer.id === 'whisper-http'
        ? 'Set a transcription endpoint in Claudian Voice settings.'
        : recognizer.id === 'openai-realtime'
          ? 'Streaming transcription needs an OpenAI API key in Claudian Voice settings.'
          : 'Web Speech API is not available here; switch the engine in settings.');
      return;
    }
    const speaker = this.#createSpeaker();
    if (this.settings.speakReplies && !speaker) {
      new Notice(this.settings.ttsEngine === 'openai'
        ? 'OpenAI speech needs the API key from the Speech to text section; replies will not be spoken.'
        : 'Speech synthesis is not available; replies will not be spoken.');
    }

    const session = new VoiceSession({
      bridge: status.bridge,
      getPromptSuffix: () => (this.settings.briefReplies ? this.settings.promptSuffix : ''),
      hasHinted: sessionId => this.#hintedSessions.has(sessionId),
      markHinted: sessionId => { this.#hintedSessions.add(sessionId); },
      getContextPrefix: sessionId => this.#activeNotePrefix(sessionId) + this.#selectionPrefix(status.bridge.kind),
      handleLocalVerb: verb => this.#handleLocalVerb(verb),
      recognizer,
      speaker: speaker ?? new SynthesisSpeaker({ getVoiceName: () => '', getRate: () => 1, getLanguage: () => '' }),
      isConversationMode: () => options.conversation,
      isSpeechEnabled: () => this.settings.speakReplies && speaker !== null,
      shouldAutoSubmit: () => this.settings.autoSubmit,
      getTurnGapMs: () => this.settings.turnGapMs,
      onState: state => this.#renderState(state),
      cue: kind => this.#earcons.play(kind),
      getIdleStopMs: () => this.settings.idleStopSeconds * 1000,
      getProgressPhrases: () => (this.settings.progressCues
        ? { first: 'Working on it.', again: 'Still working.', firstAfterMs: 5000, everyMs: 20000 }
        : null),
      bargeIn: this.settings.bargeIn && BargeInMonitor.isSupported()
        ? new BargeInMonitor({
          getThreshold: () => this.settings.silenceThreshold * 2,
          getHoldMs: () => this.settings.bargeInHoldMs,
          getReferenceLevel: () => speaker?.getOutputLevel?.(),
        })
        : null,
    });
    this.#session = session;
    void session.start().finally(() => {
      if (this.#session === session) this.#session = null;
      if (session.state.phase === 'error') new Notice(`Claudian Voice: ${session.state.message}`);
    });
  }

  stopSession(): void {
    this.#session?.stop();
  }

  #preview: Speaker | null = null;

  /** Speaks a short sample with the current voice settings; a new preview cuts off the previous one. */
  previewVoice(text = 'Hi Eli. This is how I will sound when I read replies back to you.'): void {
    if (this.#session?.isRunning) { new Notice('Stop the voice session to preview voices.'); return; }
    this.#preview?.cancel();
    const speaker = this.#createSpeaker();
    if (!speaker) {
      new Notice(this.settings.ttsEngine === 'openai'
        ? 'Add the API key under Speech to text to preview OpenAI voices.'
        : 'Speech synthesis is not available in this Obsidian build.');
      return;
    }
    this.#preview = speaker;
    void speaker.speak(text);
  }

  /**
   * Press-and-hold capture. 'dictate' drops the transcript into the Claudian composer without
   * sending; 'edit' runs Claudian's inline edit on the current selection with the transcript.
   */
  async holdToTalk(releaseKey: string, target: 'dictate' | 'edit'): Promise<void> {
    if (this.#session?.isRunning) return;
    if (!this.#hold) {
      const recognizer = this.#createRecognizer();
      if (!recognizer.isAvailable()) { new Notice('Transcription is not configured; check Claudian Voice settings.'); return; }
      void this.#glossary.refresh();
      this.#hold = new HoldToTalk({ recognizer, onState: state => this.#renderState(state), cue: kind => this.#earcons.play(kind) });
    }
    if (this.#hold.isActive) return;
    const hold = this.#hold;
    const transcript = await hold.press(releaseKey);
    this.#hold = null;
    if (!transcript) return;
    if (target === 'edit') {
      if (!this.#inlineEdit.isAvailable()) { new Notice('Claudian inline edit is not available.'); return; }
      const ok = await this.#inlineEdit.run(transcript);
      if (!ok) new Notice('Could not open Claudian inline edit for the selection.');
      return;
    }
    const status = resolveClaudianBridge(this.app);
    if (!status.ok) { new Notice(describeBridgeFailure(status)); return; }
    const sessionId = status.bridge.getActiveSessionId();
    if (!sessionId || !status.bridge.appendText?.(sessionId, transcript)) {
      // No composer access (session API): fall back to the clipboard so the words are not lost.
      await navigator.clipboard.writeText(transcript);
      new Notice('Transcript copied; paste it where you need it.');
    }
  }

  async readAloud(): Promise<boolean> {
    if (this.#reader?.isReading) { this.#reader.stop(); return true; }
    if (this.#session?.isRunning && this.#session.state.phase !== 'listening') {
      new Notice('Wait for the reply to finish, or stop the voice session, before reading a note aloud.');
      return false;
    }
    const speaker = this.#createSpeaker();
    if (!speaker) { new Notice('No speech engine available.'); return false; }
    this.#reader = new ReadAloud({
      app: this.app,
      speaker,
      onState: reading => this.#renderState(reading ? { phase: 'speaking', sessionId: 'read-aloud' } : { phase: 'idle' }),
    });
    return this.#reader.start();
  }

  async #handleLocalVerb(verb: LocalVerb): Promise<string | null> {
    switch (verb.kind) {
      case 'capture': {
        try {
          await appendToDailyNote(this.app, verb.text);
          void this.#earcons.play('listen');
          return 'Noted.';
        } catch (error) {
          new Notice(`Could not write to the daily note: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      }
      case 'read-note':
        return (await this.readAloud()) ? '' : null;
      case 'stop-reading':
        if (!this.#reader?.isReading) return null;
        this.#reader.stop();
        return '';
      case 'skip':
        if (!this.#reader?.isReading) return null;
        this.#reader.skip();
        return '';
    }
  }

  /** `[[path|name]] ` is how Claudian's own file menu attaches a note; it works through plain text on any API. */
  #activeNotePrefix(sessionId: string): string {
    if (!this.settings.includeActiveNote) return '';
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') return '';
    if (this.#lastNoteBySession.get(sessionId) === file.path) return '';
    this.#lastNoteBySession.set(sessionId, file.path);
    return `[[${file.path}|${file.basename}]] `;
  }

  /**
   * Claudian captures the live editor selection itself on the shim's submit path. The
   * session API may not, so there the selection is quoted into the prompt explicitly.
   */
  #selectionPrefix(bridgeKind: 'local-shim' | 'session-api'): string {
    if (bridgeKind === 'local-shim') return '';
    const selection = this.app.workspace.activeEditor?.editor?.getSelection().trim();
    if (!selection) return '';
    const quoted = selection.split('\n').map(line => `> ${line}`).join('\n');
    return `Selected text:\n${quoted}\n\n`;
  }

  /**
   * One speaker for the plugin's lifetime. Each OpenAISpeaker owns an AudioContext and Chromium
   * caps a page at a handful of live contexts, so creating one per session eventually goes silent.
   */
  #sharedSpeaker: { engine: string; speaker: Speaker } | null = null;

  #createSpeaker(): Speaker | null {
    const engine = this.settings.ttsEngine;
    if (this.#sharedSpeaker?.engine === engine) return this.#sharedSpeaker.speaker;
    this.#sharedSpeaker?.speaker.dispose?.();
    const speaker = this.#buildSpeaker();
    this.#sharedSpeaker = speaker ? { engine, speaker } : null;
    return speaker;
  }

  #buildSpeaker(): Speaker | null {
    if (this.settings.ttsEngine === 'openai') {
      if (!this.settings.whisperApiKey.trim() && this.settings.openaiTtsEndpoint.includes('openai.com')) return null;
      return new OpenAISpeaker({
        getEndpoint: () => this.settings.openaiTtsEndpoint,
        getApiKey: () => this.settings.whisperApiKey,
        getModel: () => this.settings.openaiTtsModel,
        getVoice: () => this.settings.openaiVoice,
        getSpeed: () => this.settings.ttsRate,
        onError: error => new Notice(`Claudian Voice: ${error.message}`, 8000),
        isDebug: () => this.settings.debug,
      });
    }
    if (!SynthesisSpeaker.isSupported()) return null;
    return new SynthesisSpeaker({
      getVoiceName: () => this.settings.ttsVoice,
      getRate: () => this.settings.ttsRate,
      getLanguage: () => this.settings.language,
    });
  }

  #createRecognizer(): SpeechRecognizer {
    if (this.settings.sttEngine === 'web-speech') {
      return new WebSpeechRecognizer(() => this.settings.language);
    }
    if (this.settings.sttEngine === 'openai-realtime') {
      return new OpenAIRealtimeRecognizer({
        getApiKey: () => this.settings.whisperApiKey,
        getModel: () => this.settings.realtimeModel,
        getLanguage: () => this.settings.language,
        getPrompt: () => this.#glossary.prompt(),
        getSilenceMs: () => this.settings.silenceMs,
        getNoSpeechTimeoutMs: () => this.settings.noSpeechTimeoutMs,
        getVadThreshold: () => this.settings.realtimeVadThreshold,
        useSemanticVad: () => this.settings.realtimeSemanticVad,
        getEagerness: () => this.settings.realtimeEagerness,
        isDebug: () => this.settings.debug,
      });
    }
    return new WhisperHttpRecognizer({
      getPrompt: () => this.#glossary.prompt(),
      getEndpoint: () => this.settings.whisperEndpoint,
      getApiKey: () => this.settings.whisperApiKey,
      getModel: () => this.settings.whisperModel,
      getLanguage: () => this.settings.language,
      getSilenceMs: () => this.settings.silenceMs,
      getNoSpeechTimeoutMs: () => this.settings.noSpeechTimeoutMs,
      getSilenceThreshold: () => this.settings.silenceThreshold,
    });
  }

  #renderState(state: VoiceState): void {
    const statusEl = this.#statusEl;
    if (statusEl) {
      statusEl.empty();
      const icon = statusEl.createSpan({ cls: 'claudian-voice-status-icon' });
      setIcon(icon, state.phase === 'idle' ? 'mic-off' : state.phase === 'speaking' ? 'volume-2' : 'mic');
      statusEl.createSpan({ text: labelFor(state) });
      statusEl.dataset.phase = state.phase;
      if (state.phase === 'listening') statusEl.style.setProperty('--claudian-voice-level', String(Math.min(1, state.level * 12)));
    }
    this.#ribbonEl?.toggleClass('claudian-voice-ribbon-active', state.phase !== 'idle' && state.phase !== 'error');
    this.#indicator?.update(state);
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<ClaudianVoiceSettings> | null) };
    this.settings.language = normalizeLanguage(this.settings.language);
    await this.#migrateSettings((await this.loadData()) as Partial<ClaudianVoiceSettings> | null);
  }

  /** Early builds persisted gpt-4o-mini-tts as the speech model; it drifts between sentences, so move to tts-1 once. */
  async #migrateSettings(stored: Partial<ClaudianVoiceSettings> | null): Promise<void> {
    const version = stored?.settingsVersion ?? 1;
    if (version < 2 && this.settings.openaiTtsModel === 'gpt-4o-mini-tts') this.settings.openaiTtsModel = 'tts-1';
    // v3: the post-reply gap clipped quick follow-ups; the recogniser now keeps a pre-roll instead.
    if (version < 3 && this.settings.turnGapMs === 400) this.settings.turnGapMs = 0;
    if (version < DEFAULT_SETTINGS.settingsVersion) {
      this.settings.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
