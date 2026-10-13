import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { floatToPcm16, pcm16ToBase64, resample, rootMeanSquare } from '../src/speech/pcm';

describe('resample', () => {
  it('halves the sample count from 48k to 24k and keeps the signal shape', () => {
    const input = Float32Array.from({ length: 480 }, (_, i) => Math.sin((i / 480) * Math.PI * 2));
    const out = resample(input, 48000, 24000);
    assert.equal(out.length, 240);
    assert.ok(Math.abs((out[60] ?? 0) - 1) < 0.01, 'peak lands at the quarter wave');
    assert.ok(Math.abs(out[0] ?? 1) < 0.01);
  });

  it('returns the input untouched when rates match', () => {
    const input = new Float32Array([0.1, 0.2]);
    assert.equal(resample(input, 24000, 24000), input);
  });
});

describe('floatToPcm16', () => {
  it('maps the float range onto signed 16-bit and clamps overs', () => {
    const pcm = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    assert.deepEqual([...pcm], [0, 32767, -32768, 32767, -32768, 16383]);
  });
});

describe('pcm16ToBase64', () => {
  it('encodes little-endian bytes', () => {
    assert.equal(pcm16ToBase64(new Int16Array([1, -1])), 'AQD//w==');
  });
});

describe('rootMeanSquare', () => {
  it('is zero for silence and the amplitude for a square wave', () => {
    assert.equal(rootMeanSquare(new Float32Array(10)), 0);
    assert.ok(Math.abs(rootMeanSquare(new Float32Array([0.5, -0.5, 0.5, -0.5])) - 0.5) < 1e-6);
  });
});
