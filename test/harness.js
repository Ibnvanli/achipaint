/* 测试运行器
 *
 * 用途：在真实 Chromium 渲染环境下加载 src/index.html，执行测试文件中的用例。
 * 之所以不使用 jsdom：本项目的断言对象是**合成层**（doc.off）与真实 Canvas 像素，
 * jsdom 没有实现 Canvas 2D，用它测试等于测试了一个假的实现。
 *
 * 启动：electron test/harness.js
 * 退出码：0 表示全部通过，1 表示存在失败。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(__dirname, 'cases');

/* 收集用例文件：test/cases/*.test.js */
const caseFiles = fs.existsSync(TEST_DIR)
  ? fs.readdirSync(TEST_DIR).filter(f => f.endsWith('.test.js')).sort()
  : [];

if (caseFiles.length === 0) {
  console.error('未找到测试用例：test/cases/*.test.js');
  process.exit(1);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,                 // 不入屏，但仍会正常执行渲染
    webPreferences: {
      offscreen: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('  [页面]', message);
  });

  const target = `file://${path.join(ROOT, 'src', 'index.html')}?w=800&h=600`;
  await win.loadURL(target);

  /* 等待应用完成装配。index.html 会在 DOMContentLoaded 后初始化，
   * 这里轮询 window.__achi 是否已挂载，避免用固定延时产生偶发失败。 */
  const ready = await win.webContents.executeJavaScript(`
    new Promise(resolve => {
      const t0 = Date.now();
      const tick = () => {
        if (window.__achi && window.__achi.doc) return resolve(true);
        if (Date.now() - t0 > 15000) return resolve(false);
        setTimeout(tick, 50);
      };
      tick();
    })
  `);

  if (!ready) {
    console.error('应用未在 15 秒内完成初始化');
    app.exit(1);
    return;
  }

  let passed = 0;
  const failures = [];

  for (const file of caseFiles) {
    const src = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');

    /* 用例文件必须在**页面上下文**中求值：
     * 它们要访问 window、document 与 Canvas，主进程里没有这些。 */
    let names;
    try {
      names = await win.webContents.executeJavaScript(`
        (() => {
          /* 每个用例文件拥有独立的辅助对象命名空间，
           * 避免上一个文件留下的 window.__t 被下一个文件误用。 */
          window.__t = undefined;
          const mod = (() => { ${src}\n; return CASES; })();
          window.__cases = mod;
          return Object.keys(mod);
        })()
      `);
    } catch (e) {
      failures.push({ file, name: '(加载)', error: e.message });
      console.log(`  ✗ ${file} › (加载)  ${e.message}`);
      continue;
    }

    for (const name of names) {
      const label = `${file} › ${name}`;
      try {
        await win.webContents.executeJavaScript(`
          (async () => {
            const __fn = window.__cases[${JSON.stringify(name)}];
            const __ctx = {
              achi: window.__achi,
              assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); },
              assertEq(a, b, msg) {
                if (a !== b) throw new Error((msg || '不相等') + '：' + a + ' ≠ ' + b);
              },
            };

            /* 每个用例开始前复位到干净文档。
             * 用例之间共享同一个应用实例，若不复位，前一个用例留下的
             * 图层、撤销栈与像素会污染后一个用例 —— 表现为「单独跑通过、
             * 连跑失败」这种最难排查的偶发问题。 */
            window.__achi.newDocument(800, 600);
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

            await __fn(__ctx);
            return true;
          })()
        `);
        passed++;
        console.log(`  ✓ ${label}`);
      } catch (e) {
        failures.push({ file, name, error: e.message });
        console.log(`  ✗ ${label}`);
        console.log(`      ${e.message}`);
      }
    }
  }

  console.log('');
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  app.exit(failures.length === 0 ? 0 : 1);
});
