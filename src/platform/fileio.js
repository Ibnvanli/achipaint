/* 文件读写：统一接口，三档实现
 *
 *   Electron     → 原生保存 / 打开对话框（preload 暴露的 window.achiFile）
 *   新版浏览器   → File System Access API（可记住上次目录，支持原地覆盖保存）
 *   其它环境     → 下载 / <input type=file>
 *
 * 上层只需调用 saveFile / openFile，无需关注底层采用哪一档实现。
 */

const EXT = '.achi';

function ensureExt(name) {
  return name.toLowerCase().endsWith(EXT) ? name : name + EXT;
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/* 浏览器下载兜底方案 */
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  // 立即 revoke 会导致部分浏览器的下载中断，因此延迟释放
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* 通过 <input type=file> 选取文件并读取 */
function pickWithInput() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = [EXT, '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].join(',');
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, buffer: await f.arrayBuffer(), handle: null });
    };
    // 用户取消时不会触发 onchange，以 focus 事件兜底
    const onFocus = () => setTimeout(() => {
      window.removeEventListener('focus', onFocus);
      if (!input.files || !input.files.length) resolve(null);
    }, 800);
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

/* 当前打开的文件句柄（浏览器环境中可原地覆盖保存） */
let currentHandle = null;

export function getCurrentFileName() {
  return currentHandle ? currentHandle.name : null;
}

export function resetCurrentFile() {
  currentHandle = null;
}

/**
 * 保存。
 * @param {Blob} blob
 * @param {object} opts { name, forceDialog }
 * @returns {Promise<{saved:boolean, name?:string, where?:string}>}
 */
export async function saveFile(blob, opts = {}) {
  const name = ensureExt(opts.name || `未命名-${stamp()}`);

  // 1) Electron 原生对话框
  if (window.achiFile && window.achiFile.save) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const path = await window.achiFile.save(buf, name);
    return path ? { saved: true, name: path.split('/').pop(), path } : { saved: false };
  }

  // 2) File System Access：已存在句柄时原地写入
  if (!opts.forceDialog && currentHandle && currentHandle.createWritable) {
    try {
      const w = await currentHandle.createWritable();
      await w.write(blob);
      await w.close();
      return { saved: true, name: currentHandle.name, path: null };
    } catch {
      currentHandle = null;   // 句柄失效，退回另存
    }
  }

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'AchiPaint 画布', accept: { 'application/x-achipaint': [EXT] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      currentHandle = handle;
      return { saved: true, name: handle.name, path: null };
    } catch (e) {
      if (e && e.name === 'AbortError') return { saved: false };
      // 其它错误继续走下载兜底方案
    }
  }

  downloadBlob(blob, name);
  return { saved: true, name, path: null, download: true };
}

/**
 * 打开。
 * @returns {Promise<{name:string, buffer:ArrayBuffer}|null>}
 */
export async function openFile() {
  if (window.achiFile && window.achiFile.open) {
    const r = await window.achiFile.open();
    if (!r) return null;
    // 经 IPC 传入的可能是 Uint8Array 或 ArrayBuffer
    const buffer = r.data instanceof ArrayBuffer ? r.data : r.data.buffer;
    currentHandle = null;
    return { name: r.name, buffer, path: r.path };
  }

  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        // 第一个 type 为默认选中项，需合并为一项，否则图片类型将呈灰色不可选
        types: [{
          description: 'AchiPaint 画布与图片',
          accept: {
            'application/x-achipaint': [EXT],
            'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'],
          },
        }],
        multiple: false,
      });
      const file = await handle.getFile();
      currentHandle = handle;
      return { name: file.name, buffer: await file.arrayBuffer(), handle };
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      // 回退至 input 兜底方案
    }
  }

  const picked = await pickWithInput();
  if (picked) currentHandle = null;
  return picked;
}

/* 按已知路径直接读取（仅 Electron 可获取路径） */
export function canOpenByPath() {
  return !!(window.achiFile && window.achiFile.read);
}

export async function openByPath(p) {
  if (!canOpenByPath()) return null;

  /* 主进程只接受用户授权过的路径。若该路径尚未授权（典型场景：重启后点击
   * 「最近文件」），先请求授权，由主进程弹出确认框。
   * 授权失败说明用户取消，此时返回 null，调用方应按「未打开」处理。 */
  if (window.achiFile.grant) {
    const ok = await window.achiFile.grant(p);
    if (!ok) return null;
  }

  const r = await window.achiFile.read(p);
  if (!r) return null;
  return {
    name: r.name,
    path: r.path,
    buffer: r.data instanceof ArrayBuffer ? r.data : r.data.buffer,
  };
}

/* 连同源文件一并删除（仅 Electron 支持） */
export function canDeleteFile() {
  return !!(window.achiFile && window.achiFile.remove);
}

export async function deleteFile(p) {
  if (!canDeleteFile() || !p) return false;
  await window.achiFile.remove(p);
  return true;
}

/* 判断当前环境能否原地覆盖保存（决定「保存」与「另存为」是否需分开处理） */
export function canOverwriteInPlace() {
  if (window.achiFile && window.achiFile.save) return true;
  return typeof window.showSaveFilePicker === 'function';
}
