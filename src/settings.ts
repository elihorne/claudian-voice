import { type App, PluginSettingTab, Setting } from 'obsidian';

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
  turnGapMs: 400,
  bargeIn: false,
  bargeInHoldMs: 500,
  soundCues: true,
  briefReplies: true,
  progressCues: true,
  includeActiveNote: true,
  promptSuffix: '(Voice chat from here on: keep replies short and conversational.)',
  ttsVoice: '',
  ttsRate: 1,
};

export class ClaudianVoiceSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ClaudianVoicePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl).setName('Speech to text').setHeading();

    new Setting(containerEl)
      .setName('Engine')
      .setDesc('Streaming (OpenAI Realtime) transcribes while you talk and detects the end of your sentence itself, so it is the fastest. Whisper HTTP records then uploads, and also works with Groq and local servers. Web Speech usually does not work inside Obsidian.')
      .addDropdown(dropdown => dropdown
        .addOption('openai-realtime', 'OpenAI streaming (fastest)')
        .addOption('whisper-http', 'Whisper-compatible HTTP endpoint')
        .addOption('web-speech', 'Web Speech API (experimental)')
        .setValue(settings.sttEngine)
        .onChange(async value => { settings.sttEngine = value as SttEngine; await save(); this.display(); }));

    if (settings.sttEngine === 'openai-realtime') {
      new Setting(containerEl)
        .setName('API key')
        .setDesc('OpenAI key, used for streaming transcription and for OpenAI speech.')
        .addText(text => {
          text.inputEl.type = 'password';
          text.setValue(settings.whisperApiKey).onChange(async value => { settings.whisperApiKey = value.trim(); await save(); });
        });
      new Setting(containerEl)
        .setName('Transcription model')
        .setDesc('gpt-4o-mini-transcribe is fast and cheap; gpt-4o-transcribe is more accurate.')
        .addText(text => text.setPlaceholder('gpt-4o-mini-transcribe').setValue(settings.realtimeModel)
          .onChange(async value => { settings.realtimeModel = value.trim(); await save(); }));
      new Setting(containerEl)
        .setName('End of turn')
        .setDesc('Semantic: the model judges when you have finished speaking, so pausing mid-thought does not send. Silence: a fixed pause ends the turn.')
        .addDropdown(dropdown => dropdown
          .addOption('semantic', 'Semantic (recommended)')
          .addOption('silence', 'Fixed silence')
          .setValue(settings.realtimeSemanticVad ? 'semantic' : 'silence')
          .onChange(async value => { settings.realtimeSemanticVad = value === 'semantic'; await save(); this.display(); }));
      if (settings.realtimeSemanticVad) {
        new Setting(containerEl)
          .setName('Eagerness')
          .setDesc('How quickly it decides you are done. Low waits for clear endings; high sends at the first plausible one.')
          .addDropdown(dropdown => dropdown
            .addOption('low', 'Low').addOption('medium', 'Medium').addOption('high', 'High')
            .setValue(settings.realtimeEagerness)
            .onChange(async value => { settings.realtimeEagerness = value as 'low' | 'medium' | 'high'; await save(); }));
      } else new Setting(containerEl)
        .setName('Voice detection sensitivity')
        .setDesc('How loud speech has to be before the server treats it as you talking. Raise it in noisy rooms.')
        .addSlider(slider => slider.setLimits(0.2, 0.9, 0.05).setDynamicTooltip().setValue(settings.realtimeVadThreshold)
          .onChange(async value => { settings.realtimeVadThreshold = value; await save(); }));
    }

    if (settings.sttEngine === 'whisper-http') {
      new Setting(containerEl)
        .setName('Endpoint')
        .setDesc('POST URL in the OpenAI /v1/audio/transcriptions shape.')
        .addText(text => text.setPlaceholder(DEFAULT_SETTINGS.whisperEndpoint).setValue(settings.whisperEndpoint)
          .onChange(async value => { settings.whisperEndpoint = value.trim(); await save(); }));
      new Setting(containerEl)
        .setName('API key')
        .setDesc('Sent as a Bearer token for both transcription and OpenAI speech. Leave empty for local servers that need none.')
        .addText(text => {
          text.inputEl.type = 'password';
          text.setValue(settings.whisperApiKey).onChange(async value => { settings.whisperApiKey = value.trim(); await save(); });
        });
      new Setting(containerEl)
        .setName('Model')
        .addText(text => text.setPlaceholder('whisper-1').setValue(settings.whisperModel)
          .onChange(async value => { settings.whisperModel = value.trim(); await save(); }));
    }

    new Setting(containerEl)
      .setName('Language')
      .setDesc('Optional hint such as "en", "de", or "sv". Empty lets the engine detect; mixed-language speakers usually get better results leaving this empty.')
      .addText(text => text.setPlaceholder('auto').setValue(settings.language)
        .onChange(async value => { settings.language = value.trim(); await save(); }));

    new Setting(containerEl)
      .setName('End of utterance')
      .setDesc('Milliseconds of silence after speech that end the recording.')
      .addSlider(slider => slider.setLimits(500, 3000, 100).setDynamicTooltip().setValue(settings.silenceMs)
        .onChange(async value => { settings.silenceMs = value; await save(); }));

    if (settings.sttEngine === 'whisper-http') new Setting(containerEl)
      .setName('Microphone sensitivity')
      .setDesc('Lower picks up quieter speech but also more room noise.')
      .addSlider(slider => slider.setLimits(0.005, 0.06, 0.005).setDynamicTooltip().setValue(settings.silenceThreshold)
        .onChange(async value => { settings.silenceThreshold = value; await save(); }));

    new Setting(containerEl).setName('Glossary').setHeading();

    new Setting(containerEl)
      .setName('Terms')
      .setDesc('Names, products, and jargon the transcriber should spell correctly. One per line or comma-separated.')
      .addTextArea(text => {
        text.inputEl.rows = 4;
        text.setPlaceholder('Claudian, Lovable, Nakul, Supabase').setValue(settings.glossaryTerms)
          .onChange(async value => { settings.glossaryTerms = value; await save(); });
      });

    new Setting(containerEl)
      .setName('Vault glossary file')
      .setDesc('Also read terms from this file so they sync with the vault. The "Add to voice glossary" command appends the selected text to it.')
      .addText(text => text.setPlaceholder('.claudian/voice-glossary.md').setValue(settings.glossaryFile)
        .onChange(async value => { settings.glossaryFile = value.trim(); await save(); }));

    new Setting(containerEl).setName('Conversation').setHeading();

    new Setting(containerEl)
      .setName('Send automatically')
      .setDesc('Off inserts the transcript into the composer so you can edit it before sending.')
      .addToggle(toggle => toggle.setValue(settings.autoSubmit)
        .onChange(async value => { settings.autoSubmit = value; await save(); }));

    new Setting(containerEl)
      .setName('Speak replies')
      .addToggle(toggle => toggle.setValue(settings.speakReplies)
        .onChange(async value => { settings.speakReplies = value; await save(); }));

    new Setting(containerEl)
      .setName('Keep listening')
      .setDesc('After the reply finishes, listen for the next prompt until you stop the session.')
      .addToggle(toggle => toggle.setValue(settings.conversationMode)
        .onChange(async value => { settings.conversationMode = value; await save(); }));

    new Setting(containerEl)
      .setName('Interrupt by speaking')
      .setDesc('Keeps the microphone open while the reply plays and cuts it off when you start talking. Use with headphones. On laptop speakers the reply itself can trigger it, which cancels the answer before you hear it. The "Interrupt reply and listen" command works regardless.')
      .addToggle(toggle => toggle.setValue(settings.bargeIn)
        .onChange(async value => { settings.bargeIn = value; await save(); }));

    new Setting(containerEl)
      .setName('Include the active note')
      .setDesc('Attach the note you are looking at to your spoken prompt, the same way "Add to chat" does, whenever it has changed since your last voice turn in that conversation.')
      .addToggle(toggle => toggle.setValue(settings.includeActiveNote)
        .onChange(async value => { settings.includeActiveNote = value; await save(); }));

    new Setting(containerEl)
      .setName('Ask for spoken-length replies')
      .setDesc('Appends a short hint to the first voice prompt in each conversation so the agent answers conversationally. Later prompts in the same conversation are sent clean.')
      .addToggle(toggle => toggle.setValue(settings.briefReplies)
        .onChange(async value => { settings.briefReplies = value; await save(); this.display(); }));
    if (settings.briefReplies) {
      new Setting(containerEl)
        .setName('Hint text')
        .addTextArea(text => text.setValue(settings.promptSuffix)
          .onChange(async value => { settings.promptSuffix = value; await save(); }));
    }

    new Setting(containerEl)
      .setName('Spoken progress')
      .setDesc('When the agent is busy with tools and has not written anything for a few seconds, say "Working on it", then "Still working" every twenty seconds.')
      .addToggle(toggle => toggle.setValue(settings.progressCues)
        .onChange(async value => { settings.progressCues = value; await save(); }));

    new Setting(containerEl)
      .setName('Sound cues')
      .setDesc('A rising chime when the session starts, a tick each time it starts listening again, a falling chime on stop.')
      .addToggle(toggle => toggle.setValue(settings.soundCues)
        .onChange(async value => { settings.soundCues = value; await save(); }));

    new Setting(containerEl).setName('Voice').setHeading();

    new Setting(containerEl)
      .setName('Speech engine')
      .setDesc('OpenAI gives natural neural voices and uses the API key above. System uses the voices built into your OS, which are free and offline but sound mechanical unless you download enhanced voices.')
      .addDropdown(dropdown => dropdown
        .addOption('openai', 'OpenAI (neural)')
        .addOption('system', 'System voices')
        .setValue(settings.ttsEngine)
        .onChange(async value => { settings.ttsEngine = value as TtsEngine; await save(); this.display(); }));

    if (settings.ttsEngine === 'openai') {
      new Setting(containerEl)
        .setName('OpenAI voice')
        .setDesc('Picking a voice plays a short sample.')
        .addDropdown(dropdown => {
          for (const voice of OPENAI_VOICES) dropdown.addOption(voice, voice);
          dropdown.setValue(settings.openaiVoice).onChange(async value => {
            settings.openaiVoice = value;
            await save();
            this.plugin.previewVoice();
          });
        })
        .addExtraButton(button => button.setIcon('play').setTooltip('Play sample').onClick(() => this.plugin.previewVoice()));
      new Setting(containerEl)
        .setName('OpenAI speech model')
        .setDesc('tts-1 is fast and sounds the same from sentence to sentence; tts-1-hd is higher quality. gpt-4o-mini-tts is more expressive but can shift voice between short requests.')
        .addText(text => text.setPlaceholder('tts-1').setValue(settings.openaiTtsModel)
          .onChange(async value => { settings.openaiTtsModel = value.trim(); await save(); }));
      new Setting(containerEl)
        .setName('Speech endpoint')
        .addText(text => text.setPlaceholder(DEFAULT_SETTINGS.openaiTtsEndpoint).setValue(settings.openaiTtsEndpoint)
          .onChange(async value => { settings.openaiTtsEndpoint = value.trim(); await save(); }));
    } else {
      const voices = SynthesisSpeaker.listVoices();
      const voiceSetting = new Setting(containerEl)
        .setName('System voice')
        .setDesc(voices.length === 0
          ? 'Loading system voices…'
          : 'On macOS, better voices are under System Settings → Accessibility → Spoken Content → System Voice → Manage Voices (download the "Enhanced" or "Premium" ones).')
        .addDropdown(dropdown => {
          dropdown.addOption('', 'Default');
          for (const voice of voices) dropdown.addOption(voice.name, `${voice.name} (${voice.lang})`);
          dropdown.setValue(settings.ttsVoice).onChange(async value => {
            settings.ttsVoice = value;
            await save();
            this.plugin.previewVoice();
          });
        })
        .addExtraButton(button => button.setIcon('play').setTooltip('Play sample').onClick(() => this.plugin.previewVoice()));
      if (voices.length === 0 && SynthesisSpeaker.isSupported()) {
        // Chromium populates the list asynchronously; redraw once it arrives.
        window.speechSynthesis.addEventListener('voiceschanged', () => {
          if (voiceSetting.settingEl.isConnected) this.display();
        }, { once: true });
      }
    }

    new Setting(containerEl)
      .setName('Speaking rate')
      .setDesc(settings.ttsEngine === 'openai'
        ? 'Exact on tts-1 and tts-1-hd. gpt-4o-mini-tts has no speed control, so the slider becomes a spoken-pace instruction and the result is approximate.'
        : 'Applies to the next sentence spoken; a running session does not need restarting.')
      .addSlider(slider => slider.setLimits(0.6, 1.8, 0.1).setDynamicTooltip().setValue(settings.ttsRate)
        .onChange(async value => { settings.ttsRate = value; await save(); }))
      .addExtraButton(button => button.setIcon('play').setTooltip('Play sample').onClick(() => this.plugin.previewVoice()));
  }
}
