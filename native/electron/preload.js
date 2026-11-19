/* 只暴露文件读写这一件事。
 * contextIsolation 开着，渲染进程拿不到 require / fs，也拿不到别的 Node 能力。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('achiFile', {
  save: (bytes, suggestedName) => ipcRenderer.invoke('achi:save', bytes, suggestedName),
  open: () => ipcRenderer.invoke('achi:open'),
  read: (filePath) => ipcRenderer.invoke('achi:read', filePath),
  remove: (filePath) => ipcRenderer.invoke('achi:delete', filePath),
  // 原生菜单点下来的命令
  onMenu: (cb) => ipcRenderer.on('achi:menu', (_e, id) => cb(id)),
});
