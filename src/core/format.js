/* Achi 文件格式（.achi）
 *
 * 设计目标只有一条：**坏文件不能把当前画布搞坏，也不能静悄悄加载一半**。
 * 所以格式自带三层校验，任何一层不过就整体拒绝：
 *
 *   1. 结构校验：magic、版本、每个块的偏移和长度都必须在边界内
 *   2. CRC32    ：覆盖 magic 之后的全部字节
 *   3. 语义校验：JSON 能解析、图层树能重建、每个块都真的被引用到
 *
 * 读取时先完整解到一个新的 Doc 对象，全部成功之后才交给调用方去替换。
 * 中途抛异常 = 当前文档原封不动。
 *
 *
 * 文件布局（全部小端）
 * ─────────────────────────────────────────────
 *   0    magic          "ACHI"          4 B
 *   4    formatVersion  u16             2 B
 *   6    flags          u16             2 B（保留，必须为 0）
 *   8    headerLen      u32             4 B
 *   12   header         UTF-8 JSON      变长
 *        ……数据块区，每块：
 *          nameLen  u16
 *          name     UTF-8            （唯一，不能重名）
 *          dataLen  u32
 *          data     PNG
 *   末尾 crc32          u32             4 B，覆盖 [0, 末尾-4)
 * ─────────────────────────────────────────────
 */
import { Doc, Layer, LayerGroup, TileCanvas, TILE } from './canvas.js';

export const MAGIC = 'ACHI';
export const FORMAT_VERSION = 1;
export const EXTENSION = '.achi';
export const MIME = 'application/x-achipaint';

/* ---------- CRC32 ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------- 错误类型 ---------- */

export class AchiFileError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AchiFileError';
    this.code = code || 'INVALID';
  }
}

/* ---------- 写 ---------- */

/* 把一个 TileCanvas 拍平成 PNG。
 * 整层一张图，而不是一瓦片一张 —— 文件少、通用工具能打开、好排查。 */
async function tileCanvasToPng(tc) {
  const cv = document.createElement('canvas');
  cv.width = tc.w;
  cv.height = tc.h;
  const ctx = cv.getContext('2d');
  for (const t of tc.tiles.values()) {
    ctx.drawImage(t.canvas, t.col * TILE, t.row * TILE);
  }
  const blob = await new Promise((resolve, reject) => {
    cv.toBlob(b => (b ? resolve(b) : reject(new AchiFileError('PNG 编码失败', 'ENCODE'))), 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function serializeNode(node, blocks) {
  const out = {
    type: node.isGroup ? 'group' : 'layer',
    name: node.name,
    visible: node.visible !== false,
    opacity: typeof node.opacity === 'number' ? node.opacity : 1,
    mode: node.mode || 'source-over',
  };

  if (node.isGroup) {
    out.expanded = !!node.expanded;
    out.children = node.children.map(c => serializeNode(c, blocks));
    return out;
  }

  out.data = blockName('layer');
  blocks.set(out.data, node.canvas);
  if (node.mask && node.mask.tiles.size) {
    out.mask = blockName('mask');
    blocks.set(out.mask, node.mask);
  }
  return out;
}

let blockSeq = 0;
function blockName(kind) {
  return `${kind}-${blockSeq++}.png`;
}

/**
 * 序列化整个文档。
 * @param {Doc} doc
 * @param {object} extra 额外的元信息（笔刷设置等）
 * @returns {Promise<Blob>}
 */
export async function serialize(doc, extra = {}) {
  blockSeq = 0;
  const blocks = new Map();

  const header = {
    format: 'achipaint',
    version: FORMAT_VERSION,
    app: extra.app || '0.1.0',
    created: new Date().toISOString(),
    doc: { w: doc.w, h: doc.h },
    view: { x: doc.view.x, y: doc.view.y, zoom: doc.view.zoom },
    brush: extra.brush || null,
    layers: doc.root.children.map(n => serializeNode(n, blocks)),
  };

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));

  /* 先把所有块的字节算出来，才能知道总长度 */
  const encoded = new Map();
  for (const [name, tc] of blocks) {
    encoded.set(name, await tileCanvasToPng(tc));
  }

  let total = 12 + headerBytes.length + 4;
  for (const [name, data] of encoded) {
    total += 2 + new TextEncoder().encode(name).length + 4 + data.length;
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let p = 0;

  out.set(new TextEncoder().encode(MAGIC), 0);
  p = 4;
  view.setUint16(p, FORMAT_VERSION, true); p += 2;
  view.setUint16(p, 0, true); p += 2;
  view.setUint32(p, headerBytes.length, true); p += 4;
  out.set(headerBytes, p); p += headerBytes.length;

  for (const [name, data] of encoded) {
    const nb = new TextEncoder().encode(name);
    view.setUint16(p, nb.length, true); p += 2;
    out.set(nb, p); p += nb.length;
    view.setUint32(p, data.length, true); p += 4;
    out.set(data, p); p += data.length;
  }

  view.setUint32(p, crc32(out.subarray(0, p)), true);

  return new Blob([out], { type: MIME });
}

/* ---------- 读 ---------- */

async function pngToTileCanvas(bytes, w, h, label) {
  const blob = new Blob([bytes], { type: 'image/png' });
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch (e) {
    throw new AchiFileError(`数据块 "${label}" 不是有效的 PNG`, 'BAD_BLOCK');
  }
  if (bmp.width !== w || bmp.height !== h) {
    throw new AchiFileError(
      `数据块 "${label}" 尺寸不符：期望 ${w}×${h}，实际 ${bmp.width}×${bmp.height}`, 'BAD_BLOCK');
  }

  const tc = new TileCanvas(w, h);
  // 整层画进去：用一张临时画布再切块
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();

  for (let r = 0; r < tc.rows; r++) {
    for (let c = 0; c < tc.cols; c++) {
      const tw = Math.min(TILE, w - c * TILE);
      const th = Math.min(TILE, h - r * TILE);
      if (tw <= 0 || th <= 0) continue;
      const tile = tc.tile(c, r);
      tile.ctx.drawImage(cv, c * TILE, r * TILE, tw, th, 0, 0, tw, th);
    }
  }
  return tc;
}

function buildNode(spec, docW, docH, blocks, used, path) {
  const name = String(spec.name ?? '未命名');
  const where = path ? `${path} / ${name}` : name;

  if (spec.type === 'group') {
    if (!Array.isArray(spec.children)) {
      throw new AchiFileError(`组 "${where}" 缺少 children`, 'BAD_TREE');
    }
    const g = new LayerGroup(name);
    g.visible = spec.visible !== false;
    g.opacity = typeof spec.opacity === 'number' ? spec.opacity : 1;
    g.mode = spec.mode || 'source-over';
    g.expanded = spec.expanded !== false;
    for (const c of spec.children) {
      const child = buildNode(c, docW, docH, blocks, used, where);
      child.parent = g;
      g.children.push(child);
    }
    return g;
  }

  if (spec.type !== 'layer') {
    throw new AchiFileError(`未知节点类型 "${spec.type}"（在 ${where}）`, 'BAD_TREE');
  }
  if (!spec.data) throw new AchiFileError(`图层 "${where}" 缺少数据块引用`, 'BAD_TREE');
  if (!blocks.has(spec.data)) throw new AchiFileError(`图层 "${where}" 引用的块不存在：${spec.data}`, 'MISSING_BLOCK');

  const l = new Layer(docW, docH, name);
  l.visible = spec.visible !== false;
  l.opacity = typeof spec.opacity === 'number' ? spec.opacity : 1;
  l.mode = spec.mode || 'source-over';
  l._pendingData = spec.data;
  used.add(spec.data);

  if (spec.mask) {
    if (!blocks.has(spec.mask)) throw new AchiFileError(`蒙版块不存在：${spec.mask}`, 'MISSING_BLOCK');
    l._pendingMask = spec.mask;
    used.add(spec.mask);
  }
  return l;
}

/**
 * 解析 .achi。
 * 任何一步失败都抛 AchiFileError，**不会**返回半个文档。
 * @returns {Promise<{doc:Doc, meta:object, warnings:string[]}>}
 */
export async function parse(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const warnings = [];

  // ---- 1. 结构 ----
  if (bytes.length < 16) throw new AchiFileError('文件太短，不是 AchiPaint 文件', 'TOO_SHORT');

  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC) throw new AchiFileError('不是 AchiPaint 文件（magic 不符）', 'BAD_MAGIC');

  const version = view.getUint16(4, true);
  if (version > FORMAT_VERSION) {
    throw new AchiFileError(
      `文件版本 ${version} 比本程序支持的 ${FORMAT_VERSION} 新，请升级 AchiPaint`, 'FUTURE_VERSION');
  }
  const flags = view.getUint16(6, true);
  if (flags !== 0) throw new AchiFileError('文件带有本程序不认识的标志位', 'BAD_FLAGS');

  // ---- 2. CRC（先校验，后面解出来的任何东西都以此为前提）----
  const bodyLen = bytes.length - 4;
  const wantCrc = view.getUint32(bodyLen, true);
  const gotCrc = crc32(bytes.subarray(0, bodyLen));
  if (wantCrc !== gotCrc) {
    throw new AchiFileError(
      `校验和不符（文件已损坏或被截断）：期望 ${wantCrc.toString(16)}，实际 ${gotCrc.toString(16)}`, 'CRC');
  }

  const headerLen = view.getUint32(8, true);
  if (12 + headerLen > bodyLen) throw new AchiFileError('头部长度越界，文件被截断', 'TRUNCATED');

  // ---- 3. 头部 ----
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLen)));
  } catch (e) {
    throw new AchiFileError('头部 JSON 解析失败：' + e.message, 'BAD_HEADER');
  }
  if (header.format !== 'achipaint') throw new AchiFileError('头部缺 format 标记', 'BAD_HEADER');
  if (!header.doc || !(header.doc.w > 0) || !(header.doc.h > 0)) {
    throw new AchiFileError('头部缺画布尺寸', 'BAD_HEADER');
  }

  const docW = Math.round(header.doc.w);
  const docH = Math.round(header.doc.h);
  if (docW < 1 || docH < 1 || docW > 20000 || docH > 20000) {
    throw new AchiFileError(`画布尺寸不合理：${docW}×${docH}`, 'BAD_HEADER');
  }

  // ---- 4. 数据块 ----
  const blocks = new Map();
  let p = 12 + headerLen;
  while (p < bodyLen) {
    if (p + 2 > bodyLen) throw new AchiFileError('数据块区被截断（读块名长度）', 'TRUNCATED');
    const nameLen = view.getUint16(p, true); p += 2;
    if (p + nameLen > bodyLen) throw new AchiFileError('数据块区被截断（读块名）', 'TRUNCATED');
    const name = new TextDecoder().decode(bytes.subarray(p, p + nameLen)); p += nameLen;

    if (p + 4 > bodyLen) throw new AchiFileError('数据块区被截断（读块长度）', 'TRUNCATED');
    const dataLen = view.getUint32(p, true); p += 4;
    if (p + dataLen > bodyLen) {
      throw new AchiFileError(`数据块 "${name}" 声明 ${dataLen} 字节，但文件剩余不足`, 'TRUNCATED');
    }
    if (blocks.has(name)) throw new AchiFileError(`数据块重名：${name}`, 'DUPLICATE_BLOCK');

    blocks.set(name, bytes.subarray(p, p + dataLen));
    p += dataLen;
  }

  // ---- 5. 图层树 ----
  if (!Array.isArray(header.layers)) throw new AchiFileError('头部缺 layers', 'BAD_TREE');

  const doc = new Doc(docW, docH);
  doc.root.children.length = 0;

  const used = new Set();
  for (const spec of header.layers) {
    const node = buildNode(spec, docW, docH, blocks, used, '');
    node.parent = doc.root;
    doc.root.children.push(node);
  }

  if (doc.root.children.length === 0) {
    throw new AchiFileError('文件里没有任何图层', 'EMPTY');
  }

  // 没被引用到的块说明文件比声明的多，不致命但记一笔
  for (const name of blocks.keys()) {
    if (!used.has(name)) warnings.push(`多余的数据块：${name}`);
  }

  // ---- 6. 真解码像素 ----
  const leaves = [];
  const walk = ns => ns.forEach(n => (n.isGroup ? walk(n.children) : leaves.push(n)));
  walk(doc.root.children);

  for (const l of leaves) {
    l.canvas = await pngToTileCanvas(blocks.get(l._pendingData), docW, docH, l.name);
    delete l._pendingData;
    if (l._pendingMask) {
      l.mask = await pngToTileCanvas(blocks.get(l._pendingMask), docW, docH, l.name + ' 蒙版');
      delete l._pendingMask;
    }
  }

  // 选中与笔刷落点：回到最上面那个图层
  const first = leaves[0];
  doc.select(first);
  doc.activeLeaf = first;

  if (header.view) {
    doc.view.x = Number(header.view.x) || 0;
    doc.view.y = Number(header.view.y) || 0;
    doc.view.zoom = Number(header.view.zoom) || 1;
  }

  return { doc, meta: header, warnings };
}
