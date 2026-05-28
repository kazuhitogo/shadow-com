import { app, BrowserWindow, ipcMain, dialog, screen, systemPreferences } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'

let mainWin = null
let hdmiWin = null

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1100,
    height: 750,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  if (process.env.NODE_ENV === 'development') {
    mainWin.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWin.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWin.on('closed', () => {
    mainWin = null
    if (hdmiWin && !hdmiWin.isDestroyed()) hdmiWin.close()
  })
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('camera')
  }
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─── File I/O ────────────────────────────────────────────────────────────────

ipcMain.handle('show-open-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile'] })
  return canceled ? null : filePaths[0]
})

ipcMain.handle('read-file', async (_e, filePath) => {
  const buf = await readFile(filePath)
  return { name: filePath.split('/').pop(), data: new Uint8Array(buf) }
})

ipcMain.handle('show-save-dialog', async (_e, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: defaultName })
  return canceled ? null : filePath
})

ipcMain.handle('save-file', async (_e, filePath, data) => {
  await writeFile(filePath, Buffer.from(data))
})

ipcMain.handle('save-debug-auto', async (_e, filename, data) => {
  const logsDir = join(app.getAppPath(), 'logs')
  await mkdir(logsDir, { recursive: true })
  const dest = join(logsDir, filename)
  await writeFile(dest, Buffer.from(data))
  return dest
})

// ─── HDMI secondary window ───────────────────────────────────────────────────

ipcMain.handle('hdmi-get-displays', () => {
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `${d.label || `Display ${i + 1}`} — ${d.size.width}×${d.size.height}${d.internal ? ' (内蔵)' : ' (外部)'}`,
    bounds: d.bounds,
    internal: d.internal,
  }))
})

ipcMain.handle('hdmi-open-window', async (_e, displayId) => {
  if (hdmiWin && !hdmiWin.isDestroyed()) {
    hdmiWin.focus()
    return
  }

  const displays = screen.getAllDisplays()
  const target = displays.find((d) => String(d.id) === String(displayId))
  if (!target) throw new Error(`displayId ${displayId} not found in [${displays.map((d) => d.id).join(',')}]`)

  const win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  hdmiWin = win
  win.on('closed', () => {
    if (hdmiWin === win) hdmiWin = null
    if (!_hdmiClosingByIPC && mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('hdmi-win-closed')
    }
    _hdmiClosingByIPC = false
  })

  if (process.env.NODE_ENV === 'development') {
    await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/hdmi-display.html`)
  } else {
    await win.loadFile(join(__dirname, '../renderer/hdmi-display.html'))
  }

  if (win.isDestroyed()) return

  win.setBounds(target.bounds)
  if (process.platform === 'darwin') {
    win.setSimpleFullScreen(true)
  } else {
    win.setFullScreen(true)
  }
})

ipcMain.handle('hdmi-send-frame', (_e, msg) => {
  if (hdmiWin && !hdmiWin.isDestroyed()) {
    hdmiWin.webContents.send('hdmi-frame', msg)
  }
})

let _hdmiClosingByIPC = false
ipcMain.handle('hdmi-close-window', () => {
  if (hdmiWin && !hdmiWin.isDestroyed()) {
    _hdmiClosingByIPC = true
    hdmiWin.close()
  }
  hdmiWin = null
})
