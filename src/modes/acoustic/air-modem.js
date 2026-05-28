import { MODES, encodeFrame, decodeFrame, symbolFreq, peakSymbol } from './mfsk.js'
import workletCode from './modem-worklet.js?raw'

export class AirModem {
  constructor() {
    this._ctx = null
    this._sendAnalyser = null
    this._stream = null
    this._state = 'idle'
    this._cfg = null
    this._rxState = null
    this._onPacket = null
    this._onStatus = null
    this._dbg = null
    this._workletNode = null
    this._workletRegistered = false
    this._lastFreqData = null
  }

  startDebug() {
    this._dbg = { meta: null, symbols: [], fftSnapshots: [], rawPackets: [] }
  }

  getDebugLog() { return this._dbg }

  // ─── Shared setup ───────────────────────────────────────────────────────────

  async _ensureContext() {
    if (!this._ctx || this._ctx.state === 'closed') {
      this._ctx = new AudioContext()
      this._sendAnalyser = this._ctx.createAnalyser()
      this._sendAnalyser.fftSize = 2048
      this._workletRegistered = false
    }
    if (this._ctx.state === 'suspended') await this._ctx.resume()
    return this._ctx
  }

  get binHz() {
    return this._ctx.sampleRate / this._cfg.fftSize
  }

  // ─── Transmit ────────────────────────────────────────────────────────────────

  /**
   * Send bytes over audio.
   * @param {Uint8Array} data
   * @param {1|2} mode
   * @param {{ onProgress?: Function }} opts
   * @returns {Promise<void>}
   */
  async send(data, mode, { onProgress } = {}) {
    const ctx = await this._ensureContext()
    const cfg = MODES[mode]
    this._cfg = cfg

    const symbols = encodeFrame(data, cfg.bitsPerSymbol)
    const totalDuration =
      cfg.preambleDuration + cfg.silenceGap + symbols.length * cfg.symbolDuration

    let t = ctx.currentTime + 0.05

    // Preamble tone
    this._playTone(cfg.preambleFreq, t, cfg.preambleDuration / 1000)
    t += (cfg.preambleDuration + cfg.silenceGap) / 1000

    // Data symbols (all pre-scheduled, no jitter)
    for (let i = 0; i < symbols.length; i++) {
      const freq = symbolFreq(symbols[i], cfg)
      this._playTone(freq, t, cfg.symbolDuration / 1000)
      t += cfg.symbolDuration / 1000
    }

    // Progress callbacks via polling
    const startMs = Date.now()
    return new Promise((resolve) => {
      const tick = () => {
        const elapsed = Date.now() - startMs
        onProgress?.(Math.min(elapsed / totalDuration, 1), symbols.length)
        if (elapsed < totalDuration + 100) {
          setTimeout(tick, 100)
        } else {
          resolve()
        }
      }
      tick()
    })
  }

  _playTone(freq, startTime, durationSec) {
    const osc = this._ctx.createOscillator()
    const gain = this._ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq

    // Soft envelope to avoid clicks
    const t = startTime
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.8, t + 0.005)
    gain.gain.setValueAtTime(0.8, t + durationSec - 0.005)
    gain.gain.linearRampToValueAtTime(0, t + durationSec)

    osc.connect(gain)
    gain.connect(this._ctx.destination)
    if (this._sendAnalyser) gain.connect(this._sendAnalyser)
    osc.start(t)
    osc.stop(t + durationSec + 0.005)
  }

  // ─── Receive ─────────────────────────────────────────────────────────────────

  /**
   * Start listening for MFSK transmissions.
   * @param {1|2} mode
   * @param {{ onPacket?: Function, onStatus?: Function }} opts
   */
  async startReceive(mode, { onPacket, onStatus, deviceId = null } = {}) {
    this.stopReceive()
    const ctx = await this._ensureContext()
    const cfg = MODES[mode]
    this._cfg = cfg
    this._onPacket = onPacket
    this._onStatus = onStatus

    const audioConstraints = deviceId ? { deviceId: { exact: deviceId } } : true
    this._stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false })
    const source = ctx.createMediaStreamSource(this._stream)

    // Register worklet module once per AudioContext instance
    if (!this._workletRegistered) {
      const blob = new Blob([workletCode], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      await ctx.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      this._workletRegistered = true
    }

    // fftSize/4 samples ≈ 5.3ms hop — much finer than rAF's 16.7ms
    const hopSamples = cfg.fftSize >> 2
    this._workletNode = new AudioWorkletNode(ctx, 'modem-processor', {
      processorOptions: { fftSize: cfg.fftSize, hopSamples },
    })
    source.connect(this._workletNode)
    this._workletNode.port.onmessage = (e) => this._handleWorkletMsg(e.data)

    if (this._dbg) {
      this._dbg.meta = {
        mode: cfg.id, label: cfg.label, cfg: { ...cfg },
        startISO: new Date().toISOString(),
        sampleRate: ctx.sampleRate,
        binHz: ctx.sampleRate / cfg.fftSize,
        hopSamples,
      }
      this._dbg.symbols = []
      this._dbg.fftSnapshots = []
      this._dbg.rawPackets = []
    }

    this._rxState = {
      phase: 'waiting',
      preambleStart: null,
      symbolStart: null,
      symbolIdx: 0,
      symbols: [],
      lastSymIdx: -1,
      maxPreamblePower: -Infinity,
    }

    this._state = 'receiving'
    this._onStatus?.('LISTENING', cfg.label)
  }

  stopReceive() {
    if (this._dbg && this._rxState && this._dbg.meta) {
      this._dbg.meta.maxPreamblePower = this._rxState.maxPreamblePower
      this._dbg.meta.threshold = this._cfg?.threshold
    }
    this._state = 'idle'
    this._rxState = null
    if (this._workletNode) { this._workletNode.disconnect(); this._workletNode = null }
    if (this._stream) { this._stream.getTracks().forEach((t) => t.stop()); this._stream = null }
    this._onStatus?.('IDLE', '')
  }

  _handleWorkletMsg({ t, freqData }) {
    if (this._state !== 'receiving') return
    this._lastFreqData = freqData
    const cfg = this._cfg
    const rx = this._rxState
    const bHz = this.binHz
    const now = t

    const preambleBin = Math.round(cfg.preambleFreq / bHz)
    const preamblePower = preambleBin < freqData.length ? freqData[preambleBin] : -100

    if (rx.phase === 'waiting') {
      if (preamblePower > rx.maxPreamblePower) rx.maxPreamblePower = preamblePower
      if (preamblePower > cfg.threshold) {
        rx.phase = 'preamble'
        rx.preambleStart = now
        this._onStatus?.('PREAMBLE', cfg.label)
        if (this._dbg) {
          const maxBin = Math.ceil(cfg.preambleFreq * 1.2 / bHz)
          this._dbg.fftSnapshots.push({
            phase: 'preamble_detected', audioTime: now, preamblePower,
            fft: Array.from(freqData.subarray(0, maxBin)).map(v => Math.round(v * 10) / 10),
          })
        }
      }
    } else if (rx.phase === 'preamble') {
      if (preamblePower < cfg.threshold - 10) {
        rx.symbols = []
        rx.lastSymIdx = -1
        rx.phase = 'sync'
        this._onStatus?.('SYNC', cfg.label)
        if (this._dbg) {
          this._dbg.fftSnapshots.push({
            phase: 'preamble_end', audioTime: now, preamblePower,
          })
        }
      }
    } else if (rx.phase === 'sync') {
      let bestPower = -Infinity
      for (let sym = 0; sym < cfg.tones; sym++) {
        const bin = Math.round(symbolFreq(sym, cfg) / bHz)
        if (bin < freqData.length && freqData[bin] > bestPower) bestPower = freqData[bin]
      }
      if (bestPower > cfg.threshold) {
        rx.symbolStart = now
        rx.phase = 'data'
        this._onStatus?.('RECEIVING', cfg.label)
        if (this._dbg) {
          const maxBin = Math.ceil(cfg.preambleFreq * 1.2 / bHz)
          this._dbg.fftSnapshots.push({
            phase: 'data_start', audioTime: now,
            fft: Array.from(freqData.subarray(0, maxBin)).map(v => Math.round(v * 10) / 10),
          })
        }
      }
    } else if (rx.phase === 'data') {
      const elapsed = now - rx.symbolStart
      if (elapsed < 0) return
      const symPeriod = cfg.symbolDuration / 1000
      const currentSymIdx = Math.floor(elapsed / symPeriod)

      // Skip first 33% of symbol period to avoid ISI from previous symbol's FFT tail
      const elapsedInSym = elapsed - currentSymIdx * symPeriod
      if (elapsedInSym < symPeriod * 0.33) return

      if (currentSymIdx > rx.lastSymIdx) {
        const { symbol, power } = peakSymbol(freqData, cfg, bHz)
        rx.lastSymIdx = currentSymIdx

        if (power < cfg.threshold) {
          if (rx.symbols.length > 0) this._tryDecode()
          rx.phase = 'waiting'
          this._onStatus?.('LISTENING', cfg.label)
          return
        }

        if (this._dbg) {
          this._dbg.symbols.push({
            symIdx: currentSymIdx,
            symbol,
            freq: symbolFreq(symbol, cfg),
            power: Math.round(power * 10) / 10,
            elapsed: Math.round(elapsed * 1000) / 1000,
          })
        }

        rx.symbols.push(symbol)

        const minHeaderSyms = Math.ceil(16 / cfg.bitsPerSymbol)
        if (rx.symbols.length >= minHeaderSyms) {
          const result = decodeFrame(rx.symbols, cfg.bitsPerSymbol)
          if (result && rx.symbols.length >= result.totalSymbols) {
            if (this._dbg) {
              this._dbg.rawPackets.push({
                idx: this._dbg.rawPackets.length,
                symbolCount: rx.symbols.length,
                hex: Array.from(result.data).map(b => b.toString(16).padStart(2, '0')).join(''),
              })
            }
            this._onPacket?.(result.data)
            rx.symbols = []
            rx.phase = 'waiting'
            this._onStatus?.('LISTENING', cfg.label)
          }
        }
      }
    }
  }

  _tryDecode() {
    const cfg = this._cfg
    const symbols = this._rxState.symbols
    const result = decodeFrame(symbols, cfg.bitsPerSymbol)
    if (result) {
      if (this._dbg) {
        this._dbg.rawPackets.push({
          idx: this._dbg.rawPackets.length,
          symbolCount: symbols.length,
          hex: Array.from(result.data).map(b => b.toString(16).padStart(2, '0')).join(''),
          via: 'tryDecode',
        })
      }
      this._onPacket?.(result.data)
    } else if (this._dbg && symbols.length > 0) {
      this._dbg.rawPackets.push({
        idx: this._dbg.rawPackets.length, symbolCount: symbols.length,
        hex: null, via: 'tryDecode_failed',
      })
    }
  }
}
