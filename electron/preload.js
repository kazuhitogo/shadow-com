import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // File I/O
  showOpenDialog: () => ipcRenderer.invoke('show-open-dialog'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  showSaveDialog: (name) => ipcRenderer.invoke('show-save-dialog', name),
  saveFile: (filePath, data) => ipcRenderer.invoke('save-file', filePath, data),
  saveDebugAuto: (filename, data) => ipcRenderer.invoke('save-debug-auto', filename, data),

  // HDMI secondary window
  hdmi: {
    getDisplays: () => ipcRenderer.invoke('hdmi-get-displays'),
    openWindow: (displayId) => ipcRenderer.invoke('hdmi-open-window', displayId),
    closeWindow: () => ipcRenderer.invoke('hdmi-close-window'),
    sendFrame: (msg) => ipcRenderer.invoke('hdmi-send-frame', msg),
  },

  // Receive HDMI frame commands (used by hdmi-display.html)
  onHdmiFrame: (cb) => ipcRenderer.on('hdmi-frame', (_e, msg) => cb(msg)),
  // Notified when secondary window is closed externally
  onHdmiWinClosed: (cb) => ipcRenderer.on('hdmi-win-closed', (_e) => cb()),
})
