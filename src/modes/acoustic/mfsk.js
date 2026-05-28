// MFSK configuration and bit-level encode/decode (no audio deps, pure JS)

export const MODES = {
  1: {
    id: 1,
    label: 'Mode 1 — Air (10-15 kHz)',
    tones: 8,
    bitsPerSymbol: 3,
    baseFreq: 10000,
    freqSpacing: 500,     // data tones: 10000, 10500, ..., 13500 Hz
    symbolDuration: 100,  // ms per symbol
    preambleFreq: 15000,  // Hz – above data range
    preambleDuration: 400,
    silenceGap: 20,       // ms gap after preamble before data
    fftSize: 2048,        // ~43 ms window @ 48 kHz
    threshold: -65,       // dBFS detection threshold (Air実測-55dBFS、AUX有線-45より低め)
    maxPayload: 20,       // bytes per acoustic packet
  },
  2: {
    id: 2,
    label: 'Mode 2 — Wired (6-10.8 kHz)',
    tones: 16,
    bitsPerSymbol: 4,
    baseFreq: 6000,
    freqSpacing: 300,     // data tones: 6000, 6300, ..., 10500 Hz
    symbolDuration: 30,   // ms per symbol
    preambleFreq: 11000,  // Hz – above data range
    preambleDuration: 200,
    silenceGap: 10,
    fftSize: 1024,        // ~21 ms window @ 48 kHz (must be < symbolDuration=30ms to avoid ISI)
    threshold: -45,
    maxPayload: 233,
  },
}

/**
 * Convert byte array to MFSK symbol array.
 * Frame = [lengthHi, lengthLo, ...data] → split into bitsPerSymbol-bit chunks.
 */
export function encodeFrame(data, bitsPerSymbol) {
  const frame = new Uint8Array(2 + data.length)
  frame[0] = (data.length >> 8) & 0xff
  frame[1] = data.length & 0xff
  frame.set(data, 2)
  return bytesToSymbols(frame, bitsPerSymbol)
}

/**
 * Convert symbol array back to bytes.
 * Returns { length, data } or null on parse error.
 */
export function decodeFrame(symbols, bitsPerSymbol) {
  const minHeaderSyms = Math.ceil(16 / bitsPerSymbol)
  if (symbols.length < minHeaderSyms) return null

  // Decode length from unified bitstream (keeps bit-level alignment correct)
  const headerBytes = symbolsToBytes(symbols, bitsPerSymbol, 2)
  const dataLen = (headerBytes[0] << 8) | headerBytes[1]
  if (dataLen > 65535) return null

  // Total frame bytes = 2 (length) + dataLen — must match what encodeFrame produced
  const totalFrameBytes = 2 + dataLen
  const totalSyms = Math.ceil((totalFrameBytes * 8) / bitsPerSymbol)
  if (symbols.length < totalSyms) return null

  const allBytes = symbolsToBytes(symbols.slice(0, totalSyms), bitsPerSymbol, totalFrameBytes)
  return { data: allBytes.slice(2), totalSymbols: totalSyms }
}

// bytes → symbol indices (MSB first within each symbol)
export function bytesToSymbols(bytes, bitsPerSymbol) {
  const bits = []
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1)
  }
  while (bits.length % bitsPerSymbol !== 0) bits.push(0)
  const symbols = []
  for (let i = 0; i < bits.length; i += bitsPerSymbol) {
    let sym = 0
    for (let j = 0; j < bitsPerSymbol; j++) sym = (sym << 1) | bits[i + j]
    symbols.push(sym)
  }
  return symbols
}

// symbol indices → bytes (MSB first, pads last byte if needed)
export function symbolsToBytes(symbols, bitsPerSymbol, byteCount) {
  const bits = []
  for (const sym of symbols) {
    for (let i = bitsPerSymbol - 1; i >= 0; i--) bits.push((sym >> i) & 1)
  }
  const bytes = []
  for (let i = 0; i < byteCount; i++) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i * 8 + j] ?? 0)
    bytes.push(b)
  }
  return new Uint8Array(bytes)
}

// Get the data frequency for a given symbol index
export function symbolFreq(symbol, cfg) {
  return cfg.baseFreq + symbol * cfg.freqSpacing
}

// Find symbol index from peak frequency bin in FFT data
export function peakSymbol(freqData, cfg, binHz) {
  let best = -1
  let bestPower = -Infinity
  for (let sym = 0; sym < cfg.tones; sym++) {
    const freq = symbolFreq(sym, cfg)
    const bin = Math.round(freq / binHz)
    if (bin < freqData.length && freqData[bin] > bestPower) {
      bestPower = freqData[bin]
      best = sym
    }
  }
  return { symbol: best, power: bestPower }
}
