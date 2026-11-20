/* 图层默认编号
 *
 * 缺陷来源：编号由自增计数器 `_seq` 生成，删除图层后计数器不回退。
 * 于是新建时跳号，出现「图层 8、图层 6、图层 5」这种断号 ——
 * 从名字上看不出中间那个是删掉了还是丢了。
 *
 * 规则：新建时复用**最小的空号**；删除时保留现有名称不动。
 */

/* 收集所有节点名，按树顺序 */
function names(doc) {
  const out = [];
  const walk = ns => ns.forEach(n => {
    out.push(n.name);
    if (n.isGroup) walk(n.children);
  });
  walk(doc.root.children);
  return out;
}

/* 从名称里取编号，非「前缀 + 数字」形式返回 null */
function numOf(name, prefix) {
  const m = new RegExp('^' + prefix + ' (\\d+)$').exec(name);
  return m ? Number(m[1]) : null;
}

const CASES = {
  /* 连续新建：编号应连续递增 */
  '连续新建编号连续': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;
    doc.addLayer();
    doc.addLayer();
    doc.addLayer();

    const nums = names(doc).map(n => numOf(n, '图层')).filter(v => v !== null);
    assert(nums.length >= 3, `应至少有 3 个带编号的图层，实际 ${nums.length}`);

    const sorted = [...new Set(nums)].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      assertEq(sorted[i], i + 1, `编号应连续，实际出现 ${sorted.join(',')}`);
    }
  },

  /* 删除中间一个后新建，应补上那个空号 */
  '删除后新建补上空号': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;

    const a = doc.addLayer();   // 图层 1
    const b = doc.addLayer();   // 图层 2
    doc.addLayer();             // 图层 3

    const n2 = numOf(b.name, '图层');
    assert(n2 !== null, `被删除的图层应带编号，实际名称 ${b.name}`);

    /* 删掉中间那个 */
    doc.select(b);
    assert(doc.deleteNode(b), '删除应成功');

    /* 新建应拿到刚才被删掉的号，而不是继续往后加 */
    const c = doc.addLayer();
    assertEq(numOf(c.name, '图层'), n2,
      `新建应复用空号 ${n2}，实际得到 ${c.name}`);
  },

  /* 一次删多个，再逐个新建，应按小到大依次填充 */
  '多个空号按从小到大填充': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;

    const layers = [];
    for (let i = 0; i < 4; i++) layers.push(doc.addLayer());

    /* 删掉图层 2 和 3，留下 1、4 */
    for (const l of [layers[1], layers[2]]) {
      doc.select(l);
      doc.deleteNode(l);
    }

    const got = [];
    for (let i = 0; i < 2; i++) got.push(numOf(doc.addLayer().name, '图层'));

    assertEq(got.join(','), '2,3',
      `应依次填充空号 2、3，实际 ${got.join(',')}`);
  },

  /* 用户改过名的图层不占用编号 */
  '自定义名称不影响编号': async ({ achi, assert, assertEq }) => {
    const doc = achi.doc;

    const a = doc.addLayer();          // 图层 1
    const b = doc.addLayer();          // 图层 2

    /* 把图层 1 改成自定义名，它就不该再占用编号 1 */
    a.name = '草稿';
    doc.select(b);
    doc.deleteNode(b);                 // 删掉图层 2

    /* 此刻「草稿」不占号、图层 2 已被删，因此 1 与 2 都空。
     * 新建应拿到最小的空号 1 —— 注意不是 2：
     * 「草稿」改名后，原来的图层 1 这个号就释放了。 */
    const c = doc.addLayer();
    assertEq(numOf(c.name, '图层'), 1,
      `自定义名释放了编号 1，新建应得 1，实际 ${c.name}`);

    /* 再建一个，应得 2 */
    const d = doc.addLayer();
    assertEq(numOf(d.name, '图层'), 2,
      `下一个空号应为 2，实际 ${d.name}`);
  },

  /* 组与图层共用同一套编号规则，但互不干扰 */
  '组与图层编号互不干扰': async ({ achi, assert }) => {
    const doc = achi.doc;

    /* 在背景层上建组：会把该图层包进去 */
    const g = doc.addGroup();
    assert(numOf(g.name, '组') !== null,
      `组名应带编号，实际 ${g.name}`);

    const l = doc.addLayer();
    assert(numOf(l.name, '图层') !== null,
      `图层名应带编号，实际 ${l.name}`);
  },

  /* 新建图层不会与已有名称重复 */
  '新建不会出现重名': async ({ achi, assertEq }) => {
    const doc = achi.doc;

    const made = [];
    for (let i = 0; i < 5; i++) {
      made.push(doc.addLayer());
      /* 隔一个删一个，制造空号 */
      if (i % 2 === 1 && made.length > 1) {
        const victim = made[made.length - 2];
        doc.select(victim);
        doc.deleteNode(victim);
      }
    }

    const all = names(doc);
    const dup = all.filter((n, i) => all.indexOf(n) !== i);
    assertEq(dup.length, 0, `不应出现重名：${dup.join(',')}`);
  },
};
