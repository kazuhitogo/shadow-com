import { describe, it, expect } from 'vitest'
import { computeCapacity, buildHeader, splitData } from '../modes/hdmi/pixel-encoder.js'

describe('pixel-encoder', () => {
  it('computeCapacity at P=4: 480×270 grid', () => {
    const { cols, rows, dataRows, bytesPerFrame } = computeCapacity(4)
    expect(cols).toBe(480)    // floor(1920/4)
    expect(rows).toBe(270)    // floor(1080/4)
    expect(dataRows).toBe(268) // rows - 2 (sync + header)
    expect(bytesPerFrame).toBe(Math.floor((268 * 480) / 8))
  })

  it('computeCapacity at P=8: 240×135 grid', () => {
    const { cols, rows, bytesPerFrame } = computeCapacity(8)
    expect(cols).toBe(240)
    expect(rows).toBe(135)
    expect(bytesPerFrame).toBe(Math.floor((133 * 240) / 8))
  })

  it('computeCapacity at P=1: full resolution', () => {
    const { cols, rows } = computeCapacity(1)
    expect(cols).toBe(1920)
    expect(rows).toBe(1080)
  })

  it('buildHeader produces 12 bytes with correct structure', () => {
    const h = buildHeader(5, 100, 2, 256, 0xabcd)
    expect(h.length).toBe(12)
    const v = new DataView(h.buffer)
    expect(v.getUint32(0)).toBe(5)      // frameIdx
    const dataTotal = (v.getUint8(4) << 16) | (v.getUint8(5) << 8) | v.getUint8(6)
    expect(dataTotal).toBe(100)         // dataTotal (uint24)
    expect(v.getUint8(7)).toBe(2)       // parityCount
    expect(v.getUint16(8)).toBe(256)    // payloadLen
    expect(v.getUint16(10)).toBe(0xabcd) // crc16
  })

  it('buildHeader: frame 0 of 1', () => {
    const h = buildHeader(0, 1, 0, 50, 0x1234)
    const v = new DataView(h.buffer)
    expect(v.getUint32(0)).toBe(0)
    const dataTotal = (v.getUint8(4) << 16) | (v.getUint8(5) << 8) | v.getUint8(6)
    expect(dataTotal).toBe(1)
    expect(v.getUint16(8)).toBe(50)
  })

  it('splitData divides data into correct chunk sizes', () => {
    const { bytesPerFrame } = computeCapacity(4)
    const data = new Uint8Array(bytesPerFrame * 2 + 100)
    const chunks = splitData(data, 4)
    expect(chunks.length).toBe(3)
    expect(chunks[0].length).toBe(bytesPerFrame)
    expect(chunks[1].length).toBe(bytesPerFrame)
    expect(chunks[2].length).toBe(100)
  })

  it('splitData: single frame', () => {
    const { bytesPerFrame } = computeCapacity(8)
    const data = new Uint8Array(bytesPerFrame)
    const chunks = splitData(data, 8)
    expect(chunks.length).toBe(1)
    expect(chunks[0].length).toBe(bytesPerFrame)
  })

  it('theoretical throughput at P=2 ≥ 10 Mbps at 60fps', () => {
    const { bytesPerFrame } = computeCapacity(2)
    const bitsPerSec = bytesPerFrame * 60 * 8
    expect(bitsPerSec).toBeGreaterThan(10_000_000)  // > 10 Mbps (spec minimum)
  })
})
