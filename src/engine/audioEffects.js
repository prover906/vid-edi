// Audio effects (Premiere-style list) built from Web Audio nodes.
// build(ctx, p) -> { input, output, auto?: { paramId: [AudioParam, map(v)] } }

import { registerAudioEffect } from '../core/registry.js';
import { P } from './effectKit.js';
import { dbToGain } from '../core/util.js';

const reg = registerAudioEffect;

function chain(ctx, nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return { input: nodes[0], output: nodes[nodes.length - 1] };
}
function biquad(ctx, type, freq, gain = 0, Q = 1) {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = freq;
  b.gain.value = gain;
  b.Q.value = Q;
  return b;
}

// ---- intrinsic ----
reg({
  id: 'volume', name: 'Volume', intrinsic: true,
  params: [P.bool('bypass', 'Bypass', false), P.num('level', 'Level', 0, -96, 15, { unit: 'dB', uiMin: -60, uiMax: 6, step: 0.1 })],
});
reg({
  id: 'channelVolume', name: 'Channel Volume', intrinsic: true,
  params: [P.bool('bypass', 'Bypass', false), P.num('left', 'Left', 0, -96, 15, { unit: 'dB', uiMin: -60, uiMax: 6 }), P.num('right', 'Right', 0, -96, 15, { unit: 'dB', uiMin: -60, uiMax: 6 })],
  build(ctx, p) {
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    const gl = ctx.createGain(), gr = ctx.createGain();
    gl.gain.value = p.bypass ? 1 : dbToGain(p.left);
    gr.gain.value = p.bypass ? 1 : dbToGain(p.right);
    split.connect(gl, 0);
    split.connect(gr, 1);
    gl.connect(merge, 0, 0);
    gr.connect(merge, 0, 1);
    const inp = ctx.createGain();
    inp.channelCountMode = 'explicit';
    inp.channelCount = 2;
    inp.connect(split);
    return { input: inp, output: merge, auto: p.bypass ? {} : { left: [gl.gain, dbToGain], right: [gr.gain, dbToGain] } };
  },
  isDefault: (p) => p.bypass || (p.left === 0 && p.right === 0),
});
reg({
  id: 'panner', name: 'Panner', intrinsic: true,
  params: [P.num('balance', 'Balance', 0, -100, 100)],
  build(ctx, p) {
    const pn = ctx.createStereoPanner();
    pn.pan.value = p.balance / 100;
    return { input: pn, output: pn, auto: { balance: [pn.pan, (v) => v / 100] } };
  },
  isDefault: (p) => p.balance === 0,
});

// ---- Amplitude and Compression ----
reg({
  id: 'amplify', name: 'Amplify', category: 'Amplitude and Compression',
  params: [P.num('gain', 'Gain', 0, -96, 24, { unit: 'dB', uiMin: -30, uiMax: 24 })],
  build(ctx, p) {
    const g = ctx.createGain();
    g.gain.value = dbToGain(p.gain);
    return { input: g, output: g, auto: { gain: [g.gain, dbToGain] } };
  },
});
reg({
  id: 'channelMixer', name: 'Channel Mixer', category: 'Amplitude and Compression',
  params: [P.pct('ll', 'L → L', 100, -100, 100), P.pct('rl', 'R → L', 0, -100, 100), P.pct('lr', 'L → R', 0, -100, 100), P.pct('rr', 'R → R', 100, -100, 100)],
  build(ctx, p) {
    const inp = ctx.createGain();
    inp.channelCountMode = 'explicit';
    inp.channelCount = 2;
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    inp.connect(split);
    const mk = (v, from, to) => {
      const g = ctx.createGain();
      g.gain.value = v / 100;
      split.connect(g, from);
      g.connect(merge, 0, to);
    };
    mk(p.ll, 0, 0);
    mk(p.rl, 1, 0);
    mk(p.lr, 0, 1);
    mk(p.rr, 1, 1);
    return { input: inp, output: merge };
  },
});
reg({
  id: 'compressor', name: 'Single-band Compressor', category: 'Amplitude and Compression',
  params: [P.num('threshold', 'Threshold', -20, -60, 0, { unit: 'dB' }), P.num('ratio', 'Ratio', 4, 1, 20), P.num('attack', 'Attack', 10, 0, 1000, { unit: 'ms' }), P.num('release', 'Release', 100, 0, 1000, { unit: 'ms' }), P.num('makeup', 'Output Gain', 0, -30, 30, { unit: 'dB' })],
  build(ctx, p) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = p.threshold;
    c.ratio.value = p.ratio;
    c.knee.value = 6;
    c.attack.value = p.attack / 1000;
    c.release.value = Math.max(0.01, p.release / 1000);
    const g = ctx.createGain();
    g.gain.value = dbToGain(p.makeup);
    c.connect(g);
    return { input: c, output: g };
  },
});
reg({
  id: 'dynamics', name: 'Dynamics', category: 'Amplitude and Compression',
  params: [P.num('threshold', 'Compressor Threshold', -18, -60, 0, { unit: 'dB' }), P.num('ratio', 'Compressor Ratio', 3, 1, 20), P.num('limit', 'Limiter Threshold', -1, -30, 0, { unit: 'dB' }), P.num('makeup', 'Make-Up Gain', 0, -12, 24, { unit: 'dB' })],
  build(ctx, p) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = p.threshold;
    c.ratio.value = p.ratio;
    c.attack.value = 0.01;
    c.release.value = 0.15;
    const g = ctx.createGain();
    g.gain.value = dbToGain(p.makeup);
    const l = ctx.createDynamicsCompressor();
    l.threshold.value = p.limit;
    l.ratio.value = 20;
    l.knee.value = 0;
    l.attack.value = 0.001;
    l.release.value = 0.05;
    return chain(ctx, [c, g, l]);
  },
});
reg({
  id: 'hardLimiter', name: 'Hard Limiter', category: 'Amplitude and Compression',
  params: [P.num('max', 'Maximum Amplitude', -0.1, -30, 0, { unit: 'dB' }), P.num('boost', 'Input Boost', 0, 0, 30, { unit: 'dB' }), P.num('release', 'Release Time', 80, 1, 500, { unit: 'ms' })],
  build(ctx, p) {
    const g = ctx.createGain();
    g.gain.value = dbToGain(p.boost);
    const l = ctx.createDynamicsCompressor();
    l.threshold.value = p.max;
    l.ratio.value = 20;
    l.knee.value = 0;
    l.attack.value = 0.001;
    l.release.value = p.release / 1000;
    return chain(ctx, [g, l]);
  },
});

// ---- Filter and EQ ----
reg({
  id: 'bass', name: 'Bass', category: 'Filter and EQ',
  params: [P.num('boost', 'Boost', 0, -24, 24, { unit: 'dB' })],
  build(ctx, p) {
    const b = biquad(ctx, 'lowshelf', 200, p.boost);
    return { input: b, output: b, auto: { boost: [b.gain, (v) => v] } };
  },
});
reg({
  id: 'treble', name: 'Treble', category: 'Filter and EQ',
  params: [P.num('boost', 'Boost', 0, -24, 24, { unit: 'dB' })],
  build(ctx, p) {
    const b = biquad(ctx, 'highshelf', 3500, p.boost);
    return { input: b, output: b, auto: { boost: [b.gain, (v) => v] } };
  },
});
reg({
  id: 'highpass', name: 'Highpass', category: 'Filter and EQ',
  params: [P.num('cutoff', 'Cutoff', 200, 20, 20000, { unit: 'Hz', step: 1, precision: 0 })],
  build(ctx, p) {
    const b = biquad(ctx, 'highpass', p.cutoff, 0, 0.707);
    return { input: b, output: b, auto: { cutoff: [b.frequency, (v) => v] } };
  },
});
reg({
  id: 'lowpass', name: 'Lowpass', category: 'Filter and EQ',
  params: [P.num('cutoff', 'Cutoff', 2000, 20, 20000, { unit: 'Hz', step: 1, precision: 0 })],
  build(ctx, p) {
    const b = biquad(ctx, 'lowpass', p.cutoff, 0, 0.707);
    return { input: b, output: b, auto: { cutoff: [b.frequency, (v) => v] } };
  },
});
reg({
  id: 'bandpass', name: 'Bandpass', category: 'Filter and EQ',
  params: [P.num('center', 'Center', 1000, 20, 20000, { unit: 'Hz', step: 1, precision: 0 }), P.num('q', 'Q', 1, 0.1, 30)],
  build(ctx, p) {
    const b = biquad(ctx, 'bandpass', p.center, 0, p.q);
    return { input: b, output: b, auto: { center: [b.frequency, (v) => v] } };
  },
});
reg({
  id: 'notch', name: 'Notch Filter', category: 'Filter and EQ',
  params: [P.num('center', 'Center', 1000, 20, 20000, { unit: 'Hz', step: 1, precision: 0 }), P.num('q', 'Q', 8, 0.1, 50)],
  build(ctx, p) {
    const b = biquad(ctx, 'notch', p.center, 0, p.q);
    return { input: b, output: b };
  },
});
reg({
  id: 'simpleParamEQ', name: 'Simple Parametric EQ', category: 'Filter and EQ',
  params: [P.num('center', 'Center', 1000, 20, 20000, { unit: 'Hz', step: 1, precision: 0 }), P.num('q', 'Q', 1, 0.1, 20), P.num('boost', 'Boost', 0, -24, 24, { unit: 'dB' })],
  build(ctx, p) {
    const b = biquad(ctx, 'peaking', p.center, p.boost, p.q);
    return { input: b, output: b, auto: { boost: [b.gain, (v) => v] } };
  },
});
reg({
  id: 'paramEQ', name: 'Parametric Equalizer', category: 'Filter and EQ',
  params: [
    P.num('lowF', 'Low Shelf Freq', 120, 20, 2000, { unit: 'Hz', group: 'Low', precision: 0 }), P.num('lowG', 'Low Shelf Gain', 0, -24, 24, { unit: 'dB', group: 'Low' }),
    P.num('m1F', 'Band 1 Freq', 400, 20, 20000, { unit: 'Hz', group: 'Band 1', precision: 0 }), P.num('m1G', 'Band 1 Gain', 0, -24, 24, { unit: 'dB', group: 'Band 1' }), P.num('m1Q', 'Band 1 Q', 1, 0.1, 20, { group: 'Band 1' }),
    P.num('m2F', 'Band 2 Freq', 1500, 20, 20000, { unit: 'Hz', group: 'Band 2', precision: 0 }), P.num('m2G', 'Band 2 Gain', 0, -24, 24, { unit: 'dB', group: 'Band 2' }), P.num('m2Q', 'Band 2 Q', 1, 0.1, 20, { group: 'Band 2' }),
    P.num('m3F', 'Band 3 Freq', 5000, 20, 20000, { unit: 'Hz', group: 'Band 3', precision: 0 }), P.num('m3G', 'Band 3 Gain', 0, -24, 24, { unit: 'dB', group: 'Band 3' }), P.num('m3Q', 'Band 3 Q', 1, 0.1, 20, { group: 'Band 3' }),
    P.num('highF', 'High Shelf Freq', 9000, 1000, 20000, { unit: 'Hz', group: 'High', precision: 0 }), P.num('highG', 'High Shelf Gain', 0, -24, 24, { unit: 'dB', group: 'High' }),
    P.num('master', 'Master Gain', 0, -24, 24, { unit: 'dB' }),
  ],
  build(ctx, p) {
    const n = [
      biquad(ctx, 'lowshelf', p.lowF, p.lowG),
      biquad(ctx, 'peaking', p.m1F, p.m1G, p.m1Q),
      biquad(ctx, 'peaking', p.m2F, p.m2G, p.m2Q),
      biquad(ctx, 'peaking', p.m3F, p.m3G, p.m3Q),
      biquad(ctx, 'highshelf', p.highF, p.highG),
    ];
    const g = ctx.createGain();
    g.gain.value = dbToGain(p.master);
    return chain(ctx, [...n, g]);
  },
});
reg({
  id: 'vocalEnhancer', name: 'Vocal Enhancer', category: 'Filter and EQ',
  params: [P.en('mode', 'Mode', ['Low Tone', 'High Tone', 'Music'], 0)],
  build(ctx, p) {
    const hp = biquad(ctx, 'highpass', p.mode === 1 ? 150 : 90, 0, 0.707);
    const pres = biquad(ctx, 'peaking', p.mode === 2 ? 2500 : p.mode === 1 ? 4000 : 3000, p.mode === 2 ? 1.5 : 3.5, 1.2);
    const mud = biquad(ctx, 'peaking', 300, -2.5, 1);
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = -22;
    c.ratio.value = 2.5;
    return chain(ctx, [hp, mud, pres, c]);
  },
});

// ---- Noise Reduction / Restoration ----
reg({
  id: 'deHummer', name: 'DeHummer', category: 'Noise Reduction/Restoration',
  params: [P.en('freq', 'Frequency', ['50 Hz', '60 Hz'], 1), P.int('harmonics', 'Number of Harmonics', 4, 1, 8), P.num('q', 'Q', 20, 1, 100)],
  build(ctx, p) {
    const f0 = p.freq ? 60 : 50;
    const nodes = [];
    for (let i = 1; i <= p.harmonics; i++) nodes.push(biquad(ctx, 'notch', f0 * i, 0, p.q));
    return chain(ctx, nodes);
  },
});

// ---- Delay and Echo ----
reg({
  id: 'delay', name: 'Delay', category: 'Delay and Echo',
  params: [P.num('time', 'Delay', 0.5, 0, 2, { unit: 's', step: 0.01, precision: 2 }), P.pct('feedback', 'Feedback', 30, 0, 95), P.pct('mix', 'Mix', 35)],
  build(ctx, p) {
    const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    const d = ctx.createDelay(2.5), fb = ctx.createGain();
    d.delayTime.value = p.time;
    fb.gain.value = p.feedback / 100;
    dry.gain.value = 1 - (p.mix / 100) * 0.5;
    wet.gain.value = p.mix / 100;
    inp.connect(dry).connect(out);
    inp.connect(d);
    d.connect(fb).connect(d);
    d.connect(wet).connect(out);
    return { input: inp, output: out };
  },
});
reg({
  id: 'chorusFlanger', name: 'Chorus/Flanger', category: 'Modulation',
  params: [P.en('mode', 'Mode', ['Chorus', 'Flanger'], 0), P.num('rate', 'Speed', 0.8, 0.05, 10, { unit: 'Hz', step: 0.01, precision: 2 }), P.pct('depth', 'Width', 50), P.pct('feedback', 'Feedback', 20, 0, 90), P.pct('mix', 'Mix', 50)],
  build(ctx, p) {
    const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    const base = p.mode === 1 ? 0.004 : 0.02;
    const d = ctx.createDelay(0.1), fb = ctx.createGain();
    d.delayTime.value = base;
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = p.rate;
    lg.gain.value = base * (p.depth / 100) * 0.8;
    lfo.connect(lg).connect(d.delayTime);
    lfo.start();
    fb.gain.value = p.feedback / 100;
    dry.gain.value = 1 - p.mix / 200;
    wet.gain.value = p.mix / 100;
    inp.connect(dry).connect(out);
    inp.connect(d);
    d.connect(fb).connect(d);
    d.connect(wet).connect(out);
    return { input: inp, output: out };
  },
});

// ---- Reverb ----
const reverbCache = new Map();
function impulse(ctx, seconds, decay, pre) {
  const key = ctx.sampleRate + ':' + seconds + ':' + decay + ':' + pre;
  if (reverbCache.has(key) && reverbCache.get(key).ctx === ctx) return reverbCache.get(key).buf;
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const preS = Math.floor(pre * ctx.sampleRate);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = preS; i < len; i++) d[i] = rnd() * Math.pow(1 - (i - preS) / (len - preS), decay);
  }
  reverbCache.set(key, { ctx, buf });
  return buf;
}
reg({
  id: 'studioReverb', name: 'Studio Reverb', category: 'Reverb',
  params: [P.en('preset', 'Room', ['Small Room', 'Room', 'Hall', 'Large Hall', 'Cathedral'], 1), P.num('decay', 'Decay', 2, 0.1, 10, { unit: 's', step: 0.01, precision: 2 }), P.num('preDelay', 'Pre-Delay', 10, 0, 200, { unit: 'ms' }), P.pct('mix', 'Dry/Wet Mix', 30)],
  build(ctx, p) {
    const sizes = [0.6, 1.2, 2.5, 3.5, 5];
    const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = impulse(ctx, Math.min(8, sizes[p.preset] * (p.decay / 2)), 2 + p.preset * 0.5, p.preDelay / 1000);
    dry.gain.value = 1 - (p.mix / 100) * 0.6;
    wet.gain.value = (p.mix / 100) * 0.8;
    inp.connect(dry).connect(out);
    inp.connect(conv).connect(wet).connect(out);
    return { input: inp, output: out };
  },
});

// ---- Special / Stereo Imagery ----
reg({
  id: 'distortion', name: 'Distortion', category: 'Special',
  params: [P.pct('amount', 'Amount', 30), P.pct('mix', 'Mix', 100)],
  build(ctx, p) {
    const ws = ctx.createWaveShaper();
    const k = (p.amount / 100) * 100;
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
    }
    ws.curve = curve;
    ws.oversample = '2x';
    const inp = ctx.createGain(), out = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    dry.gain.value = 1 - p.mix / 100;
    wet.gain.value = p.mix / 100;
    inp.connect(dry).connect(out);
    inp.connect(ws).connect(wet).connect(out);
    return { input: inp, output: out };
  },
});
function routing(ctx, map) {
  const inp = ctx.createGain();
  inp.channelCountMode = 'explicit';
  inp.channelCount = 2;
  const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
  inp.connect(split);
  for (const [from, to, g] of map) {
    const gn = ctx.createGain();
    gn.gain.value = g ?? 1;
    split.connect(gn, from);
    gn.connect(merge, 0, to);
  }
  return { input: inp, output: merge };
}
reg({ id: 'fillLeft', name: 'Fill Left with Right', category: 'Stereo Imagery', params: [], build: (ctx) => routing(ctx, [[1, 0], [1, 1]]) });
reg({ id: 'fillRight', name: 'Fill Right with Left', category: 'Stereo Imagery', params: [], build: (ctx) => routing(ctx, [[0, 0], [0, 1]]) });
reg({ id: 'swapChannels', name: 'Swap Channels', category: 'Stereo Imagery', params: [], build: (ctx) => routing(ctx, [[0, 1], [1, 0]]) });
reg({ id: 'mono', name: 'Mono (Sum Channels)', category: 'Stereo Imagery', params: [], build: (ctx) => routing(ctx, [[0, 0, 0.5], [1, 0, 0.5], [0, 1, 0.5], [1, 1, 0.5]]) });
reg({
  id: 'invertAudio', name: 'Invert', category: 'Special', params: [],
  build(ctx) {
    const g = ctx.createGain();
    g.gain.value = -1;
    return { input: g, output: g };
  },
});
reg({
  id: 'balance', name: 'Balance', category: 'Stereo Imagery',
  params: [P.num('balance', 'Balance', 0, -100, 100)],
  build(ctx, p) {
    const pn = ctx.createStereoPanner();
    pn.pan.value = p.balance / 100;
    return { input: pn, output: pn, auto: { balance: [pn.pan, (v) => v / 100] } };
  },
});
