/* 开发者控制台的页签与筛选栏
 *
 * 规则：日志级别筛选（全部操作 / 警告 / 错误 / 外接扩展）只对「日志」页有意义。
 * 性能 / 文档 / 操作三页是结构化信息，不存在 level 概念，
 * 在那里显示筛选栏会让人误以为内容被筛掉了。
 *
 * 该用例在页面内以 iframe 加载真实的 devconsole.html，
 * 断言的是实际 DOM 状态，而不是对源码的文本推断。
 */

window.__t = {
  /* 加载控制台页面并等待其脚本初始化完成 */
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
        /* 脚本会把内容写进 #devconsole，内层出现 .dc-tab 即说明已初始化 */
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
};

const CASES = {
  /* 四个页签都必须存在 */
  '控制台保留四个页签': async ({ assert, assertEq }) => {
    const frame = await window.__t.mountConsole();
    try {
      const doc = frame.contentDocument;
      const tabs = [...doc.querySelectorAll('.dc-tab')].map(b => b.dataset.tab);
      assertEq(tabs.join(','), 'log,perf,doc,act', '页签应为 日志/性能/文档/操作');
    } finally {
      window.__t.unmount(frame);
    }
  },

  /* 日志页显示筛选栏 */
  '日志页显示筛选栏': async ({ assert, assertEq }) => {
    const frame = await window.__t.mountConsole();
    try {
      const doc = frame.contentDocument;
      const bar = doc.getElementById('dc-filters');
      assert(!!bar, '筛选栏应存在');
      assertEq(bar.hidden, false, '日志页筛选栏应可见');

      const items = [...doc.querySelectorAll('.dc-filter')].map(b => b.dataset.filter);
      assertEq(items.join(','), 'all,warn,error,ext', '筛选项应完整');
    } finally {
      window.__t.unmount(frame);
    }
  },

  /* 切到性能页，筛选栏必须收起 */
  '性能页隐藏筛选栏': async ({ assert, assertEq }) => {
    const frame = await window.__t.mountConsole();
    try {
      const doc = frame.contentDocument;
      const perfTab = doc.querySelector('.dc-tab[data-tab="perf"]');
      perfTab.click();
      const bar = doc.getElementById('dc-filters');
      assertEq(bar.hidden, true, '性能页筛选栏应隐藏');

      /* 性能面板必须显示，且不含筛选栏 */
      const pane = doc.getElementById('dc-pane-perf');
      assertEq(pane.hidden, false, '性能面板应显示');
    } finally {
      window.__t.unmount(frame);
    }
  },

  /* 文档页与操作页同样隐藏 */
  '文档与操作页隐藏筛选栏': async ({ assert, assertEq }) => {
    const frame = await window.__t.mountConsole();
    try {
      const doc = frame.contentDocument;
      const bar = doc.getElementById('dc-filters');

      doc.querySelector('.dc-tab[data-tab="doc"]').click();
      assertEq(bar.hidden, true, '文档页筛选栏应隐藏');
      assertEq(doc.getElementById('dc-pane-doc').hidden, false, '文档面板应显示');

      doc.querySelector('.dc-tab[data-tab="act"]').click();
      assertEq(bar.hidden, true, '操作页筛选栏应隐藏');
      assertEq(doc.getElementById('dc-pane-act').hidden, false, '操作面板应显示');
    } finally {
      window.__t.unmount(frame);
    }
  },

  /* 切回日志页，筛选栏必须重新出现 */
  '切回日志页筛选栏恢复': async ({ assert, assertEq }) => {
    const frame = await window.__t.mountConsole();
    try {
      const doc = frame.contentDocument;
      const bar = doc.getElementById('dc-filters');

      doc.querySelector('.dc-tab[data-tab="perf"]').click();
      assertEq(bar.hidden, true, '性能页应隐藏');

      doc.querySelector('.dc-tab[data-tab="log"]').click();
      assertEq(bar.hidden, false, '切回日志页应恢复显示');
      assertEq(doc.getElementById('dc-pane-log').hidden, false, '日志面板应显示');
    } finally {
      window.__t.unmount(frame);
    }
  },

  /* 筛选栏隐藏不能依赖 hidden 属性的默认样式 —— display:flex 会盖掉它 */
  '筛选栏 hidden 规则生效': async ({ assert }) => {
    const frame = await window.__t.mountConsole();
    try {
      const doc = frame.contentDocument;
      const bar = doc.getElementById('dc-filters');
      doc.querySelector('.dc-tab[data-tab="perf"]').click();

      /* 关键：即使 bar.hidden 为 true，若 CSS 未声明 [hidden]
       * 而 .dc-filters 又设了 display:flex，元素仍然可见。 */
      const style = frame.contentWindow.getComputedStyle(bar);
      assert(style.display === 'none',
        `.dc-filters[hidden] 应计算为 display:none，实际 ${style.display}`);
    } finally {
      window.__t.unmount(frame);
    }
  },
};
