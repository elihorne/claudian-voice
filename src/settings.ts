import { type App, PluginSettingTab, type Setting, type SettingDefinitionItem } from 'obsidian';

import type ClaudianVoicePlugin from './main';
import { SynthesisSpeaker } from './speech/SynthesisSpeaker';

export type SttEngine = 'openai-realtime' | 'whisper-http' | 'web-speech';
export type TtsEngine = 'openai' | 'system';

export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'] as const;

export interface ClaudianVoiceSettings {
  sttEngine: SttEngine;
  realtimeModel: string;
  realtimeVadThreshold: number;
  realtimeSemanticVad: boolean;
  realtimeEagerness: 'low' | 'medium' | 'high';
  glossaryTerms: string;
  glossaryFile: string;
  ttsEngine: TtsEngine;
  openaiTtsEndpoint: string;
  openaiTtsModel: string;
  openaiVoice: string;
  whisperEndpoint: string;
  whisperApiKey: string;
  whisperModel: string;
  /** BCP-47 or ISO-639-1 hint for both STT and TTS; empty lets the engines detect. */
  language: string;
  silenceMs: number;
  noSpeechTimeoutMs: number;
  silenceThreshold: number;
  autoSubmit: boolean;
  speakReplies: boolean;
  conversationMode: boolean;
  turnGapMs: number;
  /** Keep the mic open while the agent speaks and cut it off when the user talks. */
  bargeIn: boolean;
  bargeInHoldMs: number;
  /** Chime on start, tick when listening resumes, chime on stop. */
  soundCues: boolean;
  /** Append a spoken-length hint to voice prompts; matters most when replies are not streamed. */
  briefReplies: boolean;
  promptSuffix: string;
  /** Say "working on it" when the agent is busy but silent. */
  progressCues: boolean;
  /** Prefix voice prompts with a link to the active note when it changed since the last voice turn. */
  includeActiveNote: boolean;
  /** End a session after this many seconds with nothing heard. 0 keeps listening forever. */
  idleStopSeconds: number;
  /** Console logging for diagnosing transcription problems. */
  debug: boolean;
  /** Bumped when stored defaults need migrating. */
  settingsVersion: number;
  ttsVoice: string;
  ttsRate: number;
}

export const DEFAULT_SETTINGS: ClaudianVoiceSettings = {
  sttEngine: 'openai-realtime',
  realtimeModel: 'gpt-4o-mini-transcribe',
  realtimeVadThreshold: 0.6,
  realtimeSemanticVad: true,
  realtimeEagerness: 'medium',
  glossaryTerms: '',
  glossaryFile: '.claudian/voice-glossary.md',
  ttsEngine: 'openai',
  openaiTtsEndpoint: 'https://api.openai.com/v1/audio/speech',
  openaiTtsModel: 'tts-1',
  openaiVoice: 'nova',
  whisperEndpoint: 'https://api.openai.com/v1/audio/transcriptions',
  whisperApiKey: '',
  whisperModel: 'whisper-1',
  language: '',
  silenceMs: 1200,
  noSpeechTimeoutMs: 8000,
  silenceThreshold: 0.015,
  autoSubmit: true,
  speakReplies: true,
  conversationMode: true,
  turnGapMs: 0,
  bargeIn: false,
  bargeInHoldMs: 500,
  soundCues: true,
  briefReplies: true,
  progressCues: true,
  includeActiveNote: true,
  debug: false,
  idleStopSeconds: 45,
  settingsVersion: 3,
  promptSuffix: '(Voice chat from here on: keep replies short and conversational.)',
  ttsVoice: '',
  ttsRate: 1,
};

/** Accepts `en`, `"en"`, `en-US`, ` EN ` and returns the lowercase ISO-639-1 code the engines expect. */
export function normalizeLanguage(value: string): string {
  const stripped = value.replace(/["'`\s]/g, '').toLowerCase();
  return stripped.split(/[-_]/)[0] ?? '';
}

/** Keys the declarative controls bind to. `realtimeTurnDetection` is a view over `realtimeSemanticVad`. */
type SettingKey = keyof ClaudianVoiceSettings | 'realtimeTurnDetection';

/** Text settings stored trimmed. */
const TRIMMED_KEYS = new Set<SettingKey>(['realtimeModel', 'whisperEndpoint', 'whisperModel', 'glossaryFile', 'openaiTtsModel', 'openaiTtsEndpoint', 'whisperApiKey']);

/**
 * Declarative settings (Obsidian 1.13+), so every setting is searchable from the settings
 * search box. Rows the declarative controls cannot express (password fields, a play button
 * beside a control) use `render`.
 */
export class ClaudianVoiceSettingTab extends PluginSettingTab {
  #voicesListener = false;

  constructor(app: App, private readonly plugin: ClaudianVoicePlugin) {
    super(app, plugin);
  }

  override getControlValue(key: string): unknown {
    const settings = this.plugin.settings;
    if (key === 'realtimeTurnDetection') return settings.realtimeSemanticVad ? 'semantic' : 'silence';
    return (settings as unknown as Record<string, unknown>)[key];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    if (key === 'realtimeTurnDetection') settings.realtimeSemanticVad = value === 'semantic';
    else if (key === 'language') settings.language = normalizeLanguage(String(value ?? ''));
    else if (TRIMMED_KEYS.has(key as SettingKey)) (settings as unknown as Record<string, unknown>)[key] = String(value ?? '').trim();
    else (settings as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
    // Engine and mode switches change which rows apply.
    this.refreshDomState();
  }

  override getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
    const settings = this.plugin.settings;
    const realtime = () => settings.sttEngine === 'openai-realtime';
    const whisper = () => settings.sttEngine === 'whisper-http';
    const openaiTts = () => settings.ttsEngine === 'openai';
    const systemTts = () => settings.ttsEngine === 'system';

    return [
      {
        type: 'group',
        heading: 'Speech to text',
        items: [
          {
            name: 'Engine',
            desc: 'Streaming (OpenAI Realtime) transcribes while you talk and detects the end of your sentence itself, so it is the fastest. Whisper HTTP records then uploads, and also works with Groq and local servers. Web Speech usually does not work inside Obsidian.',
            control: {
              type: 'dropdown',
              key: 'sttEngine',
              options: {
                'openai-realtime': 'OpenAI streaming (fastest)',
                'whisper-http': 'Whisper-compatible HTTP endpoint',
                'web-speech': 'Web Speech API (experimental)',
              },
            },
          },
          {
            name: 'API key',
            desc: 'OpenAI key, used for streaming transcription and for OpenAI speech.',
            aliases: ['OpenAI', 'token'],
            visible: realtime,
            render: setting => this.#renderSecret(setting, 'whisperApiKey'),
          },
          {
            name: 'Transcription model',
            desc: 'gpt-4o-mini-transcribe is fast and cheap; gpt-4o-transcribe is more accurate.',
            visible: realtime,
            control: { type: 'text', key: 'realtimeModel', placeholder: 'gpt-4o-mini-transcribe' },
          },
          {
            name: 'End of turn',
            desc: 'Semantic: the model judges when you have finished speaking, so pausing mid-thought does not send. Silence: a fixed pause ends the turn.',
            visible: realtime,
            control: {
              type: 'dropdown',
              key: 'realtimeTurnDetection',
              options: { semantic: 'Semantic (recommended)', silence: 'Fixed silence' },
            },
          },
          {
            name: 'Eagerness',
            desc: 'How quickly it decides you are done. Low waits for clear endings; high sends at the first plausible one.',
            visible: () => realtime() && settings.realtimeSemanticVad,
            control: { type: 'dropdown', key: 'realtimeEagerness', options: { low: 'Low', medium: 'Medium', high: 'High' } },
          },
          {
            name: 'Voice detection sensitivity',
            desc: 'How loud speech has to be before the server treats it as you talking. Raise it in noisy rooms.',
            visible: () => realtime() && !settings.realtimeSemanticVad,
            control: { type: 'slider', key: 'realtimeVadThreshold', min: 0.2, max: 0.9, step: 0.05 },
          },
          {
            name: 'Endpoint',
            desc: 'POST URL in the OpenAI /v1/audio/transcriptions shape.',
            visible: whisper,
            control: { type: 'text', key: 'whisperEndpoint', placeholder: DEFAULT_SETTINGS.whisperEndpoint },
          },
          {
            name: 'API key',
            desc: 'Sent as a Bearer token for both transcription and OpenAI speech. Leave empty for local servers that need none.',
            aliases: ['token'],
            visible: whisper,
            render: setting => this.#renderSecret(setting, 'whisperApiKey'),
          },
          {
            name: 'Model',
            visible: whisper,
            control: { type: 'text', key: 'whisperModel', placeholder: 'whisper-1' },
          },
          {
            name: 'Language',
            desc: 'Optional hint such as "en", "de", or "sv". Empty lets the engine detect; mixed-language speakers usually get better results leaving this empty.',
            control: { type: 'text', key: 'language', placeholder: 'auto' },
          },
          {
            name: 'End of utterance',
            desc: 'Milliseconds of silence after speech that end the recording.',
            control: { type: 'slider', key: 'silenceMs', min: 500, max: 3000, step: 100 },
          },
          {
            name: 'Microphone sensitivity',
            desc: 'Lower picks up quieter speech but also more room noise.',
            visible: whisper,
            control: { type: 'slider', key: 'silenceThreshold', min: 0.005, max: 0.06, step: 0.005 },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Glossary',
        items: [
          {
            name: 'Terms',
            desc: 'Names, products, and jargon the transcriber should spell correctly. One per line or comma-separated.',
            control: { type: 'textarea', key: 'glossaryTerms', rows: 4, placeholder: 'Claudian, Lovable, Nakul, Supabase' },
          },
          {
            name: 'Vault glossary file',
            desc: 'Also read terms from this file so they sync with the vault. The "Add to voice glossary" command appends the selected text to it.',
            control: { type: 'text', key: 'glossaryFile', placeholder: '.claudian/voice-glossary.md' },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Conversation',
        items: [
          {
            name: 'Send automatically',
            desc: 'Off inserts the transcript into the composer so you can edit it before sending. Claudian\'s plugin API has no composer access, so on current Claudian the prompt is sent either way.',
            control: { type: 'toggle', key: 'autoSubmit' },
          },
          { name: 'Speak replies', control: { type: 'toggle', key: 'speakReplies' } },
          {
            name: 'Keep listening',
            desc: 'After the reply finishes, listen for the next prompt until you stop the session.',
            control: { type: 'toggle', key: 'conversationMode' },
          },
          {
            name: 'Interrupt by speaking',
            desc: 'Keeps the microphone open while the reply plays and cuts it off when you start talking. Use with headphones. On laptop speakers the reply itself can trigger it, which cancels the answer before you hear it. The "Interrupt reply and listen" command works regardless.',
            aliases: ['barge-in'],
            control: { type: 'toggle', key: 'bargeIn' },
          },
          {
            name: 'Include the active note',
            desc: 'Attach the note you are looking at to your spoken prompt, the same way "Add to chat" does, whenever it has changed since your last voice turn in that conversation.',
            control: { type: 'toggle', key: 'includeActiveNote' },
          },
          {
            name: 'Ask for spoken-length replies',
            desc: 'Appends a short hint to the first voice prompt in each conversation so the agent answers conversationally. Later prompts in the same conversation are sent clean.',
            control: { type: 'toggle', key: 'briefReplies' },
          },
          {
            name: 'Hint text',
            visible: () => settings.briefReplies,
            control: { type: 'textarea', key: 'promptSuffix' },
          },
          {
            name: 'Stop when idle',
            desc: 'End the session after this many seconds with nothing heard. Streaming transcription is billed while the mic is open, so this is also a cost guard. 0 keeps listening until you stop it.',
            control: { type: 'slider', key: 'idleStopSeconds', min: 0, max: 180, step: 15 },
          },
          {
            name: 'Spoken progress',
            desc: 'When the agent is busy with tools and has not written anything for a few seconds, say "Working on it", then "Still working" every twenty seconds.',
            control: { type: 'toggle', key: 'progressCues' },
          },
          {
            name: 'Sound cues',
            desc: 'A rising chime when the session starts, a tick each time it starts listening again, a falling chime on stop.',
            control: { type: 'toggle', key: 'soundCues' },
          },
          {
            name: 'Debug logging',
            desc: 'Write transcription and session events to the developer console (⌘⌥I).',
            control: { type: 'toggle', key: 'debug' },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Voice',
        items: [
          {
            name: 'Speech engine',
            desc: 'OpenAI gives natural neural voices and uses the API key above. System uses the voices built into your OS, which are free and offline but sound mechanical unless you download enhanced voices.',
            aliases: ['text to speech', 'TTS'],
            control: { type: 'dropdown', key: 'ttsEngine', options: { openai: 'OpenAI (neural)', system: 'System voices' } },
          },
          {
            name: 'OpenAI voice',
            desc: 'Picking a voice plays a short sample.',
            visible: openaiTts,
            render: setting => this.#renderVoicePicker(setting, 'openaiVoice', Object.fromEntries(OPENAI_VOICES.map(voice => [voice, voice]))),
          },
          {
            name: 'OpenAI speech model',
            desc: 'tts-1 is fast and sounds the same from sentence to sentence; tts-1-hd is higher quality. gpt-4o-mini-tts is more expressive but can shift voice between short requests.',
            visible: openaiTts,
            control: { type: 'text', key: 'openaiTtsModel', placeholder: 'tts-1' },
          },
          {
            name: 'Speech endpoint',
            visible: openaiTts,
            control: { type: 'text', key: 'openaiTtsEndpoint', placeholder: DEFAULT_SETTINGS.openaiTtsEndpoint },
          },
          {
            name: 'System voice',
            desc: this.#systemVoiceDescription(),
            visible: systemTts,
            render: setting => this.#renderVoicePicker(setting, 'ttsVoice', this.#systemVoiceOptions()),
          },
          {
            name: 'Speaking rate',
            desc: 'Exact on tts-1 and tts-1-hd. gpt-4o-mini-tts has no speed control, so the slider becomes a spoken-pace instruction and the result is approximate.',
            visible: openaiTts,
            render: setting => this.#renderRate(setting),
          },
          {
            name: 'Speaking rate',
            desc: 'Applies to the next sentence spoken; a running session does not need restarting.',
            visible: systemTts,
            render: setting => this.#renderRate(setting),
          },
        ],
      },
    ];
  }

  /** Password-masked text input; the declarative text control has no masked variant. */
  #renderSecret(setting: Setting, key: 'whisperApiKey'): void {
    setting.addText(text => {
      text.inputEl.type = 'password';
      text.setValue(this.plugin.settings[key]).onChange(value => { void this.setControlValue(key, value); });
    });
  }

  /** Dropdown with a play button; choosing a voice plays a sample. */
  #renderVoicePicker(setting: Setting, key: 'openaiVoice' | 'ttsVoice', options: Record<string, string>): void {
    setting
      .addDropdown(dropdown => {
        for (const [value, label] of Object.entries(options)) dropdown.addOption(value, label);
        dropdown.setValue(this.plugin.settings[key]).onChange(async value => {
          await this.setControlValue(key, value);
          this.plugin.previewVoice();
        });
      })
      .addExtraButton(button => button.setIcon('play').setTooltip('Play sample').onClick(() => this.plugin.previewVoice()));
  }

  #renderRate(setting: Setting): void {
    setting
      .addSlider(slider => slider.setLimits(0.6, 1.8, 0.1).setDynamicTooltip().setValue(this.plugin.settings.ttsRate)
        .onChange(value => { void this.setControlValue('ttsRate', value); }))
      .addExtraButton(button => button.setIcon('play').setTooltip('Play sample').onClick(() => this.plugin.previewVoice()));
  }

  #systemVoiceOptions(): Record<string, string> {
    const options: Record<string, string> = { '': 'Default' };
    for (const voice of SynthesisSpeaker.listVoices()) options[voice.name] = `${voice.name} (${voice.lang})`;
    return options;
  }

  #systemVoiceDescription(): string {
    const voices = SynthesisSpeaker.listVoices();
    if (voices.length === 0 && SynthesisSpeaker.isSupported() && !this.#voicesListener) {
      // Chromium populates the list asynchronously; rebuild the definitions once it arrives.
      this.#voicesListener = true;
      window.speechSynthesis.addEventListener('voiceschanged', () => { this.#voicesListener = false; this.update(); }, { once: true });
    }
    return voices.length === 0
      ? 'Loading system voices…'
      : 'On macOS, better voices are under System Settings → Accessibility → Spoken Content → System Voice → Manage Voices (download the "Enhanced" or "Premium" ones).';
  }
}
