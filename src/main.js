/* 装配：将核心、UI 与插件连接起来
 * 热路径（pointer → stroke → composite）全部同步执行，中间不 await，也不经过插件。
 */
import { Doc, TILE } from './core/canvas.js';
import { Brush, Stroke } from './core/brush.js';
import { HokusaiEngine } from './core/hokusai-engine.js';
import { History } from './core/history.js';
import { Bus, PluginHost } from './core/bus.js';
import { DEFAULT_SWATCHES } from './core/color.js';
import { Slider } from './ui/widgets.js';
import { ColorPicker } from './ui/colorpicker.js';
import { Splash, pushRecent, removeRecent } from './ui/splash.js';
import { MenuBar } from './ui/menubar.js';
import { VERSION } from './version.js';
import { serialize, parse, AchiFileError } from './core/format.js';
import { saveFile, openFile, openByPath, canOpenByPath, deleteFile } from './platform/fileio.js';
import pngExporter from './plugins/export-png.js';

const $ = id => document.getElementById(id);

/* 在 Electron 壳中为自绘标题栏让出窗口控制按钮的位置，并将其设为可拖动区域。
 * 浏览器环境中不存在该类，因此网页版布局不受任何影响。 */
if (/\.Electron/i.test(navigator.userAgent) || navigator.userAgent.includes('Electron')) {
  document.documentElement.classList.add('electron');
}

/* ---------- 状态 ---------- */
/* 尺寸由启动页传入：index.html?w=2480&h=3508。
 * 未传参数时回退至 A4@300dpi，保证直接打开 index.html 仍可正常使用。 */
const qs = new URLSearchParams(location.search);
/* URL 中带尺寸时直接进入画布（跳过启动浮层），否则先显示启动浮层 */
const HAS_SIZE = qs.has('w') && qs.has('h');
const DW = Math.max(64, Math.min(12000, parseInt(qs.get('w'), 10) || 2480));
const DH = Math.max(64, Math.min(12000, parseInt(qs.get('h'), 10) || 3508));
let doc = new Doc(DW, DH);
const brush = new Brush();
const history = new History();
const bus = new Bus();
const host = new PluginHost(bus);
host.register(pngExporter);

let docName = '未命名';
let tool = 'brush';
let stroke = null;
let pending = null;

/* hokusai 外置笔刷引擎。未载入完成或载入失败时统一回退至内置 Stroke，
 * 确保「无法绘制线条」这一问题不会因更换引擎而重新出现。 */
const hk = new HokusaiEngine(doc);
const HOKUSAI_PRESETS = {
  brush: '基础',
  calligraphy: '书法',
  charcoal: '炭笔',
  marker_fat: '粗马克',
};

/* ---------- 视图 ---------- */
const view = $('view');
// desynchronized：使浏览器跳过部分合成同步，显著降低笔迹上屏延迟。
// 代价是极端情况下可能出现画面撕裂；对绘画场景而言，延迟比撕裂更不可接受。
const vctx = view.getContext('2d', { desynchronized: true, alpha: false });
view.style.touchAction = 'none';   // 防止触屏/笔被当作滚动手势
/* 上限 2 在 Retina 上意味着视口画布为 2200×1650 物理像素，
 * 每帧需将整块作为图层内容交由系统合成。WKWebView 在此场景明显劣化
 * （实测帧率 37fps，Chromium 同尺寸可达 60fps）。降至 1.5 换取帧率，肉眼几乎无差别。
 */
/* 上限 2 在 Retina 上意味着视口画布为 2200×1650 物理像素，
 * 每帧需将整块交由系统合成 —— 实测帧间隔 21.4ms（47fps），
 * 低于 60fps 即表现为输入滞后。降至 1.5 换取帧率，肉眼几乎无差别。 */
let dpr = Math.min(window.devicePixelRatio || 1, 1.5);

function resize() {
  const r = $('stage').getBoundingClientRect();
  view.width = r.width * dpr;
  view.height = r.height * dpr;
  view.style.width = r.width + 'px';
  view.style.height = r.height + 'px';
  redraw();
}

/* ---------- 渲染：每帧一次，仅搬运离屏缓冲 ---------- */
let rafId = 0;
let needFrame = false;
/* 使用「是否存在挂起帧」的布尔量进行去重，而非依赖 rafId 是否为 0。
 * WKWebView 在页面刚加载完成、窗口尚未实际上屏时会丢弃已排队的 rAF 回调；
 * 若此时以 rafId 作为锁，该锁将永远无法释放 —— 此后每次 requestPaint 都直接返回，
 * 画面不再更新。真机表现为「可以绘制但画面不刷新」。 */
let framePending = false;
let frameQueuedAt = 0;

/* 透明背景的棋盘格。按 8px 一格生成一张小图再平铺，开销低于每帧绘制数千个矩形。 */
let _checker = null;
function checkerPattern(ctx) {
  if (_checker) return _checker;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#e4e4e4';
  g.fillRect(0, 0, 8, 8);
  g.fillRect(8, 8, 8, 8);
  _checker = ctx.createPattern(c, 'repeat');
  return _checker;
}

/* 性能探针：记录每帧合成耗时，以及「最近一次指针事件到该帧绘制完成」的间隔。
 *
 * 数据供开发者控制台的「性能」页使用，因此默认开启。
 * 记录本身是每帧一次的对象分配 + 一次数组 push，开销可忽略；
 * 真正的成本在读取侧（getImageData 之类），不在这里。
 *
 * 此处曾写成 `if (!window.__achiPerf) return;` —— 而 window.__achiPerf 正是在
 * 函数末尾才被赋值的，于是第一次调用即返回，之后再无调用能通过该判断：
 * 探针从未记录过任何一帧，控制台性能页全部显示 null。
 * 开关改为独立的布尔量，避免「用输出判断是否要记录」这种自锁。 */
const perfSamples = [];
let perfEnabled = true;
let lastPointerAt = 0;
let lastPaintAt = 0;

function perfMark() {
  if (!perfEnabled) return;
  const now = performance.now();
  const rec = { frame: 0, inputLag: 0, gap: 0 };
  if (perfMark._t0) rec.frame = now - perfMark._t0;
  if (lastPointerAt) rec.inputLag = now - lastPointerAt;
  if (lastPaintAt) rec.gap = now - lastPaintAt;
  lastPaintAt = now;
  perfSamples.push(rec);
  if (perfSamples.length > 300) perfSamples.shift();
}

/* 对外暴露：window.__achiPerf 为样本数组（只读用途），
 * 关闭记录用 window.__achiPerfOff = true。 */
Object.defineProperty(window, '__achiPerf', {
  get: () => perfSamples,
  configurable: true,
});
Object.defineProperty(window, '__achiPerfOff', {
  get: () => !perfEnabled,
  set: v => { perfEnabled = !v; },
  configurable: true,
});

function paint() {
  rafId = 0;
  needFrame = false;
  framePending = false;
  perfMark._t0 = performance.now();

  /* 先将本帧累积的笔迹搬入覆盖层，再执行合成。
   * 顺序不可颠倒：flushDirty 需要读取 overlay。 */
  if (hk.active) hk.flush();

  // 先将脏块合成进离屏缓冲（仅处理发生变化的块）
  doc.collectDirty();
  doc.flushDirty();

  const r = $('stage').getBoundingClientRect();
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  // alpha:false 的画布不可使用 clearRect（会残留黑色），改为填充背景色
  vctx.fillStyle = '#14161a';
  vctx.fillRect(0, 0, view.width, view.height);
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const { x, y, zoom } = doc.view;

  /* 关键优化：仅绘制视口内可见的源区域。
   * 原实现为 vctx.drawImage(doc.off, 0, 0) —— 每帧将整张 2480×3508
   * 缓冲（870 万像素）完整缩放一次，性能无法承受，导致输入响应变差。
   * 现改为计算视口在文档坐标中的矩形，仅绘制该区域。
   */
  const r2 = $('stage').getBoundingClientRect();
  const viewLeft = -x / zoom;            // 视口左上角在文档里的坐标
  const viewTop = -y / zoom;
  const viewW = r2.width / zoom;
  const viewH = r2.height / zoom;

  // 与文档范围求交，并保留 1px 余量以避免边缘缝隙
  const sx = Math.max(0, Math.floor(viewLeft) - 1);
  const sy = Math.max(0, Math.floor(viewTop) - 1);
  const ex = Math.min(doc.w, Math.ceil(viewLeft + viewW) + 1);
  const ey = Math.min(doc.h, Math.ceil(viewTop + viewH) + 1);

  if (ex > sx && ey > sy) {
    vctx.translate(x, y);
    vctx.scale(zoom, zoom);

    // 纸底仅绘制可见区域。透明背景平铺棋盘格，否则填充白色。
    if (doc.background === 'transparent') {
      const pat = checkerPattern(vctx);
      vctx.fillStyle = pat || '#ffffff';
    } else {
      vctx.fillStyle = '#ffffff';
    }
    vctx.fillRect(sx, sy, ex - sx, ey - sy);

    vctx.imageSmoothingEnabled = zoom < 1;
    vctx.drawImage(doc.off, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy);

    // 浮动选区绘制在最上层，随指针移动
    if (floating) {
      const fcx = floating.x + floating.w / 2;
      const fcy = floating.y + floating.h / 2;

      vctx.save();
      vctx.translate(fcx, fcy);
      vctx.rotate(floating.angle * Math.PI / 180);
      vctx.drawImage(floating.canvas, -floating.w / 2, -floating.h / 2);
      vctx.restore();

      /* 变换框：随内容一同旋转的虚线框 + 四角手柄。
       * 这是「已选中」的视觉标识 —— 若仅有底部滑块，无法判断选中了哪一区域。 */
      vctx.save();
      vctx.translate(fcx, fcy);
      vctx.rotate(floating.angle * Math.PI / 180);

      vctx.setLineDash([5 / zoom, 4 / zoom]);
      vctx.lineWidth = 1.5 / zoom;
      vctx.strokeStyle = 'rgba(223, 160, 60, .95)';
      vctx.strokeRect(-floating.w / 2, -floating.h / 2, floating.w, floating.h);

      vctx.setLineDash([]);
      vctx.fillStyle = '#dfa03c';
      const hs = 7 / zoom;
      for (const [hx, hy] of [
        [-floating.w / 2, -floating.h / 2], [floating.w / 2, -floating.h / 2],
        [-floating.w / 2, floating.h / 2], [floating.w / 2, floating.h / 2],
      ]) {
        vctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      }
      vctx.restore();
    }

    // 边框
    vctx.strokeStyle = 'rgba(255,255,255,.18)';
    vctx.lineWidth = 1 / zoom;
    vctx.strokeRect(0, 0, doc.w, doc.h);

    // 框选：拖拽中的实时框与已确定的选框
    const sel = (gesture && gesture.kind === 'select' && gesture.rect) ? gesture.rect : doc.selection;
    if (sel && sel.x1 > sel.x0 && sel.y1 > sel.y0) {
      vctx.save();
      vctx.setLineDash([6 / zoom, 4 / zoom]);
      vctx.lineWidth = 1 / zoom;
      vctx.strokeStyle = 'rgba(0,0,0,.75)';
      vctx.strokeRect(sel.x0, sel.y0, sel.x1 - sel.x0, sel.y1 - sel.y0);
      vctx.lineDashOffset = 5 / zoom;
      vctx.strokeStyle = 'rgba(255,255,255,.95)';
      vctx.strokeRect(sel.x0, sel.y0, sel.x1 - sel.x0, sel.y1 - sel.y0);
      vctx.restore();
    }
  }

  $('st-zoom').textContent = Math.round(zoom * 100) + '%';
  $('st-mem').textContent = '撤销 ' + (history.bytes / 1048576).toFixed(1) + ' MB';
  updateNavigator();
  perfMark();
}

/* 请求一帧：合并同一帧内的多次请求，不重复绘制 */
function requestPaint() {
  const now = performance.now();
  /* 排队超过 400ms 仍未绘制，说明该帧已被丢弃（WKWebView 在页面刚加载完成、
   * 窗口尚未上屏时会吞掉已排队的 rAF 回调）。此时必须重新排队，
   * 否则标志位将永久卡住，后续所有请求都会被去重，画面完全停止更新。 */
  if (framePending && now - frameQueuedAt < 400) return;
  framePending = true;
  frameQueuedAt = now;
  rafId = requestAnimationFrame(paint);
}

/* 完整重绘（仅在视图变化时使用，开销较大） */
function redraw() {
  doc.markAllDirty();
  requestPaint();
}

/* 鼠标没有压感，e.pressure 恒为 0.5。
 * 直接传给 .myb 笔刷会得到极细的线条 —— 其压力曲线按 0~1 设计，
 * 0.5 在 radius 曲线上仅对应 -0.35，直径缩减超过一半。
 * 因此仅压感笔使用真实压力，鼠标统一按满压处理。 */
/* 本笔观测到的压力范围，用于判断设备是否真的提供压力数据。 */
const pressureObs = { min: 1, max: 0, n: 0 };

/* 设备是否提供可用压感。null = 尚未判定。
 * 判定跨笔画保持，笔画内部不做切换 —— 中途切换会让线条粗细突变。 */
let penPressureUsable = null;

function resetPressureObs() {
  pressureObs.min = 1; pressureObs.max = 0; pressureObs.n = 0;
}

/* 一笔结束时结算，更新对设备的判定。样本太少不下结论。 */
function settlePressureObs() {
  if (pressureObs.n < 4) return;
  penPressureUsable = (pressureObs.max - pressureObs.min) > 0.01;
}

function pressureOf(e) {
  const p = typeof e.pressure === 'number' ? e.pressure : 0;
  const valid = p > 0;

  if (e.pointerType === 'pen') {
    if (valid) {
      pressureObs.min = Math.min(pressureObs.min, p);
      pressureObs.max = Math.max(pressureObs.max, p);
      pressureObs.n++;
    }

    /* 尚未判定，或已判定设备不给压力 → 整笔一律按满压画。
     *
     * 关键是「整笔一致」：曾在这里做途中切换 —— 开头按满压、
     * 一旦观测到压力变化就改用真实值。结果每笔都变成
     * 「一端粗、后面细」的蝌蚪形，看起来像棉签拖尾。
     *
     * 判定因此改为只跨笔画生效：一笔结束才结算，
     * 下一笔按结论走。笔画内部绝不改变压力来源。 */
    if (penPressureUsable !== true) return 1;

    return valid ? p : 1;
  }

  /* 非 pen：鼠标的 pressure 恒为 0.5，是占位值不是真实压力。
   * 但只要不是 0.5，就说明设备确实在报压感（部分浏览器把数位板报成 mouse）。 */
  if (valid && p !== 0.5) return p;
  return 1;
}

/* ---------- 坐标换算 ---------- */
function toDoc(e) {
  const r = view.getBoundingClientRect();
  const cx = (e.clientX - r.left) * dpr;
  const cy = (e.clientY - r.top) * dpr;
  return {
    x: (cx / dpr - doc.view.x) / doc.view.zoom,
    y: (cy / dpr - doc.view.y) / doc.view.zoom,
  };
}


view.addEventListener('pointerdown', e => {
  // 仅接受左键（笔尖同样为 0）。右键与中键不应落笔
  if (e.button !== undefined && e.button !== 0) return;
  lastPointerAt = performance.now();
  // 脚本合成的 PointerEvent 没有真实 pointer 可捕获，会抛出 NotFoundError。
  // 即使在真机上捕获失败，也不应中断整个落笔流程。
  try { view.setPointerCapture(e.pointerId); } catch { /* 合成事件或已释放 */ }

  /* 上一笔若还没结束，先正常收尾。
   *
   * 指针在窗口外松开时 pointerup 可能收不到，笔画会一直挂在 overlay 上。
   * 此时再按下，hk.begin() 会清空 overlay —— 上一笔的内容就永久丢了，
   * 表现就是「再次点击画布，上一轮越出窗口的笔画被覆盖掉」。 */
  if (hk.active || stroke || gesture) endStroke();

  const p = toDoc(e);
  resetPressureObs();
  const pressure = pressureOf(e);

  /* 非绘画工具：优先处理并返回，不进入后续笔画流程 */
  if (tool === 'hand') {
    gesture = { kind: 'hand', cx: e.clientX, cy: e.clientY, vx: doc.view.x, vy: doc.view.y };
    return;
  }
  if (tool === 'zoom') {
    zoomAt(e.clientX, e.clientY, e.altKey ? 1 / 1.3 : 1.3);
    return;
  }
  if (tool === 'select') {
    // 已存在浮动选区：在其范围内则拖动，在外部则先落回并重新框选
    if (floating) {
      if (p.x >= floating.x && p.x <= floating.x + floating.w
        && p.y >= floating.y && p.y <= floating.y + floating.h) {
        gesture = { kind: 'float-move', x0: p.x, y0: p.y, fx: floating.x, fy: floating.y };
        return;
      }
      commitFloating();
    }

    // 存在选区且落点在选区内 → 提取该区域
    const sel = doc.selection;
    if (sel && p.x >= sel.x0 && p.x <= sel.x1 && p.y >= sel.y0 && p.y <= sel.y1) {
      if (liftSelection()) {
        gesture = { kind: 'float-move', x0: p.x, y0: p.y, fx: floating.x, fy: floating.y };
      }
      return;
    }

    gesture = { kind: 'select', x0: p.x, y0: p.y, rect: null };
    requestPaint();
    return;
  }
  if (tool === 'move') {
    const node = doc.layer;
    const bounds = node ? boundsOf(node.canvas) : null;

    /* 已存在浮动选区：在其范围内则继续拖动，否则先落回 */
    if (floating) {
      if (p.x >= floating.x && p.x <= floating.x + floating.w
        && p.y >= floating.y && p.y <= floating.y + floating.h) {
        gesture = { kind: 'float-move', x0: p.x, y0: p.y, fx: floating.x, fy: floating.y };
        return;
      }
      commitFloating();
    }

    /* 点中哪一笔即提取哪一笔 —— 以连通块近似「一笔」。
     * 仅在点击空白处（无可连通内容）时回退至整层移动。 */
    if (!e.altKey && node) {
      const cb = connectedBounds(node.canvas, p.x, p.y);
      if (cb) {
        doc.selection = cb;
        if (liftSelection()) {
          op('移动', '点选连通块', (cb.x1 - cb.x0) + '×' + (cb.y1 - cb.y0));
          gesture = { kind: 'float-move', x0: p.x, y0: p.y, fx: floating.x, fy: floating.y };
          return;
        }
      }
    }

    /* 按住 ⌥ 拖动 = 绕内容中心旋转。
     * 使用包围盒中心而非画布中心 —— 内容偏向一角时，绕画布中心旋转会将其甩出视野。 */
    if (e.altKey && bounds) {
      // 存在浮动选区则旋转该选区，否则旋转整层
      const cx = floating ? floating.x + floating.w / 2 : (bounds.x0 + bounds.x1) / 2;
      const cy = floating ? floating.y + floating.h / 2 : (bounds.y0 + bounds.y1) / 2;
      gesture = {
        kind: 'rotate', node, bounds, cx, cy,
        target: floating ? 'float' : 'layer',
        a0: Math.atan2(p.y - cy, p.x - cx),
        angle: 0,
      };
      return;
    }

    gesture = { kind: 'move', node, x0: p.x, y0: p.y, bounds };
    return;
  }

  const layer = doc.paintTarget;
  if (!layer) return;
  // 蒙版上绘制的是「透明度」，颜色固定为白色，仅 alpha 有意义
  /* 蒙版为 alpha 通道：alpha=255 显示，0 遮住。
   * 但用户（及 Photoshop）的直觉是「涂黑即遮住」，因此按笔刷颜色的**亮度**换算 alpha：
   * 黑色 → 全部遮住，白色 → 全部显示，灰色 → 半透明。 */
  // 蒙版上仅绘制 alpha：统一使用白色，由 erase 决定取 255 还是 0
  const paintBrush = doc.maskMode ? { ...brush, color: '#ffffff' } : brush;

  if (tool === 'pick') {
    // 吸色：读取合成后的像素
    const r = view.getBoundingClientRect();
    const px = Math.round((e.clientX - r.left) * dpr);
    const py = Math.round((e.clientY - r.top) * dpr);
    const d = vctx.getImageData(px, py, 1, 1).data;
    const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    setColor(hex);
    return;
  }

  // 橡皮：由 Stroke 内部执行 destination-out
  // 开笔零成本：不拍摄任何像素，仅创建空记录。
  // 仅在实际写入某块时才为该块拍摄快照（Stroke 中的 onFirstTouch 回调）。
  pending = history.beginStroke(layer);

  /* 画笔使用 hokusai（.myb 笔刷）；橡皮、蒙版模式以及引擎尚未就位时使用内置引擎。
   * 蒙版必须使用内置引擎：hokusai 仅接受 HSV 颜色，无法产生 alpha，因而无法擦除。 */
  if (tool === 'brush' && hk.ready && !doc.maskMode) {
    const ok = hk.begin(p.x, p.y, pressure, tiltOpts(e, p));
    if (ok) { markDirty(true); op('落笔', tool, Math.round(p.x) + ',' + Math.round(p.y)); requestPaint(); bus.emit('stroke:begin', { x: p.x, y: p.y }); return; }
  }

  stroke = new Stroke(paintBrush, layer);
  // 落笔时将该笔可能覆盖的区域原样拍摄；笔移动越界时继续补拍
  stroke.onRegion = (x0, y0, x1, y1) => history.grabRegion(pending, x0, y0, x1, y1);
  stroke.clip = doc.selection;
  /* 蒙版为 alpha 通道（255 = 显示，0 = 遮住）。
   * 工具语义需反转才符合直觉：在蒙版上「绘制」即擦除内容，橡皮才是恢复。 */
  const eraseWanted = doc.maskMode ? (tool !== 'eraser') : (tool === 'eraser');
  if (eraseWanted) stroke.erase = true;
  stroke.begin(p.x, p.y, pressure);   // begin 内部已落第一个点
  requestPaint();
  bus.emit('stroke:begin', { x: p.x, y: p.y });
});

/* 传给 hokusai 的笔参数。倾斜仅压感笔具备（pointerType === 'pen'），
 * 鼠标与触摸统一按 0 传入 —— libmypaint 的 tilt 取值范围为 [-1, 1]，而事件中提供的是角度。 */
function tiltOpts(e, p) {
  const isPen = e.pointerType === 'pen';
  return {
    preset: hk.name,
    size: brush.size,
    opacity: brush.opacity,
    color: brush.color,
    stabilize: brush.stabilize,
    tiltX: isPen ? (e.tiltX || 0) / 90 : 0,
    tiltY: isPen ? (e.tiltY || 0) / 90 : 0,
    x: p.x, y: p.y,
  };
}

/* .myb 笔刷自带「流量 / 硬度 / 间距」，这三项在 hokusai 中没有对外接口。
 * 为避免呈现无效的可调外观，画笔模式下明确禁用；切换回橡皮（内置引擎）时再启用。 */
function syncBrushControls() {
  const useHk = hk.ready && tool === 'brush';
  for (const key of ['flow', 'hardness', 'spacing']) {
    const s = sliders.get(key);
    if (!s) continue;
    s.disabled = useHk;
    s.el.title = useHk ? '.myb 笔刷自带这项，拖动不生效' : '';
  }
}

view.addEventListener('pointermove', e => {
  lastPointerAt = performance.now();

  /* 指针已经离开窗口：结束当前笔画。
   *
   * 指针捕获会让窗口外的移动继续派发事件，若不停笔，鼠标从窗口外绕回来时
   * 会和离开点连成一条直线划在画布上。超出窗口的部分本就不该产生笔迹，
   * 因此直接收笔；回到窗口后需要重新按下才能继续画。 */
  if (e.clientX < 0 || e.clientY < 0
    || e.clientX > window.innerWidth || e.clientY > window.innerHeight) {
    if (hk.active || stroke || gesture) endStroke();
    return;
  }

  const p = toDoc(e);
  $('st-pos').textContent = Math.round(p.x) + ', ' + Math.round(p.y);

  if (gesture) { gestureMove(e); return; }

  // 合并事件：避免高刷新率屏幕丢点。注意 getCoalescedEvents() 可能返回空数组
  // （无合并点，或事件来自脚本合成），此时必须回退使用原始事件，
  // 否则该次 move 会被丢弃，导致无法绘制线条。
  let evts = [e];
  if (typeof e.getCoalescedEvents === 'function') {
    const got = e.getCoalescedEvents();
    if (got && got.length) evts = got;
  }

  if (hk.active) {
    for (const ev of evts) {
      const q = toDoc(ev);
      hk.move(q.x, q.y, pressureOf(ev), tiltOpts(ev, q));
    }
    /* 此处**不**执行 flush。
     * pump() 单次需搬运数十个 64×64 块（实测 p90 8.5ms），而压感笔约每 4ms 产生一个事件；
     * 在事件中搬运会导致持续积压。因此将搬运推迟到 paint 之前，每帧仅执行一次。 */
    requestPaint();
    return;
  }

  if (!stroke) return;
  for (const ev of evts) {
    const q = toDoc(ev);
    stroke.move(q.x, q.y, pressureOf(ev));
  }
  // 仅请求一帧，不在此处重绘 —— 无论事件多少，每帧只绘制一次
  requestPaint();
});

function endStroke() {
  if (gesture) {
    op('手势结束', gesture.kind || '?');
    gestureEnd();
    return;
  }
  if (hk.active) {
    hk.end();
    settlePressureObs();     // 一笔结束才结算设备是否有压感
    if (pending) history.commit(pending);
    op('抬笔', tool, '历史 ' + history.stack.length);
    refreshThumbs();
    pending = null;
    bus.emit('stroke:end', {});
    requestPaint();
    return;
  }
  if (!stroke) return;
  stroke.end();
  settlePressureObs();
  if (pending) history.commit(pending);
  op('抬笔', tool, '历史 ' + history.stack.length);
  refreshThumbs();

  stroke = null; pending = null;
  bus.emit('stroke:end', {});
  requestPaint();
}

view.addEventListener('pointerup', endStroke);
view.addEventListener('pointercancel', endStroke);

/* 兜底：指针在窗口外松开、或用 Alt+Tab 切走时，view 上的 pointerup 收不到。
 * 笔画若一直挂着不结束，下一笔的 begin 会清掉 overlay 里的内容。 */
const finishStrokeIfAny = () => {
  if (hk.active || stroke || gesture) endStroke();
};
window.addEventListener('pointerup', finishStrokeIfAny);
window.addEventListener('pointercancel', finishStrokeIfAny);
window.addEventListener('blur', finishStrokeIfAny);

/* ---------- 参考图窗 ----------
 * 在侧边固定一张图片作为参考。支持拖动、缩放与替换。
 * 它与画布上的文档互不相关 —— 仅用于显示，不进入任何图层。
 */
const refWin = $('reference');
const refImg = $('ref-img');
const refEmpty = $('ref-empty');
const refBody = $('ref-body');
const refZoom = $('ref-zoom');
let refScale = 1;
let refUrl = null;

/* 顶部 38px 为 macOS 窗口控制按钮区域，左侧 48px 为工具栏，参考窗不得覆盖该区域 */
const REF_TOP_MIN = 52;
const REF_LEFT_MIN = 56;

function refClamp() {
  const r = refWin.getBoundingClientRect();
  let l = r.left, t = r.top;
  let changed = false;
  if (t < REF_TOP_MIN) { t = REF_TOP_MIN; changed = true; }
  if (l < REF_LEFT_MIN) { l = REF_LEFT_MIN; changed = true; }
  if (l + r.width > window.innerWidth - 8) { l = Math.max(0, window.innerWidth - r.width - 8); changed = true; }
  if (t + 40 > window.innerHeight) { t = Math.max(REF_TOP_MIN, window.innerHeight - 40); changed = true; }
  if (changed) {
    refWin.style.right = 'auto';
    refWin.style.left = l + 'px';
    refWin.style.top = t + 'px';
  }
}

function refShow(on) {
  refWin.toggleAttribute('hidden', !on);
  if (on) {
    if (!refImg.src) refEmpty.hidden = false;
    // 布局完成后校正一次：拖动过的位置可能已移至标题栏下方
    requestAnimationFrame(refClamp);
  }
}
$('ref-close').onclick = () => refShow(false);

function refSetImage(file) {
  if (refUrl) URL.revokeObjectURL(refUrl);
  refUrl = URL.createObjectURL(file);
  refImg.src = refUrl;
  refImg.hidden = false;
  refEmpty.hidden = true;
  refScale = 1;
  refApplyScale();
  // 按图片原始宽度确定窗口宽度，但不超过屏幕宽度的 40%
  const probe = new Image();
  probe.onload = () => {
    const maxW = Math.min(420, window.innerWidth * 0.4);
    const w = Math.max(200, Math.min(maxW, probe.naturalWidth));
    refWin.style.width = w + 'px';
  };
  probe.src = refUrl;
}

function refApplyScale() {
  refImg.style.transform = `scale(${refScale})`;
  refZoom.textContent = Math.round(refScale * 100) + '%';
}

$('ref-load').onclick = () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => {
    const f = input.files && input.files[0];
    if (f) refSetImage(f);
  };
  input.click();
};

/* 拖入该面板即替换参考图；拖入画布仍按「打开文档」处理 */
refBody.addEventListener('dragover', e => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  e.stopPropagation();
  refBody.classList.add('dragover');
});
refBody.addEventListener('dragleave', () => refBody.classList.remove('dragover'));
refBody.addEventListener('drop', e => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  e.preventDefault();
  e.stopPropagation();
  refBody.classList.remove('dragover');
  dragDepth = 0;
  dropHint(false);
  if (!f.type.startsWith('image/')) { toast('参考窗只接图片', 'error'); return; }
  refSetImage(f);
});

/* 滚轮缩放 */
refBody.addEventListener('wheel', e => {
  if (refImg.hidden) return;
  e.preventDefault();
  refScale = Math.max(0.05, Math.min(8, refScale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  refApplyScale();
}, { passive: false });

/* 拖标题栏移动 */
(() => {
  const head = $('ref-head');
  let dragging = false, ox = 0, oy = 0;
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    dragging = true;
    head.setPointerCapture(e.pointerId);
    const r = refWin.getBoundingClientRect();
    // 取不到有效位置时不要拿 0,0 当锚点，会直接把窗钉在屏幕原点
    if (!r.width || !r.height) return;
    ox = e.clientX - r.left;
    oy = e.clientY - r.top;
    refWin.style.right = 'auto';
    refWin.style.left = r.left + 'px';
    refWin.style.top = r.top + 'px';
  });
  head.addEventListener('pointermove', e => {
    if (!dragging) return;
    refWin.style.left = Math.max(REF_LEFT_MIN, Math.min(window.innerWidth - 80, e.clientX - ox)) + 'px';
    // 别拖进标题栏：那 38px 是红绿灯
    refWin.style.top = Math.max(REF_TOP_MIN, Math.min(window.innerHeight - 60, e.clientY - oy)) + 'px';
  });
  head.addEventListener('pointerup', e => {
    dragging = false;
    try { head.releasePointerCapture(e.pointerId); } catch {}
  });
})();

/* 菜单/命令里切换 */
function toggleReference() {
  if (refWin.hasAttribute('hidden')) refShow(true);
  else refShow(false);
}

/* ---------- 导航器 ----------
 * 整张画布的缩略图与当前视口框，点击即跳转。
 * 缩略图需重绘整个 doc.off，因此节流至 8fps；更高频率没有实际收益。
 */
const navCanvas = $('nav-canvas');
const navFrame = $('nav-frame');
let navAt = 0;

function navMetrics() {
  const maxW = 148, maxH = 108;
  const s = Math.min(maxW / doc.w, maxH / doc.h, 1);
  return { s, cw: Math.max(8, Math.round(doc.w * s)), ch: Math.max(8, Math.round(doc.h * s)) };
}

function updateNavigator(force) {
  if (!navCanvas) return;
  const now = performance.now();
  if (!force && now - navAt < 120) return;
  navAt = now;

  const { s, cw, ch } = navMetrics();
  if (navCanvas.width !== cw || navCanvas.height !== ch) {
    navCanvas.width = cw;
    navCanvas.height = ch;
    navCanvas.style.width = cw + 'px';
    navCanvas.style.height = ch + 'px';
  }

  const nctx = navCanvas.getContext('2d');
  nctx.clearRect(0, 0, cw, ch);
  nctx.fillStyle = '#ffffff';
  nctx.fillRect(0, 0, cw, ch);
  // 缩略图无需平滑处理，以降低开销
  nctx.imageSmoothingEnabled = false;
  nctx.drawImage(doc.off, 0, 0, doc.w, doc.h, 0, 0, cw, ch);

  const st = $('stage').getBoundingClientRect();
  const vx = -doc.view.x / doc.view.zoom;
  const vy = -doc.view.y / doc.view.zoom;
  const vw = st.width / doc.view.zoom;
  const vh = st.height / doc.view.zoom;

  const fx = Math.max(0, vx * s);
  const fy = Math.max(0, vy * s);
  const fw = Math.min(cw - fx, vw * s);
  const fh = Math.min(ch - fy, vh * s);

  navFrame.style.left = fx + 'px';
  navFrame.style.top = fy + 'px';
  navFrame.style.width = Math.max(3, fw) + 'px';
  navFrame.style.height = Math.max(3, fh) + 'px';
  // 视口大于整张画布时不绘制视口框（画面已完整可见，框无意义）
  navFrame.style.opacity = (fw >= cw - 1 && fh >= ch - 1) ? '0' : '1';
}

/* 点击或拖动导航器 → 将该位置移至视口中心 */
function navJump(clientX, clientY) {
  const r = navCanvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const s = doc.w / r.width;
  const dx = (clientX - r.left) * s;
  const dy = (clientY - r.top) * s;
  const st = $('stage').getBoundingClientRect();
  doc.view.x = st.width / 2 - dx * doc.view.zoom;
  doc.view.y = st.height / 2 - dy * doc.view.zoom;
  redraw();
}

if (navCanvas) {
  let navDrag = false;
  navCanvas.addEventListener('pointerdown', e => {
    navDrag = true;
    navCanvas.setPointerCapture(e.pointerId);
    navJump(e.clientX, e.clientY);
  });
  navCanvas.addEventListener('pointermove', e => {
    if (navDrag) navJump(e.clientX, e.clientY);
  });
  navCanvas.addEventListener('pointerup', e => {
    navDrag = false;
    try { navCanvas.releasePointerCapture(e.pointerId); } catch {}
  });
}

/* ---------- 拖拽打开 ----------
 * 拖入 .achi 即打开文件，拖入图片即新建同尺寸文档 —— 与文件对话框共用同一入口。
 */
let dragDepth = 0;

function dropHint(on) {
  let el = document.getElementById('drop-hint');
  if (!el) {
    if (!on) return;
    el = document.createElement('div');
    el.id = 'drop-hint';
    el.className = 'drop-hint';
    el.innerHTML = '<div class="drop-inner"><b>松手打开</b><span>.achi 或图片</span></div>';
    document.body.appendChild(el);
  }
  el.classList.toggle('on', on);
}

window.addEventListener('dragenter', e => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  dropHint(true);
});

window.addEventListener('dragover', e => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', e => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropHint(false);
});

window.addEventListener('drop', async e => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  dragDepth = 0;
  dropHint(false);

  const f = e.dataTransfer.files[0];
  try {
    const buffer = await f.arrayBuffer();
    await openFromBuffer(buffer, f.name, f.path || null);
  } catch (err) {
    showFileError('拖入失败', err);
  }
});

/* ---------- 连通块选取 ----------
 * 图层以像素存储，不存在「笔画对象」。但单笔绘制的内容在像素上是**连通的**，
 * 因此通过泛洪找出点击位置的连通块并取其包围盒，近似实现「选中这一笔」。
 * 点击空白处返回 null，由调用方回退至整层移动。
 */
function layerImageData(tc) {
  const cv = newCanvas(tc.w, tc.h);
  const ctx = cv.getContext('2d');
  for (const t of tc.tiles.values()) ctx.drawImage(t.canvas, t.col * TILE, t.row * TILE);
  return ctx.getImageData(0, 0, tc.w, tc.h);
}

/**
 * 自 (sx, sy) 泛洪，返回连通块的包围盒。
 * 采用扫描线填充，性能较逐像素 BFS 高一个数量级。
 */
function connectedBounds(tc, sx, sy) {
  const x0i = Math.floor(sx), y0i = Math.floor(sy);
  if (x0i < 0 || y0i < 0 || x0i >= tc.w || y0i >= tc.h) return null;

  const img = layerImageData(tc);
  const d = img.data, W = tc.w, H = tc.h;
  const at = (x, y) => ((y * W + x) << 2) + 3;   // alpha 偏移

  if (d[at(x0i, y0i)] < 8) return null;          // 点在透明处

  const seen = new Uint8Array(W * H);
  let minX = x0i, maxX = x0i, minY = y0i, maxY = y0i;
  const stack = [[x0i, y0i]];

  while (stack.length) {
    const [px, py] = stack.pop();
    let xl = px, xr = px;
    // 向左扩展至边界
    while (xl > 0 && !seen[py * W + xl - 1] && d[at(xl - 1, py)] >= 8) xl--;
    // 向右扩展
    while (xr < W - 1 && !seen[py * W + xr + 1] && d[at(xr + 1, py)] >= 8) xr++;

    if (xl < minX) minX = xl;
    if (xr > maxX) maxX = xr;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;

    for (let x = xl; x <= xr; x++) seen[py * W + x] = 1;

    // 在上下两行查找新的种子点
    for (const ny of [py - 1, py + 1]) {
      if (ny < 0 || ny >= H) continue;
      let run = false;
      for (let x = xl; x <= xr; x++) {
        if (!seen[ny * W + x] && d[at(x, ny)] >= 8) {
          if (!run) { stack.push([x, ny]); run = true; }
        } else {
          run = false;
        }
      }
    }
  }

  return { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
}

/* ---------- 浮动选区 ----------
 * 框选一块区域并从图层中提取：可拖动、可旋转，松手后才落回图层。
 * 这是在像素模型下「移动单个或多个笔画」的实际做法 —— 底层无笔画对象，
 * 因此选区范围是一块内容，而非某一笔。
 */
let floating = null;   // { canvas, x, y, w, h, angle, tc, rect, moved }

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/* 将选区内容从图层提取到浮动画布，并清空原位置 */
function liftSelection() {
  const sel = doc.selection;
  // paintTarget 本身即 TileCanvas（并非 Layer），无需再次获取 .canvas
  const tc = doc.paintTarget;
  if (!sel || !tc) return false;

  const x = Math.round(sel.x0), y = Math.round(sel.y0);
  const w = Math.max(1, Math.round(sel.x1 - sel.x0));
  const h = Math.max(1, Math.round(sel.y1 - sel.y0));
  if (w < 1 || h < 1) return false;

  const cv = newCanvas(w, h);
  const fctx = cv.getContext('2d');

  // 从图层逐块拷贝（瓦片为 256×256，按块坐标搬运）
  for (let r = Math.floor(y / TILE); r <= Math.floor((y + h - 1) / TILE); r++) {
    for (let c = Math.floor(x / TILE); c <= Math.floor((x + w - 1) / TILE); c++) {
      const t = tc.tiles.get(c + ',' + r);
      if (!t) continue;
      fctx.drawImage(t.canvas, c * TILE - x, r * TILE - y);
    }
  }

  // 在原位置清除
  const pending = history.beginStroke(tc);
  history.grabRegion(pending, x, y, x + w, y + h);
  tc.forEachTileInBounds(x, y, x + w - 1, y + h - 1, ctx => {
    ctx.clearRect(x, y, w, h);
  });
  tc.markDirty(x, y, x + w, y + h);

  op('选区', '浮起', w + '×' + h);
  floating = { canvas: cv, x, y, w, h, angle: 0, tc, rect: { x, y, w, h }, pending, moved: true };
  doc.selection = null;
  syncFloatBar();
  redraw();
  return true;
}

/* 落回图层：先按当前角度绘制到临时画布，再贴回图层 */
function commitFloating() {
  if (!floating) return;
  const f = floating;
  floating = null;
  syncFloatBar();

  const tc = f.tc;
  /* 临时画布必须按**旋转后**的包围盒创建，不能沿用原尺寸，
   * 否则旋转 45° 后四个角会被裁切，且不可恢复。 */
  const rad = f.angle * Math.PI / 180;
  const ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad));
  const tw = Math.max(1, Math.ceil(f.w * ca + f.h * sa));
  const th = Math.max(1, Math.ceil(f.w * sa + f.h * ca));

  const tmp = newCanvas(tw, th);
  const tctx = tmp.getContext('2d');
  tctx.translate(tw / 2, th / 2);
  tctx.rotate(rad);
  tctx.drawImage(f.canvas, -f.w / 2, -f.h / 2);

  // 绕中心旋转，中心保持不变：左上角 = 中心 - 新尺寸 / 2
  const left = Math.round(f.x + f.w / 2 - tw / 2);
  const top = Math.round(f.y + f.h / 2 - th / 2);

  /* 落回前先扩大撤销快照，使其覆盖「落回后的实际区域」。
   * 提取时拍摄的范围只有原矩形；旋转或移动后内容会越出该矩形，
   * 若不补拍，超出的那部分像素不会被撤销覆盖，撤销后会留下残影
   * （审计结论 audit/2026-11-20-audit.md 第 2.6 节）。
   * grabRegion 会自动把范围扩为并集，并只补拍新增的条带。 */
  if (f.pending) {
    history.grabRegion(f.pending, left, top, left + tw, top + th);
  }

  tc.forEachTileInBounds(left, top, left + tw - 1, top + th - 1, ctx => {
    ctx.drawImage(tmp, left, top);
  });
  tc.markDirty(0, 0, doc.w, doc.h);

  if (f.pending) history.commit(f.pending);
  redraw();
  toast('已放置');
}

/* 取消：按原状放回 */
function cancelFloating() {
  if (!floating) return;
  const f = floating;
  floating = null;
  syncFloatBar();
  f.tc.forEachTileInBounds(f.x, f.y, f.x + f.w - 1, f.y + f.h - 1, ctx => {
    ctx.drawImage(f.canvas, f.x, f.y);
  });
  f.tc.markDirty(0, 0, doc.w, doc.h);
  redraw();
}

/* 浮动选区的旋转控制条 */
const floatBar = $('float-bar');
const fbRotate = $('fb-rotate');
const fbVal = $('fb-val');

function syncFloatBar() {
  if (!floatBar) return;
  const on = !!floating && !!floating.moved;
  floatBar.toggleAttribute('hidden', !on);
  if (on) {
    fbRotate.value = String(Math.round(floating.angle * 2) / 2);
    fbVal.textContent = (floating.angle > 0 ? '+' : '') + Math.round(floating.angle) + '°';
  }
}

if (fbRotate) {
  fbRotate.addEventListener('input', () => {
    if (!floating) return;
    floating.angle = Number(fbRotate.value);
    fbVal.textContent = (floating.angle > 0 ? '+' : '') + Math.round(floating.angle) + '°';
    requestPaint();
  });
  $('fb-reset').onclick = () => {
    if (!floating) return;
    floating.angle = 0;
    syncFloatBar();
    requestPaint();
  };
  $('fb-done').onclick = () => { if (floating) commitFloating(); };
}

/* ---------- 旋转 ----------
 * 拖动过程中不重采样（对 870 万像素逐帧重采样会导致界面无响应），仅显示角度；
 * 松手后才执行一次实际旋转。
 */
let rotateHintEl = null;

function showRotateHint(deg) {
  if (!rotateHintEl) {
    rotateHintEl = document.createElement('div');
    rotateHintEl.className = 'rotate-hint';
    document.body.appendChild(rotateHintEl);
  }
  rotateHintEl.textContent = (deg >= 0 ? '+' : '') + Math.round(deg) + '°';
  rotateHintEl.classList.add('on');
}

function hideRotateHint() {
  if (rotateHintEl) rotateHintEl.classList.remove('on');
}

/**
 * 将整层绕内容中心旋转 deg 度，重采样后写回瓦片。
 * 注意这不是块级旋转 —— 旋转后每块的内容来自任意方向，只能对整层重采样。
 */
function rotateLayer(node, deg) {
  const b = boundsOf(node.canvas);
  if (!b) return;

  const pending = history.beginStroke(node.canvas);
  /* 蒙版随之旋转，所以快照范围必须同时覆盖蒙版 ——
   * 审计结论（audit/2026-11-20-audit.md 第 1.4 节）：原先只对画布拍摄，
   * 旋转后撤销不会还原蒙版，内容与蒙版永久脱节。 */
  history.grabRegion(pending, 0, 0, doc.w, doc.h);
  let maskPending = null;
  if (node.mask && node.mask.tiles.size) {
    maskPending = history.beginStroke(node.mask);
    history.grabRegion(maskPending, 0, 0, doc.w, doc.h);
  }

  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;

  rotateTiles(node.canvas, deg, cx, cy);
  // 蒙版绕同一中心旋转，两者才不会错位
  if (node.mask && node.mask.tiles.size) rotateTiles(node.mask, deg, cx, cy);

  node.canvas.markDirty(0, 0, doc.w, doc.h);
  if (node.mask) node.mask.markDirty(0, 0, doc.w, doc.h);

  if (pending) history.commit(pending);
  if (maskPending) history.commit(maskPending);
  op('变换', '旋转', Math.round(deg) + '°');
  redraw();
  toast(`已旋转 ${deg >= 0 ? '+' : ''}${Math.round(deg)}°`);
}

/* 将某个 TileCanvas 绕 (cx, cy) 旋转 deg 度，结果写回原对象。
 * 内容与蒙版共用此函数，保证两者使用完全相同的变换与中心点。 */
function rotateTiles(tc, deg, cx, cy) {
  /* 分两步：先无变换地将整层无缝合并，再一次性旋转。
   * 若直接对每块执行旋转 drawImage，每块边缘都会落在非整数位置，
   * 相邻块插值不一致，产生条状浅色缝隙。 */
  const flat = document.createElement('canvas');
  flat.width = doc.w;
  flat.height = doc.h;
  const fctx = flat.getContext('2d');
  for (const t of tc.tiles.values()) {
    fctx.drawImage(t.canvas, t.col * TILE, t.row * TILE);
  }

  const tmp = document.createElement('canvas');
  tmp.width = doc.w;
  tmp.height = doc.h;
  const tctx = tmp.getContext('2d');
  tctx.translate(cx, cy);
  tctx.rotate(deg * Math.PI / 180);
  tctx.translate(-cx, -cy);
  tctx.drawImage(flat, 0, 0);

  // flat 使用完毕立即释放：大画布上它占用约 35MB
  flat.width = 0;
  flat.height = 0;

  // 写回瓦片
  tc.tiles.clear();
  for (let r = 0; r < tc.rows; r++) {
    for (let c = 0; c < tc.cols; c++) {
      const tw = Math.min(TILE, doc.w - c * TILE);
      const th = Math.min(TILE, doc.h - r * TILE);
      if (tw <= 0 || th <= 0) continue;
      /* 每块向外多取 1px 重叠。
       * 精确取 tw×th 时，相邻块之间会残留亚像素缝隙（旋转后尤为明显）。 */
      const ox0 = c * TILE, oy0 = r * TILE;
      const sx = Math.max(0, ox0 - 1), sy = Math.max(0, oy0 - 1);
      const sw = Math.min(tmp.width - sx, tw + 2), sh = Math.min(tmp.height - sy, th + 2);
      const t = tc.tile(c, r);
      t.ctx.drawImage(tmp, sx, sy, sw, sh, sx - ox0, sy - oy0, sw, sh);
    }
  }
}

/* ---------- 平移缩放 ---------- */
view.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const r = view.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const old = doc.view.zoom;
    const next = Math.max(0.02, Math.min(16, old * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    // 以指针位置为锚点缩放
    doc.view.x = mx - (mx - doc.view.x) * (next / old);
    doc.view.y = my - (my - doc.view.y) * (next / old);
    doc.view.zoom = next;
  } else {
    doc.view.x -= e.deltaX;
    doc.view.y -= e.deltaY;
  }
  redraw();
}, { passive: false });

/* ---------- 适应窗口 ---------- */
function fit() {
  op('视图', '适应窗口');
  const r = $('stage').getBoundingClientRect();
  const z = Math.min(r.width / doc.w, r.height / doc.h) * 0.92;
  doc.view.zoom = z;
  doc.view.x = (r.width - doc.w * z) / 2;
  doc.view.y = (r.height - doc.h * z) / 2;
  redraw();
}
$('btn-fit').onclick = fit;

/* ---------- 工具切换 ---------- */
const TOOL_KEYS = { b: 'brush', e: 'eraser', i: 'pick', v: 'move', m: 'select', h: 'hand', z: 'zoom' };

function setTool(next) {
  // 存在浮动选区时切换工具，需先将其落回图层，否则会一直挂起
  if (floating && next !== 'select') commitFloating();
  if (tool !== next) op('工具', next);
  tool = next;
  document.querySelectorAll('[data-tool]').forEach(b => {
    b.classList.toggle('on', b.dataset.tool === tool);
  });
  syncBrushControls();
}

document.querySelectorAll('[data-tool]').forEach(btn => {
  btn.onclick = () => setTool(btn.dataset.tool);
});

/* ---------- 手势：抓手 / 缩放 / 移动 / 框选 ---------- */
let gesture = null;

function zoomAt(clientX, clientY, factor) {
  const r = view.getBoundingClientRect();
  const mx = clientX - r.left;
  const my = clientY - r.top;
  const old = doc.view.zoom;
  const next = Math.max(0.02, Math.min(16, old * factor));
  doc.view.x = mx - (mx - doc.view.x) * (next / old);
  doc.view.y = my - (my - doc.view.y) * (next / old);
  doc.view.zoom = next;
  redraw();
}

/* 将某个 TileCanvas 整体平移 dx, dy。
 * 注意是「原地替换内容」而非替换对象 —— history 持有该 TileCanvas 的引用，
 * 若替换对象，撤销时读取到的「修改后」快照仍是旧内容。 */
function translateTiles(src, dx, dy) {
  const T = TILE;
  const old = [...src.tiles.values()].map(t => ({ col: t.col, row: t.row, canvas: t.canvas }));
  src.tiles.clear();
  for (const o of old) {
    const wx = o.col * T + dx, wy = o.row * T + dy;
    src.forEachTileInBounds(wx, wy, wx + T, wy + T, ctx => {
      ctx.drawImage(o.canvas, wx, wy);
    });
  }
}

/* 计算内容的实际包围盒（世界坐标，已裁剪到画布范围）。
 *
 * 注意：不能直接把块网格的外接矩形当作内容边界。块固定为 256×256，
 * 内容通常只占块的一部分，按块算出的边界最多会偏出 255px；
 * 旋转以包围盒中心为轴，中心一旦偏移，内容就会被甩出画布。
 * 因此这里必须逐块扫描像素，求真实内容的边界。 */
function boundsOf(tc) {
  /* 逐块扫描像素求真实边界，而不是直接取块网格的外接矩形：
   * 块固定 256×256，内容通常只占其中一部分，按块算最多偏出 255px。
   * 旋转以包围盒中心为轴，中心一旦偏移，内容会被甩出画布。
   *
   * 性能：先用 getImageData 一次性取出整块，再在类型化数组上扫描；
   * 不对逐像素调用 getImageData。空块（全透明）会被快速跳过。 */
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of tc.tiles.values()) {
    const baseX = t.col * TILE, baseY = t.row * TILE;
    const maxY = Math.min(TILE, tc.h - baseY);
    const maxX = Math.min(TILE, tc.w - baseX);
    if (maxX <= 0 || maxY <= 0) continue;

    const img = t.ctx.getImageData(0, 0, TILE, TILE).data;
    for (let y = 0; y < maxY; y++) {
      const wy = baseY + y;
      const rowOff = y * TILE * 4;
      for (let x = 0; x < maxX; x++) {
        if (img[rowOff + x * 4 + 3] === 0) continue;
        const wx = baseX + x;
        if (wx < x0) x0 = wx;
        if (wy < y0) y0 = wy;
        if (wx + 1 > x1) x1 = wx + 1;
        if (wy + 1 > y1) y1 = wy + 1;
      }
    }
  }
  if (!(x1 > x0)) return null;
  return { x0, y0, x1, y1 };
}

function commitMove(node, dx, dy) {
  if (!dx && !dy) return;
  const target = node.canvas;
  const b = boundsOf(target);
  if (!b) return;

  // 撤销范围：旧位置与新位置的并集
  const pending = history.beginStroke(target);
  history.grabRegion(pending,
    Math.min(b.x0, b.x0 + dx), Math.min(b.y0, b.y0 + dy),
    Math.max(b.x1, b.x1 + dx), Math.max(b.y1, b.y1 + dy));

  /* 蒙版同样被平移，因此必须单独拍摄快照。
   * 审计结论（audit/2026-11-20-audit.md 第 1.4 节）：原先 translateTiles 移动了蒙版，
   * 但历史只记录 node.canvas，撤销后蒙版停留在新位置，与内容错位。 */
  let maskPending = null;
  if (node.mask) {
    const mb = boundsOf(node.mask);
    if (mb) {
      maskPending = history.beginStroke(node.mask);
      history.grabRegion(maskPending,
        Math.min(mb.x0, mb.x0 + dx), Math.min(mb.y0, mb.y0 + dy),
        Math.max(mb.x1, mb.x1 + dx), Math.max(mb.y1, mb.y1 + dy));
    }
  }

  op('变换', '移动', dx + ', ' + dy);
  translateTiles(target, dx, dy);
  if (node.mask) translateTiles(node.mask, dx, dy);

  target.markDirty(0, 0, doc.w, doc.h);
  if (node.mask) node.mask.markDirty(0, 0, doc.w, doc.h);
  history.commit(pending);
  if (maskPending) history.commit(maskPending);
  redraw();
}

function gestureMove(e) {
  const g = gesture;
  if (!g) return;
  const p = toDoc(e);

  if (g.kind === 'hand') {
    doc.view.x = g.vx + (e.clientX - g.cx);
    doc.view.y = g.vy + (e.clientY - g.cy);
    redraw();
    return;
  }

  if (g.kind === 'float-move') {
    floating.x = Math.round(g.fx + (p.x - g.x0));
    floating.y = Math.round(g.fy + (p.y - g.y0));
    floating.moved = true;
    requestPaint();
    return;
  }

  if (g.kind === 'select') {
    g.rect = {
      x0: Math.min(g.x0, p.x), y0: Math.min(g.y0, p.y),
      x1: Math.max(g.x0, p.x), y1: Math.max(g.y0, p.y),
    };
    requestPaint();
    return;
  }

  if (g.kind === 'rotate') {
    const a = Math.atan2(p.y - g.cy, p.x - g.cx);
    let deg = (a - g.a0) * 180 / Math.PI;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    g.angle = deg;

    if (g.target === 'float' && floating) {
      // 拖动浮动块：直接修改角度并实时预览
      floating.angle = deg;
      syncFloatBar();
      requestPaint();
    } else {
      showRotateHint(deg);
    }
    return;
  }

  if (g.kind === 'move') {
    const dx = Math.round(p.x - g.x0);
    const dy = Math.round(p.y - g.y0);
    doc.previewOffset = { node: g.node, dx, dy };
    // 仅重绘「旧位置与新位置的并集」区域，不做整张重新合成
    const b = g.bounds || { x0: 0, y0: 0, x1: doc.w, y1: doc.h };
    doc.markRegionDirty(
      Math.min(b.x0, b.x0 + dx), Math.min(b.y0, b.y0 + dy),
      Math.max(b.x1, b.x1 + dx), Math.max(b.y1, b.y1 + dy));
    requestPaint();
    return;
  }
}

function gestureEnd() {
  const g = gesture;
  gesture = null;
  if (!g) return;

  if (g.kind === 'float-move') {
    requestPaint();
    return;
  }

  if (g.kind === 'select') {
    const r = g.rect;
    doc.selection = (r && (r.x1 - r.x0) > 1 && (r.y1 - r.y0) > 1) ? r : null;
    op('选区', doc.selection
      ? '框选 ' + Math.round(doc.selection.x1 - doc.selection.x0) + '×' + Math.round(doc.selection.y1 - doc.selection.y0)
      : '清空');
    requestPaint();
    return;
  }

  if (g.kind === 'rotate') {
    hideRotateHint();
    gesture = null;
    if (g.target === 'float') { requestPaint(); return; }   // 浮动的角度已经生效，等放置
    const deg = g.angle || 0;
    if (Math.abs(deg) >= 0.5) rotateLayer(g.node, deg);
    else requestPaint();
    return;
  }

  if (g.kind === 'move') {
    const off = doc.previewOffset;
    doc.previewOffset = null;
    if (off && off.node === g.node) commitMove(g.node, off.dx, off.dy);
    else requestPaint();
    return;
  }

  requestPaint();
}

/* ---------- 笔刷属性：Blender 式滑块 ----------
 * 整条可拖动、数值内嵌于滑块上，支持滚轮与方向键调整。
 * 此处仅负责「UI 值 → 笔刷实际值」的换算（多数需除以 100）。
 */
const sliders = new Map();

function makeSlider(host, opts) {
  const s = new Slider(opts);
  if (opts.id) s.el.id = opts.id;
  sliders.set(opts.key, s);
  host.appendChild(s.el);
  return s;
}

const BRUSH_SLIDERS = [
  { key: 'size',      label: '大小',     min: 1, max: 600, value: 80,  scale: v => v },
  { key: 'opacity',   label: '不透明度', min: 1, max: 100, value: 100, scale: v => v / 100 },
  { key: 'flow',      label: '流量',     min: 1, max: 100, value: 100, scale: v => v / 100 },
  { key: 'hardness',  label: '硬度',     min: 0, max: 100, value: 60,  scale: v => v / 100 },
  { key: 'spacing',   label: '间距',     min: 1, max: 30,  value: 4,   scale: v => v / 100 },
  { key: 'stabilize', label: '稳定',     min: 0, max: 90,  value: 12,  scale: v => v / 100 },
];

const brushHost = $('brush-sliders');
for (const cfg of BRUSH_SLIDERS) {
  brush[cfg.key] = cfg.scale(cfg.value);
  makeSlider(brushHost, {
    key: cfg.key,
    label: cfg.label,
    min: cfg.min, max: cfg.max, step: 1, value: cfg.value,
    onChange: v => { brush[cfg.key] = cfg.scale(v); },
  });
}

/* ---------- 颜色：Blender 式取色器 ----------
 * 色轮 + 明度竖条 + RGB / HSV 切换 + 三根通道条。
 * 此处仅负责「取色器 ↔ 笔刷颜色 / hex 输入框 / 色块」之间的同步。
 */
function hexOf({ r, g, b }) {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/* 主色与副色：两个槽位，取色器编辑的是「当前槽位」。 */
const colors = { primary: '#e8eaf0', secondary: '#101014' };
let colorSlot = 'primary';

function paintSwatches() {
  $('sw-primary').style.background = colors.primary;
  $('sw-secondary').style.background = colors.secondary;
  $('sw-primary').classList.toggle('active', colorSlot === 'primary');
  $('sw-secondary').classList.toggle('active', colorSlot === 'secondary');
}

function applyColor(hex, fromPicker) {
  const rgb = parseHex(hex);
  if (!rgb) return;
  const c = hexOf(rgb);
  colors[colorSlot] = c;
  brush.color = colors.primary;
  $('color').value = c;
  $('hex').value = c;
  paintSwatches();
  if (!fromPicker) picker.setValue(c);   // 回写会把取色器光标弹回去，从它自己来就别写
}

function setColor(hex) { applyColor(hex, false); }

const picker = new ColorPicker({
  host: $('color-picker'),
  value: colors.primary,
  size: 176,
  onChange: hex => applyColor(hex, true),
});

/* 切换槽位时，界面同步显示该槽位的颜色 */
function syncColorSlot() {
  paintSwatches();
  const c = colors[colorSlot];
  $('color').value = c;
  $('hex').value = c;
  picker.setValue(c);
}

function swapColors() {
  const t = colors.primary;
  colors.primary = colors.secondary;
  colors.secondary = t;
  brush.color = colors.primary;
  syncColorSlot();
}

$('sw-primary').onclick = () => { colorSlot = 'primary'; syncColorSlot(); };
$('sw-secondary').onclick = () => { colorSlot = 'secondary'; syncColorSlot(); };

/* 原生取色器与 hex 输入框：修改的均为「当前槽位」的颜色 */
$('color').oninput = e => setColor(e.target.value);
$('hex').onchange = e => setColor(e.target.value);
$('hex').onkeydown = e => { if (e.key === 'Enter') setColor(e.target.value); };

const sw = $('swatches');
DEFAULT_SWATCHES.forEach(c => {
  const d = document.createElement('button');
  d.className = 'sw';
  d.style.background = c;
  d.title = c;
  d.onclick = () => setColor(c);
  sw.appendChild(d);
});

paintSwatches();
syncColorSlot();

/* ---------- 图层蒙版 ----------
 * 仅实现「透明度蒙版」：笔画落在蒙版上，白色 = 可见，空 = 抠除。
 * 合成时先将该图层绘制到暂存画布，再以 destination-in 应用蒙版。
 */
function setMaskMode(on) {
  const l = doc.layer;
  if (on && l && !l.mask) {
    /* 蒙版的新建同样会改变图层结构（影响导出与合成结果），纳入撤销栈。 */
    const pending = history.beginStructure(doc);
    l.ensureMask();
    history.commitStructure(pending, '新建蒙版');
  }
  doc.maskMode = !!(on && l && l.mask);
  $('btn-mask').classList.toggle('on', doc.maskMode);
  redraw();
  renderLayers();   // 蒙版行要出现 / 高亮
}

$('btn-mask').onclick = () => setMaskMode(!doc.maskMode);

/* ---------- 图层树 ----------
 * 显示顺序即 children 的顺序（children[0] 为最上层），合成时反向遍历。
 * 行支持拖拽：拖至组的中段 = 移入该组；拖至行的上半 / 下半 = 插入其前 / 后。
 */
let uidSeq = 0;
const nodeById = new Map();

function uidOf(node) {
  if (!node._uid) {
    node._uid = 'n' + (++uidSeq);
    nodeById.set(node._uid, node);
  }
  return node._uid;
}

function layerRowEl(node) {
  return $('layers').querySelector(`.lay-row[data-uid="${uidOf(node)}"]`);
}

/* 双击名称就地重命名。空名称不被接受，Esc 放弃修改。 */
function startRename(node, span) {
  const inp = document.createElement('input');
  inp.className = 'lay-rename';
  inp.value = node.name;
  span.textContent = '';
  span.appendChild(inp);
  inp.focus();
  inp.select();

  /* 防护：inp.remove() 会同步触发 blur，blur 又调用一次 done，
   * 第二次 remove 将抛出 NotFoundError。因此仅接受第一次调用。 */
  let finished = false;
  const done = commit => {
    if (finished) return;
    finished = true;
    const v = inp.value.trim();
    if (commit && v && v !== node.name) {
      const pending = history.beginStructure(doc);
      node.name = v;
      history.commitStructure(pending, '重命名');
    }
    if (inp.isConnected) inp.remove();
    renderLayers();
  };

  inp.addEventListener('pointerdown', e => e.stopPropagation());
  inp.addEventListener('dblclick', e => e.stopPropagation());
  inp.addEventListener('blur', () => done(true));
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    else if (e.key === 'Escape') { e.preventDefault(); done(false); }
  });
}

/* 缩略图底纹：4px 棋盘格（原 CSS 使用 8px，在 26px 方框内恰好排成 6 块，呈现重复感） */
function paintChecker(ctx, size, step = 4) {
  for (let y = 0; y < size; y += step) {
    for (let x = 0; x < size; x += step) {
      ctx.fillStyle = (((x / step) | 0) + ((y / step) | 0)) % 2 ? '#ffffff' : '#dcdcdc';
      ctx.fillRect(x, y, step, step);
    }
  }
}

/* ---------- 图层缩略图 ----------
 * 缩略图需重绘整层瓦片，因此按「内容是否变化」缓存，不可在每次渲染时重新计算。
 */
/* 直接绘制到 canvas 元素，不经过 toDataURL ——
 * 每笔完成后都需刷新，而 PNG 编码单次耗时 10–30ms，绘制过程中可感知卡顿。 */
function paintThumb(el, node, size = 32) {
  const ctx = el.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);

  if (!node || node.isGroup || !node.canvas || node.canvas.tiles.size === 0) {
    paintChecker(ctx, size);
    el.dataset.empty = '1';
    return;
  }
  delete el.dataset.empty;

  paintChecker(ctx, size);
  const s2 = Math.min(size / doc.w, size / doc.h);
  ctx.imageSmoothingEnabled = true;
  for (const t of node.canvas.tiles.values()) {
    ctx.drawImage(t.canvas, 0, 0, 256, 256,
      Math.floor(t.col * 256 * s2), Math.floor(t.row * 256 * s2),
      Math.ceil(256 * s2), Math.ceil(256 * s2));
  }
}

function paintMaskThumb(el, node, size = 32) {
  const ctx = el.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);            // 蒙版看不见 = 黑底
  const m = node.mask;
  if (!m || m.tiles.size === 0) return;
  const s2 = Math.min(size / doc.w, size / doc.h);
  for (const t of m.tiles.values()) {
    ctx.drawImage(t.canvas, 0, 0, 256, 256,
      Math.floor(t.col * 256 * s2), Math.floor(t.row * 256 * s2),
      Math.ceil(256 * s2), Math.ceil(256 * s2));
  }
}

/* 笔迹完成后刷新缩略图，但不重建整个图层面板（会闪烁，并丢失正在进行的交互） */
let thumbAt = 0;
let thumbTimer = 0;

function refreshThumbs(force) {
  const now = performance.now();
  // 节流：连续快速绘制时不为每一笔重绘缩略图
  if (!force && now - thumbAt < 250) {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => refreshThumbs(true), 260);
    return;
  }
  thumbAt = now;

  const box = $('layers');
  if (!box) return;
  for (const row of box.querySelectorAll('.lay-row[data-uid]')) {
    const node = nodeById.get(row.dataset.uid);
    if (!node || node.isGroup) continue;
    const t = row.querySelector('canvas.lay-thumb');
    if (t) paintThumb(t, node);
  }
  for (const row of box.querySelectorAll('.mask-row')) {
    const t = row.querySelector('canvas.lay-thumb');
    const uid = row.dataset.maskFor;
    const node = uid ? nodeById.get(uid) : null;
    if (t && node) paintMaskThumb(t, node);
  }
}

/* 内容每次变化即更新版本戳，缩略图据此判断是否需要重算 */
function bumpThumbStamp(tc) {
  if (tc) tc._dirtyStamp = (tc._dirtyStamp || 0) + 1;
}

function maskThumb(node, size = 32) {
  const m = node.mask;
  if (!m || m.tiles.size === 0) return null;
  const stamp = 'm' + m.tiles.size + ':' + history.stack.length + ':' + (m._dirtyStamp || 0);
  if (node._maskThumbKey === stamp && node._maskThumbURL) return node._maskThumbURL;

  const cv = newCanvas(size, size);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);            // 蒙版看不见 = 黑底
  // 注：蒙版缩略图不使用棋盘格，黑色 = 遮住、白色 = 显示，本身即具备语义
  const s2 = Math.min(size / doc.w, size / doc.h);
  for (const t of m.tiles.values()) {
    ctx.drawImage(t.canvas, 0, 0, 256, 256,
      Math.floor(t.col * 256 * s2), Math.floor(t.row * 256 * s2),
      Math.ceil(256 * s2), Math.ceil(256 * s2));
  }
  node._maskThumbKey = stamp;
  node._maskThumbURL = cv.toDataURL();
  return node._maskThumbURL;
}

function layerRow(node, depth) {
  const row = document.createElement('div');
  row.className = 'lay-row'
    + (node === doc.selected ? ' on' : '')
    + (node.isGroup ? ' group' : '');
  row.dataset.uid = uidOf(node);
  row.style.paddingLeft = (4 + depth * 14) + 'px';

  const exp = document.createElement('button');
  exp.className = 'lay-exp';
  if (node.isGroup) {
    exp.textContent = node.expanded ? '▾' : '▸';
    exp.title = node.expanded ? '收起' : '展开';
    exp.onclick = e => {
      e.stopPropagation();
      node.expanded = !node.expanded;
      renderLayers();
    };
  } else {
    exp.classList.add('ghost');
  }

  const eye = document.createElement('button');
  eye.className = 'lay-eye' + (node.visible ? ' on' : '');
  eye.textContent = node.visible ? '◉' : '○';
  eye.title = node.visible ? '隐藏' : '显示';
  eye.onclick = e => {
    e.stopPropagation();
    node.visible = !node.visible;
    renderLayers();
    redraw();
  };

  const thumb = document.createElement('canvas');
  thumb.className = 'lay-thumb';
  thumb.width = thumb.height = 32;
  paintThumb(thumb, node);

  const name = document.createElement('span');
  name.className = 'lay-name';
  name.textContent = node.name;
  name.title = node.name + '（双击改名）';
  name.ondblclick = e => { e.stopPropagation(); startRename(node, name); };

  row.append(exp, eye, thumb, name);
  // 此处**不可**调用 renderLayers()：若重建整棵树，
  // 第一次点击即替换该元素，第二次点击落在新元素上，浏览器不会识别为双击。
  row.onclick = () => selectNode(node);
  row.addEventListener('pointerdown', e => startLayerDrag(e, node));
  return row;
}

/* 画布 2D 原生支持的混合模式，名称使用中文 */
const BLEND_MODES = [
  ['source-over', '正常'],
  ['multiply', '正片叠底'],
  ['screen', '滤色'],
  ['overlay', '叠加'],
  ['darken', '变暗'],
  ['lighten', '变亮'],
  ['color-dodge', '颜色减淡'],
  ['color-burn', '颜色加深'],
  ['hard-light', '强光'],
  ['soft-light', '柔光'],
  ['difference', '差值'],
  ['exclusion', '排除'],
  ['hue', '色相'],
  ['saturation', '饱和度'],
  ['color', '颜色'],
  ['luminosity', '明度'],
];

function doDelete(node) {
  op('图层', '删除', node && node.name);
  /* 删除是数据丢失级操作，必须进撤销栈。
   * 节点对象被移出树时仍持有自身像素，撤销只需挂回即可完整恢复。 */
  const pending = history.beginStructure(doc);
  if (doc.deleteNode(node)) {
    history.commitStructure(pending, '删除图层');
    renderLayers();
    redraw();
  }
}

/* 不透明度滑杆在拖动过程中会持续触发回调。
 * 此处以 300ms 静默期合并为一条结构记录：拖动结束（或停手）后统一入栈，
 * 避免一次拖动产生数十条撤销记录，稀释历史。 */
const attrCommitTimers = new WeakMap();

function scheduleAttrCommit(node) {
  const prev = attrCommitTimers.get(node);
  if (prev) clearTimeout(prev);
  attrCommitTimers.set(node, setTimeout(() => {
    attrCommitTimers.delete(node);
    const pending = node._opPending;
    node._opPending = null;
    if (pending) history.commitStructure(pending, '不透明度');
  }, 300));
}

/* 在选中行下方挂载属性条：不透明度 / 混合模式 / 删除。
 * 置于行下方而非行内部 —— 行内嵌入下拉框与滑杆会使树结构变形，且无法正常拖拽。 */
function layerProps(node) {
  const wrap = document.createElement('div');
  wrap.className = 'lay-props';
  wrap.dataset.for = uidOf(node);

  const op = new Slider({
    label: '不透明度', min: 0, max: 100, step: 1,
    value: Math.round(node.opacity * 100),
    onChange: v => {
      /* 滑杆连续拖动会触发大量回调；用下方标记合并成一条撤销记录，
       * 仅在本次交互结束时入栈，避免历史被稀释。 */
      if (!node._opPending) node._opPending = history.beginStructure(doc);
      node.opacity = v / 100;
      scheduleAttrCommit(node);
      redraw();
    },
  });
  op.el.classList.add('lp-op');

  const mdRow = document.createElement('div');
  mdRow.className = 'lp-row';

  const sel = document.createElement('select');
  sel.className = 'lp-mode';
  for (const [value, label] of BLEND_MODES) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = node.mode;
  sel.onchange = () => {
    const pending = history.beginStructure(doc);
    node.mode = sel.value;
    history.commitStructure(pending, '混合模式');
    redraw();
  };

  const del = document.createElement('button');
  del.className = 'btn icon lp-del';
  del.textContent = '×';
  del.title = node.isGroup ? '删除组（连同里面的图层）' : '删除图层';
  del.onclick = e => { e.stopPropagation(); doDelete(node); };

  mdRow.append(sel, del);
  wrap.append(op.el, mdRow);
  return wrap;
}

/* 渲染属性条到固定槽位。
 * 槽位位于滚动容器之外，因此属性条不会遮住任何图层行。
 * node 为空时清空槽位。 */
function renderPropsSlot(node) {
  const slot = $('lay-props-slot');
  if (!slot) return;
  slot.innerHTML = '';
  if (node) slot.appendChild(layerProps(node));
}

/* 仅更新选中态：刷新高亮并将属性条移至新选中行下方，
 * 其余行元素保持不变（双击重命名依赖这一行为）。 */
function selectNode(node) {
  doc.select(node);
  if (doc.maskMode) setMaskMode(false);
  const box = $('layers');
  box.querySelectorAll('.lay-row').forEach(r => {
    r.classList.toggle('on', r.dataset.uid === uidOf(node));
  });
  /* 属性条渲染在滚动容器之外的固定槽位。
   * 此前它作为 #layers 的首个子元素并设 position: sticky，滚动时会盖住
   * 滚到它下方的行 —— 行的眼睛按钮正好在最左侧，被遮后无法点击。
   * 移到槽位后属性条不参与滚动，行永远滚不到它下面。 */
  renderPropsSlot(node);
}

function renderLayers() {
  const box = $('layers');
  box.innerHTML = '';
  renderPropsSlot(doc.selected);
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      box.appendChild(layerRow(n, depth));
      if (!n.isGroup && n.mask) box.appendChild(maskRow(n, depth + 1));
      if (n.isGroup && n.expanded) walk(n.children, depth + 1);
    }
  };
  walk(doc.root.children, 0);
}

/* 蒙版单独占一行：点击进入 / 退出蒙版模式，缩略图为黑底白，遮住范围可直接判读 */
function maskRow(node, depth) {
  const row = document.createElement('div');
  row.className = 'lay-row mask-row' + (doc.maskMode && doc.activeLeaf === node ? ' on' : '');
  row.dataset.maskFor = uidOf(node);
  row.style.paddingLeft = (4 + depth * 14) + 'px';

  const exp = document.createElement('span');
  exp.className = 'lay-exp ghost';

  const icon = document.createElement('span');
  icon.className = 'lay-eye on';
  icon.textContent = '◐';
  icon.title = '蒙版';

  const thumb = document.createElement('canvas');
  thumb.className = 'lay-thumb mask';
  thumb.width = thumb.height = 32;
  paintMaskThumb(thumb, node);

  const name = document.createElement('span');
  name.className = 'lay-name';
  name.textContent = '蒙版';
  name.title = '点一下进入蒙版模式（画笔=遮住，橡皮=恢复）';

  row.append(exp, icon, thumb, name);
  row.onclick = () => {
    doc.select(node);
    setMaskMode(true);
    renderLayers();
  };
  return row;
}

/* ---- 拖拽：将图层移入组、移出组、上下换位 ---- */
let dragState = null;

function startLayerDrag(e, node) {
  if (typeof e.button === 'number' && e.button !== 0) return;
  if (e.target.closest('button')) return;      // 眼睛 / 展开箭头不触发拖动
  if (e.preventDefault) e.preventDefault();    // 别让浏览器顺手选中一行行文字
  dragState = { node, x0: e.clientX, y0: e.clientY, active: false, target: null };
  window.addEventListener('pointermove', onLayerDragMove);
  window.addEventListener('pointerup', onLayerDragEnd, { once: true });
}

function hitLayerTarget(cx, cy) {
  const box = $('layers');

  // 属性条并非行，落入其上时按「插入到该行之后」处理
  for (const p of box.querySelectorAll('.lay-props')) {
    const r = p.getBoundingClientRect();
    if (cy < r.top || cy > r.bottom) continue;
    const node = nodeById.get(p.dataset.for);
    if (!node) continue;
    const parent = node.parent || doc.root;
    return { row: null, parent, index: parent.children.indexOf(node) + 1, into: false };
  }

  for (const row of box.querySelectorAll('.lay-row')) {
    const r = row.getBoundingClientRect();
    if (cy < r.top || cy > r.bottom || cx < r.left - 40 || cx > r.right + 40) continue;
    const node = nodeById.get(row.dataset.uid);
    if (!node) continue;
    const rel = (cy - r.top) / r.height;
    // 组的中段 = 移入该组
    if (node.isGroup && rel > 0.28 && rel < 0.72) {
      return { row, parent: node, index: 0, into: true };
    }
    const parent = node.parent || doc.root;
    const i = parent.children.indexOf(node);
    const above = rel < 0.5;
    return { row, parent, index: above ? i : i + 1, into: false, pos: above ? 'top' : 'bottom' };
  }
  // 落在列表下方空白区域：放置到根节点最底部
  return { row: null, parent: doc.root, index: doc.root.children.length, into: false };
}

function onLayerDragMove(e) {
  if (!dragState) return;
  if (!dragState.active) {
    if (Math.abs(e.clientX - dragState.x0) + Math.abs(e.clientY - dragState.y0) < 5) return;
    dragState.active = true;
    const el = layerRowEl(dragState.node);
    if (el) el.classList.add('dragging');
  }
  const t = hitLayerTarget(e.clientX, e.clientY);
  dragState.target = t;

  const box = $('layers');
  box.querySelectorAll('.lay-row')
    .forEach(r => r.classList.remove('drop-into', 'drop-top', 'drop-bottom'));
  if (!t || !t.row) return;
  t.row.classList.add(t.into ? 'drop-into' : ('drop-' + t.pos));
}

function onLayerDragEnd() {
  window.removeEventListener('pointermove', onLayerDragMove);
  const st = dragState;
  dragState = null;
  $('layers').querySelectorAll('.lay-row')
    .forEach(r => r.classList.remove('drop-into', 'drop-top', 'drop-bottom', 'dragging'));
  if (!st || !st.active || !st.target) return;
  const t = st.target;
  const pending = history.beginStructure(doc);
  if (doc.moveNode(st.node, t.parent, t.index)) {
    if (t.parent.isGroup && !t.parent.expanded) t.parent.expanded = true;
    history.commitStructure(pending, '图层重排');
    renderLayers();
    redraw();
  }
}

/* 面板折叠：点击标题展开 / 收起，点击标题内的按钮不触发折叠 */
document.querySelectorAll('.panel > h3').forEach(h => {
  h.onclick = e => {
    if (e.target.closest('button')) return;
    h.parentElement.classList.toggle('collapsed');
  };
});

$('btn-add-layer').onclick = () => {
  const pending = history.beginStructure(doc);
  doc.addLayer();
  history.commitStructure(pending, '新建图层');
  op('图层', '新建', doc.activeLeaf && doc.activeLeaf.name);
  renderLayers(); redraw();
};
$('btn-add-group').onclick = () => {
  const pending = history.beginStructure(doc);
  doc.addGroup();
  history.commitStructure(pending, '新建组');
  op('图层', '新建组');
  renderLayers(); redraw();
};

/* 撤销 / 重做的按钮绑定统一置于下方命令分发处，不在此处重复绑定 */

window.addEventListener('keydown', e => {
  // 在输入框中打字时，b / e / v / m 等按键不应被识别为工具切换
  const el = e.target;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
    // 仅放行 Esc（取消）与 Enter（已各自处理）
    if (e.key !== 'Escape') return;
  }
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) doRedo();
    else doUndo();
  }
  const k = e.key.toLowerCase();
  if (meta && k === 's') { e.preventDefault(); doSave(e.shiftKey); return; }
  if (meta && k === 'o') { e.preventDefault(); doOpen(); return; }
  if (meta && e.shiftKey && k === 'd') { e.preventDefault(); openDevConsole(); return; }
  if (meta && e.shiftKey && k === 'r') { e.preventDefault(); location.reload(); return; }
  if (meta && e.shiftKey && k === 'o') { e.preventDefault(); toggleReference(); return; }
  if (!meta && TOOL_KEYS[k]) { setTool(TOOL_KEYS[k]); }
  if (!meta && k === 'x') { swapColors(); }
  if (e.key === 'Enter' && floating) { e.preventDefault(); commitFloating(); return; }
  if (e.key === 'Escape') {
    if (floating) { cancelFloating(); return; }
    if (doc.selection) { doc.selection = null; requestPaint(); }
    if (doc.maskMode) setMaskMode(false);
  }
});

/* ---------- 导出 ---------- */
async function doExport() {
  const ex = host.exporters.get('png');
  if (!ex) return;
  const blob = await ex.run(doc);
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = (docName === '未命名' ? 'achipaint' : docName) + '.png';
  a.click();
  /* 不可立即释放：Safari 在 click() 之后才真正开始读取 blob，
   * 同步 revoke 会导致下载中断。fileio.js 中的下载兜底同样延迟释放，
   * 此处保持一致（审计结论 audit/2026-11-20-audit.md 第 2.4 节）。 */
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  bus.emit('export:done', { id: 'png' });
}

/* ---------- 调试钩子（开发期使用，便于在控制台检查状态） ---------- */
/* doc 可被重建（在启动浮层选择尺寸会替换它），因此必须使用 getter，
 * 否则调试钩子将始终指向第一张画布。 */
window.__achi = {
  get doc() { return doc; },
  brush, history, host, bus, redraw, requestPaint, hk,
  newDocument, doOpen, doSave, doExport, runCommand,
  get rotateLayer() { return rotateLayer; },
  get commitMove() { return commitMove; },
  /* 压感判定的测试入口：跨笔画状态，用例需要能重置 */
  pressureOf, resetPressureObs, settlePressureObs,
  get penPressureUsable() { return penPressureUsable; },
  set penPressureUsable(v) { penPressureUsable = v; },
  /* 浮动选区：供测试与调试脚本走真实路径（拖动本身由手势层驱动） */
  liftSelection: () => liftSelection(),
  commitFloating: () => commitFloating(),
  cancelFloating: () => cancelFloating(),
  get floating() { return floating; },
  moveFloating(dx, dy) {
    if (!floating) return false;
    floating.x += dx;
    floating.y += dy;
    floating.moved = true;
    requestPaint();
    return true;
  },
  get devconsole() { return mainConsole; },
  isAchiFile, openImageAsDocument,

  /* 控制台自测：不经过文件对话框，直接以内存中的数据走一遍真实路径 */
  async selfTestImage() {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    const g = c.getContext('2d');
    g.fillStyle = '#2b6cb0'; g.fillRect(0, 0, 320, 240);
    g.fillStyle = '#e2453d'; g.fillRect(40, 40, 120, 80);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await openImageAsDocument(bytes, '自测图.png');
    return `成功，新文档 ${doc.w}×${doc.h}，图层 ${doc.root.children.map(n => n.name).join('/')}`;
  },

  async selfTestRoundtrip() {
    const blob = await serialize(doc, { app: VERSION });
    const { doc: back } = await parse(await blob.arrayBuffer());

    const sizeOk = back.w === doc.w && back.h === doc.h;

    /* 仅比对尺寸等同于未测试：旧格式的缺陷正是「尺寸正确、像素错误」。
     * 此处逐瓦片比对 alpha 与颜色，任何一处不一致即判定失败。 */
    const leaves0 = [], leaves1 = [];
    const w0 = ns => ns.forEach(n => (n.isGroup ? w0(n.children) : leaves0.push(n)));
    const w1 = ns => ns.forEach(n => (n.isGroup ? w1(n.children) : leaves1.push(n)));
    w0(doc.root.children);
    w1(back.root.children);

    let diff = 0, tiles = 0;
    for (let i = 0; i < leaves0.length; i++) {
      const a = leaves0[i], b = leaves1[i];
      if (!b) { diff++; continue; }
      for (const [k, t] of a.canvas.tiles) {
        const tb = b.canvas.tiles.get(k);
        if (!tb) continue;                       // 空块本来就不存
        tiles++;
        const da = t.ctx.getImageData(0, 0, 256, 256).data;
        const db = tb.ctx.getImageData(0, 0, 256, 256).data;
        for (let j = 0; j < da.length; j += 4) {
          if (da[j] !== db[j] || da[j + 3] !== db[j + 3]) { diff++; break; }
        }
      }
    }

    const ok = sizeOk && diff === 0;
    return `${blob.size} 字节 · ${doc.w}×${doc.h} · ${tiles} 块瓦片 · ` + (ok ? '像素一致' : `有 ${diff} 处不一致！`);
  },
};

/* ---------- hokusai 载入 ---------- */
/* 撤销钩子：overlay 变化即扩拍，压入图层之前相关像素已保存完毕 */
hk.onRegion = (x0, y0, x1, y1) => {
  if (pending) history.grabRegion(pending, x0, y0, x1, y1);
};

async function initHokusai() {
  const sel = $('b-preset');
  const jsons = {};
  try {
    await Promise.all(Object.entries(HOKUSAI_PRESETS).map(async ([file, label]) => {
      const r = await fetch('./brushes/' + file + '.myb', { cache: 'no-store' });
      if (!r.ok) throw new Error(file + '.myb ' + r.status);
      jsons[label] = await r.text();
    }));
  } catch (e) {
    console.error('[hokusai] 预设下载失败，继续用内置笔刷：', e);
    if (sel) { sel.innerHTML = '<option>内置笔刷</option>'; sel.disabled = true; }
    syncBrushControls();
    return;
  }

  const ok = await hk.load(jsons);
  if (!ok) {
    if (sel) { sel.innerHTML = '<option>内置笔刷</option>'; sel.disabled = true; }
    syncBrushControls();
    return;
  }

  /* 默认预设必须固定。jsons 由 Promise.all 并发 fetch 得到，
   * 键序取决于完成顺序且每次不同 —— 若不显式固定，
   * 每次启动的默认笔刷都会变化。 */
  hk.setPreset(Object.values(HOKUSAI_PRESETS)[0]);

  if (sel) {
    sel.innerHTML = '';
    // 顺序同样依照 HOKUSAI_PRESETS，不使用并发 fetch 产生的键序
    for (const name of Object.values(HOKUSAI_PRESETS)) {
      if (!hk.presets.has(name)) continue;
      const o = document.createElement('option');
      o.value = name; o.textContent = name;
      sel.appendChild(o);
    }
    sel.value = hk.name;
    sel.onchange = () => hk.setPreset(sel.value);
    syncBrushControls();
  }
}

/* ---------- 侧栏宽度 ----------
 * 拖动左边缘调整宽度，结果存储于 localStorage。
 * 拖动过程中仅修改变量并把画布元素拉满（视觉上跟随），
 * 松手后才重新计算画布像素 —— 逐帧重算等同于逐帧整张重新合成，开销过大。
 */
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;
let sidebarW = 260;

function applySidebarWidth(w) {
  sidebarW = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));
  $('sidebar').parentElement.style.setProperty('--sidebar-w', sidebarW + 'px');
  return sidebarW;
}

/* 色轮宽度随侧栏变化，但增幅受限。
 * 侧栏的瓶颈在「高度」而非「宽度」，色轮显著增大将把下方图层面板挤出可视区域。
 * 侧栏为 260 时色轮为 176，随宽度增加最多增至 220。
 */
function wheelSizeFor(w) {
  const content = w - 24;                 // 面板左右内边距
  const prefer = 176 + Math.max(0, w - 260) * 0.35;
  return Math.round(Math.min(content - 26, Math.max(176, Math.min(220, prefer))));
}

try {
  const saved = Number(localStorage.getItem('achi.sidebarW'));
  if (saved) applySidebarWidth(saved);
} catch { /* 隐私模式读不了，用默认值 */ }
picker.resize(wheelSizeFor(sidebarW));   // 存过宽度的话，色轮一开始就是大的

(function bindSidebarGrip() {
  const grip = $('sidebar-grip');
  if (!grip) return;

  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarW;
    grip.classList.add('dragging');
    try { grip.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }

    const onMove = ev => {
      applySidebarWidth(startW - (ev.clientX - startX));
      const r = $('stage').getBoundingClientRect();
      view.style.width = r.width + 'px';
      view.style.height = r.height + 'px';
    };

    const onUp = () => {
      grip.classList.remove('dragging');
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      try { localStorage.setItem('achi.sidebarW', String(sidebarW)); } catch { /* 忽略 */ }
      resize();                                  // 真重算画布尺寸
      picker.resize(wheelSizeFor(sidebarW));
    };

    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp, { once: true });
    grip.addEventListener('pointercancel', onUp, { once: true });
  });
})();

/* ---------- 保存 / 打开 ----------
 * 打开时的关键约束：**必须先完整解析成功，再替换当前文档**。
 * 若解析中途抛出异常，用户当前画布内容不会发生任何变化。
 */
/* 轻量提示条。不可写入状态栏 —— paint() 每帧都会将 st-mem 重置为「撤销 X MB」，
 * 错误信息在一帧内即被覆盖。 */
function toast(msg, kind) {
  let el = document.getElementById('achi-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'achi-toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle('error', kind === 'error');
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 7000 : 3200);
}

/* 忙碌态：整体变暗 + 转圈光标，图标保持不变 */
function setBusy(btn, on) {
  if (!btn) return;
  btn.classList.toggle('busy', on);
  btn.disabled = on;
}

function showFileError(title, err) {
  const detail = err instanceof AchiFileError
    ? `[${err.code}] ${err.message}`
    : String(err && err.message || err);
  console.error(title, err);
  toast(title + '：' + detail, 'error');
}

function setDocName(name) {
  docName = name || '未命名';
  const el = $('docinfo');
  if (el) el.textContent = docName;
}

async function doSave(forceDialog = false) {
  const btn = $('btn-save');
  /* 仅修改状态，不得改动按钮内容：这些按钮内部为 <svg>，没有 textContent，
   * 一旦赋值 textContent = '保存中…' 将删除整个图标，且 finally 中也无法恢复。 */
  setBusy(btn, true);
  try {
    const blob = await serialize(doc, {
      app: VERSION,
      brush: {
        size: brush.size, opacity: brush.opacity, flow: brush.flow,
        hardness: brush.hardness, spacing: brush.spacing, stabilize: brush.stabilize,
        color: brush.color,
      },
    });
    const r = await saveFile(blob, { name: docName, forceDialog });
    if (r.saved) {
      op('文件', '保存', r.name + (r.path ? '' : '(无路径)'));
      // 仅在保存成功时修改文件名；降级为下载时保留原名
      if (!r.download) setDocName(r.name.replace(/\.achi$/i, ''));
      markDirty(false);
      pushRecent({ name: r.name, path: r.path || null, w: doc.w, h: doc.h });
      // 明确告知用户保存位置 —— 缺少反馈时无法判断是否已保存
      toast(r.path
        ? `已保存：${r.path}`
        : r.download ? `已下载：${r.name}` : `已保存：${r.name}`);
    }
    return r.saved;
  } catch (e) {
    showFileError('保存失败', e);
    return false;
  } finally {
    setBusy(btn, false);
  }
}

/* 装载一份已解析完成的文档。调用方须保证 parse 已成功。 */
/* 判断是否为 .achi：仅检查前 4 个字节的 magic，不依据扩展名推断 */
function isAchiFile(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0x41 && bytes[1] === 0x43 && bytes[2] === 0x48 && bytes[3] === 0x49;
}

/* 将普通图片转换为新文档：尺寸随图片，图片铺在背景层上。
 * 这是描图与参考最常用的入口 —— 打开图片即可在其上继续绘制。 */
async function openImageAsDocument(bytes, name) {
  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([bytes]));
  } catch {
    throw new AchiFileError('这个文件既不是 .achi 也不是能识别的图片', 'BAD_FILE');
  }

  if (bmp.width < 1 || bmp.height < 1 || bmp.width > 12000 || bmp.height > 12000) {
    bmp.close?.();
    throw new AchiFileError(`图片尺寸不合理：${bmp.width}×${bmp.height}`, 'BAD_IMAGE');
  }

  const imgDoc = new Doc(bmp.width, bmp.height, { background: 'white' });
  const bg = imgDoc.root.children[0];
  bg.name = name.replace(/\.[^.]+$/, '');   // 图层名跟着文件名走，比都叫「背景」有用
  // ctx 已平移至整图坐标，直接整张绘制，由浏览器按块裁剪
  bg.canvas.forEachTileInBounds(0, 0, bmp.width, bmp.height, ctx => {
    ctx.drawImage(bmp, 0, 0);
  });
  bg.canvas.markDirty(0, 0, bmp.width, bmp.height);
  bmp.close?.();

  installDocument(imgDoc, name.replace(/\.[^.]+$/, ''), null, { fitView: true });
  toast(`已导入图片：${name}（${imgDoc.w} × ${imgDoc.h}）`);
}

/**
 * @param {object} opts
 *   opts.fitView  对未携带视图参数的文档（如图片导入）需适应窗口，
 *                 否则沿用默认 view 将从左上角按 100% 展开，无法完整显示。
 */
function installDocument(loaded, name, path, opts = {}) {
  // 浮动块挂载在旧图层上，切换文档前必须丢弃，否则会写入已废弃的瓦片
  if (floating) { floating = null; syncFloatBar(); }

  /* 释放上一份文档占用的资源。
   * 审计结论（audit/2026-11-20-audit.md 第 1.3 节）：原先仅置空 hk.canvas，
   * wasm 内存依赖 FinalizationRegistry 回收，反复切换文档会持续增长。
   * dispose() 主动释放 wasm 侧的画布与笔刷对象。
   * dispose 会清空 hk.doc，因此必须在挂载新文档之前调用。 */
  if (typeof hk.dispose === 'function') hk.dispose();
  else { hk.canvas = null; hk.current = null; }

  /* nodeById 以节点 id 为键缓存节点引用。旧文档的节点已无用途，
   * 不清空会让被删除 / 被替换的图层无法被回收。 */
  nodeById.clear();

  doc = loaded;
  hk.doc = doc;

  history.stack = [];
  history.index = -1;
  history.bytes = 0;
  history.structCount = 0;
  stroke = null;
  pending = null;
  gesture = null;

  setDocName(name.replace(/\.achi$/i, ''));
  markDirty(false);
  $('st-size').textContent = doc.w + ' × ' + doc.h;
  renderLayers();

  pushRecent({ name: name, path: path || null, w: doc.w, h: doc.h });

  /* 任一入口装载文档后，启动浮层都应收起 —— 包括拖拽导入路径。
   * 置于此处而非每个调用点，是因为遗漏调用的后果是浮层持续存在。 */
  if (splashRef) splashRef.hide();

  /* 必须调用 redraw() 而非 requestPaint()：新文档的 dirtyTiles 为空，
   * flushDirty 不会执行任何操作，doc.off 中仍保留上一张画的画面，
   * 表现为「打开后一片空白，执行任一操作后才显示」。
   * fit() 内部已调用 redraw，因此走 fit 路径时无需重复调用。 */
  if (opts.fitView) fit();
  else redraw();
}

/* 统一的「按字节打开」入口：文件对话框、最近列表、拖拽均走此处。
 * 返回 true 表示文档已实际切换。 */
async function openFromBuffer(buffer, name, path) {
  const bytes = new Uint8Array(buffer);

  // 图片走另一条路径：新建同尺寸文档，并将图片铺在底层
  if (bytes.length < 4 || !isAchiFile(bytes)) {
    await openImageAsDocument(bytes, name);
    return true;
  }

  const { doc: loaded, warnings } = await parse(buffer);
  installDocument(loaded, name, path);
  toast(`已打开：${name}`);
  if (warnings && warnings.length) console.warn('[打开] 有告警：', warnings);
  return true;
}

async function doOpen(fromPath) {
  const btn = $('btn-open');
  setBusy(btn, true);
  try {
    const picked = fromPath
      ? await openByPath(fromPath)
      : await openFile();
    if (!picked) return false;
    op('文件', '打开', picked.name);
    return await openFromBuffer(picked.buffer, picked.name, picked.path);
  } catch (e) {
    showFileError('打开失败', e);
    return false;
  } finally {
    setBusy(btn, false);
  }
}


/* ---------- 命令 ----------
 * 标题栏图标、网页菜单、Electron 原生菜单与键盘快捷键最终都汇总到该分发器。
 * 新增命令只需修改此处与 ui/menubar.js 中的 COMMANDS。
 */
let splashRef = null;

function openNewDialog() {
  if (splashRef) {
    splashRef.show();
    splashRef.backToList();
    splashRef.refreshRecent();
  }
}

function runCommand(id) {
  switch (id) {
    case 'file:new':     openNewDialog(); return;
    case 'file:open':    doOpen(); return;
    case 'file:save':    doSave(false); return;
    case 'file:saveAs':  doSave(true); return;
    case 'file:export':  doExport(); return;
    case 'edit:undo':    doUndo(); return;
    case 'edit:redo':    doRedo(); return;
    case 'edit:clearSel':
      if (doc.selection) { doc.selection = null; requestPaint(); }
      return;
    case 'view:fit':     fit(); redraw(); return;
    case 'view:100':     setZoom(1); return;
    case 'view:in':      setZoom(doc.view.zoom * 1.25); return;
    case 'view:out':     setZoom(doc.view.zoom / 1.25); return;
    case 'view:console': openDevConsole(); return;
    case 'view:reference': toggleReference(); return;
    case 'debug:reload': location.reload(); return;
    case 'debug:markAll':
      doc.markAllDirty(); redraw(); toast('已强制全量重绘'); return;
    case 'debug:testImage':
      window.__achi.selfTestImage().then(r => toast(r)).catch(e => showFileError('导入测试失败', e));
      return;
    case 'debug:testRoundtrip':
      window.__achi.selfTestRoundtrip().then(r => toast(r)).catch(e => showFileError('往返测试失败', e));
      return;
    default: console.warn('未知命令', id);
  }
}

/* 以画布中心为基准调整缩放，避免内容移出视野 */
function setZoom(z) {
  const stage = $('stage').getBoundingClientRect();
  const cx = (stage.width / 2 - doc.view.x) / doc.view.zoom;
  const cy = (stage.height / 2 - doc.view.y) / doc.view.zoom;
  const next = Math.max(0.02, Math.min(16, z));
  doc.view.zoom = next;
  doc.view.x = stage.width / 2 - cx * next;
  doc.view.y = stage.height / 2 - cy * next;
  redraw();
}

/* 撤销 / 重做后必须重建图层面板：结构变更会改动图层树，
 * 仅调用 redraw() 只刷新画布，面板会与实际状态不一致。 */
function doUndo() {
  if (!history.undo(doc.activeLeaf && doc.activeLeaf.canvas)) return;
  renderLayers();
  refreshThumbs(true);
  redraw();
}
function doRedo() {
  if (!history.redo(doc.activeLeaf && doc.activeLeaf.canvas)) return;
  renderLayers();
  refreshThumbs(true);
  redraw();
}

$('btn-new').onclick = () => runCommand('file:new');
$('btn-save').onclick = () => runCommand('file:save');
$('btn-open').onclick = () => runCommand('file:open');
$('btn-undo').onclick = () => runCommand('edit:undo');
$('btn-redo').onclick = () => runCommand('edit:redo');
$('btn-export').onclick = () => runCommand('file:export');

const menubar = new MenuBar($('tb-menus'), runCommand);


/* Electron 原生菜单触发的命令由此处处理 */
if (window.achiFile && window.achiFile.onMenu) {
  window.achiFile.onMenu(id => runCommand(id));
}

/* ---------- 开发者控制台 ----------
 * 使用独立窗口而非浮层：浮层会遮挡画布，并与主界面争夺焦点。
 * 子窗口通过 window.opener.__achi 读取主窗口状态（同源，可直接访问）。
 */
let consoleWin = null;

/* 日志缓冲自启动时即存在 —— 否则「打开控制台之前发生的事件」将完全缺失，
 * 而这部分往往最为关键（崩溃与报错通常发生在打开控制台之前）。 */
const mainConsole = {
  logs: [],
  push(level, args) {
    const text = args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    this.logs.push({ level, text, t: Date.now() });
    // shift 每次需搬移 2000 个元素；改为达到上限后一次性裁剪一批
    if (this.logs.length > 2200) this.logs = this.logs.slice(-2000);
  },
  clear() { this.logs = []; },
};

/* 窗口之间使用 BroadcastChannel 通信：
 * Electron 中窗口由主进程创建（window.open 会被弹窗拦截），无法获取 opener；
 * 浏览器中 window.open 可用，但统一走频道比维护两条路径更简单。 */
const consoleBus = (() => {
  try { return new BroadcastChannel('achi-console'); } catch { return null; }
})();

function consoleSnapshot() {
  const perf = window.__achiPerf || [];
  const leaves = [];
  const walk = ns => ns.forEach(n => n.isGroup ? walk(n.children) : leaves.push(n));
  walk(doc.root.children);
  return {
    type: 'state',
    t: Date.now(),
    logs: mainConsole.logs.slice(-300),
    perf: perf.slice(-300).map(p => ({ gap: p.gap, inputLag: p.inputLag, frame: p.frame })),
    heap: performance.memory ? performance.memory.usedJSHeapSize : null,
    canvas: (() => { const c = $('view'); return c ? [c.width, c.height] : null; })(),
    doc: {
      w: doc.w, h: doc.h,
      background: doc.background,
      zoom: doc.view.zoom,
      viewX: doc.view.x, viewY: doc.view.y,
      selection: doc.selection,
      active: doc.activeLeaf ? doc.activeLeaf.name : null,
      layers: leaves.map(l => ({
        name: l.name, visible: l.visible !== false,
        opacity: l.opacity, mode: l.mode, tiles: l.canvas.tiles.size,
      })),
    },
    history: { steps: history.stack.length, bytes: history.bytes },
    hkReady: !!(hk && hk.ready),
    isElectron: !!window.achiFile,
    recents: (() => { try { return JSON.parse(localStorage.getItem('achi.recent') || '[]'); } catch { return []; } })(),
  };
}

if (consoleBus) {
  consoleBus.onmessage = async ev => {
    const msg = ev.data || {};
    if (msg.type === 'poll') {
      consoleBus.postMessage(consoleSnapshot());
      return;
    }
    if (msg.type === 'test') {
      try {
        let result;
        if (msg.id === 'image') result = await window.__achi.selfTestImage();
        else if (msg.id === 'roundtrip') result = await window.__achi.selfTestRoundtrip();
        else if (msg.id === 'markAll') { doc.markAllDirty(); redraw(); result = '已强制全量重绘'; }
        consoleBus.postMessage({ type: 'testResult', id: msg.id, ok: true, result });
      } catch (e) {
        consoleBus.postMessage({ type: 'testResult', id: msg.id, ok: false, result: String(e) });
      }
      return;
    }
    if (msg.type === 'clear') {
      mainConsole.clear();
    }
  };
}

async function openDevConsole() {
  if (window.achiFile && window.achiFile.openConsole) {
    await window.achiFile.openConsole();      // Electron：主进程建窗
    return;
  }
  if (consoleWin && !consoleWin.closed) { consoleWin.focus(); return; }
  consoleWin = window.open(
    './devconsole.html',
    'achi-devconsole',
    'width=600,height=560,menubar=no,toolbar=no,location=no,status=no'
  );
  if (!consoleWin) toast('控制台窗口被拦截了，允许一下弹窗', 'error');
}

/* 四个级别全部收集 —— 控制台「全部」页需呈现操作流水，不能仅保留警告与错误 */
for (const level of ['log', 'info', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    mainConsole.push(level, args);
  };
}

/* 关键操作单独记录：文件、文档、工具、变换。
 * 这些不属于 error，但出现问题时「最后执行的操作」往往才是线索。 */
/**
 * 操作流水：并非错误，但「最后执行的操作」往往是定位问题的线索。
 * 用法：op('图层', '新建', name) —— 第一个参数为类别。
 */
function op(cat, ...parts) {
  mainConsole.push('op', ['[' + cat + '] ' + parts.join(' ')]);
}

/* ---------- 全局操作捕获 ----------
 * 仅依赖手动埋点会有遗漏，而遗漏的那一步可能正是表现为正常行为的缺陷。
 * 此处统一记录点击、快捷键、落笔与滚轮事件，宁可冗余也不遗漏。
 */
window.addEventListener('click', e => {
  const t = e.target && e.target.closest
    ? e.target.closest('[data-tool], [data-cmd], button, .splash-card, .lay-row')
    : null;
  if (!t) return;
  const label = t.dataset.tool || t.dataset.cmd || t.id
    || (t.textContent || '').trim().slice(0, 14);
  op('点击', label || '(无标签)');
}, true);

window.addEventListener('keydown', e => {
  const mods = (e.metaKey ? '⌘' : '') + (e.shiftKey ? '⇧' : '') + (e.altKey ? '⌥' : '') + (e.ctrlKey ? '⌃' : '');
  const k = e.key.length === 1 ? e.key : e.key;
  // 仅记录「带修饰键」或「会改变状态的单键」；纯字母输入噪声过大
  if (mods || ['Escape', 'Enter', 'Delete', 'Backspace'].includes(k)
      || Object.prototype.hasOwnProperty.call(TOOL_KEYS, k.toLowerCase())) {
    op('按键', mods + k);
  }
}, true);

/* 滚轮缩放节流记录：一次滑动即可产生数十条日志 */
let wheelOpAt = 0;
window.addEventListener('wheel', e => {
  const now = performance.now();
  if (now - wheelOpAt < 400) return;
  wheelOpAt = now;
  op('滚轮', (e.ctrlKey || e.metaKey) ? '缩放' : '平移');
}, { capture: true, passive: true });
window.addEventListener('error', e => {
  mainConsole.push('error', [`${e.message}  @${e.filename}:${e.lineno}`]);
});
window.addEventListener('unhandledrejection', e => {
  mainConsole.push('error', ['未处理的 Promise 拒绝: ' + String(e.reason)]);
});

/* 未保存标记：当前仅在保存 / 新建 / 打开时清除，任一落笔即标记为脏 */
function markDirty(v) {
  const el = $('tb-dirty');
  if (el) el.toggleAttribute('hidden', !v);
}

/* ---------- 新建文档 ----------
 * 直接将 doc 替换为新对象，并接上唯一的外部引用（hk.doc）。
 * hk 的 surface 在尺寸变化时由 ensureSurface 自行重建；尺寸相同时需手动丢弃，
 * 否则上一张画的内容会残留其中。
 */
function newDocument(w, h, opts = {}) {
  if (floating) { floating = null; syncFloatBar(); }
  doc = new Doc(w, h, { background: opts.background });
  op('文档', '新建', w + '×' + h + (opts.background === 'transparent' ? ' 透明' : ''));

  hk.doc = doc;
  hk.canvas = null;
  hk.current = null;
  /* 上一份文档可能正处于绘制中：若不终止，drawEnd 会把残留笔迹压进新文档。 */
  hk.active = false;

  /* 重置撤销栈。注意 structCount 必须一并归零 ——
   * 它由 recompute() 依据栈内容维护，栈被清空后若不重置，
   * 后续的结构淘汰会以为还有大量结构记录而误删。 */
  history.stack = [];
  history.index = -1;
  history.bytes = 0;
  history.structCount = 0;

  stroke = null;
  pending = null;
  gesture = null;
  /* 选中的工具若为框选，上一份文档的选区会残留并影响后续绘制。 */
  doc.selection = null;

  setDocName(opts.name || '未命名');
  markDirty(false);
  $('st-size').textContent = doc.w + ' × ' + doc.h;
  fit();
  renderLayers();
  redraw();
}

/* ---------- 启动 ---------- */
window.addEventListener('resize', resize);
resize();
fit();
renderLayers();
/* 初始工具同样通过 setTool 设置：原实现直接写入 style.borderColor，
 * 内联样式优先级高于 .on 类，导致切换工具后画笔按钮仍保持高亮，出现两个同时高亮的按钮。 */
setTool('brush');
$('st-size').textContent = doc.w + ' × ' + doc.h;
initHokusai();

/* 启动浮层始终创建（菜单中的「新建」依赖它），但不一定显示 */
{
  const splash = splashRef = new Splash({
    defaultSize: { w: DW, h: DH },
    canOpenRecent: canOpenByPath(),
    onPick: (w, h, extra) => newDocument(w, h, extra || {}),
    onRemoveRecent: async (entry, alsoDeleteFile) => {
      if (alsoDeleteFile && entry.path) {
        try {
          await deleteFile(entry.path);
        } catch (e) {
          toast('删除文件失败：' + (e && e.message || e), 'error');
          // 文件删除失败时不要同时移除记录，否则用户将无法定位该文件
          return;
        }
      }
      removeRecent(entry);
      splash.refreshRecent();
    },
    /* 仅在打开成功时收起浮层：失败时（如文件损坏）保持原状，用户可继续选择其它文件 */
    onOpen: async () => { if (await doOpen()) splash.hide(); },
    onOpenRecent: async (entry) => { if (await doOpen(entry.path)) splash.hide(); },
  });
  if (!HAS_SIZE) splash.show();
}
