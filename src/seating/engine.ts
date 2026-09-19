/**
 * 开摆前校验引擎（纯函数，不依赖 React / IndexedDB，可独立单测）
 *
 * 输入一个方案（宾客、派别、桌、规则），在真正排座位之前回答四件事：
 *  1. 每条约束单独一句话：能不能满足、为什么。
 *  2. 互相打架的约束聚成「矛盾簇」单独列出，并说明打在哪一环。
 *  3. 互斥关系里的圈 / 链（甲不能跟乙、乙又不能跟丙……）提前挑出来。
 *  4. 某一家（keepTogether 的派别 / 必须同桌单元）人数超过任何一桌容量时提前提示。
 *
 * 建模：
 *  - 用并查集把所有「必须同桌」关系合并成若干「单元 Unit」（单人也是一个单元）。
 *  - 「禁止同桌 / 必须分开」规则展开成单元之间的无向边，得到互斥图。
 *  - 互斥图 k 着色：k = 桌数。能 k 着色才可能排开；再用容量装箱确认每桌装得下。
 *  - 圈 / 链在派别粒度的图上找：链 = 极大路径，圈 = 简单环。
 */

export type SeatGroup = {
  id: string;
  name: string;
  keepTogether: boolean;
};

export type SeatGuest = {
  id: string;
  name: string;
  /** 赴宴人数（含家属），决定占几个座 */
  partySize: number;
  groupId?: string;
};

export type SeatTable = {
  id: string;
  label: string;
  capacity: number;
};

export type SeatRuleType = 'together' | 'apart' | 'adjacent' | 'separate';

export type SeatRule = {
  id: string;
  type: SeatRuleType;
  a: string;
  b: string;
  aKind?: 'guest' | 'group';
  bKind?: 'guest' | 'group';
};

export type RuleStatus = 'satisfiable' | 'conflicting' | 'warning';

/** 每条约束的单独结论：一句话 + 涉及的人 */
export type RuleVerdict = {
  ruleId: string;
  status: RuleStatus;
  /** 一句话结论 */
  message: string;
  /** 命中的矛盾簇 id（方便 UI 高亮联动） */
  clusterIds: string[];
};

/** 互相打架的一小撮规则 */
export type ConflictCluster = {
  id: string;
  severity: 'error' | 'warning';
  ruleIds: string[];
  /** 打在哪里：一句话说明 */
  summary: string;
  /** 逐环节的展开说明 */
  details: string[];
  kind: 'direct' | 'cycle' | 'capacity' | 'oversize';
  /** 需要几张不同的桌（着色类矛盾才有） */
  requiredTables?: number;
};

/** 互斥圈 / 链提示（不一定是错误，但摆桌前要让人知道） */
export type ExclusionRing = {
  kind: 'cycle' | 'chain';
  ruleIds: string[];
  /** 环节上的名字，如 张家 ↔ 李家 ↔ 王家 */
  names: string[];
  message: string;
  /** 圈内各方需要的不同桌数 */
  requiredTables: number;
  /** 现有桌数够不够 */
  feasible: boolean;
};

/** 某一家人太多、一桌放不下的提前提示 */
export type OversizeUnit = {
  label: string;
  people: number;
  maxCapacity: number;
  tableCount: number;
  severity: 'error' | 'warning';
  message: string;
  relatedRuleIds: string[];
};

export type PrecheckReport = {
  tableCount: number;
  totalCapacity: number;
  totalPeople: number;
  feasible: boolean;
  ruleVerdicts: RuleVerdict[];
  clusters: ConflictCluster[];
  rings: ExclusionRing[];
  oversizes: OversizeUnit[];
  notices: string[];
};

/* ------------------------------------------------------------------ */
/* 并查集                                                              */
/* ------------------------------------------------------------------ */

export class DSU {
  parent = new Map<string, string>();
  add(x: string) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x: string): string {
    this.add(x);
    const p = this.parent.get(x)!;
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string) {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/* ------------------------------------------------------------------ */
/* 内部类型                                                            */
/* ------------------------------------------------------------------ */

export type Unit = {
  id: string; // root guest id
  guestIds: string[];
  people: number;
  groupIds: Set<string>;
  gluedByRules: boolean;
};

type ParsedRule = {
  rule: SeatRule;
  aGuests: string[];
  bGuests: string[];
  aName: string;
  bName: string;
  aKind: 'guest' | 'group';
  bKind: 'guest' | 'group';
  dangling: boolean;
  selfLoop: boolean;
};

export type Graph = {
  adj: Map<string, Set<string>>;
};

/* ------------------------------------------------------------------ */
/* 图工具                                                              */
/* ------------------------------------------------------------------ */

export function buildGraph(edges: [string, string][]): Graph {
  const adj = new Map<string, Set<string>>();
  const add = (x: string) => {
    if (!adj.has(x)) adj.set(x, new Set());
  };
  for (const [u, v] of edges) {
    add(u);
    add(v);
    adj.get(u)!.add(v);
    adj.get(v)!.add(u);
  }
  return { adj };
}

export function inducedSubgraph(graph: Graph, nodes: Set<string>): Graph {
  const edges: [string, string][] = [];
  for (const u of nodes) {
    for (const v of graph.adj.get(u)!) {
      if (nodes.has(v) && u < v) edges.push([u, v]);
    }
  }
  return buildGraph(edges);
}

/** 枚举无向图中长度 3..maxLen 的简单环（按最小节点固定起点去重） */
export function findSimpleCycles(graph: Graph, maxLen = 8): string[][] {
  const { adj } = graph;
  const nodes = [...adj.keys()].sort();
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const canonical = (cyc: string[]) => {
    let best = cyc.join('|');
    for (let i = 0; i < cyc.length; i++) {
      const rot = [...cyc.slice(i), ...cyc.slice(0, i)].join('|');
      if (rot < best) best = rot;
    }
    return best;
  };

  const dfs = (start: string, cur: string, path: string[], blocked: Set<string>) => {
    for (const next of [...adj.get(cur)!].sort()) {
      if (next < start) continue;
      if (next === start && path.length >= 3) {
        const key = canonical(path);
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push([...path]);
        }
        continue;
      }
      if (blocked.has(next)) continue;
      if (path.length >= maxLen) continue;
      blocked.add(next);
      dfs(start, next, [...path, next], blocked);
      blocked.delete(next);
    }
  };

  for (const start of nodes) dfs(start, start, [start], new Set([start]));
  return cycles;
}

/**
 * DSATUR 精确 k 着色（回溯）。
 * 返回 true/false；budget 用尽返回 null（算不动了，保守处理）。
 */
export function kColorable(graph: Graph, k: number, budget = 200000): boolean | null {
  const nodes = [...graph.adj.keys()];
  if (nodes.length === 0) return true;
  if (k <= 0) return false;
  const color = new Map<string, number>();
  let visited = 0;

  const pickNext = (): string => {
    let best = nodes[0];
    let bestSat = -1;
    let bestDeg = -1;
    for (const n of nodes) {
      if (color.has(n)) continue;
      const used = new Set<number>();
      for (const m of graph.adj.get(n)!) {
        const c = color.get(m);
        if (c !== undefined) used.add(c);
      }
      const uncoloredDeg = [...graph.adj.get(n)!].filter((m) => !color.has(m)).length;
      if (used.size > bestSat || (used.size === bestSat && uncoloredDeg > bestDeg)) {
        best = n;
        bestSat = used.size;
        bestDeg = uncoloredDeg;
      }
    }
    return best;
  };

  const bt = (): boolean => {
    if (++visited > budget) throw new Error('BUDGET_EXCEEDED');
    if (color.size === nodes.length) return true;
    const node = pickNext();
    const neighborColors = new Set<number>();
    for (const m of graph.adj.get(node)!) {
      const c = color.get(m);
      if (c !== undefined) neighborColors.add(c);
    }
    const candidates = Array.from({ length: k }, (_, i) => i).filter((c) => !neighborColors.has(c));
    for (const c of candidates) {
      color.set(node, c);
      if (bt()) return true;
      color.delete(node);
    }
    return false;
  };

  try {
    return bt();
  } catch (e) {
    if (e instanceof Error && e.message === 'BUDGET_EXCEEDED') return null;
    throw e;
  }
}

/** 求一个图的色数（从小往大试） */
export function chromaticNumber(graph: Graph, maxK: number): number {
  const nodes = [...graph.adj.keys()];
  if (nodes.length === 0) return 0;
  // 下界：贪心取一个团
  let lower = 1;
  const sorted = [...nodes].sort((a, b) => graph.adj.get(b)!.size - graph.adj.get(a)!.size);
  const clique = new Set<string>();
  for (const n of sorted) {
    if ([...clique].every((m) => graph.adj.get(n)!.has(m))) clique.add(n);
  }
  lower = Math.max(lower, clique.size);
  for (let k = lower; k <= maxK; k++) {
    const r = kColorable(graph, k);
    if (r === true) return k;
    if (r === null) return Math.max(k, lower);
  }
  return maxK + 1;
}

/** 找极小不可着色子图（不可满足核），用于说明"打在哪一环" */
function minimalUncolorableSubgraph(graph: Graph, k: number): string[] {
  let core = new Set(graph.adj.keys());
  for (const n of [...core]) {
    const trial = new Set(core);
    trial.delete(n);
    const sub = inducedSubgraph(graph, trial);
    if (sub.adj.size > 0 && kColorable(sub, k) === false) core = trial;
  }
  return [...core];
}

/* ------------------------------------------------------------------ */
/* 模型构建：解析端点 → 并查集合并 → 互斥图（precheck / arrange 共用）  */
/* ------------------------------------------------------------------ */

export type SeatingModel = {
  guests: SeatGuest[];
  groups: SeatGroup[];
  tables: SeatTable[];
  guestById: Map<string, SeatGuest>;
  groupById: Map<string, SeatGroup>;
  parsed: ParsedRule[];
  dsu: DSU;
  units: Unit[];
  unitMap: Map<string, Unit>;
  unitGraph: Graph;
  edgeRecs: { ua: string; ub: string; ruleId: string }[];
  gluedGroupIds: Set<string>;
  tableCount: number;
  maxCapacity: number;
  totalCapacity: number;
  totalPeople: number;
  unitName: (u: Unit) => string;
};

export function buildSeatingModel(input: {
  guests: SeatGuest[];
  groups: SeatGroup[];
  tables: SeatTable[];
  rules: SeatRule[];
}): SeatingModel {
  const { guests, groups, tables, rules } = input;
  const guestById = new Map(guests.map((g) => [g.id, g]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const tableCount = tables.length;
  const maxCapacity = tables.reduce((m, t) => Math.max(m, t.capacity), 0);
  const totalCapacity = tables.reduce((s, t) => s + t.capacity, 0);
  const totalPeople = guests.reduce((s, g) => s + Math.max(1, g.partySize), 0);

  const endpointGuests = (id: string, kind: 'guest' | 'group'): string[] =>
    kind === 'group' ? guests.filter((g) => g.groupId === id).map((g) => g.id) : [id];
  const endpointName = (id: string, kind: 'guest' | 'group'): string => {
    if (kind === 'group') return groupById.has(id) ? `${groupById.get(id)!.name}（一家）` : `已删除派别 ${id.slice(0, 8)}`;
    if (guestById.has(id)) return guestById.get(id)!.name;
    if (groupById.has(id)) return `${groupById.get(id)!.name}（一家）`;
    return `已删除对象 ${id.slice(0, 8)}`;
  };

  const parsed: ParsedRule[] = rules.map((rule) => {
    const aKind: 'guest' | 'group' = rule.aKind ?? (guestById.has(rule.a) ? 'guest' : 'group');
    const bKind: 'guest' | 'group' = rule.bKind ?? (guestById.has(rule.b) ? 'guest' : 'group');
    const aGuests = endpointGuests(rule.a, aKind).filter((gid) => guestById.has(gid));
    const bGuests = endpointGuests(rule.b, bKind).filter((gid) => guestById.has(gid));
    const dangling = aGuests.length === 0 || bGuests.length === 0;
    const setA = new Set(aGuests);
    const selfLoop = !dangling && bGuests.some((g) => setA.has(g));
    return { rule, aGuests, bGuests, aName: endpointName(rule.a, aKind), bName: endpointName(rule.b, bKind), aKind, bKind, dangling, selfLoop };
  });

  // 并查集
  const dsu = new DSU();
  guests.forEach((g) => dsu.add(g.id));
  const gluedGroupIds = new Set<string>();
  for (const grp of groups) {
    if (grp.keepTogether) {
      const members = guests.filter((g) => g.groupId === grp.id);
      for (let i = 1; i < members.length; i++) dsu.union(members[0].id, members[i].id);
      if (members.length > 0) gluedGroupIds.add(grp.id);
    }
  }
  for (const p of parsed) {
    if (p.rule.type !== 'together' || p.dangling) continue;
    // 端点（可能是整家派别）内所有人彼此合并
    const all = [...p.aGuests, ...p.bGuests];
    for (let i = 1; i < all.length; i++) dsu.union(all[0], all[i]);
  }

  const unitMap = new Map<string, Unit>();
  for (const g of guests) {
    const root = dsu.find(g.id);
    if (!unitMap.has(root)) unitMap.set(root, { id: root, guestIds: [], people: 0, groupIds: new Set(), gluedByRules: false });
    const u = unitMap.get(root)!;
    u.guestIds.push(g.id);
    u.people += Math.max(1, g.partySize);
    if (g.groupId) u.groupIds.add(g.groupId);
  }
  // 显式 together 规则涉及的单元标记 gluedByRules
  for (const p of parsed) {
    if (p.rule.type !== 'together' || p.dangling) continue;
    const root = dsu.find(p.aGuests[0]);
    const u = unitMap.get(root);
    if (u) u.gluedByRules = true;
  }
  const units = [...unitMap.values()];

  const unitName = (u: Unit): string => {
    const names = u.guestIds.map((gid) => guestById.get(gid)?.name ?? gid);
    if (u.gluedByRules) {
      return names.length <= 3
        ? `${names.join('、')} 这${names.length === 2 ? '俩' : '拨'}`
        : `${names.slice(0, 3).join('、')} 等 ${names.length} 人这拨`;
    }
    if (u.groupIds.size === 1 && u.guestIds.length > 1) {
      const grp = groupById.get([...u.groupIds][0]);
      return grp ? `${grp.name}（${names.slice(0, 2).join('、')} 等 ${names.length} 人）` : names.join('、');
    }
    return names.length === 1 ? names[0] : names.join('、');
  };

  // 互斥边
  const edgeRecs: { ua: string; ub: string; ruleId: string }[] = [];
  const edgeSeen = new Set<string>();
  for (const p of parsed) {
    if (p.rule.type !== 'apart' && p.rule.type !== 'separate') continue;
    if (p.dangling) continue;
    for (const ga of p.aGuests) {
      for (const gb of p.bGuests) {
        const x = dsu.find(ga);
        const y = dsu.find(gb);
        if (x === y) continue;
        const ua = x < y ? x : y;
        const ub = x < y ? y : x;
        const key = `${ua}|${ub}`;
        if (!edgeSeen.has(key)) edgeSeen.add(key);
        edgeRecs.push({ ua, ub, ruleId: p.rule.id });
      }
    }
  }
  const unitGraph = buildGraph(edgeRecs.map((e) => [e.ua, e.ub] as [string, string]));

  return {
    guests,
    groups,
    tables,
    guestById,
    groupById,
    parsed,
    dsu,
    units,
    unitMap,
    unitGraph,
    edgeRecs,
    gluedGroupIds,
    tableCount,
    maxCapacity,
    totalCapacity,
    totalPeople,
    unitName,
  };
}

/* ------------------------------------------------------------------ */
/* 主流程：开摆前校验                                                   */
/* ------------------------------------------------------------------ */

export function precheck(input: {
  guests: SeatGuest[];
  groups: SeatGroup[];
  tables: SeatTable[];
  rules: SeatRule[];
}): PrecheckReport {
  const m = buildSeatingModel(input);
  const { guestById, groupById, parsed, dsu, units, unitMap, unitGraph, edgeRecs, gluedGroupIds, unitName } = m;
  const tableCount = m.tableCount;
  const maxCapacity = m.maxCapacity;

  const notices: string[] = [];
  if (tableCount === 0) notices.push('方案里还没有桌，互斥关系暂时无法判断桌数是否够用，请先在画布上加桌。');
  if (m.totalCapacity < m.totalPeople) {
    notices.push(`全部宾客共 ${m.totalPeople} 人，现有 ${tableCount} 桌总共只有 ${m.totalCapacity} 个座，还差 ${m.totalPeople - m.totalCapacity} 个座。`);
  }

  const selfConflictRuleIds = new Set<string>();
  for (const p of parsed) {
    if (p.rule.type !== 'apart' && p.rule.type !== 'separate') continue;
    if (p.dangling) continue;
    const setRoots = new Set(p.aGuests.map((g) => dsu.find(g)));
    if (p.bGuests.some((g) => setRoots.has(dsu.find(g)))) selfConflictRuleIds.add(p.rule.id);
  }

  /* ---------- 超大单元 / 派别提示 ---------- */

  const oversizes: OversizeUnit[] = [];
  const oversizeRuleByUnit = new Map<string, string[]>();
  for (const p of parsed) {
    if (p.rule.type !== 'together' || p.dangling) continue;
    const root = dsu.find(p.aGuests[0]);
    if (!oversizeRuleByUnit.has(root)) oversizeRuleByUnit.set(root, []);
    oversizeRuleByUnit.get(root)!.push(p.rule.id);
  }
  for (const u of units) {
    if (u.people <= maxCapacity) continue;
    const hasKeepGroup = [...u.groupIds].some((gid) => gluedGroupIds.has(gid));
    const severity = u.gluedByRules || hasKeepGroup ? 'error' : 'warning';
    oversizes.push({
      label: unitName(u),
      people: u.people,
      maxCapacity,
      tableCount,
      severity,
      relatedRuleIds: oversizeRuleByUnit.get(u.id) ?? [],
      message:
        severity === 'error'
          ? `${unitName(u)}一共 ${u.people} 人，被要求坐一桌，但现有最大的桌只能坐 ${maxCapacity} 人，摆不下：得换大桌，或取消「必须同桌 / 整家一桌」。`
          : `${unitName(u)}一共 ${u.people} 人，一桌（${maxCapacity} 人）坐不下，要拆到 ${Math.ceil(u.people / Math.max(1, maxCapacity))} 桌；若想这一家尽量坐一起，提前把桌容调大或勾上整家一桌核对。`,
    });
  }

  // 派别维度：哪怕没勾整家一桌，一家总人数超过单桌也要提前打招呼（软提示）
  for (const grp of m.groups) {
    const members = m.guests.filter((g) => g.groupId === grp.id);
    if (members.length === 0) continue;
    const people = members.reduce((s, g) => s + Math.max(1, g.partySize), 0);
    if (people <= maxCapacity) continue;
    if (gluedGroupIds.has(grp.id)) continue; // 勾了整家一桌的已在单元层按硬错误报过
    // 若成员已被 together 规则焊成同一大单元（单元层会报），也不重复
    const roots = new Set(members.map((g) => dsu.find(g.id)));
    if (roots.size === 1) continue;
    oversizes.push({
      label: `${grp.name}（一家）`,
      people,
      maxCapacity,
      tableCount,
      severity: 'warning',
      relatedRuleIds: [],
      message: `${grp.name}一共 ${people} 人，一桌（${maxCapacity} 人）坐不下，自然要拆到 ${Math.ceil(people / Math.max(1, maxCapacity))} 桌；如果希望这一家整家坐一起，提前调大桌容或勾选「整家一桌」再核对。`,
    });
  }

  /* ---------- 着色：逐连通分量 ---------- */

  const components: string[][] = [];
  const seenNode = new Set<string>();
  for (const n of unitGraph.adj.keys()) {
    if (seenNode.has(n)) continue;
    const stack = [n];
    const comp: string[] = [];
    seenNode.add(n);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const nb of unitGraph.adj.get(cur)!) {
        if (!seenNode.has(nb)) {
          seenNode.add(nb);
          stack.push(nb);
        }
      }
    }
    components.push(comp);
  }

  type CompInfo = { nodes: string[]; chi: number; feasible: boolean | null; core: string[] };
  const compInfos: CompInfo[] = components.map((nodes) => {
    const sub = inducedSubgraph(unitGraph, new Set(nodes));
    const chi = chromaticNumber(sub, Math.max(tableCount, nodes.length));
    const result = kColorable(sub, tableCount);
    const core = result === false ? minimalUncolorableSubgraph(sub, tableCount) : nodes;
    return { nodes, chi, feasible: result, core };
  });

  /* ---------- 派别粒度的圈 / 链 ---------- */

  const groupNodeOfGuest = (gid: string): string => {
    const g = guestById.get(gid);
    return g?.groupId ? `grp:${g.groupId}` : `guest:${gid}`;
  };
  const groupNodeName = (node: string): string =>
    node.startsWith('grp:')
      ? `${groupById.get(node.slice(4))?.name ?? '已删除派别'}（一家）`
      : guestById.get(node.slice(6))?.name ?? '?';

  const ringEdges: [string, string, string][] = [];
  const ringEdgeSeen = new Set<string>();
  for (const rec of edgeRecs) {
    const ua = unitMap.get(rec.ua)!;
    const ub = unitMap.get(rec.ub)!;
    for (const ga of ua.guestIds) {
      for (const gb of ub.guestIds) {
        const x = groupNodeOfGuest(ga);
        const y = groupNodeOfGuest(gb);
        if (x === y) continue;
        const [lo, hi] = x < y ? [x, y] : [y, x];
        const key = `${lo}|${hi}|${rec.ruleId}`;
        if (!ringEdgeSeen.has(key)) {
          ringEdgeSeen.add(key);
          ringEdges.push([lo, hi, rec.ruleId]);
        }
      }
    }
  }
  const ringGraph = buildGraph(ringEdges.map(([u, v]) => [u, v] as [string, string]));
  const edgeRuleRing = new Map<string, string[]>();
  for (const [u, v, rid] of ringEdges) {
    const key = `${u}|${v}`;
    if (!edgeRuleRing.has(key)) edgeRuleRing.set(key, []);
    const arr = edgeRuleRing.get(key)!;
    if (!arr.includes(rid)) arr.push(rid);
  }

  const rings: ExclusionRing[] = [];

  // 圈检测：用 DFS 染色按连通分量判断二分图。
  // 非二分分量含奇圈（至少 3 桌才能错开）；二分分量但有环则为偶圈（2 桌）。
  // 同时记录「长在某个圈上」的节点，用于后面把链和圈分开。
  const cycleNodeSet = new Set<string>();
  const colorMark = new Map<string, number>();
  for (const start of ringGraph.adj.keys()) {
    if (colorMark.has(start)) continue;
    // DFS 返回 { hasCycle, bipartite, nodes, edgeList }
    const nodes: string[] = [];
    const compEdges: [string, string][] = [];
    let bipartite = true;
    const col = new Map<string, number>([[start, 0]]);
    const parent = new Map<string, string>([[start, '']]);
    // back edge 检测环：DFS
    const stack: { n: string; it: number }[] = [{ n: start, it: 0 }];
    colorMark.set(start, 0);
    nodes.push(start);
    let hasCycle = false;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const neighbors = ringGraph.adj.get(frame.n)!;
      const arr = [...neighbors];
      if (frame.it >= arr.length) {
        stack.pop();
        continue;
      }
      const nb = arr[frame.it++];
      if (nb === parent.get(frame.n)) continue;
      compEdges.push(frame.n < nb ? [frame.n, nb] : [nb, frame.n]);
      if (!col.has(nb)) {
        col.set(nb, col.get(frame.n)! ^ 1);
        colorMark.set(nb, col.get(nb)!);
        parent.set(nb, frame.n);
        nodes.push(nb);
        stack.push({ n: nb, it: 0 });
      } else {
        hasCycle = true;
        if (col.get(nb) === col.get(frame.n)) bipartite = false;
      }
    }

    if (!hasCycle) continue;
    // 该分量有环：把「在圈上」的节点标出来（删叶法）
    const degree = new Map<string, number>();
    for (const n of nodes) degree.set(n, ringGraph.adj.get(n)!.size);
    const leaves = nodes.filter((n) => degree.get(n)! <= 1);
    while (leaves.length) {
      const leaf = leaves.shift()!;
      const d = degree.get(leaf) ?? 0;
      if (d > 1) continue;
      degree.set(leaf, 0);
      for (const nb of ringGraph.adj.get(leaf)!) {
        const dn = (degree.get(nb) ?? 0) - 1;
        degree.set(nb, dn);
        if (dn === 1) leaves.push(nb);
      }
    }
    for (const n of nodes) if ((degree.get(n) ?? 0) >= 2) cycleNodeSet.add(n);

    // 收集该分量环上的规则 id，用于一句话联动
    const ruleIds: string[] = [];
    for (const [u, v] of compEdges) {
      if (!cycleNodeSet.has(u) || !cycleNodeSet.has(v)) continue;
      const key = `${u}|${v}`;
      for (const rid of edgeRuleRing.get(key) ?? []) if (!ruleIds.includes(rid)) ruleIds.push(rid);
    }

    // 三角形单独精确报（最常见的「三方互相不能同桌」）
    let triRep: string[] | null = null;
    if (nodes.length <= 12) {
      for (const cyc of findSimpleCycles(inducedSubgraph(ringGraph, new Set(nodes)), 6)) {
        if (cyc.length === 3) {
          triRep = cyc;
          break;
        }
      }
    }

    const required = bipartite ? 2 : 3;
    const feasible = tableCount === 0 || tableCount >= required;
    const onCycleNames = nodes.filter((n) => cycleNodeSet.has(n)).map(groupNodeName);
    const sample = onCycleNames.slice(0, 6).join(' ↔ ');
    rings.push({
      kind: 'cycle',
      ruleIds: ruleIds.length ? ruleIds : [...new Set(compEdges.flatMap(([u, v]) => edgeRuleRing.get(`${u}|${v}`) ?? []))],
      names: triRep ? [...triRep.map(groupNodeName), groupNodeName(triRep[0])] : [`${sample} …`],
      requiredTables: required,
      feasible,
      message: triRep
        ? `三方互相不能同桌（${triRep.map(groupNodeName).join(' ↔ ')}），需要 3 张不同的桌${tableCount > 0 ? `，现在只有 ${tableCount} 桌` : ''}。`
        : bipartite
          ? `这一挂互斥关系绕成了环（如 ${sample} …），偶数环 2 张桌就能错开，本身不矛盾，摆桌时知道即可。`
          : `这一挂互斥关系绕成了奇圈（如 ${sample} …），至少 3 张桌才能把各方完全错开${tableCount > 0 ? `，现在只有 ${tableCount} 桌` : ''}。`,
    });
  }

  // 链：删除所有圈上节点后的子图里，内部度数≥2 的连通路径
  const chainVisited = new Set<string>();
  const internalNeighbors = (n: string): string[] =>
    [...ringGraph.adj.get(n)!].filter((x) => !cycleNodeSet.has(x));
  for (const node of ringGraph.adj.keys()) {
    if (chainVisited.has(node) || cycleNodeSet.has(node)) continue;
    if (internalNeighbors(node).length < 2) continue;
    // BFS 出整条连通路径（只走圈外节点）
    const path: string[] = [];
    const q = [node];
    const seen = new Set<string>([node]);
    while (q.length) {
      const cur = q.shift()!;
      chainVisited.add(cur);
      path.push(cur);
      for (const nb of internalNeighbors(cur)) {
        if (!seen.has(nb)) {
          seen.add(nb);
          q.push(nb);
        }
      }
    }
    // 分叉（内部度>2）不是简单链，跳过
    const maxDeg = Math.max(...path.map((n) => internalNeighbors(n).length));
    if (path.length < 3 || maxDeg > 2) continue;
    // 从端点（内部度≤1）开始排成有序路径
    const endpoint = path.find((n) => internalNeighbors(n).length <= 1) ?? path[0];
    const ordered: string[] = [];
    let prev: string | null = null;
    let cur: string | null = endpoint;
    const ruleIds: string[] = [];
    while (cur) {
      ordered.push(cur);
      const next: string | undefined = internalNeighbors(cur).find((x) => x !== prev);
      if (next) {
        const key = cur < next ? `${cur}|${next}` : `${next}|${cur}`;
        for (const rid of edgeRuleRing.get(key) ?? []) if (!ruleIds.includes(rid)) ruleIds.push(rid);
      }
      prev = cur;
      cur = next ?? null;
      if (ordered.length > 64) break;
    }
    if (ordered.length >= 3) {
      rings.push({
        kind: 'chain',
        ruleIds,
        names: ordered.map(groupNodeName),
        requiredTables: 2,
        feasible: true,
        message: `互斥关系串成一条链（${ordered.map(groupNodeName).slice(0, 8).join(' ↔ ')}）：相邻两家不能同桌，首尾两家不冲突，排桌时顺着链错开即可。`,
      });
    }
  }

  /* ---------- 组装矛盾簇 ---------- */

  const clusters: ConflictCluster[] = [];
  let clusterSeq = 0;
  const ruleClusterMap = new Map<string, string[]>();
  const bindCluster = (c: ConflictCluster) => {
    clusters.push(c);
    for (const rid of c.ruleIds) {
      if (!ruleClusterMap.has(rid)) ruleClusterMap.set(rid, []);
      ruleClusterMap.get(rid)!.push(c.id);
    }
  };

  // 直接打架：互斥两端被必须同桌焊死
  for (const p of parsed) {
    if (!selfConflictRuleIds.has(p.rule.id)) continue;
    const apartName = p.rule.type === 'apart' ? '禁止同桌' : '必须分开';
    const c: ConflictCluster = {
      id: `cluster-${++clusterSeq}`,
      severity: 'error',
      kind: 'direct',
      ruleIds: [p.rule.id],
      summary: `「${p.aName}」和「${p.bName}」既被要求${apartName}，又被「必须同桌 / 整家一桌」绑在了一起，同一张桌坐也不是、不坐也不是。`,
      details: [
        `互斥约束：${p.aName} ${apartName} ${p.bName}`,
        '但两边存在共同的「必须同桌」关系（或同属勾了整家一桌的一派），物理上拆不开桌。',
        '处理：删掉这条互斥规则，或解除对应的必须同桌 / 整家一桌设置。',
      ],
    };
    // 找出把这两拨焊在一起的 together 规则，挂进同一簇
    const conflictRoots = new Set([...p.aGuests, ...p.bGuests].map((g) => dsu.find(g)));
    for (const t of parsed) {
      if (t.rule.type !== 'together' || t.dangling) continue;
      const tRoot = dsu.find(t.aGuests[0]);
      const tRootB = dsu.find(t.bGuests[0]);
      if (conflictRoots.has(tRoot) && conflictRoots.has(tRootB)) {
        if (!c.ruleIds.includes(t.rule.id)) c.ruleIds.push(t.rule.id);
      }
    }
    bindCluster(c);
  }

  // 桌数不够的连通分量
  for (const info of compInfos) {
    if (info.feasible !== false) continue;
    const coreSet = new Set(info.core);
    const recs = edgeRecs.filter((e) => coreSet.has(e.ua) && coreSet.has(e.ub));
    const ruleIds = [...new Set(recs.map((r) => r.ruleId))];
    if (ruleIds.length === 0) continue;
    const coreNames = info.core.map((uid) => unitName(unitMap.get(uid)!));
    const details: string[] = [];
    const coreEdgeDone = new Set<string>();
    for (const rec of recs) {
      const key = `${rec.ua}|${rec.ub}`;
      if (coreEdgeDone.has(key)) continue;
      coreEdgeDone.add(key);
      details.push(`${unitName(unitMap.get(rec.ua)!)} ✕ ${unitName(unitMap.get(rec.ub)!)}`);
    }
    details.push(`这一拨最少需要 ${info.chi} 张互不相同的桌，方案里只有 ${tableCount} 桌。`);
    const isTriangle = info.core.length === 3 && info.core.every((n) => info.core.filter((x) => x !== n).every((o) => unitGraph.adj.get(n)!.has(o)));
    bindCluster({
      id: `cluster-${++clusterSeq}`,
      severity: 'error',
      kind: isTriangle ? 'cycle' : 'capacity',
      ruleIds,
      requiredTables: info.chi,
      summary: isTriangle
        ? `${coreNames.join('、')} 三方两两不能同桌，至少要 3 张桌，现有 ${tableCount} 桌不够。`
        : `有 ${coreNames.length} 拨人连环不能同桌，至少要 ${info.chi} 张桌才能完全错开，现有 ${tableCount} 桌不够。`,
      details,
    });
  }

  // 超大单元（硬错误）
  for (const o of oversizes) {
    if (o.severity !== 'error') continue;
    bindCluster({
      id: `cluster-${++clusterSeq}`,
      severity: 'error',
      kind: 'oversize',
      ruleIds: o.relatedRuleIds,
      summary: o.message,
      details: [
        `${o.label}共 ${o.people} 人。`,
        `现有 ${o.tableCount} 桌，最大一桌容量 ${o.maxCapacity} 人。`,
        '处理：换更大容量的桌、减少这一拨的人数，或放开必须同桌限制。',
      ],
    });
  }

  /* ---------- 每条规则的单独一句话 ---------- */

  const ruleVerdicts: RuleVerdict[] = [];
  for (const p of parsed) {
    const { rule } = p;
    const myClusters = ruleClusterMap.get(rule.id) ?? [];
    const errorClusters = myClusters
      .map((cid) => clusters.find((c) => c.id === cid)!)
      .filter((c) => c?.severity === 'error');
    const typeLabel =
      rule.type === 'together' ? '必须同桌' : rule.type === 'apart' ? '禁止同桌' : rule.type === 'adjacent' ? '必须相邻' : '必须分开';

    let status: RuleStatus;
    let message: string;

    if (p.dangling) {
      status = 'warning';
      message = `「${typeLabel}：${p.aName} ↔ ${p.bName}」里有人/派别已被删除，这条约束现在是空的，不参与排座，建议删掉重选。`;
    } else if (errorClusters.length > 0) {
      status = 'conflicting';
      message = `「${typeLabel}：${p.aName} ↔ ${p.bName}」满足不了 —— ${errorClusters[0].summary}`;
    } else if (rule.type === 'together') {
      const u = unitMap.get(dsu.find(p.aGuests[0]))!;
      if (u.people > maxCapacity) {
        status = 'conflicting';
        message = `「必须同桌：${p.aName} ↔ ${p.bName}」满足不了 —— 合起来 ${u.people} 人，最大一桌只有 ${maxCapacity} 座。`;
      } else {
        status = 'satisfiable';
        message = `「必须同桌：${p.aName} ↔ ${p.bName}」可以满足，两拨共 ${u.people} 人，自动排桌会整体放进同一桌、不会拆散。`;
      }
    } else if (rule.type === 'apart' || rule.type === 'separate') {
      if (selfConflictRuleIds.has(rule.id)) {
        status = 'conflicting';
        message = `「${typeLabel}：${p.aName} ↔ ${p.bName}」满足不了 —— 两边本就是被必须同桌绑在一起的一拨人，没法分桌。`;
      } else if (tableCount === 0) {
        status = 'warning';
        message = `「${typeLabel}：${p.aName} ↔ ${p.bName}」规则本身成立，但方案还没有桌，加桌后才能最终核对桌数。`;
      } else {
        const ua = dsu.find(p.aGuests[0]);
        const ub = dsu.find(p.bGuests[0]);
        const info = compInfos.find((ci) => ci.nodes.includes(ua) && ci.nodes.includes(ub));
        const blockingRing = rings.find((r) => r.ruleIds.includes(rule.id) && !r.feasible);
        if (info && info.feasible === false) {
          status = 'conflicting';
          message = `「${typeLabel}：${p.aName} ↔ ${p.bName}」在当前 ${tableCount} 桌布局下满足不了（这一挂互斥关系至少要 ${info.chi} 桌）。`;
        } else if (blockingRing) {
          status = blockingRing.feasible ? 'warning' : 'conflicting';
          message = `「${typeLabel}：${p.aName} ↔ ${p.bName}」单独成立，但它所在的${blockingRing.kind === 'cycle' ? '互斥圈' : '关系链'}整体需要 ${blockingRing.requiredTables} 桌以上，现有 ${tableCount} 桌${blockingRing.feasible ? '够，知道即可' : '不够，排不开'}。`;
        } else {
          status = 'satisfiable';
          message = `「${typeLabel}：${p.aName} ↔ ${p.bName}」可以满足，自动排桌时 ${p.aName} 与 ${p.bName} 会分到不同桌；手动拖人坐到一桌也会实时标红。`;
        }
      }
    } else {
      status = 'satisfiable';
      message = `「必须相邻：${p.aName} ↔ ${p.bName}」已记录，排座时请把两人放到同桌相邻号位（暂不参与自动排桌与打架检测）。`;
    }

    ruleVerdicts.push({ ruleId: rule.id, status, message, clusterIds: myClusters });
  }

  /* ---------- 汇总 ---------- */

  const hardError = clusters.some((c) => c.severity === 'error');
  let feasible = !hardError;
  if (feasible && tableCount > 0) {
    const packing = packable(m, m.tables);
    if (!packing) {
      feasible = false;
      notices.push('互斥关系在桌数上能错开，但受每桌容量限制装不下（某一拨太大、或座位分布不合适），请调大桌容或增加桌数。');
    }
  }
  if (feasible && m.totalCapacity < m.totalPeople) feasible = false;

  return {
    tableCount,
    totalCapacity: m.totalCapacity,
    totalPeople: m.totalPeople,
    feasible,
    ruleVerdicts,
    clusters,
    rings,
    oversizes,
    notices,
  };
}

/* ------------------------------------------------------------------ */
/* 容量装箱：单元带互斥图，能否塞进给定的桌                              */
/* ------------------------------------------------------------------ */

export type PackInput = {
  units: { id: string; people: number }[];
  unitGraph: Graph;
  tables: { id: string; capacity: number }[];
};

export function packable(p: SeatingModel | PackInput, tablesArg?: { id: string; capacity: number }[]): boolean {
  const units = 'parsed' in p ? p.units : p.units;
  const unitGraph = p.unitGraph;
  const tables = tablesArg ?? p.tables;
  return solvePacking({ units, unitGraph, tables }) !== null;
}

/**
 * 求解装箱，返回 单元id -> 桌序号 的映射；无解返回 null。
 * 先贪心（best-fit + 约束度优先），失败再回溯。
 */
export function solvePacking(
  p: PackInput,
  budget = 300000,
): Map<string, number> | null {
  const { units, unitGraph, tables } = p;
  if (units.length === 0) return new Map();
  if (tables.length === 0) return null;

  const orderUnits = (arr: { id: string; people: number }[]) =>
    [...arr].sort((a, b) => {
      const da = unitGraph.adj.get(a.id)?.size ?? 0;
      const db = unitGraph.adj.get(b.id)?.size ?? 0;
      return db - da || b.people - a.people;
    });

  // 贪心
  const greedy = (): Map<string, number> | null => {
    const loads = tables.map(() => 0);
    const seatedAt = new Map<string, number>();
    for (const u of orderUnits(units)) {
      const forbidden = new Set<number>();
      for (const v of unitGraph.adj.get(u.id) ?? []) {
        const t = seatedAt.get(v);
        if (t !== undefined) forbidden.add(t);
      }
      let best = -1;
      let bestRemain = Infinity;
      for (let ti = 0; ti < tables.length; ti++) {
        if (forbidden.has(ti)) continue;
        const remain = tables[ti].capacity - loads[ti] - u.people;
        if (remain >= 0 && remain < bestRemain) {
          best = ti;
          bestRemain = remain;
        }
      }
      if (best === -1) return null;
      loads[best] += u.people;
      seatedAt.set(u.id, best);
    }
    return seatedAt;
  };

  const g = greedy();
  if (g) return g;

  // 回溯
  const sorted = orderUnits(units);
  const loads = tables.map(() => 0);
  const seatedAt = new Map<string, number>();
  let visited = 0;

  const bt = (idx: number): boolean => {
    if (++visited > budget) return false;
    if (idx === sorted.length) return true;
    const u = sorted[idx];
    const forbidden = new Set<number>();
    for (const v of unitGraph.adj.get(u.id) ?? []) {
      const t = seatedAt.get(v);
      if (t !== undefined) forbidden.add(t);
    }
    const cand = loads
      .map((load, ti) => ({ ti, load }))
      .filter((c) => !forbidden.has(c.ti) && c.load + u.people <= tables[c.ti].capacity)
      .sort((a, b) => b.load - a.load);
    for (const { ti } of cand) {
      loads[ti] += u.people;
      seatedAt.set(u.id, ti);
      if (bt(idx + 1)) return true;
      seatedAt.delete(u.id);
      loads[ti] -= u.people;
    }
    return false;
  };
  return bt(0) ? new Map(seatedAt) : null;
}
