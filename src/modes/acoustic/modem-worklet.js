// AudioWorklet processor for MFSK demodulation — standalone, no imports

function fftInPlace(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const ang = -Math.PI / half
    const wr0 = Math.cos(ang), wi0 = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0
      for (let j = 0; j < half; j++) {
        const ur = re[i+j], ui = im[i+j]
        const vr = re[i+j+half]*wr - im[i+j+half]*wi
        const vi = re[i+j+half]*wi + im[i+j+half]*wr
        re[i+j] = ur+vr; im[i+j] = ui+vi
        re[i+j+half] = ur-vr; im[i+j+half] = ui-vi
        const nwr = wr*wr0 - wi*wi0; wi = wr*wi0 + wi*wr0; wr = nwr
      }
    }
  }
}

function computeSpectrum(samples, n) {
  const re = new Float32Array(n), im = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)))
    re[i] = samples[i] * w
  }
  fftInPlace(re, im)
  const out = new Float32Array(n >> 1)
  const norm = n / 2
  for (let i = 0; i < out.length; i++) {
    const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / norm
    out[i] = mag > 1e-10 ? 20 * Math.log10(mag) : -150
  }
  return out
}

class ModemProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const { fftSize, hopSamples } = options.processorOptions
    this._n = fftSize
    this._hop = hopSamples
    this._buf = new Float32Array(fftSize)
    this._pos = 0
    this._filled = 0
    this._hopAcc = 0
  }

  process(inputs) {
    const ch = inputs[0]?.[0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._pos] = ch[i]
      this._pos = (this._pos + 1) % this._n
      if (this._filled < this._n) this._filled++
      this._hopAcc++
    }
    if (this._hopAcc >= this._hop && this._filled >= this._n) {
      this._hopAcc = 0
      const ordered = new Float32Array(this._n)
      for (let i = 0; i < this._n; i++)
        ordered[i] = this._buf[(this._pos + i) % this._n]
      const freqData = computeSpectrum(ordered, this._n)
      this.port.postMessage({ t: currentTime, freqData }, [freqData.buffer])
    }
    return true
  }
}

registerProcessor('modem-processor', ModemProcessor)
