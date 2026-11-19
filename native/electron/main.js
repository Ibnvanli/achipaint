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

/* 开发者控制台窗口。
 * 不靠渲染进程的 window.open —— 那条路需要用户手势，
 * 从原生菜单/IPC 触发时会被弹窗拦截器拒掉。 */
let consoleWin = null;
ipcMain.handle('achi:open-console', async () => {
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.show();
    consoleWin.focus();
    return true;
  }
  consoleWin = new BrowserWindow({
    width: 600,
    height: 560,
    minWidth: 420,
    minHeight: 320,
    title: 'AchiPaint 控制台',
    backgroundColor: '#101010',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  consoleWin.loadURL(`${SCHEME}://local/src/devconsole.html`);
  consoleWin.on('closed', () => { consoleWin = null; });
  return true;
});

/* 按路径直读：给启动页的「最近」用 */
ipcMain.handle('achi:read', async (event, filePath) => {
  const buf = await fs.readFile(filePath);
  return { path: filePath, name: path.basename(filePath), data: new Uint8Array(buf).buffer };
});

/* 只在用户明确选「连文件一起删」时才会走到这里 */
ipcMain.handle('achi:delete', async (event, filePath) => {
  await fs.unlink(filePath);
  return true;
});

ipcMain.handle('achi:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '打开画布',
    properties: ['openFile'],
    /* 第一个 filter 是对话框默认选中的那个。
     * 原来第一个只有 achi，结果图片全是灰的、根本点不了 —— 用户以为「导入不了」。
     * 现在把 .achi 和图片放进同一个 filter，两类文件都能直接选。 */
    filters: [
      { name: 'AchiPaint 画布与图片', extensions: ['achi', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (canceled || !filePaths.length) return null;
  const buf = await fs.readFile(filePaths[0]);
  return {
    path: filePaths[0],
    name: path.basename(filePaths[0]),
    data: new Uint8Array(buf).buffer,
  };
});

/* 菜单项都对应渲染进程的一个命令 id（见 src/ui/menubar.js 的 COMMANDS）。
 * 改这里记得同步那张表，否则点了没反应。
 *
 * 注意：⌘Z / ⌘S / ⌘O 一旦绑到菜单，页面就再也收不到这些键 ——
 * 所以必须真的把命令转发下去，不能只摆个占位。 */
function buildMenuTemplate() {
  const send = id => () => {
    const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (w) w.webContents.send('achi:menu', id);
  };

  return [
    {
      label: 'AchiPaint',
      submenu: [
        { role: 'about', label: '关于 AchiPaint' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 AchiPaint' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 AchiPaint' },
      ],
    },
    {
      label: '文件',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: send('file:new') },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: send('file:open') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: send('file:save') },
        { label: '另存为…', accelerator: 'Shift+CmdOrCtrl+S', click: send('file:saveAs') },
        { type: 'separator' },
        { label: '导出 PNG…', accelerator: 'Shift+CmdOrCtrl+E', click: send('file:export') },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: send('edit:undo') },
        { label: '重做', accelerator: 'Shift+CmdOrCtrl+Z', click: send('edit:redo') },
        { type: 'separator' },
        // 不绑 Esc：绑了会全局吃掉这个键，页面里的「取消选区 / 退出蒙版」就失效
        { label: '取消选区', click: send('edit:clearSel') },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '参考图窗', accelerator: 'Shift+CmdOrCtrl+O', click: send('view:reference') },
        { type: 'separator' },
        { label: '适应窗口', accelerator: 'CmdOrCtrl+0', click: send('view:fit') },
        { label: '实际大小', accelerator: 'CmdOrCtrl+1', click: send('view:100') },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: send('view:in') },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: send('view:out') },
        { type: 'separator' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏' },
      ],
    },
    {
      label: '调试',
      submenu: [
        { label: '开发者控制台', accelerator: 'Shift+CmdOrCtrl+D', click: send('view:console') },
        { label: '重新加载界面', accelerator: 'Shift+CmdOrCtrl+R', click: send('debug:reload') },
        { type: 'separator' },
        { label: '强制全量重绘', click: send('debug:markAll') },
        { label: '测试：导入一张图', click: send('debug:testImage') },
        { label: '测试：保存解析往返', click: send('debug:testRoundtrip') },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
      ],
    },
  ];
}

/* 「关于」面板。macOS 原生的那一套只显示名称/版本/版权，
 * credits 这块可以写清楚用了什么、什么协议 —— 开源项目该写明的东西。 */
app.setAboutPanelOptions({
  applicationName: 'AchiPaint',
  // 短版本显示在名字下面，构建号显示在括号里 —— 两个别设成同一个，会重复
  applicationVersion: app.getVersion(),
  version: '1',
  copyright: 'Copyright © 2026 Moalcaswes · MIT',
  /* credits 区域只有三行高，写多了 macOS 会塞一条滚动条进去。
   * 详细清单在 NOTICE / third-party/ 里，这里只点出最关键的。 */
  credits:
    '笔刷 hokusai · libmypaint（MIT / Apache-2.0）\n'
    + '运行时 Electron / Chromium（MIT）\n'
    + '完整许可见 NOTICE',
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
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
