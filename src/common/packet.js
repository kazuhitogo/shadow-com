import { encode as rsEncode, decode as rsDecode, NROOTS, MAX_DATA } from './rs-codec.js'

// Packet: [seq(2B)][total(2B)][crc(2B)][payload(N B)] then RS parity appended
const HEADER_SIZE = 6

// Max payload so that header+payload+NROOTS <= 255 (GF(2^8) limit)
export const DEFAULT_PAYLOAD_SIZE = MAX_DATA - HEADER_SIZE  // 217 bytes

function crc16(data) {
  let crc = 0xffff
  for (const byte of data) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1
  }
  return crc & 0xffff
}

export function createPacket(seq, total, payload) {
  const header = new Uint8Array(HEADER_SIZE)
  const view = new DataView(header.buffer)
  view.setUint16(0, seq)
  view.setUint16(2, total)
  view.setUint16(4, crc16(payload))
  const combined = new Uint8Array(HEADER_SIZE + payload.length)
  combined.set(header)
  combined.set(payload, HEADER_SIZE)
  return rsEncode(combined)
}

export function parsePacket(buf) {
  if (!buf || buf.length === 0) return null
  const decoded = rsDecode(buf instanceof Uint8Array ? buf : new Uint8Array(buf))
  if (!decoded || decoded.length < HEADER_SIZE) return null
  const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength)
  const seq = view.getUint16(0)
  const total = view.getUint16(2)
  const expectedCrc = view.getUint16(4)
  const payload = decoded.slice(HEADER_SIZE)
  if (crc16(payload) !== expectedCrc) return null
  return { seq, total, payload }
}

export function splitFile(data, payloadSize = DEFAULT_PAYLOAD_SIZE) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data)
  const total = Math.ceil(u8.length / payloadSize)
  const packets = []
  for (let i = 0; i < total; i++) {
    const payload = u8.slice(i * payloadSize, (i + 1) * payloadSize)
    packets.push(createPacket(i, total, payload))
  }
  return packets
}

export function assemblePackets(packets) {
  const arr = Array.isArray(packets) ? packets : [...packets.values()]
  const parsed = []
  for (const pkt of arr) {
    if (!pkt) continue
    const p = parsePacket(pkt)
    if (!p) continue
    parsed.push(p)
  }
  if (parsed.length === 0) return null
  const total = parsed[0].total
  const slots = new Array(total).fill(null)
  for (const p of parsed) {
    if (p.seq < total) slots[p.seq] = p.payload
  }
  if (slots.some((s) => s === null)) return null
  const totalBytes = slots.reduce((acc, s) => acc + s.length, 0)
  const result = new Uint8Array(totalBytes)
  let offset = 0
  for (const s of slots) { result.set(s, offset); offset += s.length }
  return result
}
