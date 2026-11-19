/* 文件读写：一个接口，三档实现
 *
 *   Electron   → 原生保存/打开对话框（preload 暴露的 window.achiFile）
 *   浏览器新版 → File System Access API（能记住上次目录、能原地覆盖保存）
 *   其它       → 下载 / <input type=file>
 *
 * 上层只管调 saveFile / openFile，不关心底下是哪一档。
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

/* 浏览器下载兜底 */
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  // 立刻 revoke 会让某些浏览器的下载中断，给一点时间
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* 用 <input type=file> 选文件并读出来 */
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
    // 用户取消不会触发 onchange，靠 focus 兜底
    const onFocus = () => setTimeout(() => {
      window.removeEventListener('focus', onFocus);
      if (!input.files || !input.files.length) resolve(null);
    }, 800);
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

/* 当前打开的文件句柄（浏览器里可以原地覆盖保存） */
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

  // 2) File System Access：已有句柄就原地写
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
      // 其它错误继续走下载兜底
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
    // 通过 IPC 过来的可能是 Uint8Array 或 ArrayBuffer
    const buffer = r.data instanceof ArrayBuffer ? r.data : r.data.buffer;
    currentHandle = null;
    return { name: r.name, buffer, path: r.path };
  }

  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [
          { description: 'AchiPaint 画布', accept: { 'application/x-achipaint': [EXT] } },
          { description: '图片', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] } },
        ],
        multiple: false,
      });
      const file = await handle.getFile();
      currentHandle = handle;
      return { name: file.name, buffer: await file.arrayBuffer(), handle };
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      // 落到 input 兜底
    }
  }

  const picked = await pickWithInput();
  if (picked) currentHandle = null;
  return picked;
}

/* 按已知路径直接读（只有 Electron 能拿到路径） */
export function canOpenByPath() {
  return !!(window.achiFile && window.achiFile.read);
}

export async function openByPath(p) {
  if (!canOpenByPath()) return null;
  const r = await window.achiFile.read(p);
  if (!r) return null;
  return {
    name: r.name,
    path: r.path,
    buffer: r.data instanceof ArrayBuffer ? r.data : r.data.buffer,
  };
}

/* 连源文件一起删（只有 Electron 能做） */
export function canDeleteFile() {
  return !!(window.achiFile && window.achiFile.remove);
}

export async function deleteFile(p) {
  if (!canDeleteFile() || !p) return false;
  await window.achiFile.remove(p);
  return true;
}

/* 这个环境能不能原地覆盖保存（决定「保存」和「另存为」要不要分开） */
export function canOverwriteInPlace() {
  if (window.achiFile && window.achiFile.save) return true;
  return typeof window.showSaveFilePicker === 'function';
}
