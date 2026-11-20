/* 插件：PNG 导出
 * 注意其位置：读取的是已完成的图层栈，不介入笔刷链路。
 */
export default {
  id: 'export-png',
  name: 'PNG 导出',
  exporters: [{
    id: 'png',
    label: 'PNG',
    ext: '.png',
    async run(doc) {
      const cv = document.createElement('canvas');
      cv.width = doc.w; cv.height = doc.h;
      const ctx = cv.getContext('2d');

      /* 文档背景为白色时先垫白底。
       *
       * Doc.background 的约定是「只影响纸怎么显示，不写进图层」，
       * 导出时据此决定要不要垫白 —— 这里此前漏了这一步，
       * 导致选了白色背景导出后仍是透明底，打开一看跟预期不符。
       *
       * 透明背景则保持原样，由使用者自行决定后续垫什么。 */
      if (doc.background !== 'transparent') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cv.width, cv.height);
      }

      doc.composite(ctx, 1);
      return await new Promise(res => cv.toBlob(b => res(b), 'image/png'));
    },
  }],
};
