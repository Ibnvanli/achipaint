/* 启动页逻辑：只有「选尺寸 → 带着参数跳进画布」一件事 */

const VERSION = '0.1.0';

/* 内存估算：文档的合成缓冲是 w*h*4，加上一层瓦片再乘个系数。
 * 这几档的数字对 8GB 机器很现实，所以直接写在卡片上。 */
function memMB(w, h) {
  const off = (w * h * 4) / 1048576;
  return Math.round(off * 2.2);
}

const PRESETS = [
  { name: 'A4 · 300dpi', w: 2480, h: 3508, note: '印刷尺寸' },
  { name: 'A4 · 150dpi', w: 1240, h: 1754, note: '同 A4，省一半内存' },
  { name: 'A5 · 300dpi', w: 1748, h: 2480, note: '速写' },
  { name: '正方形', w: 2000, h: 2000, note: '头像 / 社交' },
  { name: '屏幕', w: 1920, h: 1080, note: '横版' },
  { name: '大画布', w: 3508, h: 4961, note: 'A3 · 300dpi' },
];

const grid = document.getElementById('presets');
const hint = document.getElementById('chint');
const cw = document.getElementById('cw');
const ch = document.getElementById('ch');

function open(w, h) {
  location.href = `./index.html?w=${w}&h=${h}`;
}

for (const p of PRESETS) {
  const mem = memMB(p.w, p.h);
  const btn = document.createElement('button');
  btn.className = 'w-card' + (mem > 180 ? ' heavy' : '');
  btn.dataset.w = p.w;
  btn.dataset.h = p.h;

  // 按比例画一个小样，横竖一眼分得清
  const ratio = p.h / p.w;
  const th = 36;
  const tw = Math.max(8, Math.round(th / ratio));

  btn.innerHTML = `
    <div class="w-thumb"><i style="width:${tw}px;height:${th}px"></i></div>
    <span class="n">${p.name}</span>
    <span class="d">${p.w} × ${p.h}</span>
    <span class="m">${p.note} · 约 ${mem} MB</span>
  `;
  btn.onclick = () => open(p.w, p.h);
  grid.appendChild(btn);
}

/* 自定义尺寸：边输边算内存，超过 300MB 提醒一下 */
function clamp(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function updateHint() {
  const w = clamp(cw.value, 64, 12000);
  const h = clamp(ch.value, 64, 12000);
  const mem = memMB(w, h);
  const px = (w * h / 1e6).toFixed(1);
  hint.textContent = `${px} 百万像素 · 约 ${mem} MB 内存` + (mem > 300 ? '　（这台机器 8GB，偏大了）' : '');
  hint.style.color = mem > 300 ? '#d99a4e' : '';
}

cw.addEventListener('input', updateHint);
ch.addEventListener('input', updateHint);
updateHint();

document.getElementById('ccreate').onclick = () => {
  open(clamp(cw.value, 64, 12000), clamp(ch.value, 64, 12000));
};

document.getElementById('ver').textContent = 'v' + VERSION;

/* Electron 里给标题栏让位、并标出渲染引擎 */
if (navigator.userAgent.includes('Electron')) {
  document.documentElement.classList.add('electron');
  document.getElementById('renderEngine').textContent = 'Electron · Chromium';
} else {
  document.getElementById('renderEngine').textContent = navigator.userAgent.includes('Chrome')
    ? 'Chromium' : 'WebKit';
}
