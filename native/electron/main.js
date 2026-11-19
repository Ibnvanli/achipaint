const { app, BrowserWindow, Menu, protocol, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const ROOT = path.join(__dirname);
const SCHEME = 'achi';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.wasm':'application/wasm', '.myb':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png' };
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#141413',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadURL(`${SCHEME}://local/src/index.html`);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  return win;
}
/* ---------- 文件读写 ----------
 * 渲染进程把整份 .achi 的字节传过来，这里只负责选路径和落盘。
 * 写的时候先写 .tmp 再原子改名：中途断电不会留下半个文件把原文件顶掉。 */
ipcMain.handle('achi:save', async (event, bytes, suggestedName) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '保存画布',
    defaultPath: suggestedName,
    filters: [{ name: 'AchiPaint 画布', extensions: ['achi'] }],
  });
  if (canceled || !filePath) return null;

  const target = filePath.toLowerCase().endsWith('.achi') ? filePath : filePath + '.achi';
  const tmp = target + '.tmp';
  const buf = Buffer.from(bytes);
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, target);   // 原子替换
  return target;
});

ipcMain.handle('achi:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '打开画布',
    properties: ['openFile'],
    filters: [{ name: 'AchiPaint 画布', extensions: ['achi'] }],
  });
  if (canceled || !filePaths.length) return null;
  const buf = await fs.readFile(filePaths[0]);
  return {
    path: filePaths[0],
    name: path.basename(filePaths[0]),
    data: new Uint8Array(buf).buffer,
  };
});

app.whenReady().then(() => {
  protocol.handle(SCHEME, async (req) => {
    try {
      const rel = decodeURIComponent(new URL(req.url).pathname);
      const file = path.normalize(path.join(ROOT, rel));
      if (!file.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
      const data = await fs.readFile(file);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache, no-store, must-revalidate' } });
    } catch (e) { return new Response(String(e.message), { status: 404 }); }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'fileMenu' },
    { label: '编辑', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
