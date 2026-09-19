/**
 * history.autoSeat 命令的端到端验证：
 * 模拟真实 Plan → autoArrange → applyCommand('autoSeat') → 检查 seatOrder。
 */
import { autoArrange } from '../arrange';
import { createHistoryManager } from '../../history';
import type { Plan } from '../../types';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const mk = (id: string, name: string, gid?: string, partySize = 1) => ({ id, name, tags: [], partySize, groupId: gid });

const plan: Plan = {
  id: 'p1', name: 't', updatedAt: 0,
  guests: [
    mk('a1', '张一', 'zj'), mk('a2', '张二', 'zj'), mk('a3', '张三', 'zj'),
    mk('b1', '李一', 'lj'), mk('b2', '李二', 'lj'),
    mk('c1', '散客甲'), mk('c2', '散客乙'),
  ],
  groups: [
    { id: 'zj', name: '张家', keepTogether: true },
    { id: 'lj', name: '李家', keepTogether: true },
  ],
  tables: [
    { id: 'T1', label: '1桌', x: 0, y: 0, shape: 'round', capacity: 10, seatOrder: [] },
    { id: 'T2', label: '2桌', x: 0, y: 0, shape: 'round', capacity: 10, seatOrder: [] },
    { id: 'T3', label: '3桌', x: 0, y: 0, shape: 'round', capacity: 10, seatOrder: [] },
  ],
  rules: [
    { id: 'r1', type: 'apart', a: 'zj', b: 'lj', aKind: 'group', bKind: 'group' },
    { id: 'r2', type: 'together', a: 'c1', b: 'c2' },
  ],
};

const r = autoArrange({
  guests: plan.guests.map(({ id, name, partySize, groupId }) => ({ id, name, partySize, groupId })),
  groups: plan.groups,
  tables: plan.tables.map(({ id, label, capacity }) => ({ id, label, capacity })),
  rules: plan.rules,
});
assert(r.ok, '自动排桌返回成功');
if (!r.ok) throw new Error('arrange failed');

const hm = createHistoryManager(plan);
hm.push(plan, { type: 'autoSeat', assignments: r.assignments });
const next = hm.current();

const t1 = next.tables.find((t) => t.id === 'T1')!;
const t2 = next.tables.find((t) => t.id === 'T2')!;
const t3 = next.tables.find((t) => t.id === 'T3')!;
const allSeated = next.tables.flatMap((t) => t.seatOrder).sort();
assert(allSeated.length === 7, `7 位宾客全部入座（实际 ${allSeated.length}）`);

const tableOf = new Map<string, string>();
for (const t of next.tables) for (const gid of new Set(t.seatOrder)) tableOf.set(gid, t.id);
assert(tableOf.get('a1') === tableOf.get('a2') && tableOf.get('a2') === tableOf.get('a3'), '张家三人同桌');
assert(tableOf.get('b1') === tableOf.get('b2'), '李家两人同桌');
assert(tableOf.get('a1') !== tableOf.get('b1'), '张家李家不同桌');
assert(tableOf.get('c1') === tableOf.get('c2'), '必须同桌的散客被放到一桌');
for (const t of next.tables) assert(t.seatOrder.length <= t.capacity, `${t.label} 不超员`);

// 撤销可用
const undone = hm.undo();
assert(!!undone && undone.tables.every((t) => t.seatOrder.length === 0), '自动排桌可一键撤销');

// partySize>1 占位
const plan2: Plan = {
  id: 'p2', name: 't2', updatedAt: 0,
  guests: [mk('fam', '王家一家三口', undefined, 3), mk('solo', '单人')],
  groups: [],
  tables: [{ id: 'X', label: '1桌', x: 0, y: 0, shape: 'round', capacity: 10, seatOrder: [] }],
  rules: [],
};
const r2 = autoArrange({
  guests: plan2.guests.map(({ id, name, partySize }) => ({ id, name, partySize })),
  groups: [],
  tables: plan2.tables.map(({ id, label, capacity }) => ({ id, label, capacity })),
  rules: [],
});
assert(r2.ok, '带家属场景排桌成功');
if (r2.ok) {
  const hm2 = createHistoryManager(plan2);
  hm2.push(plan2, { type: 'autoSeat', assignments: r2.assignments });
  const seat = hm2.current().tables[0].seatOrder;
  assert(seat.filter((x) => x === 'fam').length === 3, 'partySize=3 占连续 3 个号位');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
