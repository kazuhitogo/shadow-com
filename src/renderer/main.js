import { splitFile, assemblePackets, DEFAULT_PAYLOAD_SIZE, createPacket } from '../common/packet.js'
import { computeCapacity, splitData, drawFrame, drawCalibrationFrame } from '../modes/hdmi/pixel-encoder.js'
import { computeParityFrames } from '../common/fec.js'
import { PixelDecoder } from '../modes/hdmi/pixel-decoder.js'
import { AirModem } from '../modes/acoustic/air-modem.js'
import { MODES as ACOUSTIC_MODES } from '../modes/acoustic/mfsk.js'

// Tab switching
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'))
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById(`${target}-tab`).classList.add('active')
  })
})

// ─── Acoustic Send ────────────────────────────────────────────────────────────

const acModem = new AirModem()
const acMode = 1
let acFileData = null
let acFileName = ''
let acSending = false

const acSendBar = document.getElementById('ac-send-bar')
const acSendStat = document.getElementById('ac-send-stat')
const acFileInfo = document.getElementById('ac-file-info')
const acSendBtn = document.getElementById('ac-send-btn')
const acStopBtn = document.getElementById('ac-stop-btn')
const acWaveCanvas = document.getElementById('ac-wave-canvas')
const acFreqStat = document.getElementById('ac-freq-stat')

document.getElementById('ac-select-btn').addEventListener('click', async () => {
  const filePath = await window.electronAPI.showOpenDialog()
  if (!filePath) return
  const { name, data } = await window.electronAPI.readFile(filePath)
  acFileName = name
  acFileData = new Uint8Array(data)
  const cfg = ACOUSTIC_MODES[acMode]
  const packetCount = Math.ceil(acFileData.length / cfg.maxPayload)
  acFileInfo.textContent = `${name} — ${(acFileData.length / 1024).toFixed(1)} KB — ${packetCount} パケット`
  acSendBtn.disabled = false
})

acSendBtn.addEventListener('click', async () => {
  if (!acFileData || acSending) return
  acSending = true
  acSendBtn.disabled = true
  acStopBtn.disabled = false
  acSendStat.textContent = '送信中...'

  const cfg = ACOUSTIC_MODES[acMode]
  const payload = acFileData.slice(0, cfg.maxPayload)  // first chunk only for demo
  const total = Math.ceil(acFileData.length / cfg.maxPayload)
  let sentPackets = 0

  for (let i = 0; i < total && acSending; i++) {
    const chunk = acFileData.slice(i * cfg.maxPayload, (i + 1) * cfg.maxPayload)
    const pkt = createPacket(i, total, chunk)
    acSendStat.textContent = `パケット ${i + 1}/${total} 送信中...`
    acSendBar.style.width = `${(i / total) * 100}%`
    acFreqStat.textContent = `${cfg.label} — preamble + ${Math.ceil((pkt.length * 8) / cfg.bitsPerSymbol)} symbols`

    await acModem.send(pkt, acMode, {
      onProgress: (ratio) => {
        const pkt_pct = (i + ratio) / total * 100
        acSendBar.style.width = `${pkt_pct}%`
      },
    })
    sentPackets++
  }

  if (acSending) {
    acSendStat.textContent = `完了 — ${sentPackets}/${total} パケット送信`
    acSendBar.style.width = '100%'
  }
  acSending = false
  acSendBtn.disabled = false
  acStopBtn.disabled = true
})

acStopBtn.addEventListener('click', () => {
  acSending = false
  acStopBtn.disabled = true
  acSendBtn.disabled = false
  acSendStat.textContent = '停止'
})

// Waveform visualizer — taps into acModem's send analyser (no mic needed)
;(function startWaveViz() {
  const canvas = acWaveCanvas
  const ctx2d = canvas.getContext('2d')
  let started = false

  function drawWave() {
    requestAnimationFrame(drawWave)
    const analyser = acModem._sendAnalyser
    if (!analyser) return
    const buf = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(buf)
    const W = canvas.width, H = canvas.height
    ctx2d.fillStyle = '#000'
    ctx2d.fillRect(0, 0, W, H)
    ctx2d.strokeStyle = '#00d4ff'
    ctx2d.lineWidth = 1
    ctx2d.beginPath()
    const step = buf.length / W
    for (let x = 0; x < W; x++) {
      const v = buf[Math.floor(x * step)]
      const y = (1 - (v + 1) / 2) * H
      x === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y)
    }
    ctx2d.stroke()
  }

  document.querySelector('[data-tab="air-send"]').addEventListener('click', () => {
    if (started) return
    started = true
    drawWave()
  })
})()

// ─── Acoustic Receive ─────────────────────────────────────────────────────────

const acRecvModem = new AirModem()
const arMode = 1
let arReceivedPackets = new Map()
let arTotal = null
let arRecvFileName = 'received_acoustic'

const arStatus = document.getElementById('ar-status')
const arStat = document.getElementById('ar-stat')
const arPacketGrid = document.getElementById('ar-packet-grid')
const arProgressStat = document.getElementById('ar-progress-stat')
const arFreqStat = document.getElementById('ar-freq-stat')
const arFftCanvas = document.getElementById('ar-fft-canvas')
const arStartBtn = document.getElementById('ar-start-btn')
const arStopBtn = document.getElementById('ar-stop-btn')
const arSaveBtn = document.getElementById('ar-save-btn')
function setArStatus(cls, text) {
  arStatus.className = `status-badge ${cls}`
  arStatus.textContent = text
}

function updateArGrid() {
  if (!arTotal) return
  arPacketGrid.innerHTML = ''
  for (let i = 0; i < arTotal; i++) {
    const cell = document.createElement('div')
    cell.className = `pkt-cell${arReceivedPackets.has(i) ? ' received' : ''}`
    arPacketGrid.appendChild(cell)
  }
  arProgressStat.textContent = `${arReceivedPackets.size} / ${arTotal ?? '?'}`
}

arStartBtn.addEventListener('click', async () => {
  arReceivedPackets.clear()
  arTotal = null
  arSaveBtn.disabled = true
  arPacketGrid.innerHTML = ''
  setArStatus('scanning', 'LISTENING')
  arStat.textContent = 'マイク起動中...'
  arStartBtn.disabled = true
  arStopBtn.disabled = false

  const cfg = ACOUSTIC_MODES[arMode]
  arFreqStat.textContent = `${cfg.label}`

  // FFT visualizer
  let fftRaf = null
  const fftCtx = arFftCanvas.getContext('2d')

  try {
    acRecvModem.startDebug()
    await acRecvModem.startReceive(arMode, {
      onStatus: (status, label) => {
        setArStatus(
          status === 'IDLE' ? 'idle' : status === 'PREAMBLE' ? 'scanning' : 'scanning',
          status
        )
        arStat.textContent = `${status} — ${label}`
      },
      onPacket: async (rawData) => {
        // rawData is the MFSK-decoded bytes (raw RS packet)
        const parsed = parsePacket(rawData)
        if (!parsed) {
          arStat.textContent = 'パケット CRC エラー'
          return
        }
        const { seq, total } = parsed
        arTotal = total
        arReceivedPackets.set(seq, rawData)
        updateArGrid()
        arStat.textContent = `パケット受信: seq=${seq} total=${total}`
        if (arReceivedPackets.size === total) {
          setArStatus('done', 'COMPLETE')
          arSaveBtn.disabled = false
          arStopBtn.disabled = true
          arStartBtn.disabled = false
          cancelAnimationFrame(fftRaf)
          acRecvModem.stopReceive()
          await saveAirDebugLog()
        }
      },
    })

    // FFT draw loop using cached worklet freqData
    const drawFft = () => {
      fftRaf = requestAnimationFrame(drawFft)
      const data = acRecvModem._lastFreqData
      if (!data) return
      const W = arFftCanvas.width, H = arFftCanvas.height
      fftCtx.fillStyle = '#000'
      fftCtx.fillRect(0, 0, W, H)
      fftCtx.strokeStyle = '#00ff88'
      fftCtx.lineWidth = 1
      fftCtx.beginPath()
      const maxBin = Math.min(data.length, Math.ceil(24000 / (48000 / cfg.fftSize)))
      for (let i = 0; i < W; i++) {
        const bin = Math.floor((i / W) * maxBin)
        const dB = Math.max(data[bin] ?? -120, -120)
        const y = H - ((dB + 120) / 100) * H
        i === 0 ? fftCtx.moveTo(i, y) : fftCtx.lineTo(i, y)
      }
      fftCtx.stroke()
    }
    drawFft()
  } catch (e) {
    setArStatus('error', 'ERROR')
    arStat.textContent = `エラー: ${e.message}`
    arStartBtn.disabled = false
    arStopBtn.disabled = true
  }
})

async function saveAirDebugLog() {
  try {
    const log = acRecvModem.getDebugLog()
    console.log('[DBG-AIR] saveAirDebugLog called, log:', log ? `symbols=${log.symbols?.length} packets=${log.rawPackets?.length}` : 'NULL')
    if (!log) return
    const bytes = new TextEncoder().encode(JSON.stringify(log, null, 2))
    const dest = await window.electronAPI.saveDebugAuto('air_debug.json', Array.from(bytes))
    console.log('[DBG-AIR] saved to:', dest)
  } catch (e) {
    console.error('[DBG-AIR] saveAirDebugLog error:', e)
  }
}

arStopBtn.addEventListener('click', async () => {
  acRecvModem.stopReceive()
  setArStatus('idle', 'IDLE')
  arStat.textContent = '停止'
  arStartBtn.disabled = false
  arStopBtn.disabled = true
  await saveAirDebugLog()
})

arSaveBtn.addEventListener('click', async () => {
  const assembled = assemblePackets(arReceivedPackets)
  if (!assembled) { arStat.textContent = 'エラー: パケット不完全'; return }
  const savePath = await window.electronAPI.showSaveDialog(arRecvFileName)
  if (!savePath) return
  await window.electronAPI.saveFile(savePath, assembled)
  arStat.textContent = `保存完了: ${savePath}`
})

// ─── Mode 4 Send (HDMI) ───────────────────────────────────────────────────────

let hdmiFileData = null
let hdmiFileName = ''
let hdmiSending = false
let hdmiPixelSize = 2
let hdmiFps = 30
let hdmiWinOpen = false
let _hdmiOpening = false

const hdmiRefreshDisplaysBtn = document.getElementById('hdmi-refresh-displays-btn')
const hdmiDisplaySel = document.getElementById('hdmi-display-sel')
const hdmiPxSlider = document.getElementById('hdmi-px-slider')
const hdmiPxVal = document.getElementById('hdmi-px-val')
const hdmiFpsSlider = document.getElementById('hdmi-fps-slider')
const hdmiFpsVal = document.getElementById('hdmi-fps-val')
const hdmiCapacityStat = document.getElementById('hdmi-capacity-stat')
const hdmiSelectBtn = document.getElementById('hdmi-select-btn')
const hdmiFileInfo = document.getElementById('hdmi-file-info')
const hdmiStartBtn = document.getElementById('hdmi-start-btn')
const hdmiStopBtn = document.getElementById('hdmi-stop-btn')
const hdmiSendBar = document.getElementById('hdmi-send-bar')
const hdmiSendStat = document.getElementById('hdmi-send-stat')
const hdmiPreviewCanvas = document.getElementById('hdmi-preview-canvas')
const hdmiFrameStat = document.getElementById('hdmi-frame-stat')
const hdmiRetransmitInput = document.getElementById('hdmi-retransmit-input')
const hdmiRetransmitBtn = document.getElementById('hdmi-retransmit-btn')

function displaySortRank(label) {
  if (label.includes('USB')) return 0
  if (label.includes('HDMI')) return 1
  return 2
}

async function openAndCalibrate() {
  if (_hdmiOpening) return
  _hdmiOpening = true
  hdmiRefreshDisplaysBtn.disabled = true
  hdmiDisplaySel.disabled = true
  hdmiPxSlider.disabled = true
  hdmiFpsSlider.disabled = true
  try {
    const displayId = Number(hdmiDisplaySel.value) || undefined
    if (!displayId) return
    if (hdmiWinOpen) {
      await window.electronAPI.hdmi.closeWindow()
      hdmiWinOpen = false
      hdmiStartBtn.disabled = true
    }
    await window.electronAPI.hdmi.openWindow(displayId)
    hdmiWinOpen = true
    if (hdmiFileData) {
      hdmiStartBtn.disabled = false
      hdmiRetransmitBtn.disabled = false
    }
    await new Promise((r) => setTimeout(r, 800))
    await window.electronAPI.hdmi.sendFrame({ type: 'calibrate', pixelSize: hdmiPixelSize })
    drawCalibrationFrame(hdmiPreviewCanvas, hdmiPixelSize)
    hdmiFrameStat.textContent = 'キャリブレーションフレーム表示中'
  } finally {
    _hdmiOpening = false
    hdmiRefreshDisplaysBtn.disabled = false
    hdmiDisplaySel.disabled = false
    hdmiPxSlider.disabled = false
    hdmiFpsSlider.disabled = false
  }
}

async function refreshDisplayList() {
  hdmiRefreshDisplaysBtn.disabled = true
  hdmiDisplaySel.disabled = true
  try {
    const prevId = hdmiDisplaySel.value
    const displays = await window.electronAPI.hdmi.getDisplays()
    console.log('[DBG-HDMI] getAllDisplays:', JSON.stringify(displays))
    const filtered = displays.filter((d) => !d.internal)
    filtered.sort((a, b) => displaySortRank(a.label) - displaySortRank(b.label))
    hdmiDisplaySel.innerHTML = filtered.map((d) =>
      `<option value="${d.id}">${d.label}</option>`
    ).join('')
    if (filtered.some((d) => String(d.id) === prevId)) {
      hdmiDisplaySel.value = prevId
    }
    updateCapacityStat()
    if (hdmiDisplaySel.value && !hdmiWinOpen) {
      await openAndCalibrate()
    }
  } finally {
    hdmiRefreshDisplaysBtn.disabled = false
    hdmiDisplaySel.disabled = false
  }
}

// Populate display list when tab is opened
document.querySelector('[data-tab="hdmi-send"]').addEventListener('click', refreshDisplayList)
document.getElementById('hdmi-refresh-displays-btn').addEventListener('click', refreshDisplayList)

hdmiDisplaySel.addEventListener('change', openAndCalibrate)

window.electronAPI.onHdmiWinClosed(() => {
  hdmiWinOpen = false
  hdmiStartBtn.disabled = true
  hdmiRetransmitBtn.disabled = true
  hdmiSending = false
})

function updateCapacityStat() {
  const { bytesPerFrame, cols, rows } = computeCapacity(hdmiPixelSize)
  const mbps = ((bytesPerFrame * 60) / 1e6).toFixed(1)
  hdmiCapacityStat.textContent = `${cols}×${rows} grid — ${bytesPerFrame.toLocaleString()} B/frame — ~${mbps} MB/s @ 60fps`
}

hdmiPxSlider.addEventListener('input', () => {
  hdmiPixelSize = Number(hdmiPxSlider.value)
  hdmiPxVal.textContent = `${hdmiPixelSize}×${hdmiPixelSize}`
  updateCapacityStat()
})

hdmiFpsSlider.addEventListener('input', () => {
  hdmiFps = Number(hdmiFpsSlider.value)
  hdmiFpsVal.textContent = `${hdmiFps} fps`
})


hdmiSelectBtn.addEventListener('click', async () => {
  const filePath = await window.electronAPI.showOpenDialog()
  if (!filePath) return
  const { name, data } = await window.electronAPI.readFile(filePath)
  hdmiFileName = name
  hdmiFileData = new Uint8Array(data)
  const { bytesPerFrame } = computeCapacity(hdmiPixelSize)
  const frameCount = Math.ceil(hdmiFileData.length / bytesPerFrame)
  hdmiFileInfo.textContent = `${name} — ${(hdmiFileData.length / 1024).toFixed(1)} KB — ${frameCount} フレーム`
  if (hdmiWinOpen) hdmiStartBtn.disabled = false
  hdmiRetransmitBtn.disabled = false
})

hdmiStartBtn.addEventListener('click', async () => {
  if (!hdmiFileData || hdmiSending) return
  hdmiSending = true
  hdmiStartBtn.disabled = true
  hdmiStopBtn.disabled = false
  hdmiSelectBtn.disabled = true
  hdmiPxSlider.disabled = true
  hdmiFpsSlider.disabled = true
  hdmiDisplaySel.disabled = true
  hdmiRefreshDisplaysBtn.disabled = true
  hdmiRetransmitBtn.disabled = true

  const P = hdmiPixelSize
  const chunks = splitData(hdmiFileData, P)
  const dataTotal = chunks.length
  const parityFrames = computeParityFrames(chunks)
  const fecCount = parityFrames.length
  const frameTotal = dataTotal + fecCount
  hdmiSendBar.style.width = '0%'
  hdmiSendStat.textContent = `0 / ${frameTotal} フレーム (FEC +${fecCount})`

  const frameInterval = Math.round(1000 / hdmiFps)

  for (let i = 0; i < dataTotal && hdmiSending; i++) {
    const payload = chunks[i]
    await window.electronAPI.hdmi.sendFrame({
      type: 'frame', frameIdx: i, dataTotal, parityCount: fecCount,
      payload: Array.from(payload), pixelSize: P,
    })
    drawFrame(hdmiPreviewCanvas, i, dataTotal, fecCount, payload, P)
    hdmiSendBar.style.width = `${((i + 1) / frameTotal) * 100}%`
    hdmiSendStat.textContent = `frame ${i + 1} / ${frameTotal}`
    hdmiFrameStat.textContent = `frame=${i} — ${payload.length.toLocaleString()} bytes`
    await new Promise((r) => setTimeout(r, frameInterval))
  }

  for (let g = 0; g < fecCount && hdmiSending; g++) {
    const { payload, payloadLenXor } = parityFrames[g]
    const frameIdx = dataTotal + g
    await window.electronAPI.hdmi.sendFrame({
      type: 'frame', frameIdx, dataTotal, parityCount: fecCount,
      payload: Array.from(payload), pixelSize: P, payloadLenOverride: payloadLenXor,
    })
    drawFrame(hdmiPreviewCanvas, frameIdx, dataTotal, fecCount, payload, P, payloadLenXor)
    hdmiSendBar.style.width = `${((dataTotal + g + 1) / frameTotal) * 100}%`
    hdmiSendStat.textContent = `FEC frame ${g + 1} / ${fecCount}`
    hdmiFrameStat.textContent = `parity frame=${g}`
    await new Promise((r) => setTimeout(r, frameInterval))
  }

  hdmiSendStat.textContent = '送信完了'
  await window.electronAPI.hdmi.sendFrame({ type: 'blank' })
  hdmiSending = false
  hdmiStartBtn.disabled = false
  hdmiStopBtn.disabled = true
  hdmiSelectBtn.disabled = false
  hdmiPxSlider.disabled = false
  hdmiFpsSlider.disabled = false
  hdmiDisplaySel.disabled = false
  hdmiRefreshDisplaysBtn.disabled = false
  hdmiRetransmitBtn.disabled = false
})

hdmiStopBtn.addEventListener('click', async () => {
  hdmiSending = false
  await window.electronAPI.hdmi.sendFrame({ type: 'blank' })
  hdmiStartBtn.disabled = false
  hdmiStopBtn.disabled = true
  hdmiSelectBtn.disabled = false
  hdmiPxSlider.disabled = false
  hdmiFpsSlider.disabled = false
  hdmiDisplaySel.disabled = false
  hdmiRefreshDisplaysBtn.disabled = false
  hdmiRetransmitBtn.disabled = false
  hdmiSendStat.textContent = '停止'
})

hdmiRetransmitBtn.addEventListener('click', async () => {
  if (!hdmiFileData || hdmiSending) return
  const raw = hdmiRetransmitInput.value.trim()
  if (!raw) return
  const P = hdmiPixelSize
  const chunks = splitData(hdmiFileData, P)
  const dataTotal = chunks.length
  const fecCount = computeParityFrames(chunks).length
  const indices = [...new Set(
    raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n >= 0 && n < dataTotal)
  )].sort((a, b) => a - b)
  if (!indices.length) { hdmiSendStat.textContent = '再送: 有効フレームなし'; return }

  hdmiSending = true
  hdmiStartBtn.disabled = true
  hdmiRetransmitBtn.disabled = true
  hdmiStopBtn.disabled = false
  hdmiSelectBtn.disabled = true
  hdmiPxSlider.disabled = true
  hdmiFpsSlider.disabled = true
  hdmiDisplaySel.disabled = true
  hdmiRefreshDisplaysBtn.disabled = true
  const frameInterval = Math.round(1000 / hdmiFps)

  for (let pos = 0; pos < indices.length && hdmiSending; pos++) {
    const i = indices[pos]
    const payload = chunks[i]
    await window.electronAPI.hdmi.sendFrame({ type: 'frame', frameIdx: i, dataTotal, parityCount: fecCount, payload: Array.from(payload), pixelSize: P })
    drawFrame(hdmiPreviewCanvas, i, dataTotal, fecCount, payload, P)
    hdmiSendStat.textContent = `再送 frame ${i} (${pos + 1}/${indices.length})`
    hdmiFrameStat.textContent = `frame=${i} — ${payload.length.toLocaleString()} bytes`
    await new Promise((r) => setTimeout(r, frameInterval))
  }

  await window.electronAPI.hdmi.sendFrame({ type: 'blank' })
  hdmiSending = false
  hdmiStartBtn.disabled = false
  hdmiRetransmitBtn.disabled = false
  hdmiStopBtn.disabled = true
  hdmiSelectBtn.disabled = false
  hdmiPxSlider.disabled = false
  hdmiFpsSlider.disabled = false
  hdmiDisplaySel.disabled = false
  hdmiRefreshDisplaysBtn.disabled = false
})

// ─── Mode 4 Receive (HDMI) ────────────────────────────────────────────────────

const pixelDecoder = new PixelDecoder()
let hdmiRecvPixelSize = 2
let hdmiRecvFileName = 'received_hdmi'

const hdmiCapSel = document.getElementById('hdmi-cap-sel')
const hdmiRecvPx = document.getElementById('hdmi-recv-px')
const hdmiRecvPxVal = document.getElementById('hdmi-recv-px-val')
const hdmiRecvStatus = document.getElementById('hdmi-recv-status')
const hdmiRecvStat = document.getElementById('hdmi-recv-stat')
const hdmiRecvBar = document.getElementById('hdmi-recv-bar')
const hdmiFrameGrid = document.getElementById('hdmi-frame-grid')
const hdmiRecvProgress = document.getElementById('hdmi-recv-progress')
const hdmiMissingDisplay = document.getElementById('hdmi-missing-display')
const hdmiRecvStartBtn = document.getElementById('hdmi-recv-start-btn')
const hdmiRecvStopBtn = document.getElementById('hdmi-recv-stop-btn')
const hdmiRecvSaveBtn = document.getElementById('hdmi-recv-save-btn')
const hdmiCapVideo = document.getElementById('hdmi-cap-video')
const hdmiScanCanvas = document.getElementById('hdmi-scan-canvas')
const hdmiCapStat = document.getElementById('hdmi-cap-stat')

// Populate capture devices when tab is opened
document.querySelector('[data-tab="hdmi-recv"]').addEventListener('click', async () => {
  // getUserMedia を一度呼んで macOS カメラ権限ダイアログを出す
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true })
    s.getTracks().forEach(t => t.stop())
  } catch (e) {
    hdmiCapStat.textContent = `カメラ権限エラー: ${e.message}`
  }
  const devices = await PixelDecoder.listVideoDevices()
  const CAPTURE_KW = ['Capture', 'USB Video', 'UVC', 'UGREEN', 'AV']
  devices.sort((a, b) => {
    const aIsCap = CAPTURE_KW.some((k) => (a.label || '').includes(k))
    const bIsCap = CAPTURE_KW.some((k) => (b.label || '').includes(k))
    return aIsCap === bIsCap ? 0 : aIsCap ? -1 : 1
  })
  hdmiCapSel.innerHTML = devices.map((d) =>
    `<option value="${d.deviceId}">${d.label}</option>`
  ).join('')
})

hdmiRecvPx.addEventListener('input', () => {
  hdmiRecvPixelSize = Number(hdmiRecvPx.value)
  hdmiRecvPxVal.textContent = `${hdmiRecvPixelSize}×${hdmiRecvPixelSize}`
})

function setHdmiRecvStatus(cls, text) {
  hdmiRecvStatus.className = `status-badge ${cls}`
  hdmiRecvStatus.textContent = text
}

function updateHdmiFrameGrid(received, total, maxSeen = -1) {
  hdmiFrameGrid.innerHTML = ''
  for (let i = 0; i < total; i++) {
    const cell = document.createElement('div')
    cell.className = `pkt-cell${received.has(i) ? ' received' : ''}`
    hdmiFrameGrid.appendChild(cell)
  }
  hdmiRecvProgress.textContent = `${received.size} / ${total}`
  // Only show frames the sender has already passed (≤ maxSeen) as truly missing
  const ceiling = maxSeen >= 0 ? maxSeen : -1
  const missing = ceiling >= 0
    ? Array.from({ length: ceiling + 1 }, (_, i) => i).filter(i => !received.has(i))
    : []
  hdmiMissingDisplay.value = missing.length ? missing.join(',') : ''
  hdmiMissingDisplay.placeholder = missing.length ? '' : (ceiling >= 0 ? 'なし' : '受信中...')
}


hdmiRecvStartBtn.addEventListener('click', async () => {
  hdmiRecvSaveBtn.disabled = true
  hdmiFrameGrid.innerHTML = ''
  setHdmiRecvStatus('scanning', 'SCANNING')
  hdmiRecvStat.textContent = 'カメラ起動中...'
  hdmiRecvStartBtn.disabled = true
  hdmiRecvStopBtn.disabled = false
  hdmiCapSel.disabled = true
  hdmiRecvPx.disabled = true

  try {
    const deviceId = hdmiCapSel.value || undefined
    await pixelDecoder.startCamera(hdmiCapVideo, hdmiScanCanvas, deviceId)
    await new Promise((r) => setTimeout(r, 500))
    const threshold = pixelDecoder.calibrate()
    if (threshold !== null) {
      hdmiCapStat.textContent = `キャリブレーション完了: ${threshold.toFixed(1)}`
    } else {
      const d = pixelDecoder._lastCalibDebug
      const detail = d ? ` (low=${d.low.toFixed(0)} high=${d.high.toFixed(0)} contrast=${d.contrast.toFixed(0)})` : ''
      hdmiCapStat.textContent = `キャリブレーション失敗${detail} — 送信側キャリブレーションフレーム表示中か確認`
    }

    await pixelDecoder.start(hdmiCapVideo, hdmiScanCanvas, {
      pixelSize: hdmiRecvPixelSize,
      deviceId,
      onScanTick: (tick) => { if (tick % 60 === 0) hdmiCapStat.textContent = `SCANNING tick=${tick}` },
      onStatus: (s) => {
        setHdmiRecvStatus(
          s === 'COMPLETE' ? 'done' : s === 'IDLE' ? 'idle' : 'scanning', s
        )
      },
      onFrame: (frameIdx, total, _payload, progress) => {
        hdmiRecvStat.textContent = `フレーム受信: ${progress.received} / ${progress.total}`
        hdmiRecvBar.style.width = `${(progress.received / progress.total) * 100}%`
        hdmiCapStat.textContent = `frame=${frameIdx}`
        updateHdmiFrameGrid(pixelDecoder._received, progress.total, frameIdx)
      },
      onAllParityReceived: () => {
        const fecRecovered = pixelDecoder.tryFecRecovery()
        const prog = pixelDecoder.getProgress()
        updateHdmiFrameGrid(pixelDecoder._received, prog.total, prog.total - 1)
        hdmiRecvBar.style.width = `${(prog.received / prog.total) * 100}%`
        if (prog.missing.length === 0) {
          hdmiRecvStat.textContent = fecRecovered > 0
            ? `完了 — FEC復元: ${fecRecovered}フレーム`
            : '完了'
          hdmiRecvSaveBtn.disabled = false
        } else {
          hdmiRecvStat.textContent = `欠損 ${prog.missing.length}フレーム${fecRecovered > 0 ? ` (FEC復元: ${fecRecovered})` : ''} — 再送か停止`
        }
      },
      onComplete: () => {
        hdmiRecvSaveBtn.disabled = false
        hdmiRecvStopBtn.disabled = true
        hdmiRecvStartBtn.disabled = false
        hdmiCapSel.disabled = false
        hdmiRecvPx.disabled = false
        hdmiRecvBar.style.width = '100%'
      },
    })
  } catch (e) {
    setHdmiRecvStatus('error', 'ERROR')
    hdmiRecvStat.textContent = `エラー: ${e.message}`
    hdmiRecvStartBtn.disabled = false
    hdmiRecvStopBtn.disabled = true
    hdmiCapSel.disabled = false
    hdmiRecvPx.disabled = false
  }
})

hdmiRecvStopBtn.addEventListener('click', async () => {
  pixelDecoder.stop()
  const recovered = pixelDecoder.tryFecRecovery()
  const prog = pixelDecoder.getProgress()
  const maxSeen = prog.total ? prog.total - 1 : -1
  updateHdmiFrameGrid(pixelDecoder._received, prog.total ?? 0, maxSeen)
  hdmiRecvBar.style.width = prog.total ? `${(prog.received / prog.total) * 100}%` : '0%'
  if (recovered > 0) {
    setHdmiRecvStatus(prog.missing.length === 0 ? 'done' : 'idle', prog.missing.length === 0 ? 'COMPLETE' : 'IDLE')
    hdmiRecvStat.textContent = `停止 — FEC復元: ${recovered}フレーム`
    if (prog.missing.length === 0) hdmiRecvSaveBtn.disabled = false
  } else {
    setHdmiRecvStatus(prog.missing.length === 0 ? 'done' : 'idle', prog.missing.length === 0 ? 'COMPLETE' : 'IDLE')
    hdmiRecvStat.textContent = prog.missing.length === 0 ? '停止 — 完了' : '停止'
    if (prog.missing.length === 0) hdmiRecvSaveBtn.disabled = false
  }
  hdmiRecvStartBtn.disabled = false
  hdmiRecvStopBtn.disabled = true
  hdmiCapSel.disabled = false
  hdmiRecvPx.disabled = false
  await saveHdmiDebugLog()
})

async function saveHdmiDebugLog() {
  const log = pixelDecoder.getDebugLog()
  if (!log.length) return
  const summary = {
    total: pixelDecoder._dataTotal,
    received: pixelDecoder._received.size,
    threshold: pixelDecoder._threshold,
    events: log,
  }
  const bytes = new TextEncoder().encode(JSON.stringify(summary, null, 2))
  const dest = await window.electronAPI.saveDebugAuto('hdmi_debug.json', Array.from(bytes))
  console.log('[DBG-HDMI] saved to:', dest)
  pixelDecoder.clearDebugLog()
}

hdmiRecvSaveBtn.addEventListener('click', async () => {
  const assembled = pixelDecoder.assemble()
  if (!assembled) {
    const prog = pixelDecoder.getProgress()
    hdmiRecvStat.textContent = `エラー: フレーム不完全 (received=${prog.received} total=${prog.total})`
    await saveHdmiDebugLog()
    return
  }
  const savePath = await window.electronAPI.showSaveDialog(hdmiRecvFileName)
  if (!savePath) return
  await window.electronAPI.saveFile(savePath, assembled)
  hdmiRecvStat.textContent = `保存完了: ${savePath}`
})

// ─── AUX Send ────────────────────────────────────────────────────────────────

const auxSendModem = new AirModem()
let auxFileData = null
let auxFileName = ''
let auxSending = false

const axsSendBar = document.getElementById('axs-send-bar')
const axsSendStat = document.getElementById('axs-send-stat')
const axsFileInfo = document.getElementById('axs-file-info')
const axsSendBtn = document.getElementById('axs-send-btn')
const axsStopBtn = document.getElementById('axs-stop-btn')
const axsWaveCanvas = document.getElementById('axs-wave-canvas')
const axsFreqStat = document.getElementById('axs-freq-stat')

document.getElementById('axs-select-btn').addEventListener('click', async () => {
  const filePath = await window.electronAPI.showOpenDialog()
  if (!filePath) return
  const { name, data } = await window.electronAPI.readFile(filePath)
  auxFileName = name
  auxFileData = new Uint8Array(data)
  const cfg = ACOUSTIC_MODES[2]
  const packetCount = Math.ceil(auxFileData.length / cfg.maxPayload)
  axsFileInfo.textContent = `${name} — ${(auxFileData.length / 1024).toFixed(1)} KB — ${packetCount} パケット`
  axsSendBtn.disabled = false
})

axsSendBtn.addEventListener('click', async () => {
  if (!auxFileData || auxSending) return
  auxSending = true
  axsSendBtn.disabled = true
  axsStopBtn.disabled = false
  axsSendStat.textContent = '送信中...'

  const cfg = ACOUSTIC_MODES[2]
  const total = Math.ceil(auxFileData.length / cfg.maxPayload)
  let sentPackets = 0

  for (let i = 0; i < total && auxSending; i++) {
    const chunk = auxFileData.slice(i * cfg.maxPayload, (i + 1) * cfg.maxPayload)
    const pkt = createPacket(i, total, chunk)
    axsSendStat.textContent = `パケット ${i + 1}/${total} 送信中...`
    axsSendBar.style.width = `${(i / total) * 100}%`
    axsFreqStat.textContent = `${cfg.label} — preamble + ${Math.ceil((pkt.length * 8) / cfg.bitsPerSymbol)} symbols`

    await auxSendModem.send(pkt, 2, {
      onProgress: (ratio) => {
        axsSendBar.style.width = `${(i + ratio) / total * 100}%`
      },
    })
    sentPackets++
  }

  if (auxSending) {
    axsSendStat.textContent = `完了 — ${sentPackets}/${total} パケット送信`
    axsSendBar.style.width = '100%'
  }
  auxSending = false
  axsSendBtn.disabled = false
  axsStopBtn.disabled = true
})

axsStopBtn.addEventListener('click', () => {
  auxSending = false
  axsStopBtn.disabled = true
  axsSendBtn.disabled = false
  axsSendStat.textContent = '停止'
})

;(function startAuxWaveViz() {
  const canvas = axsWaveCanvas
  const ctx2d = canvas.getContext('2d')
  let started = false

  function drawWave() {
    requestAnimationFrame(drawWave)
    const analyser = auxSendModem._sendAnalyser
    if (!analyser) return
    const buf = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(buf)
    const W = canvas.width, H = canvas.height
    ctx2d.fillStyle = '#000'
    ctx2d.fillRect(0, 0, W, H)
    ctx2d.strokeStyle = '#00d4ff'
    ctx2d.lineWidth = 1
    ctx2d.beginPath()
    const step = buf.length / W
    for (let x = 0; x < W; x++) {
      const v = buf[Math.floor(x * step)]
      const y = (1 - (v + 1) / 2) * H
      x === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y)
    }
    ctx2d.stroke()
  }

  document.querySelector('[data-tab="aux-send"]').addEventListener('click', () => {
    if (started) return
    started = true
    drawWave()
  })
})()

// ─── AUX Receive ─────────────────────────────────────────────────────────────

const auxRecvModem = new AirModem()
let auxrReceivedPackets = new Map()
let auxrTotal = null
const auxrRecvFileName = 'received_aux'

const axrDeviceSel = document.getElementById('axr-device-sel')
const axrStatus = document.getElementById('axr-status')
const axrStat = document.getElementById('axr-stat')
const axrPacketGrid = document.getElementById('axr-packet-grid')
const axrProgressStat = document.getElementById('axr-progress-stat')
const axrFreqStat = document.getElementById('axr-freq-stat')
const axrFftCanvas = document.getElementById('axr-fft-canvas')
const axrStartBtn = document.getElementById('axr-start-btn')
const axrStopBtn = document.getElementById('axr-stop-btn')
const axrSaveBtn = document.getElementById('axr-save-btn')
// Populate audio input devices when AUX recv tab is opened
document.querySelector('[data-tab="aux-recv"]').addEventListener('click', async () => {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true })
    const devices = await navigator.mediaDevices.enumerateDevices()
    const inputs = devices.filter((d) => d.kind === 'audioinput')
    axrDeviceSel.innerHTML = inputs.map((d) =>
      `<option value="${d.deviceId}">${d.label || d.deviceId}</option>`
    ).join('')
  } catch { /* permission denied */ }
})

function setAxrStatus(cls, text) {
  axrStatus.className = `status-badge ${cls}`
  axrStatus.textContent = text
}

function updateAxrGrid() {
  if (!auxrTotal) return
  axrPacketGrid.innerHTML = ''
  for (let i = 0; i < auxrTotal; i++) {
    const cell = document.createElement('div')
    cell.className = `pkt-cell${auxrReceivedPackets.has(i) ? ' received' : ''}`
    axrPacketGrid.appendChild(cell)
  }
  axrProgressStat.textContent = `${auxrReceivedPackets.size} / ${auxrTotal ?? '?'}`
}

axrStartBtn.addEventListener('click', async () => {
  auxrReceivedPackets.clear()
  auxrTotal = null
  axrSaveBtn.disabled = true
  axrPacketGrid.innerHTML = ''
  setAxrStatus('scanning', 'LISTENING')
  axrStat.textContent = 'マイク起動中...'
  axrStartBtn.disabled = true
  axrStopBtn.disabled = false

  const cfg = ACOUSTIC_MODES[2]
  axrFreqStat.textContent = `${cfg.label}`

  let fftRaf = null
  const fftCtx = axrFftCanvas.getContext('2d')

  try {
    const axrDeviceId = axrDeviceSel.value || null
    auxRecvModem.startDebug()
    await auxRecvModem.startReceive(2, {
      deviceId: axrDeviceId,
      onStatus: (status, label) => {
        setAxrStatus(status === 'IDLE' ? 'idle' : 'scanning', status)
        axrStat.textContent = `${status} — ${label}`
      },
      onPacket: async (rawData) => {
        const parsed = parsePacket(rawData)
        if (!parsed) {
          axrStat.textContent = 'パケット CRC エラー'
          return
        }
        const { seq, total } = parsed
        auxrTotal = total
        auxrReceivedPackets.set(seq, rawData)
        updateAxrGrid()
        axrStat.textContent = `パケット受信: seq=${seq} total=${total}`
        if (auxrReceivedPackets.size === total) {
          setAxrStatus('done', 'COMPLETE')
          axrSaveBtn.disabled = false
          axrStopBtn.disabled = true
          axrStartBtn.disabled = false
          cancelAnimationFrame(fftRaf)
          auxRecvModem.stopReceive()
          await saveAuxDebugLog()
        }
      },
    })

    const drawFft = () => {
      fftRaf = requestAnimationFrame(drawFft)
      const data = auxRecvModem._lastFreqData
      if (!data) return
      const W = axrFftCanvas.width, H = axrFftCanvas.height
      fftCtx.fillStyle = '#000'
      fftCtx.fillRect(0, 0, W, H)
      fftCtx.strokeStyle = '#00ff88'
      fftCtx.lineWidth = 1
      fftCtx.beginPath()
      const maxBin = Math.min(data.length, Math.ceil(24000 / (48000 / cfg.fftSize)))
      for (let i = 0; i < W; i++) {
        const bin = Math.floor((i / W) * maxBin)
        const dB = Math.max(data[bin] ?? -120, -120)
        const y = H - ((dB + 120) / 100) * H
        i === 0 ? fftCtx.moveTo(i, y) : fftCtx.lineTo(i, y)
      }
      fftCtx.stroke()
    }
    drawFft()
  } catch (e) {
    setAxrStatus('error', 'ERROR')
    axrStat.textContent = `エラー: ${e.message}`
    axrStartBtn.disabled = false
    axrStopBtn.disabled = true
  }
})

async function saveAuxDebugLog() {
  try {
    const log = auxRecvModem.getDebugLog()
    console.log('[DBG] saveAuxDebugLog called, log:', log ? `symbols=${log.symbols?.length} packets=${log.rawPackets?.length}` : 'NULL')
    if (!log) return
    const bytes = new TextEncoder().encode(JSON.stringify(log, null, 2))
    const dest = await window.electronAPI.saveDebugAuto('aux_debug.json', Array.from(bytes))
    console.log('[DBG] saved to:', dest)
  } catch (e) {
    console.error('[DBG] saveAuxDebugLog error:', e)
  }
}

axrStopBtn.addEventListener('click', async () => {
  auxRecvModem.stopReceive()
  setAxrStatus('idle', 'IDLE')
  axrStat.textContent = '停止'
  axrStartBtn.disabled = false
  axrStopBtn.disabled = true
  await saveAuxDebugLog()
})

axrSaveBtn.addEventListener('click', async () => {
  const assembled = assemblePackets(auxrReceivedPackets)
  if (!assembled) { axrStat.textContent = 'エラー: パケット不完全'; return }
  const savePath = await window.electronAPI.showSaveDialog(auxrRecvFileName)
  if (!savePath) return
  await window.electronAPI.saveFile(savePath, assembled)
  axrStat.textContent = `保存完了: ${savePath}`
})
