import { Notice, Plugin, setIcon } from 'obsidian';

import { type ClaudianApi, describeApiFailure, resolveClaudianApi } from './claudian/api';
import { ClaudianVoiceSettingTab, type ClaudianVoiceSettings, DEFAULT_SETTINGS } from './settings';
import { SynthesisSpeaker } from './speech/SynthesisSpeaker';
import type { SpeechRecognizer } from './speech/types';
import { WebSpeechRecognizer } from './speech/WebSpeechRecognizer';
import { WhisperHttpRecognizer } from './speech/WhisperHttpRecognizer';
import { VoiceSession, type VoiceState } from './voice/VoiceSession';

export default class ClaudianVoicePlugin extends Plugin {
  settings: ClaudianVoiceSettings = { ...DEFAULT_SETTINGS };
  #session: VoiceSession | null = null;
  #statusEl: HTMLElement | null = null;
  #ribbonEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ClaudianVoiceSettingTab(this.app, this));

    this.#statusEl = this.addStatusBarItem();
    this.#statusEl.addClass('claudian-voice-status');
    this.#renderState({ phase: 'idle' });

    this.#ribbonEl = this.addRibbonIcon('mic', 'Claudian Voice: start or stop conversation', () => this.toggleConversation());

    this.addCommand({
      id: 'toggle-conversation',
      name: 'Start or stop voice conversation',
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
      callback: () => this.#session?.interrupt(),
    });
    this.addCommand({
      id: 'stop',
      name: 'Stop listening and speaking',
      callback: () => this.stopSession(),
    });
  }

  onunload(): void {
    this.stopSession();
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
    const status = resolveClaudianApi(this.app);
    if (!status.ok) {
      new Notice(describeApiFailure(status));
      return;
    }
    if (!status.api.getActiveChat()) {
      new Notice('Open a Claudian chat first.');
      return;
    }
    const recognizer = this.#createRecognizer();
    if (!recognizer.isAvailable()) {
      new Notice(recognizer.id === 'whisper-http'
        ? 'Set a transcription endpoint in Claudian Voice settings.'
        : 'Web Speech API is not available here; switch the engine in settings.');
      return;
    }
    if (this.settings.speakReplies && !SynthesisSpeaker.isSupported()) {
      new Notice('Speech synthesis is not available; replies will not be spoken.');
    }

    const session = new VoiceSession({
      api: status.api,
      recognizer,
      speaker: new SynthesisSpeaker({
        getVoiceName: () => this.settings.ttsVoice,
        getRate: () => this.settings.ttsRate,
        getLanguage: () => this.settings.language,
      }),
      isConversationMode: () => options.conversation,
      isSpeechEnabled: () => this.settings.speakReplies && SynthesisSpeaker.isSupported(),
      shouldAutoSubmit: () => this.settings.autoSubmit,
      getTurnGapMs: () => this.settings.turnGapMs,
      onState: state => this.#renderState(state),
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

  #createRecognizer(): SpeechRecognizer {
    if (this.settings.sttEngine === 'web-speech') {
      return new WebSpeechRecognizer(() => this.settings.language);
    }
    return new WhisperHttpRecognizer({
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
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<ClaudianVoiceSettings> | null) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

function labelFor(state: VoiceState): string {
  switch (state.phase) {
    case 'idle': return 'Voice off';
    case 'listening': return 'Listening';
    case 'transcribing': return 'Transcribing';
    case 'thinking': return 'Waiting for reply';
    case 'speaking': return 'Speaking';
    case 'error': return 'Voice error';
  }
}
