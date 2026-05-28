import { describe, it, expect } from 'vitest'
import { parityCount, groupSize, computeParityFrames, recoverWithParity } from '../common/fec.js'

describe('parityCount / groupSize', () => {
  it('3414 frames → 35 parity, groupSize 98', () => {
    expect(parityCount(3414)).toBe(35)
    expect(groupSize(3414)).toBe(98)   // ceil(3414/35) = 98
  })
  it('100 frames → 1 parity, groupSize 100', () => {
    expect(parityCount(100)).toBe(1)
    expect(groupSize(100)).toBe(100)
  })
  it('1 frame → 1 parity, groupSize 1', () => {
    expect(parityCount(1)).toBe(1)
    expect(groupSize(1)).toBe(1)
  })
  it('200 frames → 2 parity, groupSize 100', () => {
    expect(parityCount(200)).toBe(2)
    expect(groupSize(200)).toBe(100)
  })
})

describe('computeParityFrames', () => {
  it('XOR of equal-length frames', () => {
    const chunks = [
      new Uint8Array([0x01, 0x02, 0x03]),
      new Uint8Array([0x04, 0x05, 0x06]),
    ]
    // parityCount(2)=1, groupSize(2)=2 → one parity frame covering both
    const parity = computeParityFrames(chunks)
    expect(parity.length).toBe(1)
    expect(Array.from(parity[0].payload)).toEqual([0x01 ^ 0x04, 0x02 ^ 0x05, 0x03 ^ 0x06])
    expect(parity[0].payloadLenXor).toBe(3 ^ 3)  // 0
  })

  it('XOR of different-length frames — parity length = max', () => {
    const chunks = [
      new Uint8Array([0x01, 0x02, 0x03]),
      new Uint8Array([0x04, 0x05]),
    ]
    const parity = computeParityFrames(chunks)
    expect(parity[0].payload.length).toBe(3)
    expect(parity[0].payload[0]).toBe(0x01 ^ 0x04)
    expect(parity[0].payload[1]).toBe(0x02 ^ 0x05)
    expect(parity[0].payload[2]).toBe(0x03)         // 0x03 ^ 0x00 (zero-pad)
    expect(parity[0].payloadLenXor).toBe(3 ^ 2)    // 1
  })

  it('multiple groups', () => {
    // 200 frames → 2 parity frames
    const chunks = Array.from({ length: 200 }, (_, i) => new Uint8Array([i & 0xff]))
    const parity = computeParityFrames(chunks)
    expect(parity.length).toBe(2)
  })
})

describe('recoverWithParity', () => {
  it('recovers 1 missing frame (equal-length)', () => {
    const chunks = [
      new Uint8Array([0x01, 0x02, 0x03]),
      new Uint8Array([0x04, 0x05, 0x06]),
    ]
    const parityFrames = computeParityFrames(chunks)
    const received = new Map([[1, chunks[1]]])  // frame 0 is missing
    const parityReceived = new Map([[0, parityFrames[0]]])
    const recovered = recoverWithParity(received, parityReceived, 2)
    expect(recovered.has(0)).toBe(true)
    expect(Array.from(recovered.get(0))).toEqual([0x01, 0x02, 0x03])
  })

  it('recovers last (shorter) missing frame', () => {
    const chunks = [
      new Uint8Array([0x01, 0x02, 0x03]),
      new Uint8Array([0x04, 0x05]),           // shorter last frame
    ]
    const parityFrames = computeParityFrames(chunks)
    const received = new Map([[0, chunks[0]]])  // frame 1 is missing
    const parityReceived = new Map([[0, parityFrames[0]]])
    const recovered = recoverWithParity(received, parityReceived, 2)
    expect(recovered.has(1)).toBe(true)
    expect(Array.from(recovered.get(1))).toEqual([0x04, 0x05])
  })

  it('cannot recover 2 missing frames in same group', () => {
    const chunks = [
      new Uint8Array([0x01]),
      new Uint8Array([0x02]),
      new Uint8Array([0x03]),
    ]
    // parityCount(3)=1, groupSize(3)=3 → one group of 3
    const parityFrames = computeParityFrames(chunks)
    const received = new Map()               // frames 0 and 1 missing
    received.set(2, chunks[2])
    const parityReceived = new Map([[0, parityFrames[0]]])
    const recovered = recoverWithParity(received, parityReceived, 3)
    expect(recovered.size).toBe(0)
  })

  it('no recovery without parity frame', () => {
    const chunks = [
      new Uint8Array([0x01]),
      new Uint8Array([0x02]),
    ]
    const received = new Map([[1, chunks[1]]])
    const recovered = recoverWithParity(received, new Map(), 2)
    expect(recovered.size).toBe(0)
  })

  it('interleaved: burst loss across groups is recoverable', () => {
    // 200 frames → pc=2, group0=[0,2,4,...,198], group1=[1,3,5,...,199]
    // sequential grouping would put 0,1 both in group0 → unrecoverable
    // interleaved puts 0 in group0 and 1 in group1 → both recoverable
    const chunks = Array.from({ length: 200 }, (_, i) => new Uint8Array([i & 0xff]))
    const parityFrames = computeParityFrames(chunks)
    const received = new Map()
    for (let i = 0; i < 200; i++) if (i !== 0 && i !== 1) received.set(i, chunks[i])
    const parityReceived = new Map([[0, parityFrames[0]], [1, parityFrames[1]]])
    const recovered = recoverWithParity(received, parityReceived, 200)
    expect(recovered.has(0)).toBe(true)
    expect(recovered.has(1)).toBe(true)
    expect(Array.from(recovered.get(0))).toEqual([0])
    expect(Array.from(recovered.get(1))).toEqual([1])
  })

  it('no-op when no frames missing', () => {
    const chunks = [
      new Uint8Array([0x01]),
      new Uint8Array([0x02]),
    ]
    const parityFrames = computeParityFrames(chunks)
    const received = new Map([[0, chunks[0]], [1, chunks[1]]])
    const parityReceived = new Map([[0, parityFrames[0]]])
    const recovered = recoverWithParity(received, parityReceived, 2)
    expect(recovered.size).toBe(0)
  })

  it('round-trip: full data recoverable after 1 loss per group', () => {
    const data = new Uint8Array(300).map((_, i) => i & 0xff)
    // Simulate 3 chunks of 100 bytes
    const chunks = [data.slice(0, 100), data.slice(100, 200), data.slice(200, 300)]
    // parityCount(3)=1, groupSize(3)=3 → 1 parity for all 3
    const parityFrames = computeParityFrames(chunks)
    // Drop chunk 1
    const received = new Map([[0, chunks[0]], [2, chunks[2]]])
    const parityReceived = new Map([[0, parityFrames[0]]])
    const recovered = recoverWithParity(received, parityReceived, 3)
    expect(Array.from(recovered.get(1))).toEqual(Array.from(chunks[1]))
  })
})
