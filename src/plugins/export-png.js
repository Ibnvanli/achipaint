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

      doc.composite(ctx, 1);

      /* 文档背景为白色时垫白底。
       *
       * Doc.background 的约定是「只影响纸怎么显示，不写进图层」，
       * 导出时据此决定要不要垫白。此前漏了这一步，选了白色背景导出后
       * 仍是透明底。
       *
       * 必须在 composite 之后：composite 开头会 clearRect 整张画布，
       * 先填的白底会被擦掉。
       * 用 destination-over 把白色垫在已有内容下方，笔迹不受影响。 */
      if (doc.background !== 'transparent') {
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.globalCompositeOperation = 'source-over';
      }
      return await new Promise(res => cv.toBlob(b => res(b), 'image/png'));
    },
  }],
};
