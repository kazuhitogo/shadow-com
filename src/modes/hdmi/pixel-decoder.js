// Pixel Matrix decoder for Mode 4 (HDMI / Video Matrix)

import { recoverWithParity } from '../../common/fec.js'

const HEADER_BYTES = 12
const SAFE_H = 1080  // mirror encoder: full height (setFullScreen eliminates artifacts)

// Mirror encoder: for P<4, guard rows push data past y=8 (next JPEG 8x8 block boundary)
function dataRowOffset(pixelSize) {
  return pixelSize < 4 ? Math.ceil(8 / pixelSize) : 2
}

function crc16(data) {
  let crc = 0xffff
  for (const b of data) {
    crc ^= b << 8
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1
  }
  return crc & 0xffff
}

export class PixelDecoder {
  constructor() {
    this._stream = null
    this._video = null
    this._canvas = null
    this._ctx = null
    this._pixelSize = 4
    this._threshold = 128
    this._received = new Map()        // frameIdx → payload (data frames only)
    this._parityReceived = new Map()  // groupIdx → { payload, payloadLenXor }
    this._dataTotal = null
    this._parityCount = null
    this._rafId = null
    this._running = false
    this._onFrame = null
    this._onComplete = null
    this._onStatus = null
    this._onAllParityReceived = null
    this._onScanTick = null
    this._lastFrameIdx = -1
    this._offsetX = 0
    this._offsetY = 0
    this._dbg = []  // debug log entries
  }

  getDebugLog() { return this._dbg }
  clearDebugLog() { this._dbg = [] }

  /** Start camera stream only (no scan loop). Safe to call before calibrate(). */
  async startCamera(video, canvas, deviceId) {
    if (this._stream) return
    this._video = video
    this._canvas = canvas
    this._ctx = canvas.getContext('2d', { willReadFrequently: true })
    const constraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
      },
    }
    this._stream = await navigator.mediaDevices.getUserMedia(constraints)
    video.srcObject = this._stream
    await video.play()
  }

  /**
   * Start capture from a video device (UVC capture card or screen capture).
   * @param {HTMLVideoElement} video
   * @param {HTMLCanvasElement} canvas - hidden canvas for pixel extraction
   * @param {{ pixelSize, deviceId, onFrame, onComplete, onStatus }} opts
   */
  async start(video, canvas, { pixelSize = 4, deviceId, onFrame, onComplete, onStatus, onAllParityReceived, onScanTick } = {}) {
    // Stop scan loop only — preserve camera stream so pre-start calibration survives
    this._running = false
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null }
    this._pixelSize = pixelSize
    this._onFrame = onFrame
    this._onComplete = onComplete
    this._onStatus = onStatus
    this._onAllParityReceived = onAllParityReceived
    this._onScanTick = onScanTick
    this._received.clear()
    this._parityReceived.clear()
    this._dataTotal = null
    this._parityCount = null
    this._lastFrameIdx = -1

    await this.startCamera(video, canvas, deviceId)

    this._running = true
    this._onStatus?.('SCANNING')
    this._scanLoop()
  }

  /** Get list of available video input devices for device picker UI. */
  static async listVideoDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'videoinput').map((d) => ({
      deviceId: d.deviceId,
      label: d.label || `Camera ${d.deviceId.slice(0, 6)}`,
    }))
  }

  stop() {
    this._running = false
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null }
    if (this._stream) { this._stream.getTracks().forEach((t) => t.stop()); this._stream = null }
    if (this._video) { this._video.srcObject = null }
    this._onStatus?.('IDLE')
  }

  /** Calibrate threshold from current frame (call when calibration frame is displayed). */
  calibrate() {
    const video = this._video
    if (!video || video.readyState < video.HAVE_CURRENT_DATA) return null
    const W = video.videoWidth, H = video.videoHeight
    this._canvas.width = W
    this._canvas.height = H
    this._ctx.drawImage(video, 0, 0, W, H)
    const img = this._ctx.getImageData(0, 0, W, H)

    // Sample from checkerboard region (bottom half of calibration frame).
    // This region uses the same spatial frequency as actual data frames,
    // ensuring the threshold is calibrated for the high-frequency pattern
    // that HDMI/USB compression may attenuate differently from row stripes.
    const P = this._pixelSize
    const gridRows = Math.floor(H / P)
    const halfRows = Math.floor(gridRows / 2)
    const yStart = halfRows * P  // physical y where checkerboard begins
    const samples = []
    for (let y = yStart; y < Math.min(H, yStart + 200); y++) {
      for (let x = 0; x < Math.min(W, 200); x++) {
        const idx = (y * W + x) * 4
        const brightness = (img.data[idx] + img.data[idx + 1] + img.data[idx + 2]) / 3
        samples.push(brightness)
      }
    }
    samples.sort((a, b) => a - b)
    const low = samples[Math.floor(samples.length * 0.1)]
    const high = samples[Math.floor(samples.length * 0.9)]
    this._lastCalibDebug = { low, high, contrast: high - low, vW: W, vH: H }
    if (high - low < 32) return null  // contrast too low — black frame or no signal
    this._threshold = (low + high) / 2
    return this._threshold
  }

  getProgress() {
    return {
      received: this._received.size,
      total: this._dataTotal,
      missing: this._dataTotal
        ? Array.from({ length: this._dataTotal }, (_, i) => i).filter((i) => !this._received.has(i))
        : [],
    }
  }

  /** Try FEC recovery. Returns number of newly recovered frames. */
  tryFecRecovery() {
    if (!this._dataTotal || !this._parityCount) return 0
    const recovered = recoverWithParity(this._received, this._parityReceived, this._dataTotal)
    for (const [idx, payload] of recovered) this._received.set(idx, payload)
    return recovered.size
  }

  _scanTick = 0

  _scanLoop() {
    if (!this._running) return
    this._rafId = requestAnimationFrame(() => {
      try {
        this._processFrame()
      } catch (e) {
        this._dbg.push({ t: Date.now(), ev: 'scan_error', msg: String(e) })
      }
      this._scanTick++
      this._onScanTick?.(this._scanTick)
      this._scanLoop()
    })
  }

  _processFrame() {
    const video = this._video
    if (!video || video.readyState < video.HAVE_CURRENT_DATA) return
    const vW = video.videoWidth, vH = video.videoHeight
    if (vW === 0 || vH === 0) return

    if (this._canvas.width !== vW || this._canvas.height !== vH) {
      this._canvas.width = vW
      this._canvas.height = vH
    }
    this._ctx.drawImage(video, 0, 0, vW, vH)
    const img = this._ctx.getImageData(0, 0, vW, vH)

    const P = this._pixelSize
    const scaleX = vW / 1920
    const scaleY = vH / 1080
    const scaledP_X = Math.max(1, Math.round(P * scaleX))
    const scaledP_Y = Math.max(1, Math.round(P * scaleY))
    const cols = Math.floor(vW / scaledP_X)
    const rows = Math.min(Math.floor(vH / scaledP_Y), Math.floor(SAFE_H * vH / (1080 * scaledP_Y)))

    // Sample brightness (luma) at center of a pixel block (average r×r area for robustness)
    const sampleBrightness = (col, row) => {
      const cx = col * scaledP_X + Math.floor(scaledP_X / 2)
      const cy = row * scaledP_Y + Math.floor(scaledP_Y / 2)
      const r = Math.max(0, Math.floor(Math.min(scaledP_X, scaledP_Y) / 4))
      let sum = 0, count = 0
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const px = Math.min(Math.max(cx + dx, 0), vW - 1)
          const py = Math.min(Math.max(cy + dy, 0), vH - 1)
          const idx = (py * vW + px) * 4
          sum += (img.data[idx] + img.data[idx + 1] + img.data[idx + 2]) / 3
          count++
        }
      }
      return sum / count
    }
    const readBit = (col, row, thr) => sampleBrightness(col, row) > thr ? 1 : 0

    // Validate sync row using calibrated threshold (row 0: alternating 0/1 pattern)
    let syncErrors = 0
    const syncCheck = Math.min(cols, 20)
    for (let c = 0; c < syncCheck; c++) {
      if (readBit(c, 0, this._threshold) !== (c & 1)) syncErrors++
    }
    if (syncErrors > syncCheck * 0.3) {
      if (this._dbg.length < 500) {
        const syncSamples = []
        for (let c = 0; c < syncCheck; c++) syncSamples.push(Math.round(sampleBrightness(c, 0)))
        this._dbg.push({ t: Date.now(), ev: 'sync_fail', syncErrors, syncCheck, threshold: this._threshold, vW, vH, cols, rows, P, syncSamples })
      }
      return
    }

    // Derive per-frame dynamic threshold from known sync pattern (black=even cols, white=odd cols)
    let blackSum = 0, whiteSum = 0, blackN = 0, whiteN = 0
    for (let c = 0; c < syncCheck; c++) {
      const b = sampleBrightness(c, 0)
      if (c & 1) { whiteSum += b; whiteN++ } else { blackSum += b; blackN++ }
    }
    const avgBlack = blackN > 0 ? blackSum / blackN : 0
    const avgWhite = whiteN > 0 ? whiteSum / whiteN : 0
    const dynThreshold = whiteN > 0 && blackN > 0
      ? (avgWhite + avgBlack) / 2
      : this._threshold

    // One-time brightness probe: record actual sync row and first data row samples
    if (this._dbg.filter(e => e.ev === 'brightness_probe').length === 0) {
      const syncSamples = []
      for (let c = 0; c < Math.min(cols, 40); c++) syncSamples.push(Math.round(sampleBrightness(c, 0)))
      const dataSamples = []
      for (let c = 0; c < Math.min(cols, 40); c++) dataSamples.push(Math.round(sampleBrightness(c, 2)))
      this._dbg.push({ ev: 'brightness_probe', avgBlack: Math.round(avgBlack), avgWhite: Math.round(avgWhite), dynThreshold: Math.round(dynThreshold), calThreshold: this._threshold, syncRow: syncSamples, dataRow2: dataSamples })
    }

    // Decode header from row 1 (use per-frame dynamic threshold)
    const headerBits = []
    for (let c = 0; c < HEADER_BYTES * 8 && c < cols; c++) headerBits.push(readBit(c, 1, dynThreshold))
    const header = new Uint8Array(HEADER_BYTES)
    for (let i = 0; i < HEADER_BYTES; i++) {
      let b = 0
      for (let j = 0; j < 8; j++) b = (b << 1) | (headerBits[i * 8 + j] ?? 0)
      header[i] = b
    }

    const view = new DataView(header.buffer)
    const frameIdx = view.getUint32(0)
    const dataTotal = view.getUint16(4)                                                   // [4:6]
    const parityCount = view.getUint8(6)                                                  // [6:7]
    const payloadLen = (view.getUint8(7) << 16) | (view.getUint8(8) << 8) | view.getUint8(9)  // [7:10]
    const expectedCrc = view.getUint16(10)                                                // [10:12]
    const frameTotal = dataTotal + parityCount
    const isParity = frameIdx >= dataTotal

    if (dataTotal === 0 || frameIdx >= frameTotal || (!isParity && payloadLen === 0)) {
      this._dbg.push({ t: Date.now(), ev: 'header_invalid', frameIdx, dataTotal, parityCount, payloadLen, expectedCrc })
      return
    }
    if (isParity) {
      const groupIdx = frameIdx - dataTotal
      if (this._parityReceived.has(groupIdx)) return
    } else {
      if (this._received.has(frameIdx)) return
    }

    // Decode payload bytes — monochrome 1 bit/cell
    // Parity frames: payloadLen field = payloadLenXor (not actual byte count).
    // Read full frame capacity instead, same as the encoder drew.
    const dataStart = dataRowOffset(P)
    const decodeLen = isParity ? Math.floor((rows - dataStart) * cols / 8) : payloadLen
    const payload = new Uint8Array(decodeLen)
    let bitIdx = 0
    const totalDataBits = decodeLen * 8
    outer: for (let r = dataStart; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (bitIdx >= totalDataBits) break outer
        const byteI = bitIdx >> 3
        const bitI = 7 - (bitIdx & 7)
        const bit = readBit(c, r, dynThreshold)
        payload[byteI] |= bit << bitI
        bitIdx++
      }
    }

    // Verify CRC
    const actualCrc = crc16(payload)
    if (actualCrc !== expectedCrc) {
      if (frameIdx === 0 && this._dbg.filter(e => e.ev === 'row_scan').length === 0) {
        const rowBrightness = []
        for (let r = 2; r < rows; r++) {
          const rowSamples = []
          for (let c = 0; c < Math.min(cols, 8); c++) rowSamples.push(Math.round(sampleBrightness(c, r)))
          rowBrightness.push(rowSamples)
        }
        this._dbg.push({ ev: 'row_scan', frameIdx, rows, cols, P, rowBrightness })
      }
      this._dbg.push({ t: Date.now(), ev: 'crc_fail', frameIdx, dataTotal, payloadLen, expectedCrc, actualCrc, dynThreshold })
      return
    }

    if (this._dataTotal === null) {
      this._dataTotal = dataTotal
      this._parityCount = parityCount
    }

    if (isParity) {
      const groupIdx = frameIdx - dataTotal
      this._parityReceived.set(groupIdx, { payload, payloadLenXor: payloadLen })
      this._dbg.push({ t: Date.now(), ev: 'parity_ok', groupIdx, payloadLen })
      if (this._parityReceived.size === this._parityCount) {
        this._onAllParityReceived?.()
      }
    } else {
      this._received.set(frameIdx, payload)
      const progress = this.getProgress()
      this._dbg.push({ t: Date.now(), ev: 'frame_ok', frameIdx, dataTotal, payloadLen, received: progress.received })
      this._onFrame?.(frameIdx, dataTotal, payload, progress)
    }

    if (this._received.size === dataTotal) {
      this._running = false
      this._onComplete?.(this._received)
      this._onStatus?.('COMPLETE')
    }
  }

  /** Assemble all received payloads in order. */
  assemble() {
    if (!this._dataTotal || this._received.size < this._dataTotal) return null
    const parts = []
    for (let i = 0; i < this._dataTotal; i++) {
      const p = this._received.get(i)
      if (!p) return null
      parts.push(p)
    }
    const total = parts.reduce((a, p) => a + p.length, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const p of parts) { result.set(p, offset); offset += p.length }
    return result
  }
}
