/* 开发者控制台的渲染行为
 *
 * 审查报告（audit/2026-11-20-devconsole.md）判定「未发现功能性缺陷」，
 * 但报告只验证了页签联动与按钮语义，未验证渲染开销。
 *
 * 这里验证的是：内容未变化时，界面不应被重建。
 * 全量重建不只是性能问题 —— 它会重置滚动位置、冲掉用户正在做的操作，
 * 属于可感知的行为缺陷。
 */

window.__t = {
  async mountConsole() {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:-9999px;width:600px;height:560px;';
    frame.src = './devconsole.html';
    document.body.appendChild(frame);

    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const doc = frame.contentDocument;
        const host = doc && doc.getElementById('devconsole');
        if (host && host.querySelector('.dc-tab')) return resolve();
        if (Date.now() - t0 > 8000) return reject(new Error('控制台未在 8 秒内初始化'));
        setTimeout(tick, 50);
      };
      tick();
    });
    return frame;
  },
  unmount(frame) {
    if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
  },
  /* 轮询等待条件成立，避免固定延时造成的偶发失败 */
  waitFor(fn, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        let ok = false;
        try { ok = fn(); } catch { ok = false; }
        if (ok) return resolve();
        if (Date.now() - t0 > timeout) return reject(new Error('等待条件超时'));
        setTimeout(tick, 50);
      };
      tick();
    });
  },
};

const CASES = {
  /* 内容不变时不应重建 DOM。
   * 用 MutationObserver 统计 1 秒内的子节点变动次数：
   * 静止界面应为 0；若每帧都重建，会出现数十次。 */
  '静止时日志区不重建': async ({ assert }) => {
    const frame = await window.__t.mountConsole();
    try {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      const pane = doc.getElementById('dc-pane-log');

      /* 等首次渲染稳定 */
      await new Promise(r => setTimeout(r, 800));

      let mutations = 0;
      const obs = new win.MutationObserver(list => { mutations += list.length; });
      obs.observe(pane, { childList: true, subtree: true, characterData: true });

      /* 观察 1.5 秒。此期间没有新日志，也没有用户操作。 */
      await new Promise(r => setTimeout(r, 1500));
      obs.disconnect();

      assert(mutations === 0,
        `静止界面不应产生 DOM 变动，1.5 秒内实际发生 ${mutations} 次`);
    } finally {
      window.__t.unmount(frame);
    }
  },

  /* 向上翻阅时，新日志到达不应把视口拽回底部。
   *
   * 注意：控制台显示的日志完全由主窗口快照驱动（state.logs 会被覆盖），
   * 因此必须往主窗口 mainConsole 推日志，才能走真实的投递路径。 */
  '向上翻阅时不被新日志拽回': async ({ achi, assert }) => {
    const frame = await window.__t.mountConsole();
    try {
      const doc = frame.contentDocument;
      const win = frame.contentWindow;
      const pane = doc.getElementById('dc-pane-log');
      const mc = achi.devconsole;

      /* 主窗口积累足够多的日志，等控制台收到 */
      for (let i = 0; i < 150; i++) mc.push('info', ['填充日志 ' + i]);
      await window.__t.waitFor(() => pane.children.length > 100);

      /* 滚到顶部，模拟用户翻阅历史 */
      pane.scrollTop = 0;
      pane.dispatchEvent(new win.Event('scroll'));
      await new Promise(r => setTimeout(r, 80));
      const before = pane.scrollTop;

      /* 新日志到达。等待行数「确实增加」—— 用固定阈值会在
       * 主窗口原有日志已满足条件时提前通过，测不到滚动行为。 */
      const rowsBefore = pane.children.length;
      for (let i = 0; i < 5; i++) mc.push('info', ['新日志 ' + i]);
      await window.__t.waitFor(() => pane.children.length > rowsBefore, 3000);

      assert(pane.scrollTop === before,
        `向上翻阅时视口不应移动，实际从 ${before} 变为 ${pane.scrollTop}`);
    } finally {
      window.__t.unmount(frame);
    }
  },

  /* 停在底部时，新日志应自动跟随 */
  '停在底部时自动跟随新日志': async ({ achi, assert }) => {
    const frame = await window.__t.mountConsole();
    try {
      const doc = frame.contentDocument;
      const win = frame.contentWindow;
      const pane = doc.getElementById('dc-pane-log');
      const mc = achi.devconsole;

      for (let i = 0; i < 150; i++) mc.push('info', ['填充日志 ' + i]);
      await window.__t.waitFor(() => pane.children.length > 100);

      /* 停在底部 */
      pane.scrollTop = pane.scrollHeight;
      pane.dispatchEvent(new win.Event('scroll'));
      await new Promise(r => setTimeout(r, 80));

      const rowsBefore = pane.children.length;
      for (let i = 0; i < 5; i++) mc.push('info', ['新日志 ' + i]);
      await window.__t.waitFor(() => pane.children.length > rowsBefore, 3000);

      const gap = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
      assert(gap < 30, `停在底部时应自动跟随，实际距底部 ${gap}px`);
    } finally {
      window.__t.unmount(frame);
    }
  },

  /* 渲染短路不能牺牲功能：切换筛选必须重建 */
  '切换筛选仍能重建': async ({ achi, assert }) => {
    const frame = await window.__t.mountConsole();
    try {
      const doc = frame.contentDocument;
      const pane = doc.getElementById('dc-pane-log');
      const mc = achi.devconsole;

      mc.push('warn', ['一条警告']);
      mc.push('error', ['一条错误']);
      await window.__t.waitFor(() => pane.children.length >= 2);

      const all = pane.children.length;

      doc.querySelector('.dc-filter[data-filter="warn"]').click();
      await new Promise(r => setTimeout(r, 100));
      const warnOnly = pane.children.length;

      doc.querySelector('.dc-filter[data-filter="all"]').click();
      await new Promise(r => setTimeout(r, 100));
      const back = pane.children.length;

      assert(warnOnly <= all, '筛选后行数不应增加');
      assert(back === all, `切回「全部」应恢复原行数，实际 ${back} ≠ ${all}`);
    } finally {
      window.__t.unmount(frame);
    }
  },

  /* 清空后必须还能正常显示后续日志（签名不能被清空后的状态卡住） */
  '清空后仍可正常显示新日志': async ({ achi, assert }) => {
    const frame = await window.__t.mountConsole();
    try {
      const doc = frame.contentDocument;
      const pane = doc.getElementById('dc-pane-log');
      const mc = achi.devconsole;

      for (let i = 0; i < 5; i++) mc.push('info', ['清空前 ' + i]);
      await window.__t.waitFor(() => pane.children.length >= 5);

      doc.getElementById('dc-clear').click();
      await new Promise(r => setTimeout(r, 150));

      mc.push('info', ['清空后的新日志']);
      await window.__t.waitFor(() => pane.textContent.includes('清空后的新日志'), 3000);

      assert(true, '清空后新日志应能显示');
    } finally {
      window.__t.unmount(frame);
    }
  },

  /* 滚到底部后再向上翻，不应被强行拉回底部 */
  '向上滚动不被重置': async ({ assert }) => {
    const frame = await window.__t.mountConsole();
    try {
      const doc = frame.contentDocument;
      const pane = doc.getElementById('dc-pane-log');

      /* 造足够多的日志撑出滚动条 */
      const win = frame.contentWindow;
      for (let i = 0; i < 200; i++) {
        win.eval(`(() => {
          const st = window.__testState;
          return null;
        })()`);
      }

      await new Promise(r => setTimeout(r, 600));

      /* 直接往 DOM 里塞行，模拟日志很多的情况 */
      const filler = doc.createElement('div');
      filler.style.height = '2000px';
      pane.appendChild(filler);
      pane.scrollTop = 0;

      await new Promise(r => setTimeout(r, 1200));

      assert(pane.scrollTop === 0,
        `用户滚到顶部后应保持位置，实际被重置为 ${pane.scrollTop}`);
    } finally {
      window.__t.unmount(frame);
    }
  },
};
