import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { floatToPcm16, resample } from '../src/speech/pcm';
import { PCM_CAPTURE_PROCESSOR, PCM_CAPTURE_WORKLET_SOURCE, type PcmCaptureMessage } from '../src/speech/pcmCaptureWorklet';

interface ProcessorLike {
  process(inputs: Float32Array[][]): boolean;
  flush(): void;
}
interface ProcessorClass {
  new (options: { processorOptions: { targetRate: number; chunkSamples: number } }): ProcessorLike;
}

/** Evaluates the worklet source with a stand-in AudioWorkletGlobalScope and returns a processor factory. */
function loadWorklet(sampleRate: number) {
  const posted: PcmCaptureMessage[] = [];
  const registry = new Map<string, ProcessorClass>();
  class AudioWorkletProcessor {
    port = { postMessage: (message: PcmCaptureMessage) => { posted.push(message); } };
  }
  const registerProcessor = (name: string, cls: ProcessorClass) => { registry.set(name, cls); };
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', PCM_CAPTURE_WORKLET_SOURCE)(AudioWorkletProcessor, registerProcessor, sampleRate);
  const Processor = registry.get(PCM_CAPTURE_PROCESSOR);
  assert.ok(Processor, 'processor registered under the exported name');
  return {
    posted,
    create: (targetRate: number, chunkSamples: number) => new Processor({ processorOptions: { targetRate, chunkSamples } }),
  };
}

const sine = (length: number, period: number) => Float32Array.from({ length }, (_, i) => Math.sin((i / period) * Math.PI * 2));

describe('PCM capture worklet', () => {
  it('resamples 48k input to 24k pcm16 in fixed-size chunks and reports the level', () => {
    const { posted, create } = loadWorklet(48000);
    const processor = create(24000, 240);
    const input = sine(4800, 480); // 100ms, 10 cycles
    for (let offset = 0; offset < input.length; offset += 128) {
      processor.process([[input.subarray(offset, offset + 128)]]);
    }
    processor.flush();

    const total = posted.reduce((sum, message) => sum + message.pcm.length, 0);
    assert.ok(Math.abs(total - 2400) <= 1, `about half the samples come out (${total})`);
    assert.ok(posted.slice(0, -1).every(message => message.pcm.length === 240), 'full chunks are the requested size');
    assert.ok(posted.every(message => message.pcm instanceof Int16Array));
    // Each 240-sample chunk is one whole cycle, so the level is a sine's 0.707.
    assert.ok(posted.every(message => Math.abs(message.rms - Math.SQRT1_2) < 0.02), `rms ${posted[0]?.rms}`);
  });

  it('reports the exact level of a constant-amplitude signal per chunk', () => {
    const { posted, create } = loadWorklet(48000);
    const processor = create(24000, 120);
    const square = Float32Array.from({ length: 1280 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5));
    for (let offset = 0; offset < square.length; offset += 128) processor.process([[square.subarray(offset, offset + 128)]]);
    processor.flush();
    assert.ok(posted.length >= 5);
    assert.ok(posted.every(message => Math.abs(message.rms - 0.5) < 1e-6), `rms ${posted.map(m => m.rms).join(', ')}`);
  });

  it('agrees with the main-thread resampler on a block boundary', () => {
    const { posted, create } = loadWorklet(48000);
    const processor = create(24000, 10_000);
    const input = sine(960, 480);
    processor.process([[input.subarray(0, 480)]]);
    processor.process([[input.subarray(480)]]);
    processor.flush();
    const worklet = [...(posted[0]?.pcm ?? [])];
    const reference = [...floatToPcm16(resample(input, 48000, 24000))];
    // The worklet may hold back the final sample until it has a right-hand neighbour.
    assert.ok(reference.length - worklet.length <= 1 && worklet.length <= reference.length, `${worklet.length} vs ${reference.length}`);
    for (let index = 0; index < worklet.length; index += 1) {
      assert.ok(Math.abs((worklet[index] ?? 0) - (reference[index] ?? 0)) <= 1, `sample ${index}: ${worklet[index]} vs ${reference[index]}`);
    }
  });

  it('passes audio through at the target rate with a one-sample delay', () => {
    const { posted, create } = loadWorklet(24000);
    const processor = create(24000, 64);
    processor.process([[new Float32Array([0, 0.5, -0.5, 1, -1])]]);
    processor.flush();
    assert.deepEqual([...(posted[0]?.pcm ?? [])], [0, 16383, -16384, 32767]);
  });

  it('clamps over-range samples', () => {
    const { posted, create } = loadWorklet(24000);
    const processor = create(24000, 64);
    processor.process([[new Float32Array([2, -2, 0])]]);
    processor.flush();
    assert.deepEqual([...(posted[0]?.pcm ?? [])], [32767, -32768]);
  });

  it('posts nothing for silence until a chunk fills, then zeros', () => {
    const { posted, create } = loadWorklet(24000);
    const processor = create(24000, 128);
    processor.process([[new Float32Array(100)]]);
    assert.equal(posted.length, 0);
    processor.process([[new Float32Array(100)]]);
    assert.equal(posted.length, 1);
    assert.equal(posted[0]?.rms, 0);
    assert.ok([...(posted[0]?.pcm ?? [])].every(sample => sample === 0));
  });

  it('keeps running on an empty input block', () => {
    const { create } = loadWorklet(48000);
    const processor = create(24000, 64);
    assert.equal(processor.process([[]]), true);
    assert.equal(processor.process([]), true);
  });
});
