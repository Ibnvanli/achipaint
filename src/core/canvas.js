/* 核心：分块画布
 *
 * 已修正的三类问题，修改本文件时应避免回归：
 *  1) 跨块笔点被裁切成点串 —— forEachTileInBounds 遍历包围盒内所有块
 *  2) 笔迹越出画布 —— 合成与导出均裁剪到 (0, 0, w, h)
 *  3) 每帧全量重绘过慢 —— 增加离屏合成缓存，仅刷新脏块
 */
export const TILE = 256;

let docSeq = 0;

export class TileCanvas {
  constructor(w, h) {
    this.id = ++docSeq;
    this.w = w;
    this.h = h;
    this.cols = Math.ceil(w / TILE);
    this.rows = Math.ceil(h / TILE);
    this.tiles = new Map();   // key "c,r" -> {canvas, ctx, col, row}
    this.dirty = new Set();
  }

  key(c, r) { return c + ',' + r; }

  tile(c, r) {
    const k = this.key(c, r);
    let t = this.tiles.get(k);
    if (!t) {
      const cv = document.createElement('canvas');
      cv.width = TILE; cv.height = TILE;
      t = { canvas: cv, ctx: cv.getContext('2d'), col: c, row: r };
      this.tiles.set(k, t);
    }
    return t;
  }

  markDirty(x0, y0, x1, y1) {
    const c0 = Math.max(0, Math.floor(x0 / TILE));
    const c1 = Math.min(this.cols - 1, Math.floor(x1 / TILE));
    const r0 = Math.max(0, Math.floor(y0 / TILE));
    const r1 = Math.min(this.rows - 1, Math.floor(y1 / TILE));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.dirty.add(this.key(c, r));
  }

  /* 单次笔点绘制其覆盖的全部块。
   * 若仅绘制「点中心所在的块」，跨块边界处会被裁切，大笔刷将呈现点串状。
   * fn(ctx, c, r)：每块使用各自的平移，但作用于同一整图坐标。
   */
  forEachTileInBounds(x0, y0, x1, y1, fn) {
    const T = TILE;
    const c0 = Math.max(0, Math.floor(x0 / T));
    const c1 = Math.min(this.cols - 1, Math.floor(x1 / T));
    const r0 = Math.max(0, Math.floor(y0 / T));
    const r1 = Math.min(this.rows - 1, Math.floor(y1 / T));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const t = this.tile(c, r);
        const ctx = t.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.translate(-c * T, -r * T);
        fn(ctx, c, r);
      }
    }
  }

  snapshotTile(key) {
    const t = this.tiles.get(key);
    if (!t) return null;
    return t.ctx.getImageData(0, 0, TILE, TILE);
  }

  restoreTile(key, data) {
    if (!data) { this.tiles.delete(key); return; }
    const [c, r] = key.split(',').map(Number);
    const t = this.tile(c, r);
    t.ctx.putImageData(data, 0, 0);
  }
}

/* ---------- 图层树 ----------
 * 节点的 children 按显示顺序排列：children[0] 为最上层。
 * 合成时必须反向遍历（自最底层开始叠加），顺序不可颠倒。
 */
export class LayerNode {
  constructor(name) {
    this.name = name;
    this.visible = true;
    this.opacity = 1;
    this.mode = 'source-over';
    this.parent = null;
  }
  get isGroup() { return false; }
}

export class Layer extends LayerNode {
  constructor(w, h, name = '图层') {
    super(name);
    this.w = w; this.h = h;
    this.canvas = new TileCanvas(w, h);
    /* 蒙版本身是普通 TileCanvas，仅使用其 alpha 通道：
     * 有内容 = 该处可见，为空 = 该处被抠除（destination-in）。 */
    this.mask = null;
  }
  ensureMask() {
    if (!this.mask) this.mask = new TileCanvas(this.w, this.h);
    return this.mask;
  }
}

/* 组本身不携带像素。合成时先将子节点合成到一张隔离缓冲，
 * 再按组的不透明度 / 混合模式整体叠加。这是「组」应有的语义；
 * 否则组的不透明度会使组内互相重叠的图层退化为半透明叠加。
 */
export class LayerGroup extends LayerNode {
  constructor(name = '组') {
    super(name);
    this.children = [];
    this.expanded = true;
  }
  get isGroup() { return true; }
}

/* 仅遍历叶子节点（即实际携带像素的节点） */
export function walkLeaves(nodes, fn) {
  for (const n of nodes) {
    if (n.isGroup) walkLeaves(n.children, fn);
    else fn(n);
  }
}

/* 第一个叶子节点 —— 删除节点后需要新的落点 */
export function firstLeaf(nodes) {
  for (const n of nodes) {
    if (n.isGroup) {
      const f = firstLeaf(n.children);
      if (f) return f;
    } else {
      return n;
    }
  }
  return null;
}

/* 判断某节点是否位于给定子树内 */
export function within(node, nodes) {
  for (const n of nodes) {
    if (n === node) return true;
    if (n.isGroup && within(node, n.children)) return true;
  }
  return false;
}

/* 判断 a 是否为 node 的祖先 —— 拖拽时防止将组拖入其自身 */
export function isAncestor(a, node) {
  for (let p = node.parent; p; p = p.parent) if (p === a) return true;
  return false;
}

/* ---------- 文档：图层树 + 视口 + 离屏合成缓存 ---------- */
export class Doc {
  /**
   * @param {number} w
   * @param {number} h
   * @param {{background?: 'white'|'transparent'}} opts
   *   background 仅影响「纸」的显示方式，不向图层写入像素，
   *   因此切换背景不会污染画稿；导出时据此决定是否垫白底。
   */
  constructor(w, h, opts = {}) {
    this.w = w; this.h = h;
    this.background = opts.background === 'transparent' ? 'transparent' : 'white';

    this.root = new LayerGroup('root');
    const bg = new Layer(w, h, '背景');
    bg.parent = this.root;
    this.root.children.push(bg);

    this.selected = bg;      // 面板里高亮的那一行，可以是组
    this.activeLeaf = bg;    // 画笔真正落到的图层，一定是叶子
    this._seq = 1;

    this.view = { x: 0, y: 0, zoom: 1 };

    // 离屏合成缓冲：所有图层先合成至此，重绘时只需一次 drawImage
    this.off = document.createElement('canvas');
    this.off.width = w; this.off.height = h;
    this.offctx = this.off.getContext('2d');
    this.dirtyTiles = new Set();
    this._tileScratch = [];      // 组隔离用的 256×256 暂存，按嵌套深度取

    /* 笔迹覆盖层：当前正在绘制的一笔先落于此，松手后才压入图层。
     * 外置笔刷（hokusai）在单笔范围内持续累加，若逐事件以 source-over
     * 写入图层，重叠处会被反复叠加而变黑；一次性压入可避免该问题。
     * 键为 64×64 的块（与 blocks 不同，不可混用），值为 {canvas, ctx, x, y, w, h}。
     */
    this.overlay = new Map();
    this.overlayActive = false;
    this.overlayAlpha = 1;

    /* 矩形框选：{x0, y0, x1, y1} 世界坐标。null 表示未选择。
     * 当前唯一作用：将笔画限制在框内。 */
    this.selection = null;
    /* 当前是否处于图层蒙版编辑状态（笔画写入 mask） */
    this.maskMode = false;
    /* 移动工具的实时预览：不复制像素，仅在合成时施加偏移 */
    this.previewOffset = null;
  }

  /* 笔画写入目标：蒙版模式下写入蒙版，否则写入图层 */
  get paintTarget() {
    const l = this.activeLeaf;
    if (!l) return null;
    return (this.maskMode && l.mask) ? l.mask : l.canvas;
  }

  /* 兼容保留：doc.layers 指向根节点的直接子节点 */
  get layers() { return this.root.children; }
  get layer() { return this.activeLeaf; }

  /* 选中节点；若选中的是组，画笔仍落在上一次选中的叶子上 */
  select(node) {
    this.selected = node;
    if (node && !node.isGroup) this.activeLeaf = node;
    return node;
  }

  /* 新建图层：插入到选中项上方（同一层级）；若选中的是组，则插入该组最上层 */
  addLayer() {
    const sel = this.selected || this.root;
    const parent = sel.isGroup ? sel : (sel.parent || this.root);
    const index = sel.isGroup ? 0 : Math.max(0, parent.children.indexOf(sel));
    const l = new Layer(this.w, this.h, '图层 ' + (++this._seq));
    l.parent = parent;
    parent.children.splice(index, 0, l);
    this.select(l);
    return l;
  }

  /* 新建组：若选中的是图层，则将其包裹进新组（最常用做法）；
   * 若选中的是组，则在其上方创建一个空组 */
  addGroup() {
    const sel = this.selected || this.root;
    if (sel.isGroup) {
      const parent = sel.parent || this.root;
      const g = new LayerGroup('组 ' + (++this._seq));
      g.parent = parent;
      parent.children.splice(Math.max(0, parent.children.indexOf(sel)), 0, g);
      this.select(g);
      return g;
    }
    const parent = sel.parent || this.root;
    const index = Math.max(0, parent.children.indexOf(sel));
    const g = new LayerGroup('组 ' + (++this._seq));
    g.parent = parent;
    // 先将组放到图层原位置，再把图层移入该组
    parent.children.splice(index, 0, g);
    parent.children.splice(parent.children.indexOf(sel), 1);
    g.children.push(sel);
    sel.parent = g;
    this.select(g);
    return g;
  }

  /* 移动节点。newParent 不能是其自身或其子孙节点。 */
  moveNode(node, newParent, index) {
    if (!node || !newParent) return false;
    if (node === newParent) return false;
    if (node.isGroup && isAncestor(node, newParent)) return false;
    const oldParent = node.parent || this.root;
    const oi = oldParent.children.indexOf(node);
    if (oi < 0) return false;
    oldParent.children.splice(oi, 1);
    let idx = Math.max(0, Math.min(index, newParent.children.length));
    if (oldParent === newParent && oi < idx) idx--;
    newParent.children.splice(idx, 0, node);
    node.parent = newParent;
    return true;
  }

  /* 删除节点（组将连同子孙一并删除）。
   * 必须至少保留一个叶子节点：画布上不允许没有任何可绘制的图层。 */
  deleteNode(node) {
    if (!node || node === this.root) return false;

    /* 统计「删除后剩余叶子数」。不能只判断单个图层数量：
     * 删除一个组时，组内可能包含最后一个图层，此前曾因此把画布删空。 */
    let remain = 0;
    walkLeaves(this.root.children, l => { if (!within(l, [node])) remain++; });
    if (remain === 0) return false;

    const parent = node.parent || this.root;
    const i = parent.children.indexOf(node);
    if (i < 0) return false;

    parent.children.splice(i, 1);

    // 若选中项位于被删除的子树内，则改选其它节点
    if (within(this.selected, [node]) || this.selected === node) {
      this.selected = parent.children[Math.min(i, parent.children.length - 1)]
        || firstLeaf(this.root.children) || this.root;
    }
    if (!this.activeLeaf || within(this.activeLeaf, [node]) || this.activeLeaf === node) {
      this.activeLeaf = firstLeaf(this.root.children);
    }
    // 画笔必须有落点；若确已删空，则将选中项回退至根
    if (!this.activeLeaf) {
      this.activeLeaf = firstLeaf(this.root.children);
      this.selected = this.activeLeaf || this.root;
    }
    return true;
  }

  markTileDirty(c, r) { this.dirtyTiles.add(c + ',' + r); }

  /* 按世界坐标标记脏块（覆盖层按 64×64 小块汇报，需换算回文档块） */
  markRegionDirty(x0, y0, x1, y1) {
    const c0 = Math.max(0, Math.floor(x0 / TILE));
    const c1 = Math.min(Math.ceil(this.w / TILE) - 1, Math.floor((x1 - 1) / TILE));
    const r0 = Math.max(0, Math.floor(y0 / TILE));
    const r1 = Math.min(Math.ceil(this.h / TILE) - 1, Math.floor((y1 - 1) / TILE));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.dirtyTiles.add(c + ',' + r);
  }

  /* 将各图层累积的脏块汇总到文档级，再统一刷新。 */
  collectDirty() {
    walkLeaves(this.root.children, l => {
      // 蒙版同样需要收集；若只收集 l.canvas，在蒙版上绘制的笔迹将永远不会重合成
      if (l.mask && l.mask.dirty.size) {
        l.mask.dirty.forEach(k => this.dirtyTiles.add(k));
        l.mask.dirty.clear();
      }
      if (l.canvas.dirty.size === 0) return;
      l.canvas.dirty.forEach(k => this.dirtyTiles.add(k));
      l.canvas.dirty.clear();
    });
  }

  /* 全量标记脏块 = 视口变化、撤销、图层结构变动 —— 必须整张重新合成。 */
  markAllDirty() {
    this.dirtyTiles.clear();
    const cols = Math.ceil(this.w / TILE), rows = Math.ceil(this.h / TILE);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) this.dirtyTiles.add(c + ',' + r);
    walkLeaves(this.root.children, l => l.canvas.dirty.clear());
  }

  _tileScratchFor(depth) {
    let c = this._tileScratch[depth];
    if (!c) {
      c = document.createElement('canvas');
      c.width = TILE; c.height = TILE;
      this._tileScratch[depth] = c;
    }
    return c;
  }

  /* 按图层树递归合成单块区域。
   * rx, ry 为目标画布左上角在世界坐标中的位置（doc.off 为 0,0，块暂存为 x,y）。
   * 仅当组满足「不透明度 < 1」或「混合模式不是 normal」时才需要隔离缓冲；
   * 否则直接摊平，省去一次 256×256 的搬运。
   */
  /* 将某层按 (dx, dy) 偏移绘制到「当前块」。
   *
   * 注意：不能使用 _drawStack 传入的 rx/ry 计算，该值对 doc.off 恒为 0（世界原点）；
   * 必须由 this._key 反推当前块坐标，否则计算结果始终是画面左上角附近的源块。
   *
   * 仅遍历可能重叠的源块（最多 3×3），不会退化为 O(瓦片数)。
   */
  _drawOffsetTile(n, ctx, dx, dy, ox = 0, oy = 0) {
    const T = TILE;
    const bx = (this._keyC || 0) * T, by = (this._keyR || 0) * T;   // 当前块的世界坐标

    const c0 = Math.floor((bx - dx) / T) - 1;
    const c1 = Math.floor((bx - dx + T) / T) + 1;
    const r0 = Math.floor((by - dy) / T) - 1;
    const r1 = Math.floor((by - dy + T) / T) + 1;

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const src = n.canvas.tiles.get(c + ',' + r);
        if (!src) continue;
        // ox/oy：目标画布原点（世界坐标），绘制进 scratch 时需减去
        ctx.drawImage(src.canvas, c * T + dx - ox, r * T + dy - oy);
      }
    }
  }

  _drawStack(nodes, ctx, rx, ry, depth, scratchFor) {
    /* 隔离分支使用 256×256 的 scratch，而瓦片坐标为世界坐标。
     * 若不换算到「当前块」原点，非 (0,0) 的块将被绘制到 scratch 之外，
     * 表现为「蒙版 / 组不透明度仅在左上角 256px 范围内正确」。 */
    /* 坐标由 flushDirty 直接传入 —— 每个脏块每帧执行一次 split 开销过大，
     * A4 全量重绘时 140 块即产生 140 次字符串切分与数组分配。 */
    const bx = (this._keyC || 0) * TILE;
    const by = (this._keyR || 0) * TILE;

    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (!n.visible) continue;

      if (!n.isGroup) {
        const off = (this.previewOffset && this.previewOffset.node === n) ? this.previewOffset : null;
        const dx = off ? off.dx : 0;
        const dy = off ? off.dy : 0;
        const masked = n.mask && n.mask.tiles.size > 0;

        if (!masked) {
          ctx.globalAlpha = n.opacity;
          ctx.globalCompositeOperation = n.mode;
          if (off && (dx || dy)) {
            /* 拖动预览：目标块可能需要从**相邻块**取内容。
             * 若仅绘制 this._key 对应的块，当偏移量不是 256 的整数倍时，
             * 块与块之间会出现裂口与拖影（即「拖动后残留」的成因）。 */
            this._drawOffsetTile(n, ctx, dx, dy, rx, ry);
          } else {
            const t = n.canvas.tiles.get(this._key);
            if (!t) continue;
            ctx.drawImage(t.canvas, t.col * TILE - rx + dx, t.row * TILE - ry + dy);
          }
          continue;
        }

        /* 存在蒙版时必须隔离：先将该块绘制到暂存画布，再用 destination-in 抠除蒙版外部分。
         * 若直接在主画布上执行 destination-in，会连同下方所有图层一并抠除。 */
        const s = scratchFor(depth);
        const sc = s.getContext('2d');
        sc.setTransform(1, 0, 0, 1, 0, 0);
        sc.globalAlpha = 1;
        sc.globalCompositeOperation = 'source-over';
        sc.clearRect(0, 0, s.width, s.height);

        if (off && (dx || dy)) this._drawOffsetTile(n, sc, dx, dy, bx, by);
        else {
          const t = n.canvas.tiles.get(this._key);
          if (t) sc.drawImage(t.canvas, t.col * TILE - bx + dx, t.row * TILE - by + dy);
        }

        const mt = n.mask.tiles.get(this._key);
        if (mt) {
          sc.globalCompositeOperation = 'destination-in';
          sc.drawImage(mt.canvas, mt.col * TILE - bx, mt.row * TILE - by);
          sc.globalCompositeOperation = 'source-over';
        }
        /* 蒙版该块无瓦片即表示全部可见，不做任何处理。
         * 此处曾使用 clearRect（误作「整块不可见」），后果为：
         * 蒙版上仅擦除一小块时，其余所有块都被判定为「蒙版为空」而清除，
         * 表现为「添加蒙版后一擦，整张画布内容消失」。 */
        else {
          // 保留 sc 中的内容不变
        }

        ctx.globalAlpha = n.opacity;
        ctx.globalCompositeOperation = n.mode;
        ctx.drawImage(s, bx, by);
        continue;
      }

      const iso = n.opacity < 1 || n.mode !== 'source-over';
      if (!iso) {
        this._drawStack(n.children, ctx, rx, ry, depth, scratchFor);
        continue;
      }
      const s = scratchFor(depth);
      const sc = s.getContext('2d');
      sc.setTransform(1, 0, 0, 1, 0, 0);
      sc.globalAlpha = 1;
      sc.globalCompositeOperation = 'source-over';
      sc.clearRect(0, 0, s.width, s.height);
      /* 递归进入 scratch 时将原点移至当前块：scratch 为 256×256，
       * 若继续传入 rx/ry（=0），子层内容将按世界坐标绘制，从而越出画布。 */
      this._drawStack(n.children, sc, bx, by, depth + 1, scratchFor);
      ctx.globalAlpha = n.opacity;
      ctx.globalCompositeOperation = n.mode;
      ctx.drawImage(s, bx, by);
    }
  }

  /* 仅将脏块刷新到离屏缓冲 */
  flushDirty() {
    if (this.dirtyTiles.size === 0) return;
    const T = TILE;
    const ctx = this.offctx;
    const scratchFor = d => this._tileScratchFor(d);

    for (const key of this.dirtyTiles) {
      const [c, r] = key.split(',').map(Number);
      const x = c * T, y = r * T;

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, T, T);
      ctx.clip();
      ctx.clearRect(x, y, T, T);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      this._key = key;
      this._keyC = c;
      this._keyR = r;
      this._drawStack(this.root.children, ctx, 0, 0, 0, scratchFor);
      this._key = null;

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // 正在绘制的笔迹叠加在最上层
      if (this.overlay.size) {
        ctx.globalAlpha = this.overlayAlpha;
        for (const o of this.overlay.values()) {
          if (o.x >= x + T || o.x + o.w <= x) continue;
          if (o.y >= y + T || o.y + o.h <= y) continue;
          ctx.drawImage(o.canvas, o.x, o.y, o.w, o.h);
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.dirtyTiles.clear();
  }

  /* 导出专用：完整合成一次，并裁剪到画布范围（不越界）。
   * 此处的隔离缓冲为整张画布大小，仅在导出时分配。 */
  composite(targetCtx, dpr = 1) {
    targetCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    targetCtx.clearRect(0, 0, this.w, this.h);
    targetCtx.save();
    targetCtx.beginPath();
    targetCtx.rect(0, 0, this.w, this.h);
    targetCtx.clip();

    const full = [];
    const scratchFor = d => {
      let c = full[d];
      if (!c) {
        c = document.createElement('canvas');
        c.width = this.w; c.height = this.h;
        full[d] = c;
      }
      return c;
    };

    /* 导出不按块处理，每个图层需铺满所有块，
     * 因此单独实现 drawAll，不复用 flushDirty 中按 _key 取块的路径。 */
    const drawAll = (nodes, ctx, depth) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (!n.visible) continue;
        if (!n.isGroup) {
          const masked = n.mask && n.mask.tiles.size > 0;
          if (!masked) {
            ctx.globalAlpha = n.opacity;
            ctx.globalCompositeOperation = n.mode;
            n.canvas.tiles.forEach(t => ctx.drawImage(t.canvas, t.col * TILE, t.row * TILE));
            continue;
          }
          const s2 = scratchFor(depth);
          const sc2 = s2.getContext('2d');
          sc2.setTransform(1, 0, 0, 1, 0, 0);
          sc2.globalAlpha = 1;
          sc2.globalCompositeOperation = 'source-over';
          sc2.clearRect(0, 0, s2.width, s2.height);
          n.canvas.tiles.forEach(t => sc2.drawImage(t.canvas, t.col * TILE, t.row * TILE));
          sc2.globalCompositeOperation = 'destination-in';
          n.mask.tiles.forEach(t => sc2.drawImage(t.canvas, t.col * TILE, t.row * TILE));
          sc2.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = n.opacity;
          ctx.globalCompositeOperation = n.mode;
          ctx.drawImage(s2, 0, 0);
          continue;
        }
        const iso = n.opacity < 1 || n.mode !== 'source-over';
        if (!iso) { drawAll(n.children, ctx, depth); continue; }
        const s = scratchFor(depth);
        const sc = s.getContext('2d');
        sc.setTransform(1, 0, 0, 1, 0, 0);
        sc.globalAlpha = 1;
        sc.globalCompositeOperation = 'source-over';
        sc.clearRect(0, 0, s.width, s.height);
        drawAll(n.children, sc, depth + 1);
        ctx.globalAlpha = n.opacity;
        ctx.globalCompositeOperation = n.mode;
        ctx.drawImage(s, 0, 0);
      }
    };
    drawAll(this.root.children, targetCtx, 0);

    targetCtx.restore();
    targetCtx.globalAlpha = 1;
    targetCtx.globalCompositeOperation = 'source-over';
  }
}
