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
/* ---------- 已授权路径表 ----------
 * 审计结论（audit/2026-11-20-audit.md 第 2.1 节）：achi:read / achi:delete 原先
 * 直接使用渲染进程传入的路径，渲染进程一旦被注入即可读写用户权限内的任意文件。
 *
 * 现在主进程只接受「用户亲自通过对话框选择或保存过」的路径。
 * 授权来源仅有两处：showOpenDialog 与 showSaveDialog 的返回结果。
 * 表格仅存在于内存，进程重启即清空 —— 这是有意为之：
 * 「最近文件」跨会话仍可用，是因为启动时通过 achi:open 重新选择过文件。
 */
const authorizedPaths = new Set();

/* 规范化后登记：同一文件经符号链接等不同写法访问时应视为同一路径。 */
function grantPath(p) {
  if (!p) return;
  try {
    authorizedPaths.add(fs.realpathSync.native(p));
  } catch {
    // 文件尚不存在（保存场景），退化为原样登记
    authorizedPaths.add(path.resolve(p));
  }
}

/* 校验：未授权路径一律拒绝，并在主进程留痕，便于排查异常调用。 */
function requireGranted(p, action) {
  let key;
  try {
    key = fs.realpathSync.native(p);
  } catch {
    key = path.resolve(p);
  }
  if (!authorizedPaths.has(key)) {
    console.warn(`[安全] 拒绝 ${action}：路径未获授权 ${p}`);
    throw new Error('该路径未经用户授权，请通过打开 / 保存对话框选择文件');
  }
  return key;
}

/* ---------- 文件读写 ----------
 * 渲染进程将整份 .achi 的字节传入，此处仅负责选择路径与写入磁盘。
 * 写入时先写 .tmp 再原子改名：中途断电不会残留不完整文件覆盖原文件。 */
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
  grantPath(target);              // 用户已通过对话框选定该路径
  return target;
});

/* 开发者控制台窗口。
 * 不依赖渲染进程的 window.open —— 该方式需要用户手势，
 * 由原生菜单或 IPC 触发时会被弹窗拦截器拒绝。 */
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

/* 重新授权最近文件。
 * 授权表只存在于内存，重启后为空。用户点击「最近文件」是一次明确的用户意图，
 * 但仍需显示确认对话框 —— 不能仅凭渲染进程传入的路径就放行，
 * 否则等于把授权表的作用抵消掉。 */
ipcMain.handle('achi:grant', async (event, filePath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (typeof filePath !== 'string' || !filePath) return false;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['取消', '允许'],
    defaultId: 1,
    cancelId: 0,
    title: '读取最近文件',
    message: '是否允许本次会话读取该文件？',
    detail: filePath,
  });
  if (response !== 1) return false;
  grantPath(filePath);
  return true;
});

/* 按路径直接读取：供启动页「最近文件」使用。
 * 仅允许读取本次会话中用户已授权的路径。 */
ipcMain.handle('achi:read', async (event, filePath) => {
  const safe = requireGranted(filePath, '读取');
  const buf = await fs.readFile(safe);
  return { path: safe, name: path.basename(safe), data: new Uint8Array(buf).buffer };
});

/* 仅在用户明确选择「连同文件一并删除」时才会执行此处。
 * 删除属破坏性操作，同样要求路径已获授权。 */
ipcMain.handle('achi:delete', async (event, filePath) => {
  const safe = requireGranted(filePath, '删除');
  await fs.unlink(safe);
  authorizedPaths.delete(safe);   // 文件已删除，撤销授权
  return true;
});

ipcMain.handle('achi:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '打开画布',
    properties: ['openFile'],
    /* 第一个 filter 为对话框默认选中项。
     * 原实现中第一项仅含 .achi，导致图片选项呈灰色不可选，用户会误认为「无法导入」。
     * 现将 .achi 与图片类型合并至同一 filter，两类文件均可直接选择。 */
    filters: [
      { name: 'AchiPaint 画布与图片', extensions: ['achi', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (canceled || !filePaths.length) return null;
  grantPath(filePaths[0]);        // 用户已通过对话框选定该路径
  const buf = await fs.readFile(filePaths[0]);
  return {
    path: filePaths[0],
    name: path.basename(filePaths[0]),
    data: new Uint8Array(buf).buffer,
  };
});

/* 每个菜单项对应渲染进程的一个命令 id（见 src/ui/menubar.js 的 COMMANDS）。
 * 修改此处须同步更新该表，否则点击将无响应。
 *
 * 注意：⌘Z / ⌘S / ⌘O 一旦绑定到菜单，页面将无法再收到这些按键事件，
 * 因此必须真正转发对应命令，不能仅作占位。 */
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
        // 不绑定 Esc：绑定后会全局拦截该键，页面中的「取消选区 / 退出蒙版」将失效
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

/* 「关于」面板。macOS 原生实现仅显示名称 / 版本 / 版权，
 * credits 区域可说明所依赖的组件与协议，这是开源项目应当明示的内容。 */
app.setAboutPanelOptions({
  applicationName: 'AchiPaint',
  // 短版本显示于名称下方，构建号置于括号内 —— 两者不可设为同一值，否则会重复显示
  applicationVersion: app.getVersion(),
  version: '1',
  copyright: 'Copyright © 2026 Moalcaswes · MIT',
  /* credits 区域高度仅为三行，内容过多时 macOS 会插入滚动条。
   * 完整清单见 NOTICE 与 third-party/，此处仅列出关键项。 */
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
