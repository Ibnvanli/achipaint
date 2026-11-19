/* 核心：分块画布
 * 修过的坑：
 *  1) 跨块笔点被裁成串珠 —— forEachTileInBounds 遍历包围盒内所有块
 *  2) 画出画布 —— 合成与导出都裁剪到 (0,0,w,h)
 *  3) 每帧全量重绘太慢 —— 加离屏合成缓存，只刷脏块
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

  /* 一次笔点画满它覆盖的所有块。
   * 只画「点中心那一块」的话，边缘跨块处会被裁掉，大笔刷画出来就是串珠。
   * fn(ctx, c, r) —— 每块都用自己的平移，但用的是同一个整图坐标。
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
 * 节点的 children 按「显示顺序」排：children[0] 是最上面那一层。
 * 合成的时候要倒着走（从最底下开始叠），别搞反。
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
    /* 蒙版是一个普通的 TileCanvas，但只拿它的 alpha 用：
     * 有内容 = 那里看得见，空 = 那里被抠掉（destination-in）。 */
    this.mask = null;
  }
  ensureMask() {
    if (!this.mask) this.mask = new TileCanvas(this.w, this.h);
    return this.mask;
  }
}

/* 组本身不带像素。合成时先把子节点合到一张隔离缓冲上，
 * 再按组的不透明度 / 混合模式整体叠上去 —— 这才是「组」该有的语义，
 * 否则组的不透明度会把组里互相重叠的图层变成半透加法。
 */
export class LayerGroup extends LayerNode {
  constructor(name = '组') {
    super(name);
    this.children = [];
    this.expanded = true;
  }
  get isGroup() { return true; }
}

/* 只走叶子（真正有像素的那些） */
export function walkLeaves(nodes, fn) {
  for (const n of nodes) {
    if (n.isGroup) walkLeaves(n.children, fn);
    else fn(n);
  }
}

/* 第一个叶子 —— 删东西之后要有个落点 */
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

/* 某个节点是不是在给定子树里 */
export function within(node, nodes) {
  for (const n of nodes) {
    if (n === node) return true;
    if (n.isGroup && within(node, n.children)) return true;
  }
  return false;
}

/* a 是不是 node 的祖先 —— 拖拽时防止把组拖进自己肚子里 */
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
   *   background 只影响「纸」怎么显示，不往图层里写像素 ——
   *   所以切背景不会污染画稿，导出时也按它决定要不要垫白。
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

    // 离屏合成缓冲：所有层先合到这里，重绘时只做一次 drawImage
    this.off = document.createElement('canvas');
    this.off.width = w; this.off.height = h;
    this.offctx = this.off.getContext('2d');
    this.dirtyTiles = new Set();
    this._tileScratch = [];      // 组隔离用的 256×256 暂存，按嵌套深度取

    /* 笔迹覆盖层：正在画的那一笔先落这儿，松手才压进图层。
     * 外置笔刷（hokusai）一笔内会不断累加，逐事件往图层 source-over
     * 会把重叠处一遍遍叠黑；压成「一次性用完」就干净了。
     * 键是 64×64 的块（跟 blocks 不同，别混用），值是 {canvas,ctx,x,y,w,h}。
     */
    this.overlay = new Map();
    this.overlayActive = false;
    this.overlayAlpha = 1;

    /* 矩形框选：{x0,y0,x1,y1} 世界坐标。null = 没选。
     * 现在只做一件事：把笔画限制在框里。 */
    this.selection = null;
    /* 正在编辑当前图层的蒙版（笔画落到 mask 上） */
    this.maskMode = false;
    /* 移动工具的实时预览，不复制任何像素，只在合成时偏移 */
    this.previewOffset = null;
  }

  /* 笔画该落到哪儿：蒙版模式下落蒙版，否则落图层 */
  get paintTarget() {
    const l = this.activeLeaf;
    if (!l) return null;
    return (this.maskMode && l.mask) ? l.mask : l.canvas;
  }

  /* 旧代码里 doc.layers 指根下的直接子节点，保留 */
  get layers() { return this.root.children; }
  get layer() { return this.activeLeaf; }

  /* 选中某个节点；选到组时画笔仍然落在上一次的叶子上 */
  select(node) {
    this.selected = node;
    if (node && !node.isGroup) this.activeLeaf = node;
    return node;
  }

  /* 新图层：插在选中项的上方（同一层），选中的是组就插进组里最上面 */
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

  /* 新组：选中的是图层就把它包进去（最常用的做法），
   * 选中的是组就在它上面建一个空组 */
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
    // 先把组放到图层的位置上，再把图层搬进去
    parent.children.splice(index, 0, g);
    parent.children.splice(parent.children.indexOf(sel), 1);
    g.children.push(sel);
    sel.parent = g;
    this.select(g);
    return g;
  }

  /* 移动节点。newParent 不能是它自己或它的子孙。 */
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

  /* 删除节点（组会连子孙一起删）。
   * 至少留一个叶子：画布上不能一个能画的图层都没有。 */
  deleteNode(node) {
    if (!node || node === this.root) return false;

    /* 数「删完还剩几个叶子」。不能只判断单个图层的数量：
     * 删一个组时里面可能装着最后一个图层，之前就是这么把画布删空的。 */
    let remain = 0;
    walkLeaves(this.root.children, l => { if (!within(l, [node])) remain++; });
    if (remain === 0) return false;

    const parent = node.parent || this.root;
    const i = parent.children.indexOf(node);
    if (i < 0) return false;

    parent.children.splice(i, 1);

    // 选中项落在被删掉的子树里，就换一个
    if (within(this.selected, [node]) || this.selected === node) {
      this.selected = parent.children[Math.min(i, parent.children.length - 1)]
        || firstLeaf(this.root.children) || this.root;
    }
    if (!this.activeLeaf || within(this.activeLeaf, [node]) || this.activeLeaf === node) {
      this.activeLeaf = firstLeaf(this.root.children);
    }
    // 画笔必须有落点；真删空了就把选中也退回根
    if (!this.activeLeaf) {
      this.activeLeaf = firstLeaf(this.root.children);
      this.selected = this.activeLeaf || this.root;
    }
    return true;
  }

  markTileDirty(c, r) { this.dirtyTiles.add(c + ',' + r); }

  /* 按世界坐标标脏（覆盖层按 64×64 的小块汇报，得换算回文档块） */
  markRegionDirty(x0, y0, x1, y1) {
    const c0 = Math.max(0, Math.floor(x0 / TILE));
    const c1 = Math.min(Math.ceil(this.w / TILE) - 1, Math.floor((x1 - 1) / TILE));
    const r0 = Math.max(0, Math.floor(y0 / TILE));
    const r1 = Math.min(Math.ceil(this.h / TILE) - 1, Math.floor((y1 - 1) / TILE));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.dirtyTiles.add(c + ',' + r);
  }

  /* 把各个图层里积攒的脏块搬到文档级，再统一刷新。 */
  collectDirty() {
    walkLeaves(this.root.children, l => {
      // 蒙版也要收 —— 只收 l.canvas 的话，在蒙版上画的笔画永远不重合
      if (l.mask && l.mask.dirty.size) {
        l.mask.dirty.forEach(k => this.dirtyTiles.add(k));
        l.mask.dirty.clear();
      }
      if (l.canvas.dirty.size === 0) return;
      l.canvas.dirty.forEach(k => this.dirtyTiles.add(k));
      l.canvas.dirty.clear();
    });
  }

  /* 全量标脏 = 视口变了、撤销了、图层结构变动了 —— 必须整张重合成。 */
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

  /* 按树递归合成一块区域。
   * rx, ry = 目标画布的左上角在世界坐标里的位置（doc.off 是 0,0，块暂存是 x,y）。
   * 组只有在「不透明度 < 1」或「混合模式不是 normal」时才需要隔离缓冲；
   * 否则直接摊平，省掉一次 256×256 的搬运。
   */
  /* 把某层按 (dx,dy) 偏移画进「当前块」。
   *
   * 注意：不能拿 _drawStack 传进来的 rx/ry 算，那个对 doc.off 一直是 0（世界原点）；
   * 要用 this._key 反推当前块的坐标，否则算出来永远是画面左上角那一带的源块。
   *
   * 只遍历真正可能重叠的源块（最多 3×3），不会退化成 O(瓦片数)。
   */
  _drawOffsetTile(n, ctx, dx, dy, ox = 0, oy = 0) {
    const T = TILE;
    const [cc, cr] = this._key.split(',').map(Number);
    const bx = cc * T, by = cr * T;          // 当前块的世界坐标

    const c0 = Math.floor((bx - dx) / T) - 1;
    const c1 = Math.floor((bx - dx + T) / T) + 1;
    const r0 = Math.floor((by - dy) / T) - 1;
    const r1 = Math.floor((by - dy + T) / T) + 1;

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const src = n.canvas.tiles.get(c + ',' + r);
        if (!src) continue;
        // ox/oy：目标画布的原点（世界坐标）—— 画进 scratch 时要减掉
        ctx.drawImage(src.canvas, c * T + dx - ox, r * T + dy - oy);
      }
    }
  }

  _drawStack(nodes, ctx, rx, ry, depth, scratchFor) {
    /* 隔离分支用的是 256×256 的 scratch，而瓦片坐标是世界坐标。
     * 不换算到「当前块」原点的话，非 (0,0) 的块会被画到 scratch 外面 ——
     * 表现就是「蒙版 / 组不透明度只有左上角那 256px 是对的」。 */
    const [bc, br] = this._key ? this._key.split(',').map(Number) : [0, 0];
    const bx = bc * TILE, by = br * TILE;

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
            /* 拖动预览：目标块可能要从**邻居块**取内容。
             * 只画 this._key 那一块的话，偏移量不是 256 的整数倍时
             * 块与块之间会裂开、拖影（这就是「拖动后残留」的原因）。 */
            this._drawOffsetTile(n, ctx, dx, dy, rx, ry);
          } else {
            const t = n.canvas.tiles.get(this._key);
            if (!t) continue;
            ctx.drawImage(t.canvas, t.col * TILE - rx + dx, t.row * TILE - ry + dy);
          }
          continue;
        }

        /* 有蒙版就得隔离：先把这一块画到暂存，再用 destination-in 抠掉蒙版外的部分。
         * 直接在主画布上 destination-in 会把下面所有图层一起抠掉。 */
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
        } else {
          sc.clearRect(0, 0, s.width, s.height);   // 蒙版这块是空的 = 整块看不见
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
      /* 递归进 scratch 时把原点挪到当前块：scratch 是 256×256，
       * 继续传 rx/ry(=0) 的话子层内容会画到世界坐标的位置，跑出画布。 */
      this._drawStack(n.children, sc, bx, by, depth + 1, scratchFor);
      ctx.globalAlpha = n.opacity;
      ctx.globalCompositeOperation = n.mode;
      ctx.drawImage(s, bx, by);
    }
  }

  /* 只重刷脏块到离屏缓冲 */
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
      this._drawStack(this.root.children, ctx, 0, 0, 0, scratchFor);
      this._key = null;

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // 正在画的那一笔叠在最上面
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

  /* 导出用：完整合成一次，并裁剪到画布范围（不出界）。
   * 这里的隔离缓冲是整张画布大小，只在导出时才会分配。 */
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

    /* 导出不是按块走的，每个图层要把所有块铺满，
     * 所以这里另写一份 drawAll，不复用 flushDirty 那条按 _key 取的路径。 */
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
