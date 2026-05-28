import { drawFrame, drawCalibrationFrame } from '../modes/hdmi/pixel-encoder.js'

const canvas = document.getElementById('display-canvas')
const overlay = document.getElementById('overlay')

let _frameCount = 0
window.electronAPI.onHdmiFrame((msg) => {
  overlay.style.display = 'none'
  const { type, frameIdx, dataTotal, parityCount, payload, pixelSize, payloadLenOverride } = msg
  _frameCount++
  document.title = `HDMI [${_frameCount}] ${type} ${frameIdx ?? ''}`
  console.log('[hdmi-display] msg', type, frameIdx, 'total msgCount', _frameCount)

  if (type === 'calibrate') {
    drawCalibrationFrame(canvas, pixelSize)
    return
  }

  if (type === 'frame') {
    drawFrame(canvas, frameIdx, dataTotal, parityCount, new Uint8Array(payload), pixelSize, payloadLenOverride)
    return
  }

  if (type === 'blank') {
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    overlay.style.display = 'flex'
    overlay.textContent = `SHADOW COM — HDMI OUTPUT — WAITING (${_frameCount} msgs received)`
  }
})

// F key = toggle fullscreen
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen()
    else canvas.requestFullscreen()
  }
})
