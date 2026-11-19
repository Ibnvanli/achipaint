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
  // 控制台由主进程建窗：IPC 触发的 window.open 不算用户手势，会被弹窗拦截
  openConsole: () => ipcRenderer.invoke('achi:open-console'),
});
