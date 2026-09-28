import { ipcRenderer } from 'electron'

ipcRenderer.on('desktop:splash:status', (_event, text: string) => {
  const status = document.getElementById('status')
  if (status !== null) status.textContent = text
})
