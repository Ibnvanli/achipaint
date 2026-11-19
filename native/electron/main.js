const { app, BrowserWindow, Menu, protocol, shell } = require('electron');
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
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
  });
  win.loadURL(`${SCHEME}://local/src/welcome.html`);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  return win;
}
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
