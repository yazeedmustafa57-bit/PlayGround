'use strict';

// Audio-Codec: mulaw (Twilio, 8 kHz) <-> PCM16 (ElevenLabs).
// Reine Mathematik, keine Dependencies, deterministisch testbar.
//
// mulaw <-> linear: Standard G.711 (Bias 0x84, Clip 32635).

const MULAW_BIAS = 0x84;

function mulawToPcm16(mulawByte) {
  const u = (~mulawByte) & 0xff;
  const mantissa = u & 0x0f;
  const exponent = (u >> 4) & 0x07;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return (u & 0x80) ? -sample : sample;
}

const SEG_END = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

function pcm16ToMulaw(pcm) {
  let magnitude = Math.trunc(pcm);
  const sign = magnitude < 0 ? 0x80 : 0x00;
  if (sign) magnitude = -magnitude;
  if (magnitude > 32635) magnitude = 32635;
  magnitude += MULAW_BIAS;
  let exponent = 7;
  for (let e = 0; e < 8; e++) {
    if (magnitude <= SEG_END[e]) { exponent = e; break; }
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function mulawBufferToPcm16(buffer) {
  const out = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) out[i] = mulawToPcm16(buffer[i]);
  return out;
}

function pcm16ToMulawBuffer(samples) {
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = pcm16ToMulaw(samples[i]);
  return out;
}

// Base64-Helfer (Twilio schickt/empfängt base64).
function mulawBase64ToPcm16(b64) {
  return mulawBufferToPcm16(Buffer.from(String(b64 || ''), 'base64'));
}

function pcm16ToMulawBase64(samples) {
  return pcm16ToMulawBuffer(samples).toString('base64');
}

// Einfaches Resampling (nächster Nachbar / Dezimierung). Reicht für Sprache.
function upsample8kTo16k(samples8k) {
  const out = new Int16Array(samples8k.length * 2);
  for (let i = 0; i < samples8k.length; i++) {
    out[i * 2] = samples8k[i];
    out[i * 2 + 1] = samples8k[i];
  }
  return out;
}

function downsample16kTo8k(samples16k) {
  const len = Math.floor(samples16k.length / 2);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) out[i] = samples16k[i * 2];
  return out;
}

function pcm16ToBytesLE(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

function bytesLEToPcm16(buffer) {
  const len = Math.floor(buffer.length / 2);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) out[i] = buffer.readInt16LE(i * 2);
  return out;
}

module.exports = {
  mulawToPcm16,
  pcm16ToMulaw,
  mulawBufferToPcm16,
  pcm16ToMulawBuffer,
  mulawBase64ToPcm16,
  pcm16ToMulawBase64,
  upsample8kTo16k,
  downsample16kTo8k,
  pcm16ToBytesLE,
  bytesLEToPcm16,
};
