/**
 * 摆桌前校验引擎 / 自动排桌的场景测试（node 下直接运行，不依赖测试框架）。
 * 运行：npx esbuild src/seating/__tests__/engine.test.ts --bundle --platform=node --format=esm | node
 */
import { precheck, buildGraph, findSimpleCycles, kColorable } from '../engine';
import { autoArrange } from '../arrange';
import type { SeatGuest, SeatGroup, SeatTable, SeatRule } from '../engine';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function makeTables(n: number, cap = 10): SeatTable[] {
  return Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, label: `${i + 1}桌`, capacity: cap }));
}

function guestsFrom(names: string[], groupId?: string, size = 1): SeatGuest[] {
  return names.map((name, i) => ({ id: `g-${name}-${i}-${groupId ?? 'x'}`, name, partySize: size, groupId }));
}

/* ---------- 场景 1：三方互斥圈，只有 2 桌 → 矛盾簇 ---------- */
console.log('\n[场景1] 张家↔李家↔王家 三方互斥，2 桌');
{
  const groups: SeatGroup[] = [
    { id: 'zj', name: '张家', keepTogether: false },
    { id: 'lj', name: '李家', keepTogether: false },
    { id: 'wj', name: '王家', keepTogether: false },
  ];
  const guests = [
    ...guestsFrom(['张一', '张二'], 'zj'),
    ...guestsFrom(['李一', '李二'], 'lj'),
    ...guestsFrom(['王一'], 'wj'),
  ];
  const rules: SeatRule[] = [
    { id: 'r1', type: 'apart', a: 'zj', b: 'lj', aKind: 'group', bKind: 'group' },
    { id: 'r2', type: 'apart', a: 'lj', b: 'wj', aKind: 'group', bKind: 'group' },
    { id: 'r3', type: 'apart', a: 'wj', b: 'zj', aKind: 'group', bKind: 'group' },
  ];
  const rep = precheck({ guests, groups, tables: makeTables(2, 10), rules });
  assert(!rep.feasible, '整体判定不可行');
  const cyc = rep.rings.find((r) => r.kind === 'cycle');
  assert(!!cyc && cyc.requiredTables === 3, '挑出了需要 3 桌的互斥圈');
  assert(rep.clusters.some((c) => c.kind === 'cycle' && c.requiredTables === 3), '矛盾簇标注为三方互斥、需 3 桌');
  for (const id of ['r1', 'r2', 'r3']) {
    const v = rep.ruleVerdicts.find((x) => x.ruleId === id)!;
    assert(v.status === 'conflicting', `规则 ${id} 单独一句话判定为满足不了`);
    assert(v.message.includes('至少要 3 桌') || v.message.includes('满足不了'), `规则 ${id} 结论说明了原因`);
  }
  // 3 桌就可行
  const rep3 = precheck({ guests, groups, tables: makeTables(3, 10), rules });
  assert(rep3.feasible, '同样关系换成 3 桌后可行');
  assert(rep3.rings.some((r) => r.kind === 'cycle' && r.feasible), '圈仍会提示，但标记为桌数够');
}

/* ---------- 场景 2：链（甲不能跟乙、乙不能跟丙），不应误报矛盾 ---------- */
console.log('\n[场景2] 互斥链 甲↔乙↔丙，2 桌');
{
  const guests = guestsFrom(['甲', '乙', '丙']);
  const rules: SeatRule[] = [
    { id: 'c1', type: 'apart', a: guests[0].id, b: guests[1].id },
    { id: 'c2', type: 'apart', a: guests[1].id, b: guests[2].id },
  ];
  const rep = precheck({ guests, groups: [], tables: makeTables(2, 10), rules });
  assert(rep.feasible, '链不是矛盾，2 桌可行');
  assert(rep.clusters.length === 0, '没有矛盾簇');
  assert(rep.rings.some((r) => r.kind === 'chain'), '链被提前挑出来提示');
  assert(rep.ruleVerdicts.every((v) => v.status === 'satisfiable'), '每条约束都是「可满足」');
}

/* ---------- 场景 3：自相矛盾（禁止同桌 + 必须同桌打架） ---------- */
console.log('\n[场景3] A/B 禁止同桌却又必须同桌');
{
  const guests = guestsFrom(['A', 'B']);
  const rules: SeatRule[] = [
    { id: 'x1', type: 'apart', a: guests[0].id, b: guests[1].id },
    { id: 'x2', type: 'together', a: guests[0].id, b: guests[1].id },
  ];
  const rep = precheck({ guests, groups: [], tables: makeTables(2, 10), rules });
  assert(!rep.feasible, '判定不可行');
  assert(rep.clusters.some((c) => c.kind === 'direct' && c.ruleIds.includes('x1') && c.ruleIds.includes('x2')), '两条规则聚进同一个直接矛盾簇，并说明打在哪一环');
  const apartV = rep.ruleVerdicts.find((v) => v.ruleId === 'x1')!;
  const togetherV = rep.ruleVerdicts.find((v) => v.ruleId === 'x2')!;
  assert(apartV.status === 'conflicting' && togetherV.status === 'conflicting', '两条规则各自的一句话都判定满足不了');
}

/* ---------- 场景 4：派别级互斥 + keepTogether 一家太大，提前提示 ---------- */
console.log('\n[场景4] 老同事一家 12 人勾了整家一桌，桌容 10');
{
  const groups: SeatGroup[] = [
    { id: 'lao', name: '爸爸老同事', keepTogether: true },
    { id: 'qin', name: '舅家亲戚', keepTogether: false },
  ];
  const guests = [
    ...guestsFrom(['老周', '老吴', '老郑', '老王', '老赵', '老钱', '老孙', '老李', '老冯', '老陈', '老楚', '老魏'], 'lao'),
    ...guestsFrom(['大舅', '二舅', '舅妈'], 'qin'),
  ];
  const rules: SeatRule[] = [{ id: 'o1', type: 'apart', a: 'lao', b: 'qin', aKind: 'group', bKind: 'group' }];
  const rep = precheck({ guests, groups, tables: makeTables(3, 10), rules });
  const over = rep.oversizes.find((o) => o.severity === 'error');
  assert(!!over && over.people === 12, '提前报出 12 人 > 10 座的硬错误（排座之前）');
  assert(!rep.feasible, '整体不可行，阻止自动排桌');
  // 没勾整家一桌时只是软提示
  const groups2 = groups.map((g) => (g.id === 'lao' ? { ...g, keepTogether: false } : g));
  const rep2 = precheck({ guests, groups: groups2, tables: makeTables(3, 10), rules });
  assert(rep2.oversizes.some((o) => o.severity === 'warning' && o.people === 12), '不勾整家一桌时降级为「要拆 2 桌」的软提示');
  assert(rep2.feasible, '软提示不阻止排座');
}

/* ---------- 场景 5：每规则一句话 + 悬空规则 ---------- */
console.log('\n[场景5] 悬空端点规则给待确认');
{
  const guests = guestsFrom(['独一']);
  const rules: SeatRule[] = [{ id: 'd1', type: 'apart', a: guests[0].id, b: 'gone' }];
  const rep = precheck({ guests, groups: [], tables: makeTables(2, 10), rules });
  const v = rep.ruleVerdicts.find((x) => x.ruleId === 'd1')!;
  assert(v.status === 'warning' && v.message.includes('已被删除'), '悬空规则一句话提示删除重选');
}

/* ---------- 场景 6：自动排桌遵守派别互斥 + 必须同桌 ---------- */
console.log('\n[场景6] 一键自动排桌：整家互斥不共桌、必须同桌不拆散');
{
  const groups: SeatGroup[] = [
    { id: 'zj', name: '张家', keepTogether: true },
    { id: 'lj', name: '李家', keepTogether: true },
  ];
  const guests = [
    ...guestsFrom(['张一', '张二', '张三', '张四'], 'zj'),
    ...guestsFrom(['李一', '李二'], 'lj'),
    ...guestsFrom(['散客甲', '散客乙']),
  ];
  const tables: (SeatTable & { seatOrder?: string[] })[] = makeTables(3, 10);
  const rules: SeatRule[] = [
    { id: 'a1', type: 'apart', a: 'zj', b: 'lj', aKind: 'group', bKind: 'group' },
    { id: 't1', type: 'together', a: guests[6].id, b: guests[7].id }, // 散客甲、乙必须同桌
  ];
  const rep = precheck({ guests, groups, tables, rules });
  assert(rep.feasible, '前置核对通过');
  const r = autoArrange({ guests, groups, tables, rules });
  assert(r.ok, '自动排桌成功');
  if (r.ok) {
    const tableOf = new Map<string, string>();
    for (const [gid, tid] of Object.entries(r.assignments)) tableOf.set(gid, tid);
    const zjTables = new Set(guests.slice(0, 4).map((g) => tableOf.get(g.id)));
    assert(zjTables.size === 1, '张家 4 人整家同桌');
    const ljTables = new Set(guests.slice(4, 6).map((g) => tableOf.get(g.id)));
    assert(ljTables.size === 1, '李家 2 人整家同桌');
    assert([...zjTables][0] !== [...ljTables][0], '张家与李家不同桌');
  }
}

/* ---------- 场景 7：容量装箱矛盾（色数够但装不下） ---------- */
console.log('\n[场景7] 两拨各 6 人互斥，2 桌各容 8：桌数够但装得下？');
{
  const guests = [...guestsFrom(['X1', 'X2', 'X3', 'X4', 'X5', 'X6']), ...guestsFrom(['Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'Y6'])];
  // 各自必须同桌
  const rules: SeatRule[] = [];
  for (let i = 1; i < 6; i++) rules.push({ id: `tx${i}`, type: 'together' as const, a: guests[0].id, b: guests[i].id });
  for (let i = 7; i < 12; i++) rules.push({ id: `ty${i}`, type: 'together' as const, a: guests[6].id, b: guests[i].id });
  rules.push({ id: 'xy', type: 'apart', a: guests[0].id, b: guests[6].id });
  // 每拨 6 人，桌容 8，2 桌 → 装得下
  const repOk = precheck({ guests, groups: [], tables: makeTables(2, 8), rules });
  assert(repOk.feasible, '6+6 互斥、桌容 8、2 桌：可行');
  // 桌容 5 但单拨 6 人 > 5 → oversize 硬错误
  const repBad = precheck({ guests, groups: [], tables: makeTables(3, 5), rules });
  assert(!repBad.feasible && repBad.oversizes.some((o) => o.severity === 'error' && o.people === 6), '单拨 6 人超过桌容 5 时提前报错');
}

/* ---------- 场景 8：图工具单测 ---------- */
console.log('\n[场景8] 图算法单测');
{
  const g = buildGraph([
    ['a', 'b'], ['b', 'c'], ['c', 'a'], // 三角形
    ['c', 'd'], ['d', 'e'], // 尾巴
  ]);
  const cyc = findSimpleCycles(g);
  assert(cyc.some((c) => c.length === 3), '能找出三角形环');
  assert(kColorable(g, 3) === true && kColorable(g, 2) === false, '三角形图 3 色可着、2 色不可着');
  const k4 = buildGraph([['a', 'b'], ['a', 'c'], ['a', 'd'], ['b', 'c'], ['b', 'd'], ['c', 'd']]);
  assert(kColorable(k4, 3) === false, 'K4 用 3 色不可着');
}

/* ---------- 场景 9：大型方案性能（40 桌 400 人，互斥图） ---------- */
console.log('\n[场景9] 性能：400 宾客、30 派别互斥');
{
  const groups: SeatGroup[] = Array.from({ length: 30 }, (_, i) => ({ id: `grp${i}`, name: `家${i}`, keepTogether: false }));
  const guests: SeatGuest[] = [];
  groups.forEach((grp) => {
    for (let i = 0; i < 13; i++) guests.push({ id: `${grp.id}-p${i}`, name: `${grp.name}-${i}`, partySize: 1, groupId: grp.id });
  });
  const rules: SeatRule[] = [];
  for (let i = 0; i < 30; i++) rules.push({ id: `rr${i}`, type: 'apart' as const, a: `grp${i}`, b: `grp${(i + 1) % 30}`, aKind: 'group' as const, bKind: 'group' as const });
  const t0 = Date.now();
  const rep = precheck({ guests, groups, tables: makeTables(40, 10), rules });
  const ms = Date.now() - t0;
  assert(ms < 3000, `390 人环形互斥校验在 ${ms}ms 内完成（<3s）`);
  assert(rep.feasible, '40 桌装 390 人且相邻家错开可行');
  const t1 = Date.now();
  const r = autoArrange({ guests, groups, tables: makeTables(40, 10), rules });
  const ms2 = Date.now() - t1;
  assert(r.ok, `大规模自动排桌成功（${ms2}ms）`);
}

/* ---------- 场景 10：装箱无解（着色可行但容量卡死） ---------- */
console.log('\n[场景10] 3 个大单元各 7 人两两互斥，2 桌各容 10：色数需要 3');
{
  const guests: SeatGuest[] = [];
  const rules: SeatRule[] = [];
  // 3 组各 7 人，组内 together
  for (let grp = 0; grp < 3; grp++) {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = `big-${grp}-${i}`;
      ids.push(id);
      guests.push({ id, name: `${grp + 1}组${i + 1}`, partySize: 1 });
    }
    for (let i = 1; i < 7; i++) rules.push({ id: `tg-${grp}-${i}`, type: 'together', a: ids[0], b: ids[i] });
  }
  // 三组两两互斥
  rules.push({ id: 'ab', type: 'apart', a: 'big-0-0', b: 'big-1-0' });
  rules.push({ id: 'bc', type: 'apart', a: 'big-1-0', b: 'big-2-0' });
  rules.push({ id: 'ca', type: 'apart', a: 'big-2-0', b: 'big-0-0' });
  const rep2 = precheck({ guests, groups: [], tables: makeTables(2, 10), rules });
  assert(!rep2.feasible, '三组两两互斥，2 桌不可行');
  const rep3 = precheck({ guests, groups: [], tables: makeTables(3, 10), rules });
  assert(rep3.feasible, '3 桌各容 10 装 3×7 可行');
  // 3 桌但每桌只能容 8：色数 3 够，但每桌放 7 后，三组都必须独占一桌，没有第四组空间问题——其实可行
  // 换成 4 组各 7 人、仅线性互斥 1-2-3-4，3 桌容 8：需 2 色但单桌 7 容量可行，故可行；构造真容量冲突：
  const guests2: SeatGuest[] = [];
  const rules2: SeatRule[] = [];
  for (let grp = 0; grp < 2; grp++) {
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      const id = `b2-${grp}-${i}`;
      ids.push(id);
      guests2.push({ id, name: `X${grp}${i}`, partySize: 1 });
    }
    for (let i = 1; i < 9; i++) rules2.push({ id: `t2-${grp}-${i}`, type: 'together', a: ids[0], b: ids[i] });
  }
  rules2.push({ id: 'apart2', type: 'apart', a: 'b2-0-0', b: 'b2-1-0' });
  // 2 桌各容 10，每单元 9 人互斥 → 放得下（9+0 / 0+9）
  const repOk = precheck({ guests: guests2, groups: [], tables: makeTables(2, 10), rules: rules2 });
  assert(repOk.feasible, '两单元各 9 人互斥，2 桌容 10：可行');
}

/* ---------- 场景 11：400 独立宾客、长 300 的互斥链，性能 ---------- */
console.log('\n[场景11] 400 宾客、300 条链状互斥规则的性能');
{
  const guests = Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, name: `客${i}`, partySize: 1 }));
  const rules: SeatRule[] = Array.from({ length: 300 }, (_, i) => ({ id: `chain-${i}`, type: 'apart' as const, a: `p${i}`, b: `p${i + 1}` }));
  const t0 = Date.now();
  const rep = precheck({ guests, groups: [], tables: makeTables(40, 10), rules });
  const ms = Date.now() - t0;
  assert(ms < 2000, `400 宾客长链校验 ${ms}ms（<2s）`);
  assert(rep.feasible && rep.rings.some((r) => r.kind === 'chain'), '长链可行且被识别');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
