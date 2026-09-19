import { v4 as uuidv4 } from 'uuid';
import type { Plan } from './types';
import { buildForbiddenIndex } from './constraints';

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
    groupRules: [],
    updatedAt: Date.now(),
  };
}

export function clonePlan(plan: Plan): Plan {
  return JSON.parse(JSON.stringify(plan));
}

export function getConflictMap(plan: Plan): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const { tables, rules } = plan;

  const flagPair = (a: string, b: string) => {
    if (!map.has(a)) map.set(a, []);
    if (!map.has(b)) map.set(b, []);
    if (!map.get(a)!.includes(b)) map.get(a)!.push(b);
    if (!map.get(b)!.includes(a)) map.get(b)!.push(a);
  };

  // 不能同桌 / 必须分桌 / 成组标注：同桌即冲突（成组标注一并展开）
  const forbidden = buildForbiddenIndex(plan);
  for (const table of tables) {
    for (let i = 0; i < table.seatOrder.length; i++) {
      for (let j = i + 1; j < table.seatOrder.length; j++) {
        const a = table.seatOrder[i];
        const b = table.seatOrder[j];
        if (forbidden.get(a)?.has(b)) flagPair(a, b);
      }
    }
  }

  // 必须同桌：两人已落座却在不同桌才算冲突（未分配不告警）
  for (const rule of rules) {
    if (rule.type !== 'together') continue;
    const ta = tables.find((t) => t.seatOrder.includes(rule.a));
    const tb = tables.find((t) => t.seatOrder.includes(rule.b));
    if (ta && tb && ta.id !== tb.id) flagPair(rule.a, rule.b);
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
