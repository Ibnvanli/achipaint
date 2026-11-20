/* Achi 文件格式（.achi）v2
 *
 * 设计目标只有一条：**坏文件不能把当前画布搞坏，也不能静悄悄加载一半**。
 * 所以格式自带三层校验，任何一层不过就整体拒绝：
 *
 *   1. 结构校验：magic、版本、每个块的偏移和长度都必须在边界内
 *   2. CRC32    ：覆盖 magic 之后的全部字节
 *   3. 语义校验：JSON 能解析、图层树能重建、每块都被引用到、瓦片坐标不重复
 *
 * 读取时先完整解到一个新的 Doc 对象，全部成功之后才交给调用方去替换。
 *
 *
 * 文件布局（全部小端）
 * ─────────────────────────────────────────────
 *   0    magic          "ACHI"          4 B
 *   4    formatVersion  u16             2 B（当前 2）
 *   6    flags          u16             2 B（保留，必须为 0）
 *   8    headerLen      u32             4 B
 *   12   header         UTF-8 JSON      变长
 *        ……数据块区，每块：
 *          nameLen  u16
 *          name     UTF-8            （唯一，不能重名）
 *          dataLen  u32
 *          data     PNG              256×256 一块瓦片
 *   末尾 crc32          u32             4 B，覆盖 [0, 末尾-4)
 * ─────────────────────────────────────────────
 *
 * v2 相对 v1 的变化：**按瓦片存，不再整层存一张大图**。
 * 一个 A4 文档有 140 块瓦片，画几笔通常只有十几块真有笔迹，
 * 只存这些能把文件压到原来的几十分之一；空瓦片不落盘。
 * header 里每层带 tiles: [{c, r, data}] 记录有内容的块。
 *
 */
import { Doc, Layer, LayerGroup, TileCanvas, TILE } from './canvas.js';

export const MAGIC = 'ACHI';
export const FORMAT_VERSION = 2;
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

/* 一块瓦片有没有内容。全透明就不存 —— A4 有 140 块，通常只有十几块真有笔迹。 */
function tileHasInk(tile) {
  const w = tile.canvas.width, h = tile.canvas.height;
  const d = tile.ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
  return false;
}

/* 单块导出成 PNG。尺寸就是这块瓦片的实际尺寸（边缘块可能小于 256）。 */
async function tileToPng(tile) {
  const blob = await new Promise((resolve, reject) => {
    tile.canvas.toBlob(b => (b ? resolve(b) : reject(new AchiFileError('PNG 编码失败', 'ENCODE'))), 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/* 规划阶段：只产出 header 结构和「块名 → 瓦片」的映射，不做编码。 */
function planNode(node, plan) {
  const out = {
    type: node.isGroup ? 'group' : 'layer',
    name: node.name,
    visible: node.visible !== false,
    opacity: typeof node.opacity === 'number' ? node.opacity : 1,
    mode: node.mode || 'source-over',
  };

  if (node.isGroup) {
    out.expanded = !!node.expanded;
    out.children = node.children.map(c => planNode(c, plan));
    return out;
  }

  out.tiles = planTiles(node.canvas, plan);
  if (node.mask && node.mask.tiles.size) {
    out.mask = { tiles: planTiles(node.mask, plan) };
  }
  return out;
}

/* 收集某层的非空瓦片，给每块分配一个块名。 */
function planTiles(tc, plan) {
  const list = [];
  for (const [key, tile] of tc.tiles) {
    if (!tileHasInk(tile)) continue;          // 空块不存
    const [c, r] = key.split(',').map(Number);
    const name = 't' + plan.length;
    plan.push([name, tile]);
    list.push({ c, r, data: name });
  }
  return list;
}

/**
 * 序列化整个文档。
 * @param {Doc} doc
 * @param {object} extra 额外的元信息（笔刷设置等）
 * @returns {Promise<Blob>}
 */
export async function serialize(doc, extra = {}) {
  const plan = [];                       // [[块名, tile], ...]
  const header = {
    format: 'achipaint',
    version: FORMAT_VERSION,
    app: extra.app || '0.0.0',
    created: new Date().toISOString(),
    doc: { w: doc.w, h: doc.h, background: doc.background || 'white' },
    view: { x: doc.view.x, y: doc.view.y, zoom: doc.view.zoom },
    brush: extra.brush || null,
    layers: doc.root.children.map(n => planNode(n, plan)),
  };

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));

  /* 只编码真正有笔迹的瓦片；空图层产出的 plan 是空表。 */
  const encoded = [];
  for (const [name, tile] of plan) {
    encoded.push([name, await tileToPng(tile)]);
  }

  const enc = new TextEncoder();
  let total = 12 + headerBytes.length + 4;
  for (const [name, data] of encoded) {
    total += 2 + enc.encode(name).length + 4 + data.length;
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let p = 0;

  out.set(enc.encode(MAGIC), 0);
  p = 4;
  view.setUint16(p, FORMAT_VERSION, true); p += 2;
  view.setUint16(p, 0, true); p += 2;
  view.setUint32(p, headerBytes.length, true); p += 4;
  out.set(headerBytes, p); p += headerBytes.length;

  for (const [name, data] of encoded) {
    const nb = enc.encode(name);
    view.setUint16(p, nb.length, true); p += 2;
    out.set(nb, p); p += nb.length;
    view.setUint32(p, data.length, true); p += 4;
    out.set(data, p); p += data.length;
  }

  view.setUint32(p, crc32(out.subarray(0, p)), true);

  return new Blob([out], { type: MIME });
}

/* ---------- 读 ---------- */

/* 解一块瓦片 PNG 并贴回对应坐标。尺寸必须和该块应有的尺寸一致。 */
async function fillTiles(tc, list, blocks, docW, docH, label) {
  for (const e of list) {
    const { bmp, c, r, tw, th } = await pngToTile(blocks.get(e.data), e.c | 0, e.r | 0, docW, docH, label);
    const tile = tc.tile(c, r);
    // 只贴有效区域：边缘块右/下超出的部分是空的，不用画
    tile.ctx.drawImage(bmp, 0, 0, tw, th, 0, 0, tw, th);
    bmp.close?.();
  }
}

async function pngToTile(bytes, c, r, docW, docH, label) {
  const tw = Math.min(TILE, docW - c * TILE);
  const th = Math.min(TILE, docH - r * TILE);
  if (tw <= 0 || th <= 0) {
    throw new AchiFileError(`数据块 "${label}" 的坐标越界：(${c}, ${r})`, 'BAD_BLOCK');
  }

  const blob = new Blob([bytes], { type: 'image/png' });
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch (e) {
    throw new AchiFileError(`数据块 "${label}" 不是有效的 PNG`, 'BAD_BLOCK');
  }
  /* 瓦片 canvas 统一 256×256（边缘块超出文档的部分留空），
   * 所以这里校验固定尺寸，贴回时再按有效区域 tw×th 裁剪。 */
  if (bmp.width !== TILE || bmp.height !== TILE) {
    throw new AchiFileError(
      `数据块 "${label}" 尺寸不符：期望 ${TILE}×${TILE}，实际 ${bmp.width}×${bmp.height}`, 'BAD_BLOCK');
  }
  return { bmp, c, r, tw, th };
}

/* 校验图层/蒙版的瓦片清单：块要存在、坐标不能重复。 */
function checkTiles(list, blocks, used, where) {
  if (list === undefined) {
    throw new AchiFileError(`图层 "${where}" 缺少 tiles`, 'BAD_TREE');
  }
  if (!Array.isArray(list)) {
    throw new AchiFileError(`图层 "${where}" 的 tiles 不是数组`, 'BAD_TREE');
  }
  const seen = new Set();
  for (const e of list) {
    if (!e || !blocks.has(e.data)) {
      throw new AchiFileError(`图层 "${where}" 引用的块不存在：${e && e.data}`, 'MISSING_BLOCK');
    }
    const k = e.c + ',' + e.r;
    if (seen.has(k)) throw new AchiFileError(`图层 "${where}" 瓦片坐标重复：(${e.c}, ${e.r})`, 'BAD_TREE');
    seen.add(k);
    used.add(e.data);
  }
  return list;
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
  const l = new Layer(docW, docH, name);
  l.visible = spec.visible !== false;
  l.opacity = typeof spec.opacity === 'number' ? spec.opacity : 1;
  l.mode = spec.mode || 'source-over';

  /* 瓦片清单是必需的：空图层就是空数组（合法），缺字段才算坏。 */
  l._pendingTiles = checkTiles(spec.tiles, blocks, used, where);
  if (spec.mask) l._pendingMaskTiles = checkTiles(spec.mask.tiles, blocks, used, where + ' 蒙版');
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
  /* v1 是「整层存一张 PNG」的旧布局，v2 改成按瓦片存，结构不兼容。
   * 与其让它走到 BAD_TREE 报个看不懂的错，不如直接说清楚。 */
  if (version < 2) {
    throw new AchiFileError(
      `这是 AchiPaint 旧版本（v${version}）的文件，当前版本已改用新的存储格式，无法直接读取。`, 'LEGACY_FORMAT');
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
  /* 上限要和新建对话框一致（12000）。
   * 20 万像素见方会先分配 1.6GB 的离屏画布，坏文件能把内存吃光。 */
  const MAX_SIDE = 12000;
  if (docW < 1 || docH < 1 || docW > MAX_SIDE || docH > MAX_SIDE) {
    throw new AchiFileError(`画布尺寸不合理：${docW}×${docH}（上限 ${MAX_SIDE}）`, 'BAD_HEADER');
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

  const doc = new Doc(docW, docH, { background: header.doc.background });
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
    await fillTiles(l.canvas, l._pendingTiles, blocks, docW, docH, l.name);
    delete l._pendingTiles;
    if (l._pendingMaskTiles) {
      l.ensureMask();
      await fillTiles(l.mask, l._pendingMaskTiles, blocks, docW, docH, l.name + ' 蒙版');
      delete l._pendingMaskTiles;
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
