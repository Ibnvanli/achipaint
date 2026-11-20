/* 事件总线：插件只能监听，不能拦截笔迹
 *
 * 关键设计：emit 不 await、不返回结果、不传播异常。
 * 任何插件拖慢笔刷热路径或抛出异常，均不得影响绘制。
 */
export class Bus {
  constructor() { this.map = new Map(); }

  on(evt, fn) {
    if (!this.map.has(evt)) this.map.set(evt, new Set());
    this.map.get(evt).add(fn);
    return () => this.map.get(evt).delete(fn);
  }

  // 单向广播：不等待、不收集结果、捕获全部异常
  emit(evt, payload) {
    const set = this.map.get(evt);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (e) { console.warn('[bus] 插件事件出错:', evt, e); }
    }
  }
}

/* 插件注册表：仅暴露边缘能力，不提供核心钩子 */
export class PluginHost {
  constructor(bus) {
    this.bus = bus;
    this.plugins = [];
    this.exporters = new Map();
    this.panels = [];
    this.filters = [];
  }

  /* 插件声明接口：
   * { id, name, exporters?, panels?, filters?, setup?(api) }
   */
  register(p) {
    if (!p || !p.id) throw new Error('插件必须有 id');
    this.plugins.push(p);
    (p.exporters || []).forEach(e => this.exporters.set(e.id, e));
    (p.panels || []).forEach(panel => this.panels.push(panel));
    (p.filters || []).forEach(f => this.filters.push(f));
    if (typeof p.setup === 'function') {
      try {
        p.setup({
          bus: this.bus,
          addExporter: e => this.exporters.set(e.id, e),
          addPanel: panel => this.panels.push(panel),
          addFilter: f => this.filters.push(f),
        });
      } catch (e) { console.warn('[plugin] setup 失败:', p.id, e); }
    }
    return p;
  }
}
