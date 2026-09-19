/**
 * 一键自动排桌
 *
 * 基于 engine.buildSeatingModel 得到的「单元 + 互斥图」：
 *  1. 每个单元由并查集合并而来（必须同桌 / 整家一桌的人焊在一起）；
 *  2. solvePacking 把每个单元整体分配到一张桌：互斥单元绝不同桌、每桌不超容；
 *  3. history 的 autoSeat 命令再把分配展开成每桌 seatOrder（同派别聚拢、
 *     partySize>1 的宾客连续占位）。
 */

import { buildSeatingModel, solvePacking } from './engine';
import type { SeatGuest, SeatGroup, SeatTable, SeatRule } from './engine';

export type ArrangeResult =
  | { ok: true; assignments: Record<string, string> }
  | { ok: false; reason: string };

export function autoArrange(input: {
  guests: SeatGuest[];
  groups: SeatGroup[];
  tables: SeatTable[];
  rules: SeatRule[];
}): ArrangeResult {
  if (input.tables.length === 0) return { ok: false, reason: '还没有桌，请先在画布上加桌。' };
  if (input.guests.length === 0) return { ok: true, assignments: {} };

  const m = buildSeatingModel(input);

  // 单桌放不下的硬伤提前拦（precheck 会给详细原因，这里兜底）
  for (const u of m.units) {
    if (u.people > m.maxCapacity) {
      return {
        ok: false,
        reason: `${m.unitName(u)} 一共 ${u.people} 人，被要求同桌，但最大一桌只有 ${m.maxCapacity} 座。请先在「摆桌前核对」里处理。`,
      };
    }
  }

  const packing = solvePacking({ units: m.units, unitGraph: m.unitGraph, tables: m.tables });
  if (!packing) {
    return {
      ok: false,
      reason: '在现有桌数与每桌容量下，没法同时满足所有「禁止同桌 / 必须同桌」约束。请加桌、调大桌容，或先在「摆桌前核对」里查看矛盾。',
    };
  }

  const assignments: Record<string, string> = {};
  for (const [unitId, ti] of packing) {
    const tid = m.tables[ti].id;
    for (const gid of m.unitMap.get(unitId)!.guestIds) assignments[gid] = tid;
  }

  return { ok: true, assignments };
}
