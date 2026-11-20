/* 核心：撤销（第五版 —— 像素快照 + 结构快照）
 *
 * 像素记录的历史：前三版的失败路径
 *   v1 整层快照   —— 单笔 34MB，数笔即耗尽内存
 *   v2 按块快照   —— 一笔仅触及块的一角却需存整块 256KB，且撤销会误伤块内其他笔迹
 *   v3 块级脏矩形 —— 仍按整块存储，内存未下降；且 trim 会使 index 变为负数，导致无法继续撤销
 *
 * 像素部分采用：**只存储这一笔实际覆盖的矩形像素**。
 * 一条细线仅存储其包围盒范围内的像素，通常数 KB 至数十 KB。
 * 撤销时将该矩形贴回，矩形外不触碰任何像素。
 *
 * v5 新增**结构记录**，覆盖第四版遗留的缺口：图层的新建、删除、重排、改名、
 * 属性修改与蒙版增删此前完全不进撤销栈，误删图层无法恢复。
 * 结构记录保存操作前后的图层树形态（节点引用 + 位置 + 属性），
 * 因节点对象仍持有各自的像素画布，撤销时只需还原树结构与属性即可恢复内容。
 *
 * 内存上限 384MB，按记录先后淘汰最旧的一条。index 不得为负
 *（无法撤销表示已到达起点，而非历史被丢弃）。
 */
export const HISTORY_LIMIT = 384 * 1024 * 1024;

const TILE = 256;

/* 结构记录的条数上限。
 *
 * 结构记录不复制像素，因此不计入字节上限；但「不计入」不等于「不限制」。
 * 由于像素记录与结构记录共用同一个栈，纯结构操作时 this.bytes 恒为 0，
 * trim() 永远不会被触发（复查结论见 audit/2026-11-20-structure-undo.md 第二节）。
 *
 * 真正需要限制的是记录所持有的**节点引用**：删除图层时，节点对象连同其
 * TileCanvas 一并被快照引用，无法被 GC 回收。A4 满铺一层约数十 MB，
 * 与「每条记录只有几 KB」的印象不符，因此这里同时设条数上限并做内存估算。
 */
export const STRUCT_LIMIT = 200;

export class History {
  constructor(limit = HISTORY_LIMIT) {
    this.limit = limit;
    this.stack = [];     // 像素记录 { rect, before, after, bytes, target } / 结构记录 { kind:'structure', … }
    this.index = -1;
    this.bytes = 0;      // 像素记录占用的字节数（结构记录按估算值另计）
    this.structCount = 0;  // 结构记录条数
  }

  beginStroke(tileCanvas) {
    return { tileCanvas, snapshot: null, rect: null };
  }

  /* ---------- 结构记录 ----------
   * 记录图层树在操作前后的形态。节点对象本身不复制 —— 像素仍挂在节点上，
   * 只需还原「谁是谁的父节点、排在第几位、属性是什么」即可完整恢复。
   *
   * 用法：
   *   const p = history.beginStructure(doc);
   *   ...修改图层树...
   *   history.commitStructure(p);
   * 若期间未产生实际变化，commitStructure 会自行丢弃该记录。
   */
  beginStructure(doc) {
    return { doc, before: captureTree(doc), after: null };
  }

  commitStructure(pending, label = '') {
    if (!pending || !pending.doc) return false;
    const doc = pending.doc;
    const after = captureTree(doc);
    if (treeEqual(pending.before, after)) return false;

    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push({
      kind: 'structure',
      doc,
      before: pending.before,
      after,
      label,
      /* 结构记录本身只有引用与属性，但被引用的节点可能持有整层画布。
       * 这里按「节点数 × 单条引用开销」估算，使其能参与淘汰判断；
       * 真实像素内存不属于快照自身，不能全额计入，否则一条记录就会顶满上限。 */
      bytes: estimateStructureBytes(pending.before, after),
    });
    this.index = this.stack.length - 1;
    this.recompute();       // 截断 redo 分支后计数会失准，统一重算
    this.trimStructures();
    this.trim();
    return true;
  }

  /* 依据当前栈内容重算聚合计数。
   *
   * 任何时候只要 stack 被整体改写（截断 redo 分支、批量淘汰），
   * 都必须调用它 —— 增量维护计数容易在「截断」这类路径上漏算。 */
  recompute() {
    this.bytes = 0;
    this.structCount = 0;
    for (const rec of this.stack) {
      this.bytes += rec.bytes || 0;
      if (rec.kind === 'structure') this.structCount++;
    }
  }

  /* 淘汰最旧的结构记录，使其条数不超过上限。
   *
   * 只删结构记录，不动像素记录 —— 两者的淘汰依据不同：
   * 像素按字节，结构按条数。若强行混在一起按字节淘汰，会把大量像素记录
   * 挤掉，表现为「画到一半就撤不动了」。 */
  trimStructures() {
    let changed = false;
    while (this.structCount > STRUCT_LIMIT) {
      const i = this.stack.findIndex(r => r.kind === 'structure');
      if (i < 0) break;
      this.stack.splice(i, 1);
      this.structCount--;
      changed = true;
      /* index 指向被删记录时，撤销位应回到该记录之前；
       * 指向其后时整体前移一位。两种情况都不能让 index 越界。 */
      if (this.index >= i) this.index--;
      if (this.index >= this.stack.length) this.index = this.stack.length - 1;
    }
    if (changed) {
      this.recompute();
      if (this.index >= this.stack.length) this.index = this.stack.length - 1;
    }
  }

  /* 落笔 / 移动时扩容。
   * 首次调用拍摄「当前矩形」原状；此后矩形扩大时仅拍摄「新增的条带」，
   * 已拍摄部分保持原样（即该笔实际落笔前的真实状态）。
   */
  grabRegion(pending, x0, y0, x1, y1) {
    if (!pending) return;
    const t = pending.tileCanvas;
    const r = clampRect(x0, y0, x1, y1, t.w, t.h);
    if (!r) return;

    if (!pending.snapshot) {
      pending.rect = r;
      pending.snapshot = readRect(t, r);
      return;
    }

    const g = pending.rect;
    // 已在范围内则无需重新拍摄
    if (r.x0 >= g.x0 && r.y0 >= g.y0 && r.x1 <= g.x1 && r.y1 <= g.y1) return;

    // 扩大：新矩形取并集。旧像素从已有快照拷贝，新增区域即时读取。
    const nr = {
      x0: Math.min(g.x0, r.x0), y0: Math.min(g.y0, r.y0),
      x1: Math.max(g.x1, r.x1), y1: Math.max(g.y1, r.y1),
    };
    const old = pending.snapshot;
    const merged = new ImageData(nr.x1 - nr.x0, nr.y1 - nr.y0);

    // 旧快照贴入新画布的对应位置（旧区域即「操作前」状态，仍然有效）
    blitImageData(old, g, merged, nr);
    // 新增条带即时读取当前像素（此时该区域尚未被本笔覆盖）
    const cx = nr.x1 - nr.x0, cy = nr.y1 - nr.y0;
    const cur = readRect(t, nr);
    for (let y = 0; y < cy; y++) {
      for (let x = 0; x < cx; x++) {
        const ax = nr.x0 + x, ay = nr.y0 + y;
        const insideOld = ax >= g.x0 && ax < g.x1 && ay >= g.y0 && ay < g.y1;
        if (insideOld) continue;             // 旧区域保留快照值
        const si = (y * cx + x) * 4;
        merged.data[si] = cur.data[si];
        merged.data[si + 1] = cur.data[si + 1];
        merged.data[si + 2] = cur.data[si + 2];
        merged.data[si + 3] = cur.data[si + 3];
      }
    }
    pending.rect = nr;
    pending.snapshot = merged;
  }

  commit(pending) {
    if (!pending || !pending.snapshot || !pending.rect) return;
    const t = pending.tileCanvas;
    const { rect, snapshot: before } = pending;
    if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return;

    const after = readRect(t, rect);
    const bytes = before.data.length + after.data.length;

    this.stack = this.stack.slice(0, this.index + 1);
    /* 必须记录该快照所属的画布。
     * 原实现仅存 rect，撤销时贴给「当前活动图层」——跨图层撤销会将 A 层像素
     * 写入 B 层，同时应撤销的内容并未撤销。 */
    this.stack.push({ rect, before, after, bytes, target: t });
    this.index = this.stack.length - 1;
    this.recompute();
    this.trim();
  }

  /* 淘汰最旧的记录。
   * 关键约束：index 不得变为负数，否则 undo() 将直接返回 false，
   * 表现为「撤销若干步后突然无法继续」。
   */
  /* 淘汰最旧的记录，直至总字节数低于上限。
   *
   * 注意不可在循环中调用 shift —— Array.shift() 每次需搬移整个数组，
   * 栈内有数十条时复杂度为 O(n²)。改为先统计需淘汰的条数，最后以一次 slice 截断。 */
  trim() {
    if (this.bytes <= this.limit) return;

    /* 按字节淘汰：自最旧记录开始累计，直到总字节数回到上限内。
     * 结构记录的 bytes 是估算值，同样计入 —— 它反映的是被引用节点带来的
     * 真实持有量，不应该因为「快照本身很小」而完全免于淘汰压力。 */
    let drop = 0;
    let bytes = this.bytes;
    while (bytes > this.limit && this.stack.length - drop > 1) {
      bytes -= this.stack[drop].bytes || 0;
      drop++;
    }
    if (drop === 0) return;

    this.stack = this.stack.slice(drop);
    this.recompute();
    // index 需同步调整，但不得变为负数
    this.index = Math.max(0, this.index - drop);
    if (this.index >= this.stack.length) this.index = this.stack.length - 1;
  }

  undo(tileCanvas) {
    if (this.index < 0 || this.index >= this.stack.length) return false;
    const rec = this.stack[this.index];
    if (rec.kind === 'structure') {
      restoreTree(rec.doc, rec.before);
      this.index--;
      return true;
    }
    // 使用记录自身的目标画布；参数仅作为旧记录（无 target 字段）的回退值
    writeRect(rec.target || tileCanvas, rec.rect, rec.before);
    this.index--;
    return true;
  }

  redo(tileCanvas) {
    if (this.index >= this.stack.length - 1) return false;
    this.index++;
    const rec = this.stack[this.index];
    if (rec.kind === 'structure') {
      restoreTree(rec.doc, rec.after);
      return true;
    }
    writeRect(rec.target || tileCanvas, rec.rect, rec.after);
    return true;
  }

  get canUndo() { return this.index >= 0 && this.stack.length > 0; }
  get canRedo() { return this.index < this.stack.length - 1; }
}

/* ---------- 图层树快照 ----------
 * 只记录结构与属性，不复制像素：节点对象持有各自画布，
 * 恢复树形即恢复内容。这正是结构撤销开销极低的原因。
 */

/* 递归采集：节点引用、父节点、层内位置、可变属性、蒙版引用。 */
function captureTree(doc) {
  const nodes = [];
  const walk = (list, parent) => {
    list.forEach((node, index) => {
      nodes.push({
        node, parent, index,
        name: node.name,
        visible: node.visible,
        opacity: node.opacity,
        mode: node.mode,
        expanded: !!node.expanded,
        mask: node.mask || null,
      });
      if (node.isGroup) walk(node.children, node);
    });
  };
  walk(doc.root.children, doc.root);
  return {
    nodes,
    selected: doc.selected || null,
    activeLeaf: doc.activeLeaf || null,
    maskMode: !!doc.maskMode,
  };
}

/* 估算一条结构记录的内存持有量。
 *
 * 记录本身只存引用与属性，约合每条几十字节；真正的重量来自被引用的节点 ——
 * 删除图层时，该图层的 TileCanvas 仍被快照引用，无法回收。
 * 因此按节点基数 + 每个被引用节点的画布占用做估算，让淘汰机制能够感知到它。
 *
 * 注意不能全额计入画布字节：同一节点会同时出现在 before 与 after 两份快照里，
 * 全额计入会重复计数，并且一条 A4 图层的记录就会顶满 384MB 上限。
 * 这里取一个保守的折算系数，只用于体现「删除大图层比新建空图层更值得淘汰」。 */
const STRUCT_REF_BASE = 160;         // 每条引用 + 属性字段的粗略开销
const STRUCT_TILE_BYTES = 256 * 256 * 4;  // 单块瓦片的原始像素占用

function estimateStructureBytes(before, after) {
  /* 记录自身的固定开销：两份快照的节点引用与属性字段。
   * 这部分很轻，但条数多时会累积，因此仍需计入。 */
  let bytes = STRUCT_REF_BASE * (before.nodes.length + after.nodes.length);

  /* 被引用的画布才是真正的大头。
   * 删除图层时，该图层的节点对象仍被快照持有，其瓦片无法被 GC 回收 ——
   * A4 满铺一层约 140 块，按像素算接近 37MB。
   *
   * 但不能按全额计入：同一节点会同时出现在 before 与 after 两份快照中，
   * 全额计入会重复计数；且一条 A4 满层记录就会单独顶满 384MB 上限，
   * 导致撤销历史只剩一条，实用性归零。
   * 因此按半额计（两份快照各占一半引用），这是对「实际持有量」的保守近似。 */
  const seen = new Set();
  for (const snap of [before, after]) {
    for (const rec of snap.nodes) {
      const node = rec.node;
      if (!node || seen.has(node)) continue;
      seen.add(node);
      const tc = node.canvas;
      if (!tc) continue;
      /* 只统计真正持有像素的块：空图层不持有任何瓦片，不应被计入。 */
      const tiles = tc.tiles.size;
      if (tiles > 0) bytes += tiles * STRUCT_TILE_BYTES * 0.5;
    }
  }
  return Math.round(bytes);
}

/* 判定两份快照是否等价。结构未变时无需入栈，避免污染撤销历史。 */
function treeEqual(a, b) {
  if (a.nodes.length !== b.nodes.length) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    const x = a.nodes[i], y = b.nodes[i];
    if (x.node !== y.node || x.parent !== y.parent || x.index !== y.index) return false;
    if (x.name !== y.name || x.visible !== y.visible) return false;
    if (x.opacity !== y.opacity || x.mode !== y.mode || x.expanded !== y.expanded) return false;
    if (x.mask !== y.mask) return false;
  }
  return a.selected === b.selected && a.activeLeaf === b.activeLeaf
    && a.maskMode === b.maskMode;
}

/* 按快照还原图层树与属性。像素内容不在快照内，随节点对象自然保留。 */
function restoreTree(doc, snap) {
  /* 先重建父子关系与层内顺序：自根向下逐层填充 children 数组。
   * 不能就地 patch —— 被删除的节点需要重新挂回，被移动的节点需要改变父节点。 */
  const byParent = new Map();
  for (const rec of snap.nodes) {
    if (!byParent.has(rec.parent)) byParent.set(rec.parent, []);
    byParent.get(rec.parent)[rec.index] = rec;
  }

  const rebuild = parent => {
    const list = byParent.get(parent) || [];
    const children = [];
    for (const rec of list) {
      if (!rec) continue;                       // 索引空洞跳过
      const node = rec.node;
      node.parent = parent;
      node.name = rec.name;
      node.visible = rec.visible;
      node.opacity = rec.opacity;
      node.mode = rec.mode;
      node.expanded = rec.expanded;
      node.mask = rec.mask;
      if (node.isGroup) rebuild(node);
      children.push(node);
    }
    parent.children = children;
  };
  rebuild(doc.root);

  doc.selected = snap.selected;
  doc.activeLeaf = snap.activeLeaf;
  doc.maskMode = snap.maskMode;
  doc.markAllDirty();
}

/* ---------- 像素读写：跨块时同样必须正确 ---------- */

function clampRect(x0, y0, x1, y1, w, h) {
  const r = {
    x0: Math.max(0, Math.floor(x0)),
    y0: Math.max(0, Math.floor(y0)),
    x1: Math.min(w, Math.ceil(x1)),
    y1: Math.min(h, Math.ceil(y1)),
  };
  if (r.x1 <= r.x0 || r.y1 <= r.y0) return null;
  return r;
}

/* 从分块画布读取矩形区域 */
function readRect(t, rect) {
  const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
  const out = new ImageData(w, h);
  const c0 = Math.floor(rect.x0 / TILE), c1 = Math.floor((rect.x1 - 1) / TILE);
  const r0 = Math.floor(rect.y0 / TILE), r1 = Math.floor((rect.y1 - 1) / TILE);

  for (let tr = r0; tr <= r1; tr++) {
    for (let tc = c0; tc <= c1; tc++) {
      const tile = t.tiles.get(tc + ',' + tr);
      if (!tile) continue;   // 空块 = 全透明，跳过即可（out 初值就是透明）
      const tileX = tc * TILE, tileY = tr * TILE;
      const ix0 = Math.max(rect.x0, tileX), iy0 = Math.max(rect.y0, tileY);
      const ix1 = Math.min(rect.x1, tileX + TILE), iy1 = Math.min(rect.y1, tileY + TILE);
      if (ix1 <= ix0 || iy1 <= iy0) continue;

      const src = tile.ctx.getImageData(ix0 - tileX, iy0 - tileY, ix1 - ix0, iy1 - iy0);
      for (let y = 0; y < iy1 - iy0; y++) {
        for (let x = 0; x < ix1 - ix0; x++) {
          const di = ((iy0 - rect.y0 + y) * w + (ix0 - rect.x0 + x)) * 4;
          const si = (y * (ix1 - ix0) + x) * 4;
          out.data[di] = src.data[si];
          out.data[di + 1] = src.data[si + 1];
          out.data[di + 2] = src.data[si + 2];
          out.data[di + 3] = src.data[si + 3];
        }
      }
    }
  }
  return out;
}

/* 将矩形写回分块画布（逐块 putImageData，不影响块外区域） */
function writeRect(t, rect, img) {
  const w = rect.x1 - rect.x0;
  const c0 = Math.floor(rect.x0 / TILE), c1 = Math.floor((rect.x1 - 1) / TILE);
  const r0 = Math.floor(rect.y0 / TILE), r1 = Math.floor((rect.y1 - 1) / TILE);

  for (let tr = r0; tr <= r1; tr++) {
    for (let tc = c0; tc <= c1; tc++) {
      const tileX = tc * TILE, tileY = tr * TILE;
      const ix0 = Math.max(rect.x0, tileX), iy0 = Math.max(rect.y0, tileY);
      const ix1 = Math.min(rect.x1, tileX + TILE), iy1 = Math.min(rect.y1, tileY + TILE);
      if (ix1 <= ix0 || iy1 <= iy0) continue;

      const patch = new ImageData(ix1 - ix0, iy1 - iy0);
      for (let y = 0; y < iy1 - iy0; y++) {
        for (let x = 0; x < ix1 - ix0; x++) {
          const si = ((iy0 - rect.y0 + y) * w + (ix0 - rect.x0 + x)) * 4;
          const di = (y * (ix1 - ix0) + x) * 4;
          patch.data[di] = img.data[si];
          patch.data[di + 1] = img.data[si + 1];
          patch.data[di + 2] = img.data[si + 2];
          patch.data[di + 3] = img.data[si + 3];
        }
      }
      const tile = t.tile(tc, tr);
      tile.ctx.putImageData(patch, ix0 - tileX, iy0 - tileY);
      t.markDirty(ix0, iy0, ix1, iy1);
    }
  }
}

/* 将旧快照按位置贴入新画布 */
function blitImageData(src, srcRect, dst, dstRect) {
  const sw = srcRect.x1 - srcRect.x0;
  const dw = dstRect.x1 - dstRect.x0;
  for (let y = 0; y < srcRect.y1 - srcRect.y0; y++) {
    for (let x = 0; x < sw; x++) {
      const si = (y * sw + x) * 4;
      const di = ((srcRect.y0 - dstRect.y0 + y) * dw + (srcRect.x0 - dstRect.x0 + x)) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}
