import { v4 as uuidv4 } from 'uuid';
import type { Plan } from './types';

export function generateId(): string {
  return uuidv4();
}

export function createEmptyPlan(name = '未命名方案'): Plan {
  return {
    id: generateId(),
    name,
    tables: [],
    guests: [],
    rules: [],
    groups: [],
    updatedAt: Date.now(),
  };
}

export function clonePlan(plan: Plan): Plan {
  return JSON.parse(JSON.stringify(plan));
}

/** 兼容旧版本方案：补齐 groups 等后加的字段 */
export function normalizePlan(plan: Plan): Plan {
  return {
    ...plan,
    groups: Array.isArray(plan.groups) ? plan.groups : [],
    tables: plan.tables ?? [],
    guests: plan.guests ?? [],
    rules: plan.rules ?? [],
  };
}

/**
 * 实时冲突检测：在当前已经摆上桌的座位里，把违规的宾客两两标出来。
 * 规则端点支持宾客或派别（group）：
 *  - apart / separate（禁止同桌 / 必须分开）：端点展开成宾客，同桌即冲突
 *  - together（必须同桌）：两人都已入座但不在同一桌即冲突
 *  - adjacent：实时检测里不做强制（属于号位级约束）
 */
export function getConflictMap(plan: Plan): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const { tables, rules, guests } = plan;

  const addConflict = (a: string, b: string) => {
    if (a === b) return;
    if (!map.has(a)) map.set(a, []);
    if (!map.has(b)) map.set(b, []);
    if (!map.get(a)!.includes(b)) map.get(a)!.push(b);
    if (!map.get(b)!.includes(a)) map.get(b)!.push(a);
  };

  const guestById = new Map(guests.map((g) => [g.id, g]));
  const endpointGuestIds = (id: string, kind?: 'guest' | 'group'): string[] => {
    if (kind === 'group') return guests.filter((g) => g.groupId === id).map((g) => g.id);
    if (kind === 'guest') return guestById.has(id) ? [id] : [];
    // 旧数据兼容：先按宾客找，找不到再当派别
    if (guestById.has(id)) return [id];
    return guests.filter((g) => g.groupId === id).map((g) => g.id);
  };

  for (const rule of rules) {
    if (rule.type === 'apart' || rule.type === 'separate') {
      const listA = endpointGuestIds(rule.a, rule.aKind);
      const listB = endpointGuestIds(rule.b, rule.bKind);
      for (const table of tables) {
        const seatedA = listA.filter((gid) => table.seatOrder.includes(gid));
        const seatedB = listB.filter((gid) => table.seatOrder.includes(gid));
        for (const a of seatedA) for (const b of seatedB) addConflict(a, b);
      }
    } else if (rule.type === 'together') {
      const listA = endpointGuestIds(rule.a, rule.aKind);
      const listB = endpointGuestIds(rule.b, rule.bKind);
      for (const a of listA) {
        for (const b of listB) {
          if (a === b) continue;
          const ta = tables.find((t) => t.seatOrder.includes(a));
          const tb = tables.find((t) => t.seatOrder.includes(b));
          if (ta && tb && ta.id !== tb.id) addConflict(a, b);
        }
      }
    }
  }
  return map;
}

export function getTableStats(plan: Plan) {
  let seated = 0;
  let capacity = 0;
  let emptySeats = 0;
  const unassigned = plan.guests.filter((g) => {
    const atTable = plan.tables.some((t) => t.seatOrder.includes(g.id));
    return !atTable;
  });
  for (const t of plan.tables) {
    seated += t.seatOrder.length;
    capacity += t.capacity;
    emptySeats += Math.max(0, t.capacity - t.seatOrder.length);
  }
  return { seated, capacity, emptySeats, totalGuests: plan.guests.length, unassignedCount: unassigned.length };
}

export function parseGuestsText(text: string): { name: string; tags: string[] }[] {
  const lines = text.split(/\n|，|,|;/).map((s) => s.trim()).filter(Boolean);
  const result: { name: string; tags: string[] }[] = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const name = parts[0];
    const tags = parts.slice(1);
    if (name) result.push({ name, tags });
  }
  return result;
}

export function exportPlanToJSON(plan: Plan): string {
  return JSON.stringify(plan, null, 2);
}

export function importPlanFromJSON(json: string): Plan | null {
  try {
    const p = JSON.parse(json);
    if (p.id && p.name && Array.isArray(p.tables) && Array.isArray(p.guests) && Array.isArray(p.rules)) {
      return p as Plan;
    }
  } catch {}
  return null;
}
