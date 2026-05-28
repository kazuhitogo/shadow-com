// Pixel Matrix encoder for Mode 4 (HDMI / Video Matrix)
//
// Frame layout at pixel size P on a 1920×1080 canvas:
//   row 0      : sync row (alternating black/white pixels, starts black)
//   row 1      : 96-bit header packed into first 96 pixels (rest = black)
//   rows 2..H-1: data pixels — monochrome, 1 bit/cell (black=0, white=1)
//
// Header (12 bytes / 96 bits):
//   [0:4]   frame_idx    uint32 BE
//   [4:6]   data_total   uint16 BE  (number of data frames, excludes parity; max 65535)
//   [6:7]   parity_count uint8      (number of parity frames; 0 = no FEC)
//   [7:10]  payload_len  uint24 BE  (data frame: actual bytes; parity frame: XOR of group payloadLens; max ~16MB)
//   [10:12] crc16        uint16 BE  (CRC of payload only)

const W = 1920
const H = 1080
const SAFE_H = 1080  // full height — setFullScreen eliminates taskbar/Dock overlap
const HEADER_BYTES = 12

function crc16(data) {
  let crc = 0xffff
  for (const b of data) {
    crc ^= b << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1
  }
  return crc & 0xffff
}

// For small P, header row and first data row fall in the same JPEG 8×8 block (y=0-7).
// DCT ringing from data pixels contaminates adjacent header pixels, causing frame-specific bit errors.
// Guard rows push data past y=8 (next JPEG block boundary) when P < 4.
function dataRowOffset(pixelSize) {
  return pixelSize < 4 ? Math.ceil(8 / pixelSize) : 2
}

/** Return capacity info for a given pixel size. */
export function computeCapacity(pixelSize) {
  const cols = Math.floor(W / pixelSize)
  const rows = Math.floor(SAFE_H / pixelSize)
  if (cols < HEADER_BYTES * 8) throw new Error(`pixelSize ${pixelSize} too large: cols=${cols} < ${HEADER_BYTES * 8}`)
  const dataStart = dataRowOffset(pixelSize)
  const dataRows = rows - dataStart
  const bytesPerFrame = Math.floor((dataRows * cols) / 8)  // 1 bit/cell (monochrome)
  return { cols, rows, dataRows, dataStart, bytesPerFrame }
}

/** Build 12-byte header buffer. */
export function buildHeader(frameIdx, dataTotal, parityCount, payloadLen, crc) {
  const h = new Uint8Array(HEADER_BYTES)
  const v = new DataView(h.buffer)
  v.setUint32(0, frameIdx)
  v.setUint16(4, dataTotal)                       // [4:6]  uint16
  v.setUint8(6, parityCount)                      // [6:7]  uint8
  v.setUint8(7, (payloadLen >> 16) & 0xff)        // [7:10] uint24
  v.setUint8(8, (payloadLen >> 8) & 0xff)
  v.setUint8(9, payloadLen & 0xff)
  v.setUint16(10, crc)                            // [10:12] uint16
  return h
}

/** Split data into frame payloads. Returns array of Uint8Array. */
export function splitData(data, pixelSize) {
  const { bytesPerFrame } = computeCapacity(pixelSize)
  const chunks = []
  for (let i = 0; i < data.length; i += bytesPerFrame) {
    chunks.push(data.slice(i, i + bytesPerFrame))
  }
  return chunks
}

/**
 * Draw a pixel matrix frame onto a canvas.
 * Used by secondary HDMI window renderer.
 * @param {number} payloadLenOverride - for parity frames: XOR of group payloadLens
 */
export function drawFrame(canvas, frameIdx, dataTotal, parityCount, payload, pixelSize, payloadLenOverride) {
  const P = pixelSize
  const { cols, rows, dataStart } = computeCapacity(P)
  canvas.width = W
  canvas.height = H

  const ctx = canvas.getContext('2d')
  const imgData = ctx.createImageData(W, H)
  const buf32 = new Uint32Array(imgData.data.buffer)

  const BLACK = 0xff000000
  const WHITE = 0xffffffff
  buf32.fill(BLACK)

  function setBlock(col, row, value) {
    const color = value ? WHITE : BLACK
    const x0 = col * P, y0 = row * P
    for (let dy = 0; dy < P; dy++) {
      const rs = (y0 + dy) * W + x0
      for (let dx = 0; dx < P; dx++) buf32[rs + dx] = color
    }
  }

  // Row 0: sync — alternating black/white
  for (let c = 0; c < cols; c++) setBlock(c, 0, c & 1)

  // Row 1: header — 1 bit/cell, 96 cells
  const crc = crc16(payload)
  const headerPayloadLen = payloadLenOverride ?? payload.length
  const header = buildHeader(frameIdx, dataTotal, parityCount, headerPayloadLen, crc)
  for (let c = 0; c < cols; c++) {
    const bit = c < HEADER_BYTES * 8 ? (header[c >> 3] >> (7 - (c & 7))) & 1 : 0
    setBlock(c, 1, bit)
  }

  // Rows dataStart+: data — monochrome 1 bit/cell
  // rows 2..dataStart-1 are guard rows, left black
  let bitIdx = 0
  const totalDataBits = (rows - dataStart) * cols
  for (let r = dataStart; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (bitIdx >= totalDataBits) break
      const byteI = bitIdx >> 3
      const bitI = 7 - (bitIdx & 7)
      const bit = byteI < payload.length ? (payload[byteI] >> bitI) & 1 : 0
      setBlock(c, r, bit)
      bitIdx++
    }
  }

  ctx.putImageData(imgData, 0, 0)
}

/**
 * Draw calibration frame (used by receiver to determine threshold + pixel boundaries).
 * Layout: top strip = alternating rows of black/white, bottom = sync pattern.
 */
export function drawCalibrationFrame(canvas, pixelSize) {
  const P = pixelSize
  const { cols, rows } = computeCapacity(P)
  canvas.width = W
  canvas.height = H

  const ctx = canvas.getContext('2d')
  const imgData = ctx.createImageData(W, H)
  const buf32 = new Uint32Array(imgData.data.buffer)
  buf32.fill(0xff000000)

  function setPixelBlock(col, row, value) {
    const color = value ? 0xffffffff : 0xff000000
    const x0 = col * P, y0 = row * P
    for (let dy = 0; dy < P; dy++) {
      const rs = (y0 + dy) * W + x0
      for (let dx = 0; dx < P; dx++) buf32[rs + dx] = color
    }
  }

  // Top half: alternating all-white / all-black rows (for threshold detection)
  const halfRows = Math.floor(rows / 2)
  for (let r = 0; r < halfRows; r++) {
    const v = r & 1
    for (let c = 0; c < cols; c++) setPixelBlock(c, r, v)
  }
  // Bottom half: sync checker pattern (for pixel boundary detection)
  for (let r = halfRows; r < rows; r++) {
    for (let c = 0; c < cols; c++) setPixelBlock(c, r, (r + c) & 1)
  }

  ctx.putImageData(imgData, 0, 0)
}
