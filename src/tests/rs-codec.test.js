import { describe, it, expect } from 'vitest'
import { encode, decode, NROOTS, MAX_DATA } from '../common/rs-codec.js'

describe('rs-codec', () => {
  it('MAX_DATA = 255 - NROOTS', () => {
    expect(MAX_DATA).toBe(255 - NROOTS)
  })

  it('encode adds NROOTS parity bytes', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    expect(encode(data).length).toBe(5 + NROOTS)
  })

  it('encode throws if data > MAX_DATA', () => {
    expect(() => encode(new Uint8Array(MAX_DATA + 1))).toThrow()
  })

  it('decode recovers original (no errors)', () => {
    const data = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50, 0xaa, 0xbb])
    expect(decode(encode(data))).toEqual(data)
  })

  it('decode corrects up to NROOTS/2 errors', () => {
    const data = new Uint8Array(50).map((_, i) => i)
    const encoded = encode(data)
    const corrupted = new Uint8Array(encoded)
    const t = NROOTS / 2  // 8 correctable errors
    for (let i = 0; i < t; i++) corrupted[i * 2] ^= 0xff
    const decoded = decode(corrupted)
    expect(decoded).toEqual(data)
  })

  it('decode returns null on > NROOTS/2 errors', () => {
    const data = new Uint8Array(20).fill(0xab)
    const encoded = encode(data)
    const corrupted = new Uint8Array(encoded)
    for (let i = 0; i < NROOTS + 1; i++) corrupted[i] ^= 0xff
    expect(decode(corrupted)).toBeNull()
  })

  it('encode/decode roundtrip at max payload size', () => {
    const data = new Uint8Array(MAX_DATA).map((_, i) => i & 0xff)
    expect(decode(encode(data))).toEqual(data)
  })
})
