import { describe, it, expect } from 'vitest'
import { bytesToSymbols, symbolsToBytes, encodeFrame, decodeFrame, MODES } from '../modes/acoustic/mfsk.js'

describe('mfsk — bit encoding', () => {
  it('bytesToSymbols: 8 bits → ceil(8/3)=3 symbols for bitsPerSymbol=3', () => {
    const syms = bytesToSymbols(new Uint8Array([0b10110010]), 3)
    // bits: 1 0 1  1 0 0  1 0 + pad(0) → [1,0,0]
    // syms: 5     4     4
    expect(syms).toEqual([5, 4, 4])
  })

  it('bytesToSymbols: 8 bits → 2 symbols for bitsPerSymbol=4', () => {
    const syms = bytesToSymbols(new Uint8Array([0b10110010]), 4)
    // bits: 1011 0010
    // syms: 11   2
    expect(syms).toEqual([11, 2])
  })

  it('symbolsToBytes roundtrip — bitsPerSymbol=3', () => {
    const data = new Uint8Array([0x41, 0x42, 0x43])
    const syms = bytesToSymbols(data, 3)
    const back = symbolsToBytes(syms, 3, data.length)
    expect(back).toEqual(data)
  })

  it('symbolsToBytes roundtrip — bitsPerSymbol=4', () => {
    const data = new Uint8Array([0x00, 0xff, 0x55, 0xaa])
    const syms = bytesToSymbols(data, 4)
    const back = symbolsToBytes(syms, 4, data.length)
    expect(back).toEqual(data)
  })

  it('encodeFrame prepends 2-byte length', () => {
    const data = new Uint8Array(5).fill(0x77)
    const syms = encodeFrame(data, 3)
    // frame = [0x00, 0x05, 0x77, 0x77, 0x77, 0x77, 0x77] = 7 bytes = 56 bits
    // ceil(56/3) = 19 symbols
    expect(syms.length).toBe(Math.ceil((7 * 8) / 3))
  })

  it('decodeFrame recovers data after encodeFrame', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const syms = encodeFrame(data, 3)
    const result = decodeFrame(syms, 3)
    expect(result).not.toBeNull()
    expect(result.data).toEqual(data)
  })

  it('decodeFrame roundtrip — bitsPerSymbol=4 (Mode 2)', () => {
    const data = new Uint8Array(20).map((_, i) => i * 3)
    const syms = encodeFrame(data, 4)
    const result = decodeFrame(syms, 4)
    expect(result).not.toBeNull()
    expect(result.data).toEqual(data)
  })

  it('MODES.1 tones × freqSpacing fits in 15-22kHz band', () => {
    const cfg = MODES[1]
    const maxFreq = cfg.baseFreq + (cfg.tones - 1) * cfg.freqSpacing
    expect(maxFreq).toBeLessThanOrEqual(22000)
    expect(cfg.preambleFreq).toBeGreaterThan(maxFreq)
  })

  it('MODES.2 tones × freqSpacing fits in 6-11kHz band', () => {
    const cfg = MODES[2]
    const maxFreq = cfg.baseFreq + (cfg.tones - 1) * cfg.freqSpacing
    expect(maxFreq).toBeLessThan(11000)
    expect(cfg.preambleFreq).toBeGreaterThan(maxFreq)
  })
})
