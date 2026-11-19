/* 装配：把核心、UI、插件接起来
 * 热路径（pointer→stroke→composite）全同步，中间不 await、不经过插件。
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

/* Electron 壳里给自绘标题栏让出红绿灯的位置，并把它变成可拖动区域。
 * 浏览器里没有这个类，所以网页版布局一个像素都不变。 */
if (/\.Electron/i.test(navigator.userAgent) || navigator.userAgent.includes('Electron')) {
  document.documentElement.classList.add('electron');
}

/* ---------- 状态 ---------- */
/* 尺寸从启动页带过来：index.html?w=2480&h=3508。
 * 没带参数就退回 A4@300dpi，保证直接打开 index.html 也能用。 */
const qs = new URLSearchParams(location.search);
/* 链接里带了尺寸就直接进画布（启动页会跳过），否则先弹启动浮层 */
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

/* hokusai 外置笔刷引擎。没载入完 / 载入失败时一律退回内置 Stroke，
 * 保证「画不出线」这种事不会因为引擎换了再发生一次。 */
const hk = new HokusaiEngine(doc);
const HOKUSAI_PRESETS = {
  brush: '基础',
  calligraphy: '书法',
  charcoal: '炭笔',
  marker_fat: '粗马克',
};

/* ---------- 视图 ---------- */
const view = $('view');
// desynchronized: 让浏览器跳过一部分合成同步，显著降低笔迹上屏延迟。
// 代价是极端情况下可能撕裂，但对绘画来说延迟比撕裂重要得多。
const vctx = view.getContext('2d', { desynchronized: true, alpha: false });
view.style.touchAction = 'none';   // 防止触屏/笔被当作滚动手势
/* 上限 2 在 Retina 上意味着视口画布有 2200×1650 物理像素，
 * 每帧要把这一整块作为图层内容交给系统合成 —— WKWebView 在这上面明显吃亏
 * （实测帧率 37fps，Chromium 同尺寸能到 60）。降到 1.5 换帧率，肉眼几乎无差。 */
/* 上限 2 在 Retina 上意味着视口画布 2200×1650 物理像素，
 * 每帧要把整块作为图层内容交给系统合成 —— 实测帧间隔 21.4ms（47fps），
 * 掉到 60fps 以下就会「不跟手」。降到 1.5 换帧率，肉眼几乎无差。 */
let dpr = Math.min(window.devicePixelRatio || 1, 1.5);

function resize() {
  const r = $('stage').getBoundingClientRect();
  view.width = r.width * dpr;
  view.height = r.height * dpr;
  view.style.width = r.width + 'px';
  view.style.height = r.height + 'px';
  redraw();
}

/* ---------- 渲染：每帧一次，只搬离屏缓冲 ---------- */
let rafId = 0;
let needFrame = false;
/* 用「有没有挂着一帧」这个布尔量来去重，而不是靠 rafId 是否为 0。
 * WKWebView 在页面刚加载完、窗口还没真正上屏时，会把已排队的 rAF 回调丢掉；
 * 如果这时拿 rafId 当锁，锁就永远解不开了 —— 之后每次 requestPaint 都直接 return，
 * 画面再也不更新。真机上表现为「画得出来但看着发闷」。 */
let framePending = false;
let frameQueuedAt = 0;

/* 透明背景的棋盘格。按 8px 一格画一张小图再平铺，比每帧画几千个矩形便宜。 */
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

/* 性能探针：记录每帧合成耗时，以及「最近一次指针事件 → 这一帧画完」的间隔。
 * 只在 window.__achiPerf 存在时记录，默认不占开销。 */
const perfSamples = [];
let lastPointerAt = 0;
let lastPaintAt = 0;
function perfMark() {
  if (!window.__achiPerf) return;
  const now = performance.now();
  const rec = { frame: 0, inputLag: 0, gap: 0 };
  if (perfMark._t0) rec.frame = now - perfMark._t0;
  if (lastPointerAt) rec.inputLag = now - lastPointerAt;
  if (lastPaintAt) rec.gap = now - lastPaintAt;
  lastPaintAt = now;
  perfSamples.push(rec);
  if (perfSamples.length > 300) perfSamples.shift();
  window.__achiPerf = perfSamples;
}

function paint() {
  rafId = 0;
  needFrame = false;
  framePending = false;
  perfMark._t0 = performance.now();

  /* 把攒了一帧的笔迹先搬进覆盖层，再合成。
   * 顺序不能反：flushDirty 需要读 overlay。 */
  if (hk.active) hk.flush();

  // 先把脏块合进离屏缓冲（只处理变过的块）
  doc.collectDirty();
  doc.flushDirty();

  const r = $('stage').getBoundingClientRect();
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  // alpha:false 的画布不能用 clearRect（会留黑），改填背景色
  vctx.fillStyle = '#14161a';
  vctx.fillRect(0, 0, view.width, view.height);
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const { x, y, zoom } = doc.view;

  /* 关键优化：只画「视口里看得见的那一小块源区域」。
   * 以前是 vctx.drawImage(doc.off, 0, 0) —— 每帧把整张 2480×3508
   * 缓冲（8.7 兆像素）完整缩放一遍，M1 也扛不住，手感就糊了。
   * 现在算出视口在文档坐标里的矩形，只取这一块去画。
   */
  const r2 = $('stage').getBoundingClientRect();
  const viewLeft = -x / zoom;            // 视口左上角在文档里的坐标
  const viewTop = -y / zoom;
  const viewW = r2.width / zoom;
  const viewH = r2.height / zoom;

  // 与文档范围求交，并留 1px 余量避免边缘缝
  const sx = Math.max(0, Math.floor(viewLeft) - 1);
  const sy = Math.max(0, Math.floor(viewTop) - 1);
  const ex = Math.min(doc.w, Math.ceil(viewLeft + viewW) + 1);
  const ey = Math.min(doc.h, Math.ceil(viewTop + viewH) + 1);

  if (ex > sx && ey > sy) {
    vctx.translate(x, y);
    vctx.scale(zoom, zoom);

    // 纸底只画可见那块。透明背景铺棋盘格，否则铺白。
    if (doc.background === 'transparent') {
      const pat = checkerPattern(vctx);
      vctx.fillStyle = pat || '#ffffff';
    } else {
      vctx.fillStyle = '#ffffff';
    }
    vctx.fillRect(sx, sy, ex - sx, ey - sy);

    vctx.imageSmoothingEnabled = zoom < 1;
    vctx.drawImage(doc.off, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy);

    // 浮动选区画在最上面，跟手走
    if (floating) {
      const fcx = floating.x + floating.w / 2;
      const fcy = floating.y + floating.h / 2;

      vctx.save();
      vctx.translate(fcx, fcy);
      vctx.rotate(floating.angle * Math.PI / 180);
      vctx.drawImage(floating.canvas, -floating.w / 2, -floating.h / 2);
      vctx.restore();

      /* 变换框：跟内容一起转的虚线框 + 四角手柄。
       * 这才是「选中了」的可视信号 —— 只有一个底部滑块的话，看不出选中了哪一块。 */
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

    // 框选：拖拽中的实时框 + 已确定的框
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

/* 请求一帧：合并同一帧内的多次请求，绝不重复绘制 */
function requestPaint() {
  const now = performance.now();
  /* 排队超过 400ms 还没画出来，说明那一帧被丢了（WKWebView 在页面刚加载完、
   * 窗口还没上屏时会把已排队的 rAF 回调吞掉）。这时候必须重排，
   * 否则标志位永远卡着，后续所有请求都被去重掉，画面彻底不更新。 */
  if (framePending && now - frameQueuedAt < 400) return;
  framePending = true;
  frameQueuedAt = now;
  rafId = requestAnimationFrame(paint);
}

/* 完整重绘（视图变化时才用，代价大） */
function redraw() {
  doc.markAllDirty();
  requestPaint();
}

/* 鼠标没有压感，e.pressure 恒为 0.5。
 * 直接喂给 .myb 笔刷会得到一条发丝线 —— 人家的压力曲线是按 0~1 设计的，
 * 0.5 在 radius 曲线上只有 -0.35，直径直接砍一半还多。
 * 所以只有笔才用真实压力，鼠标一律按满压。 */
function pressureOf(e) {
  if (e.pointerType === 'pen') return e.pressure > 0 ? e.pressure : 0.5;
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
  // 只认左键（笔尖也是 0）。右键/中键不该落笔
  if (e.button !== undefined && e.button !== 0) return;
  lastPointerAt = performance.now();
  // 脚本合成的 PointerEvent 没有真实 pointer 可捕获，会抛 NotFoundError。
  // 真机上捕获失败也不该让整个落笔流程断掉。
  try { view.setPointerCapture(e.pointerId); } catch { /* 合成事件或已释放 */ }
  const p = toDoc(e);
  const pressure = pressureOf(e);

  /* 非绘画工具：先接走，别进下面的笔画流程 */
  if (tool === 'hand') {
    gesture = { kind: 'hand', cx: e.clientX, cy: e.clientY, vx: doc.view.x, vy: doc.view.y };
    return;
  }
  if (tool === 'zoom') {
    zoomAt(e.clientX, e.clientY, e.altKey ? 1 / 1.3 : 1.3);
    return;
  }
  if (tool === 'select') {
    // 已经浮着一块：在它里面就拖，在外面就落下并重新框选
    if (floating) {
      if (p.x >= floating.x && p.x <= floating.x + floating.w
        && p.y >= floating.y && p.y <= floating.y + floating.h) {
        gesture = { kind: 'float-move', x0: p.x, y0: p.y, fx: floating.x, fy: floating.y };
        return;
      }
      commitFloating();
    }

    // 有选区，且点在选区里 → 拎起来
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

    /* 已经浮着一块：在它里面就继续拖，否则先落下 */
    if (floating) {
      if (p.x >= floating.x && p.x <= floating.x + floating.w
        && p.y >= floating.y && p.y <= floating.y + floating.h) {
        gesture = { kind: 'float-move', x0: p.x, y0: p.y, fx: floating.x, fy: floating.y };
        return;
      }
      commitFloating();
    }

    /* 点中哪一笔就拎哪一笔 —— 用连通块近似「一笔」。
     * 点空白处（没连通内容）才退回整层移动。 */
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
     * 用包围盒中心而不是画布中心 —— 内容偏在一角时，绕画布中心转会甩出去。 */
    if (e.altKey && bounds) {
      // 浮着一块就转这一块，否则才转整层
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
  // 蒙版上画的是「透明度」，颜色固定白色，只有 alpha 有意义
  /* 蒙版是 alpha 通道：alpha=255 显示、0 遮住。
   * 但用户（和 PS）的直觉是「涂黑就遮住」，所以按笔刷颜色的**亮度**换算 alpha：
   * 黑色 → 全遮，白色 → 全显，灰色 → 半透明。 */
  // 蒙版上只画 alpha：一律白色，靠 erase 决定是 255 还是 0
  const paintBrush = doc.maskMode ? { ...brush, color: '#ffffff' } : brush;

  if (tool === 'pick') {
    // 吸色：读合成后的像素
    const r = view.getBoundingClientRect();
    const px = Math.round((e.clientX - r.left) * dpr);
    const py = Math.round((e.clientY - r.top) * dpr);
    const d = vctx.getImageData(px, py, 1, 1).data;
    const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    setColor(hex);
    return;
  }

  // 橡皮：Stroke 自己走 destination-out
  // 开笔零成本：不拍任何像素，只建一个空记录。
  // 真正动到某块时才给它拍快照（Stroke 里的 onFirstTouch 回调）。
  pending = history.beginStroke(layer);

  /* 画笔走 hokusai（.myb 笔刷）；橡皮、蒙版模式、以及引擎没就位时都走内置引擎。
   * 蒙版必须走内置的：hokusai 只认 HSV 颜色，做不出 alpha，也就擦不掉。 */
  if (tool === 'brush' && hk.ready && !doc.maskMode) {
    const ok = hk.begin(p.x, p.y, pressure, tiltOpts(e, p));
    if (ok) { markDirty(true); op('落笔', tool, Math.round(p.x) + ',' + Math.round(p.y)); requestPaint(); bus.emit('stroke:begin', { x: p.x, y: p.y }); return; }
  }

  stroke = new Stroke(paintBrush, layer);
  // 落笔时把「这一笔可能覆盖的区域」原样抓下来；笔移动越界会继续补拍
  stroke.onRegion = (x0, y0, x1, y1) => history.grabRegion(pending, x0, y0, x1, y1);
  stroke.clip = doc.selection;
  /* 蒙版是 alpha 通道（255=显示，0=遮住）。
   * 工具语义要反过来才对得上直觉：在蒙版上「画」= 擦掉内容，橡皮才是恢复。 */
  const eraseWanted = doc.maskMode ? (tool !== 'eraser') : (tool === 'eraser');
  if (eraseWanted) stroke.erase = true;
  stroke.begin(p.x, p.y, pressure);   // begin 内部已落第一个点
  requestPaint();
  bus.emit('stroke:begin', { x: p.x, y: p.y });
});

/* 交给 hokusai 的这笔参数。笔倾斜只有 pen 才有（pointerType === 'pen'），
 * 鼠标/触摸一律按 0 喂 —— libmypaint 的 tilt 约定是 [-1, 1]，事件里是角度。 */
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

/* .myb 笔刷自带「流量 / 硬度 / 间距」，这三项在 hokusai 里没有对外接口。
 * 与其让它们看着能用，不如在画笔模式下明确关掉；换回橡皮（内置引擎）再打开。 */
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
  const p = toDoc(e);
  $('st-pos').textContent = Math.round(p.x) + ', ' + Math.round(p.y);

  if (gesture) { gestureMove(e); return; }

  // 合并事件：高刷屏不丢点。注意 getCoalescedEvents() 可能返回空数组
  // （没有合并点、或事件来自脚本合成），此时必须退回原始事件，
  // 否则这一下 move 直接被吞掉，线就画不出来。
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
    /* 这里**不** flush。
     * pump() 一次要搬几十个 64×64 块（实测 p90 8.5ms），而压感笔约 4ms 一个事件 ——
     * 在事件里搬就会越搬越积。改成把落块推迟到 paint 前，一帧只搬一次。 */
    requestPaint();
    return;
  }

  if (!stroke) return;
  for (const ev of evts) {
    const q = toDoc(ev);
    stroke.move(q.x, q.y, pressureOf(ev));
  }
  // 只请求一帧，不在这里重绘 —— 事件再多，一帧也只画一次
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
    if (pending) history.commit(pending);
    op('抬笔', tool, '历史 ' + history.stack.length);
    pending = null;
    bus.emit('stroke:end', {});
    requestPaint();
    return;
  }
  if (!stroke) return;
  stroke.end();
  if (pending) history.commit(pending);
  op('抬笔', tool, '历史 ' + history.stack.length);

  stroke = null; pending = null;
  bus.emit('stroke:end', {});
  requestPaint();
}

view.addEventListener('pointerup', endStroke);
view.addEventListener('pointercancel', endStroke);

/* ---------- 参考图窗 ----------
 * 钉一张图在旁边对着画。可拖、可缩放、可换图。
 * 它和画布上的文档互不相干 —— 只是「看得见」，不进任何图层。
 */
const refWin = $('reference');
const refImg = $('ref-img');
const refEmpty = $('ref-empty');
const refBody = $('ref-body');
const refZoom = $('ref-zoom');
let refScale = 1;
let refUrl = null;

/* 上边 38px 是 macOS 红绿灯，左边 48px 是工具栏 —— 参考窗别压上去 */
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
    // 布局完成后校正一次：拖过的地方可能已经跑到标题栏底下了
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
  // 按图片原始宽度定窗宽，但不超过屏的 40%
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

/* 拖进这个面板就是换参考图；拖到画布上仍然走「打开文档」 */
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
 * 整张画的缩略图 + 当前视口框。点哪跳哪。
 * 缩略图要重画整个 doc.off，所以节流到 8fps —— 再快纯属浪费。
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
  // 缩略图不需要平滑，省点
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
  // 视口比整张画还大时不画框（全看清了，框没意义）
  navFrame.style.opacity = (fw >= cw - 1 && fh >= ch - 1) ? '0' : '1';
}

/* 点/拖导航器 → 把那里挪到视口中心 */
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
 * 拖 .achi 就是打开，拖图片就是新建同尺寸文档 —— 和文件对话框同一套入口。
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

/* ---------- 点选连通块 ----------
 * 图层是像素，没有「笔画对象」。但一笔画出来的东西在像素上是**连通的**，
 * 所以用泛洪找出点中的那一块，取它的包围盒 —— 这就约等于「选中这一笔」。
 * 点空白处返回 null，调用方退回整层移动。
 */
function layerImageData(tc) {
  const cv = newCanvas(tc.w, tc.h);
  const ctx = cv.getContext('2d');
  for (const t of tc.tiles.values()) ctx.drawImage(t.canvas, t.col * TILE, t.row * TILE);
  return ctx.getImageData(0, 0, tc.w, tc.h);
}

/**
 * 从 (sx,sy) 泛洪，返回连通块的包围盒。
 * 用扫描线填充，比逐像素 BFS 快一个量级。
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
    // 向左扩到边界
    while (xl > 0 && !seen[py * W + xl - 1] && d[at(xl - 1, py)] >= 8) xl--;
    // 向右扩
    while (xr < W - 1 && !seen[py * W + xr + 1] && d[at(xr + 1, py)] >= 8) xr++;

    if (xl < minX) minX = xl;
    if (xr > maxX) maxX = xr;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;

    for (let x = xl; x <= xr; x++) seen[py * W + x] = 1;

    // 上下两行找新的种子
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
 * 框选一块，把它从图层里拎出来：可以拖、可以转，松手才落回去。
 * 这是「移动单个/多个笔画」的现实做法 —— 底子是像素，没有笔画对象，
 * 所以选择的范围就是一块内容，而不是某一笔。
 */
let floating = null;   // { canvas, x, y, w, h, angle, tc, rect, moved }

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/* 把选区那一块从图层搬到浮动画布上，并清空原处 */
function liftSelection() {
  const sel = doc.selection;
  // paintTarget 本身就是 TileCanvas（不是 Layer），别再取一次 .canvas
  const tc = doc.paintTarget;
  if (!sel || !tc) return false;

  const x = Math.round(sel.x0), y = Math.round(sel.y0);
  const w = Math.max(1, Math.round(sel.x1 - sel.x0));
  const h = Math.max(1, Math.round(sel.y1 - sel.y0));
  if (w < 1 || h < 1) return false;

  const cv = newCanvas(w, h);
  const fctx = cv.getContext('2d');

  // 从图层逐块拷过来（瓦片是 256×256，按块坐标搬）
  for (let r = Math.floor(y / TILE); r <= Math.floor((y + h - 1) / TILE); r++) {
    for (let c = Math.floor(x / TILE); c <= Math.floor((x + w - 1) / TILE); c++) {
      const t = tc.tiles.get(c + ',' + r);
      if (!t) continue;
      fctx.drawImage(t.canvas, c * TILE - x, r * TILE - y);
    }
  }

  // 原地挖掉
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

/* 落回图层：先按当前角度画进临时图，再贴回去 */
function commitFloating() {
  if (!floating) return;
  const f = floating;
  floating = null;
  syncFloatBar();

  const tc = f.tc;
  /* 临时画布要按**旋转后**的包围盒来开，不能还用原尺寸 ——
   * 否则 45° 转完四个角直接被裁掉，而且不可恢复。 */
  const rad = f.angle * Math.PI / 180;
  const ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad));
  const tw = Math.max(1, Math.ceil(f.w * ca + f.h * sa));
  const th = Math.max(1, Math.ceil(f.w * sa + f.h * ca));

  const tmp = newCanvas(tw, th);
  const tctx = tmp.getContext('2d');
  tctx.translate(tw / 2, th / 2);
  tctx.rotate(rad);
  tctx.drawImage(f.canvas, -f.w / 2, -f.h / 2);

  // 绕中心转，所以中心不变：左上角 = 中心 - 新尺寸/2
  const left = Math.round(f.x + f.w / 2 - tw / 2);
  const top = Math.round(f.y + f.h / 2 - th / 2);

  tc.forEachTileInBounds(left, top, left + tw - 1, top + th - 1, ctx => {
    ctx.drawImage(tmp, left, top);
  });
  tc.markDirty(0, 0, doc.w, doc.h);

  if (f.pending) history.commit(f.pending);
  redraw();
  toast('已放置');
}

/* 取消：原样放回 */
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

/* 浮动的旋转条 */
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
 * 拖动时不重采样（8.7M 像素每帧都做会卡死），只显示角度；
 * 松手才真正转一次。
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
 * 把整层绕内容中心旋转 deg 度，重采样后写回瓦片。
 * 注意不是块级旋转 —— 旋转后每块的内容来自任意方向，只能整层重采样。
 */
function rotateLayer(node, deg) {
  const tc = node.canvas;
  const b = boundsOf(tc);
  if (!b) return;

  const pending = history.beginStroke(tc);
  history.grabRegion(pending, 0, 0, doc.w, doc.h);

  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;

  /* 两步：先无变换地把整层无缝合并，再一次性旋转。
   * 直接对每块做旋转 drawImage 的话，每块边缘都落在非整数位置，
   * 相邻块插值不一致 → 一条条浅色缝。 */
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

  // flat 已经用完了，立刻放手：大画布上它值 35MB
  flat.width = 0;
  flat.height = 0;

  // 写回瓦片
  const old = [...tc.tiles.values()].map(t => ({ col: t.col, row: t.row, canvas: t.canvas }));
  tc.tiles.clear();
  for (let r = 0; r < tc.rows; r++) {
    for (let c = 0; c < tc.cols; c++) {
      const tw = Math.min(TILE, doc.w - c * TILE);
      const th = Math.min(TILE, doc.h - r * TILE);
      if (tw <= 0 || th <= 0) continue;
      /* 每块向外多取 1px 重叠。
       * 精确取 tw×th 时相邻块之间会留一条亚像素缝（旋转后特别明显）。 */
      const ox0 = c * TILE, oy0 = r * TILE;
      const sx = Math.max(0, ox0 - 1), sy = Math.max(0, oy0 - 1);
      const sw = Math.min(tmp.width - sx, tw + 2), sh = Math.min(tmp.height - sy, th + 2);
      const t = tc.tile(c, r);
      t.ctx.drawImage(tmp, sx, sy, sw, sh, sx - ox0, sy - oy0, sw, sh);
    }
  }
  if (node.mask) { /* 蒙版跟着转会更复杂，先不动，留给自由变换统一做 */ }

  tc.markDirty(0, 0, doc.w, doc.h);
  if (pending) history.commit(pending);
  op('变换', '旋转', Math.round(deg) + '°');
  redraw();
  toast(`已旋转 ${deg >= 0 ? '+' : ''}${Math.round(deg)}°`);
}

/* ---------- 平移缩放 ---------- */
view.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const r = view.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const old = doc.view.zoom;
    const next = Math.max(0.02, Math.min(16, old * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    // 以鼠标为锚点缩放
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
  // 浮着一块时切工具，先把它落回图层，否则它会一直挂在那儿
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

/* 把某个 TileCanvas 整体平移 dx,dy。
 * 注意是「原地换内容」而不是换对象 —— history 里握着这个 TileCanvas 的引用，
 * 换对象的话撤销读到的「改完」快照就还是旧的。 */
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

function boundsOf(tc) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of tc.tiles.values()) {
    x0 = Math.min(x0, t.col * TILE);
    y0 = Math.min(y0, t.row * TILE);
    x1 = Math.max(x1, t.col * TILE + TILE);
    y1 = Math.max(y1, t.row * TILE + TILE);
  }
  return x1 > x0 ? { x0, y0, x1, y1 } : null;
}

function commitMove(node, dx, dy) {
  if (!dx && !dy) return;
  const target = node.canvas;
  const b = boundsOf(target);
  if (!b) return;

  // 撤销：旧位置 ∪ 新位置
  const pending = history.beginStroke(target);
  history.grabRegion(pending,
    Math.min(b.x0, b.x0 + dx), Math.min(b.y0, b.y0 + dy),
    Math.max(b.x1, b.x1 + dx), Math.max(b.y1, b.y1 + dy));

  op('变换', '移动', dx + ', ' + dy);
  translateTiles(target, dx, dy);
  if (node.mask) translateTiles(node.mask, dx, dy);

  target.markDirty(0, 0, doc.w, doc.h);
  if (node.mask) node.mask.markDirty(0, 0, doc.w, doc.h);
  history.commit(pending);
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
      // 拖浮动块：直接改角度，实时预览（这才是「够实时」）
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
    // 只重画「旧位置 ∪ 新位置」那一块，别整张重合成
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
 * 整条能拖、数字压在条上、滚轮和方向键都能改。
 * 这里只负责「UI 值 → 笔刷真实值」的换算（大多要除以 100）。
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
 * 色轮 + 明度竖条 + RGB/HSV 切换 + 三根通道条。
 * 这里只做「取色器 ↔ 笔刷颜色 / hex 框 / 色块」的同步。
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

/* 主色 / 副色：两个槽，取色器编辑的是「当前槽」。 */
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

/* 切到另一个槽时，界面跟着切到那个颜色 */
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

/* 原生取色器和 hex 框：改的都是「当前槽」的颜色 */
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
 * 只做「透明度蒙版」：笔画落在蒙版上，白 = 看得见，空 = 抠掉。
 * 合成时先把这个图层画到暂存，再 destination-in 蒙版。
 */
function setMaskMode(on) {
  const l = doc.layer;
  if (on && l && !l.mask) l.ensureMask();
  doc.maskMode = !!(on && l && l.mask);
  $('btn-mask').classList.toggle('on', doc.maskMode);
  redraw();
}

$('btn-mask').onclick = () => setMaskMode(!doc.maskMode);

/* ---------- 图层树 ----------
 * 显示顺序就是 children 的顺序（children[0] 在最上面），合成时倒着走。
 * 行可以拖：拖到组的中间段 = 放进组里，拖到行上/下半 = 插到它前面/后面。
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

/* 双击名字原地改名。空名字不接受，Esc 放弃。 */
function startRename(node, span) {
  const inp = document.createElement('input');
  inp.className = 'lay-rename';
  inp.value = node.name;
  span.textContent = '';
  span.appendChild(inp);
  inp.focus();
  inp.select();

  /* 守卫：inp.remove() 会同步触发 blur，blur 又调一次 done，
   * 第二次 remove 就抛 NotFoundError。只认第一次。 */
  let finished = false;
  const done = commit => {
    if (finished) return;
    finished = true;
    const v = inp.value.trim();
    if (commit && v) node.name = v;
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

  const name = document.createElement('span');
  name.className = 'lay-name';
  name.textContent = node.name;
  name.title = node.name + '（双击改名）';
  name.ondblclick = e => { e.stopPropagation(); startRename(node, name); };

  row.append(exp, eye, name);
  // 这里**不能**调 renderLayers()：整棵树重建的话，
  // 第一次点击就把这个元素换掉了，第二次点在新元素上，浏览器不会认成双击。
  row.onclick = () => selectNode(node);
  row.addEventListener('pointerdown', e => startLayerDrag(e, node));
  return row;
}

/* 画布 2D 原生支持的混合模式，名字用中文 */
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
  if (doc.deleteNode(node)) {
    renderLayers();
    redraw();
  }
}

/* 选中那一行下面挂一条属性：不透明度 / 混合模式 / 删除。
 * 放在行下面而不是行里面 —— 行里塞下拉框和滑杆会把树挤变形，拖拽也没法做了。 */
function layerProps(node) {
  const wrap = document.createElement('div');
  wrap.className = 'lay-props';
  wrap.dataset.for = uidOf(node);

  const op = new Slider({
    label: '不透明度', min: 0, max: 100, step: 1,
    value: Math.round(node.opacity * 100),
    onChange: v => { node.opacity = v / 100; redraw(); },
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
  sel.onchange = () => { node.mode = sel.value; redraw(); };

  const del = document.createElement('button');
  del.className = 'btn icon lp-del';
  del.textContent = '×';
  del.title = node.isGroup ? '删除组（连同里面的图层）' : '删除图层';
  del.onclick = e => { e.stopPropagation(); doDelete(node); };

  mdRow.append(sel, del);
  wrap.append(op.el, mdRow);
  return wrap;
}

/* 只换选中态：更新高亮 + 把属性条挪到新选中的行下面，
 * 其它行元素保持原样（双击改名依赖这一点）。 */
function selectNode(node) {
  doc.select(node);
  if (doc.maskMode) setMaskMode(false);
  const box = $('layers');
  box.querySelectorAll('.lay-row').forEach(r => {
    r.classList.toggle('on', r.dataset.uid === uidOf(node));
  });
  // 属性条固定在列表顶部（吸顶），不进到行之间 ——
  // 插在选中行下面会让它后面所有行往下跳，下一次点击就点空了。
  box.querySelectorAll('.lay-props').forEach(p => p.remove());
  box.prepend(layerProps(node));
}

function renderLayers() {
  const box = $('layers');
  box.innerHTML = '';
  if (doc.selected) box.appendChild(layerProps(doc.selected));
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      box.appendChild(layerRow(n, depth));
      if (n.isGroup && n.expanded) walk(n.children, depth + 1);
    }
  };
  walk(doc.root.children, 0);
}

/* ---- 拖拽：把图层挪进组、挪出组、上下换位 ---- */
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

  // 属性条不是行，落在它上面就当「插到那一行后面」
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
    // 组的中间一段 = 放进这个组
    if (node.isGroup && rel > 0.28 && rel < 0.72) {
      return { row, parent: node, index: 0, into: true };
    }
    const parent = node.parent || doc.root;
    const i = parent.children.indexOf(node);
    const above = rel < 0.5;
    return { row, parent, index: above ? i : i + 1, into: false, pos: above ? 'top' : 'bottom' };
  }
  // 落在列表下方空白：放到根的最底下
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
  if (doc.moveNode(st.node, t.parent, t.index)) {
    if (t.parent.isGroup && !t.parent.expanded) t.parent.expanded = true;
    renderLayers();
    redraw();
  }
}

/* 面板折叠：点标题收放，点标题里的按钮不算 */
document.querySelectorAll('.panel > h3').forEach(h => {
  h.onclick = e => {
    if (e.target.closest('button')) return;
    h.parentElement.classList.toggle('collapsed');
  };
});

$('btn-add-layer').onclick = () => {
  doc.addLayer(); op('图层', '新建', doc.activeLeaf && doc.activeLeaf.name);
  renderLayers(); redraw();
};
$('btn-add-group').onclick = () => {
  doc.addGroup(); op('图层', '新建组');
  renderLayers(); redraw();
};

/* 撤销/重做的按钮绑定统一放在下面的命令分发处，别在这里再绑一次 */

window.addEventListener('keydown', e => {
  // 在输入框里打字时，b/e/v/m 这些不该被当成工具切换
  const el = e.target;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
    // 只放行 Esc（取消）和 Enter（已经各自处理）
    if (e.key !== 'Escape') return;
  }
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) { if (history.redo(doc.layer.canvas)) redraw(); }
    else { if (history.undo(doc.layer.canvas)) redraw(); }
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
  a.href = URL.createObjectURL(blob);
  a.download = (docName === '未命名' ? 'achipaint' : docName) + '.png';
  a.click();
  URL.revokeObjectURL(a.href);
  bus.emit('export:done', { id: 'png' });
}

/* ---------- 调试钩子（开发期用，方便在控制台查状态） ---------- */
/* doc 是可重建的（启动浮层选尺寸会换掉它），所以这里必须用 getter，
 * 否则调试钩子永远指着第一张画布。 */
window.__achi = {
  get doc() { return doc; },
  brush, history, host, bus, redraw, requestPaint, hk,
  newDocument, doOpen, doSave, doExport, runCommand,
  get rotateLayer() { return rotateLayer; },
  get devconsole() { return mainConsole; },
  isAchiFile, openImageAsDocument,

  /* 控制台里的自测：不经过文件对话框，直接用内存里的数据走一遍真实路径 */
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
    const before = [doc.w, doc.h];
    const { doc: back } = await parse(await blob.arrayBuffer());
    const ok = back.w === before[0] && back.h === before[1];
    return `${blob.size} 字节 · ${before.join('×')} → ${back.w}×${back.h} ${ok ? '一致' : '不一致！'}`;
  },
};

/* ---------- hokusai 载入 ---------- */
/* 撤销的钩子：overlay 一变就扩拍，压图层之前那些像素已经存好了 */
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

  /* 默认预设必须固定。jsons 是 Promise.all 并发 fetch 出来的，
   * 谁先到谁先进对象，键序每次都不一样 —— 不钉死的话，
   * 每次打开默认笔刷都在换人。 */
  hk.setPreset(Object.values(HOKUSAI_PRESETS)[0]);

  if (sel) {
    sel.innerHTML = '';
    // 顺序也照 HOKUSAI_PRESETS 来，别用并发 fetch 留下的键序
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
 * 拖动左边缘改宽度，结果存 localStorage。
 * 拖动过程中只改 CSS 变量 + 把画布元素拉满（视觉上跟手），
 * 松手才真的重算画布像素 —— 每帧重算等于每帧整张重合成，太贵。
 */
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;
let sidebarW = 260;

function applySidebarWidth(w) {
  sidebarW = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));
  $('sidebar').parentElement.style.setProperty('--sidebar-w', sidebarW + 'px');
  return sidebarW;
}

/* 色轮跟着宽度走，但只长一点。
 * 侧栏缺的是「高度」不是「宽度」，轮子长大一截就把下面的图层面板顶出去了。
 * 260 时还是 176，越宽最多长到 220。 */
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
 * 打开时最关键的一条：**先完整解析成功，再替换当前文档**。
 * 解析中途抛异常的话，用户手上这张画一个字都不会动。
 */
/* 轻量提示条。不能写状态栏 —— paint() 每帧都会把 st-mem 改回「撤销 X MB」，
 * 错误信息一帧就被冲掉了。 */
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

/* 忙碌态：变暗 + 转圈光标，图标原样留着 */
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
  /* 只改状态，绝不动内容：这几个按钮里是 <svg>，没有 textContent，
   * 一旦 textContent = '保存中…' 就把图标整个删了，finally 也恢复不回来。 */
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
      // 保存成功才改名字；下载兜底时保留原名
      if (!r.download) setDocName(r.name.replace(/\.achi$/i, ''));
      markDirty(false);
      pushRecent({ name: r.name, path: r.path || null, w: doc.w, h: doc.h });
      // 明确告诉用户存哪了 —— 没有反馈的话「存了没」根本看不出来
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

/* 把一份解析好的文档装上。调用方保证 parse 已经成功。 */
/* 判断是不是 .achi：只看前 4 个字节的 magic，别猜扩展名 */
function isAchiFile(bytes) {
  return bytes.length >= 4
    && bytes[0] === 0x41 && bytes[1] === 0x43 && bytes[2] === 0x48 && bytes[3] === 0x49;
}

/* 把一张普通图片变成新文档：尺寸跟图走，图铺在背景层上。
 * 这是描图/参考最常见的入口 —— 打开一张图就能在上面接着画。 */
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
  // ctx 已经平移到整图坐标，直接整张画，浏览器会按块裁
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
 *   opts.fitView  没有自带视图的文档（图片导入的）要适应窗口，
 *                 否则沿用默认 view 就从左上角按 100% 摊开，一眼看不全。
 */
function installDocument(loaded, name, path, opts = {}) {
  // 浮动块挂在旧图层上，换文档前必须丢掉，否则会往已废弃的瓦片上写
  if (floating) { floating = null; syncFloatBar(); }
  doc = loaded;
  hk.doc = doc;
  hk.canvas = null;
  hk.current = null;

  history.stack = [];
  history.index = -1;
  history.bytes = 0;
  stroke = null;
  pending = null;
  gesture = null;

  setDocName(name.replace(/\.achi$/i, ''));
  markDirty(false);
  $('st-size').textContent = doc.w + ' × ' + doc.h;
  renderLayers();

  pushRecent({ name: name, path: path || null, w: doc.w, h: doc.h });

  /* 任何入口装上了文档，启动浮层都该收起 —— 包括拖拽进来这条。
   * 放在这里而不是每个调用点，是因为「忘记调」的代价是浮层赖着不走。 */
  if (splashRef) splashRef.hide();

  /* 必须 redraw() 而不是 requestPaint()：新文档的 dirtyTiles 是空的，
   * flushDirty 什么都不做，doc.off 里还留着上一张画的画面 ——
   * 表现就是「打开之后一片空白，动一下才出来」。
   * fit() 内部就会 redraw，所以走 fit 时不用再调一次。 */
  if (opts.fitView) fit();
  else redraw();
}

/* 统一的「从字节打开」：文件对话框、最近列表、拖拽，全走这一条。
 * 返回 true 表示真的换了文档。 */
async function openFromBuffer(buffer, name, path) {
  const bytes = new Uint8Array(buffer);

  // 图片走另一条路：新建一个同尺寸文档，图铺在底层
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
 * 标题栏图标、网页菜单、Electron 原生菜单、键盘快捷键，最后都汇到这一个分发器。
 * 加新命令只改这里 + ui/menubar.js 的 COMMANDS。
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

/* 以画布中心为基准改缩放，别让内容跑出视野 */
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

function doUndo() { if (history.undo(doc.activeLeaf.canvas)) redraw(); }
function doRedo() { if (history.redo(doc.activeLeaf.canvas)) redraw(); }

$('btn-new').onclick = () => runCommand('file:new');
$('btn-save').onclick = () => runCommand('file:save');
$('btn-open').onclick = () => runCommand('file:open');
$('btn-undo').onclick = () => runCommand('edit:undo');
$('btn-redo').onclick = () => runCommand('edit:redo');
$('btn-export').onclick = () => runCommand('file:export');

const menubar = new MenuBar($('tb-menus'), runCommand);


/* Electron 原生菜单点下来的命令走这里 */
if (window.achiFile && window.achiFile.onMenu) {
  window.achiFile.onMenu(id => runCommand(id));
}

/* ---------- 开发者控制台 ----------
 * 独立窗口，不是浮层：浮层会压住画布，而且和主界面抢焦点。
 * 子窗口通过 window.opener.__achi 读主窗口的状态（同源，直接可用）。
 */
let consoleWin = null;

/* 日志缓冲从一开始就存在 —— 否则「打开控制台之前发生的事」一条都看不到，
 * 而那恰恰是最需要看的（崩溃、报错通常发生在你还没打开控制台的时候）。 */
const mainConsole = {
  logs: [],
  push(level, args) {
    const text = args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    this.logs.push({ level, text, t: Date.now() });
    if (this.logs.length > 2000) this.logs.shift();
  },
  clear() { this.logs = []; },
};

/* 窗口之间用 BroadcastChannel 通信：
 * Electron 里窗口由主进程建（window.open 会被弹窗拦截），拿不到 opener；
 * 浏览器里 window.open 能用，但统一走频道比维护两条路省事。 */
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

/* 四个级别全收 —— 控制台「全部」页要能看到操作流水，不能只有警告和错误 */
for (const level of ['log', 'info', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    mainConsole.push(level, args);
  };
}

/* 关键操作单独记一笔：文件、文档、工具、变换。
 * 这些不是 error，但出问题时「最后一步做了什么」往往才是线索。 */
/**
 * 操作流水：不是错误，但「最后做了什么」往往才是线索。
 * 用法：op('图层', '新建', name) —— 第一段是类别。
 */
function op(cat, ...parts) {
  mainConsole.push('op', ['[' + cat + '] ' + parts.join(' ')]);
}

/* ---------- 全局操作捕获 ----------
 * 光靠手动埋点会漏 —— 漏掉的那一步恰恰可能是「伪装成正常」的那个 bug。
 * 这里把点击、快捷键、落笔、滚轮都收一份，宁可吵也别缺。
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
  // 只记「有修饰键」或「会改状态的单键」，纯字母输入太吵
  if (mods || ['Escape', 'Enter', 'Delete', 'Backspace'].includes(k)
      || Object.prototype.hasOwnProperty.call(TOOL_KEYS, k.toLowerCase())) {
    op('按键', mods + k);
  }
}, true);

/* 滚轮缩放节流记：手一滑能出几十条 */
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

/* 未保存标记：目前只在保存/新建/打开时清，笔一落就算脏 */
function markDirty(v) {
  const el = $('tb-dirty');
  if (el) el.toggleAttribute('hidden', !v);
}

/* ---------- 新建文档 ----------
 * 直接把 doc 换成新的，然后把唯一一个外部引用（hk.doc）接上。
 * hk 的 surface 尺寸变了会在 ensureSurface 里自己重建；同尺寸时要手动丢弃，
 * 否则上一张画的内容还留在里面。
 */
function newDocument(w, h, opts = {}) {
  if (floating) { floating = null; syncFloatBar(); }
  doc = new Doc(w, h, { background: opts.background });
  op('文档', '新建', w + '×' + h + (opts.background === 'transparent' ? ' 透明' : ''));

  hk.doc = doc;
  hk.canvas = null;
  hk.current = null;

  history.stack = [];
  history.index = -1;
  history.bytes = 0;

  stroke = null;
  pending = null;
  gesture = null;

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
/* 初始工具也用 setTool 走一遍：以前这里是直接写 style.borderColor，
 * 内联样式压过 .on 类，导致切走之后画笔按钮还亮着，变成两个同时高亮。 */
setTool('brush');
$('st-size').textContent = doc.w + ' × ' + doc.h;
initHokusai();

/* 启动浮层总是建出来（菜单里的「新建」要用它），只是不一定显示 */
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
          // 文件删不掉就别把记录也抹了，否则用户找不到它
          return;
        }
      }
      removeRecent(entry);
      splash.refreshRecent();
    },
    /* 打开成功才收起浮层：失败的话（坏文件）还留在原地，用户能继续选别的 */
    onOpen: async () => { if (await doOpen()) splash.hide(); },
    onOpenRecent: async (entry) => { if (await doOpen(entry.path)) splash.hide(); },
  });
  if (!HAS_SIZE) splash.show();
}
