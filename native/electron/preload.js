/* 仅暴露文件读写能力。
 * contextIsolation 已启用，渲染进程无法获取 require / fs，也无法访问其他 Node 能力。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('achiFile', {
  save: (bytes, suggestedName) => ipcRenderer.invoke('achi:save', bytes, suggestedName),
  open: () => ipcRenderer.invoke('achi:open'),
  read: (filePath) => ipcRenderer.invoke('achi:read', filePath),
  // 请求为某个路径授权（主进程会弹确认框）。用于「最近文件」这类跨会话路径。
  grant: (filePath) => ipcRenderer.invoke('achi:grant', filePath),
  remove: (filePath) => ipcRenderer.invoke('achi:delete', filePath),
  // 由原生菜单触发的命令
  onMenu: (cb) => ipcRenderer.on('achi:menu', (_e, id) => cb(id)),
  // 控制台窗口由主进程创建：IPC 触发的 window.open 不被视为用户手势，会被弹窗拦截
  openConsole: () => ipcRenderer.invoke('achi:open-console'),
});
