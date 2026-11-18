/* 插件：PNG 导出
 * 注意位置——它读的是已完成的图层栈，不碰笔刷。
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
      return await new Promise(res => cv.toBlob(b => res(b), 'image/png'));
    },
  }],
};
