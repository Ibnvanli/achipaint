/* 核心：撤销（第四版 —— 按像素矩形存，不按块存）
 *
 * 前三版的错误：
 *   v1 整层快照  —— 每笔 34MB，几笔就爆
 *   v2 按块快照  —— 一笔只碰到块一角，却要存整块 256KB，且撤销误伤块内别的笔画
 *   v3 块级脏矩形 —— 仍然按整块存，内存没省下来，撤到一定量后 trim 把 index 弄成负数，撤不动
 *
 * 现在：**只存这一笔真正覆盖的矩形像素**。
 * 一条细线只存「它的包围盒」那点像素，通常几 KB ~ 几十 KB。
 * 撤销时把那块矩形贴回去，矩形外一个像素都不动。
 *
 * 内存上限 384MB，按条淘汰最老的。index 永不为负
 *（撤不动 = 已经到底，而不是「历史被吃掉了」）。
 */
export const HISTORY_LIMIT = 384 * 1024 * 1024;

const TILE = 256;

export class History {
  constructor(limit = HISTORY_LIMIT) {
    this.limit = limit;
    this.stack = [];     // { rect, before: ImageData, after: ImageData, bytes }
    this.index = -1;
    this.bytes = 0;
  }

  beginStroke(tileCanvas) {
    return { tileCanvas, snapshot: null, rect: null };
  }

  /* 落笔/移动时扩容。
   * 第一次调用拍「当前矩形」原样；之后矩形扩大，只拍「新增的条带」，
   * 已经拍过的部分保持原样（那才是这一笔动手之前的真正状态）。
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
    // 已经在范围内就不用重拍
    if (r.x0 >= g.x0 && r.y0 >= g.y0 && r.x1 <= g.x1 && r.y1 <= g.y1) return;

    // 扩大：新矩形 = 并集。旧像素从已有快照里拷，新增区域现读。
    const nr = {
      x0: Math.min(g.x0, r.x0), y0: Math.min(g.y0, r.y0),
      x1: Math.max(g.x1, r.x1), y1: Math.max(g.y1, r.y1),
    };
    const old = pending.snapshot;
    const merged = new ImageData(nr.x1 - nr.x0, nr.y1 - nr.y0);

    // 旧快照贴进新画布对应位置（旧区域是「动手前」的状态，是对的）
    blitImageData(old, g, merged, nr);
    // 新增的条带现读当前像素（此时还没被这一笔画到）
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
    /* 必须记下这块快照属于哪个画布。
     * 以前只存 rect，撤销时贴给「当前活动图层」——跨图层撤销就会把 A 层的像素
     * 写进 B 层，同时该撤的没撤。 */
    this.stack.push({ rect, before, after, bytes, target: t });
    this.index = this.stack.length - 1;
    this.bytes += bytes;
    this.trim();
  }

  /* 淘汰最老的记录。
   * 关键：index 不能变成负数 —— 那会让 undo() 直接返回 false，
   * 用户看到的就是「撤到一定量突然撤不动」。
   */
  /* 淘汰最老的记录，直到总字节数回到上限内。
   *
   * 注意不能一边 shift 一边循环 —— Array.shift() 每次都要搬整个数组，
   * 栈里几十条时就是 O(n²)。改成先数出要丢几条，最后一次 slice 切掉。 */
  trim() {
    if (this.bytes <= this.limit) return;

    let drop = 0;
    while (this.bytes > this.limit && this.stack.length - drop > 1) {
      this.bytes -= this.stack[drop].bytes;
      drop++;
    }
    if (drop === 0) return;

    this.stack = this.stack.slice(drop);
    // index 要跟着挪，但不能变成负数
    this.index = Math.max(0, this.index - drop);
    if (this.index >= this.stack.length) this.index = this.stack.length - 1;
  }

  undo(tileCanvas) {
    if (this.index < 0 || this.index >= this.stack.length) return false;
    const rec = this.stack[this.index];
    // 用记录自己的目标画布；参数只作为老记录（没有 target 的）的兜底
    writeRect(rec.target || tileCanvas, rec.rect, rec.before);
    this.index--;
    return true;
  }

  redo(tileCanvas) {
    if (this.index >= this.stack.length - 1) return false;
    this.index++;
    const rec = this.stack[this.index];
    writeRect(rec.target || tileCanvas, rec.rect, rec.after);
    return true;
  }

  get canUndo() { return this.index >= 0 && this.stack.length > 0; }
  get canRedo() { return this.index < this.stack.length - 1; }
}

/* ---------- 像素读写：跨块也要正确 ---------- */

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

/* 从分块画布读出矩形区域 */
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

/* 把矩形写回分块画布（逐块 putImageData，块外不受影响） */
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

/* 把旧快照按位置贴进新画布 */
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
