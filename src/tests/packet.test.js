import { describe, it, expect } from 'vitest'
import { createPacket, parsePacket, splitFile, assemblePackets, DEFAULT_PAYLOAD_SIZE } from '../common/packet.js'
import { NROOTS } from '../common/rs-codec.js'

const HEADER = 6

function makeData(size, fill = 0xab) {
  return new Uint8Array(size).fill(fill)
}

describe('packet', () => {
  it('createPacket / parsePacket roundtrip', () => {
    const payload = makeData(100)
    const pkt = createPacket(3, 10, payload)
    const parsed = parsePacket(pkt)
    expect(parsed).not.toBeNull()
    expect(parsed.seq).toBe(3)
    expect(parsed.total).toBe(10)
    expect(parsed.payload).toEqual(payload)
  })

  it('parsePacket returns null on null/empty input', () => {
    expect(parsePacket(null)).toBeNull()
    expect(parsePacket(new Uint8Array(0))).toBeNull()
  })

  it('each packet length = header + payload + RS parity', () => {
    const payload = makeData(100)
    const pkt = createPacket(0, 1, payload)
    expect(pkt.length).toBe(HEADER + 100 + NROOTS)
  })

  it('splitFile / assemblePackets roundtrip — 1 KB', () => {
    const data = makeData(1024)
    const packets = splitFile(data, DEFAULT_PAYLOAD_SIZE)
    expect(packets.length).toBe(Math.ceil(1024 / DEFAULT_PAYLOAD_SIZE))
    const assembled = assemblePackets(packets)
    expect(assembled).toEqual(data)
  })

  it('splitFile / assemblePackets roundtrip — 100 KB', () => {
    const data = new Uint8Array(100 * 1024).map((_, i) => i & 0xff)
    const packets = splitFile(data, DEFAULT_PAYLOAD_SIZE)
    const assembled = assemblePackets(packets)
    expect(assembled).toEqual(data)
  })

  it('assemblePackets handles out-of-order delivery', () => {
    // Use 3 * DEFAULT_PAYLOAD_SIZE to get exactly 3 packets
    const data = makeData(3 * DEFAULT_PAYLOAD_SIZE, 0x77)
    const packets = splitFile(data, DEFAULT_PAYLOAD_SIZE)
    expect(packets.length).toBe(3)
    const shuffled = [packets[1], packets[0], packets[2]]
    const assembled = assemblePackets(shuffled)
    expect(assembled).toEqual(data)
  })

  it('assemblePackets skips undefined/null elements gracefully', () => {
    const data = makeData(3 * DEFAULT_PAYLOAD_SIZE)
    const packets = splitFile(data, DEFAULT_PAYLOAD_SIZE)
    // Pass array with undefined — should return null (incomplete)
    const assembled = assemblePackets([packets[0], undefined, packets[2]])
    expect(assembled).toBeNull()
  })

  it('assemblePackets returns null when missing packets', () => {
    const data = makeData(2 * DEFAULT_PAYLOAD_SIZE)
    const packets = splitFile(data, DEFAULT_PAYLOAD_SIZE)
    const assembled = assemblePackets([packets[0]])
    expect(assembled).toBeNull()
  })
})
