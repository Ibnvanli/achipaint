# vendor

随仓库分发的第三方库。**均为自包含的单文件 ESM**，无内部 import，可直接以相对路径引入。

本项目无构建步骤，因此不使用裸模块名（`import 'fflate'` 无法被浏览器解析），
统一按相对路径引用：

```js
import { gzipSync, gunzipSync } from '../vendor/fflate.js';
```

## 清单

| 文件 | 来源 | 版本 | 许可 |
|---|---|---|---|
| `fflate.js` | [fflate](https://github.com/101arrowz/fflate) `esm/browser.js` | 0.8.3 | MIT |
| `comlink.js` | [comlink](https://github.com/GoogleChromeLabs/comlink) `dist/esm/comlink.mjs` | 4.4.2 | Apache-2.0 |
| `perfect-freehand.js` | [perfect-freehand](https://github.com/steveruizok/perfect-freehand) `dist/esm/index.mjs` | 1.2.3 | MIT |

## 升级方式

```bash
npm pack <包名>@<版本>
tar xzf <包名>-<版本>.tgz
cp package/<上述路径> src/vendor/<文件名>.js
```

拷贝完成后执行一次导入测试，确认导出内容未发生变化。

## 体积

| 文件 | 大小 |
|---|---|
| `fflate.js` | 89KB |
| `comlink.js` | 12KB |
| `perfect-freehand.js` | 4.4KB |
