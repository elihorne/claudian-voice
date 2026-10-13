import { type App, PluginSettingTab, Setting } from 'obsidian';

import type ClaudianVoicePlugin from './main';
import { SynthesisSpeaker } from './speech/SynthesisSpeaker';

export type SttEngine = 'whisper-http' | 'web-speech';

export interface ClaudianVoiceSettings {
  sttEngine: SttEngine;
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
  ttsVoice: string;
  ttsRate: number;
}

export const DEFAULT_SETTINGS: ClaudianVoiceSettings = {
  sttEngine: 'whisper-http',
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
      .setDesc('Whisper HTTP works with OpenAI, Groq, and local faster-whisper or whisper.cpp servers. Web Speech is Chromium\'s built-in recogniser and usually does not work inside Obsidian.')
      .addDropdown(dropdown => dropdown
        .addOption('whisper-http', 'Whisper-compatible HTTP endpoint')
        .addOption('web-speech', 'Web Speech API (experimental)')
        .setValue(settings.sttEngine)
        .onChange(async value => { settings.sttEngine = value as SttEngine; await save(); this.display(); }));

    if (settings.sttEngine === 'whisper-http') {
      new Setting(containerEl)
        .setName('Endpoint')
        .setDesc('POST URL in the OpenAI /v1/audio/transcriptions shape.')
        .addText(text => text.setPlaceholder(DEFAULT_SETTINGS.whisperEndpoint).setValue(settings.whisperEndpoint)
          .onChange(async value => { settings.whisperEndpoint = value.trim(); await save(); }));
      new Setting(containerEl)
        .setName('API key')
        .setDesc('Sent as a Bearer token. Leave empty for local servers that need none.')
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

    new Setting(containerEl)
      .setName('Microphone sensitivity')
      .setDesc('Lower picks up quieter speech but also more room noise.')
      .addSlider(slider => slider.setLimits(0.005, 0.06, 0.005).setDynamicTooltip().setValue(settings.silenceThreshold)
        .onChange(async value => { settings.silenceThreshold = value; await save(); }));

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

    new Setting(containerEl).setName('Voice').setHeading();

    const voices = SynthesisSpeaker.listVoices();
    new Setting(containerEl)
      .setName('System voice')
      .setDesc(voices.length === 0 ? 'No system voices reported yet; reopen settings after the first spoken reply.' : 'Voices come from your operating system.')
      .addDropdown(dropdown => {
        dropdown.addOption('', 'Default');
        for (const voice of voices) dropdown.addOption(voice.name, `${voice.name} (${voice.lang})`);
        dropdown.setValue(settings.ttsVoice).onChange(async value => { settings.ttsVoice = value; await save(); });
      });

    new Setting(containerEl)
      .setName('Speaking rate')
      .addSlider(slider => slider.setLimits(0.6, 1.8, 0.1).setDynamicTooltip().setValue(settings.ttsRate)
        .onChange(async value => { settings.ttsRate = value; await save(); }));
  }
}
