import type { Plan, Rule } from './types';

/**
 * 约束核对引擎
 * - 事前（摆桌前）检查每条规则能不能被满足
 * - 挑出互相打架的约束簇：必须同桌 vs 禁止同桌、禁止同桌图需要的桌数超过现有桌数
 * - 某一家（必须同桌连通组 / 标签组）人数超过单桌容量时提前提示
 */

export type ClusterReason = 'together-apart' | 'clique' | 'odd-cycle' | 'coloring';

export type ConflictCluster = {
  id: string;
  reason: ClusterReason;
  title: string;
  detail: string;
  guestIds: string[];
  ruleIds: string[];
  groupRuleIds: string[];
};

export type OverflowWarning = {
  id: string;
  kind: 'together-group' | 'tag-group';
  label: string;
  size: number;
  tableCapacity: number;
  guestIds: string[];
  tag?: string;
};

export type RuleStatus = {
  ruleId: string;
  ok: boolean;
  message: string;
  clusterId?: string;
  warningId?: string;
};

export type GroupRuleStatus = {
  groupRuleId: string;
  ok: boolean;
  message: string;
  clusterId?: string;
};

export type PreflightReport = {
  hasTables: boolean;
  tableCount: number;
  maxCapacity: number; // 无桌时按婚宴默认 10 人/桌预估
  ruleStatuses: RuleStatus[];
  groupStatuses: GroupRuleStatus[];
  clusters: ConflictCluster[];
  overflows: OverflowWarning[];
  okCount: number;
  failCount: number;
};

export const DEFAULT_TABLE_CAPACITY = 10;

type FEdge = {
  a: string;
  b: string;
  pairRuleIds: string[];
  groupRuleIds: string[];
};

// 宾客 id 都是 uuid，不会出现 :: ，安全用作边的键
const edgeKey = (a: string, b: string) => (a < b ? `${a}::${b}` : `${b}::${a}`);

// ---------- 禁止同桌图（含成组标注展开） ----------

/** 宾客 id -> 与其不能同桌的宾客 id 集合；拖拽落桌时用它自动避开 */
export function buildForbiddenIndex(plan: Plan): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (a === b) return;
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(b)) map.set(b, new Set());
    map.get(a)!.add(b);
    map.get(b)!.add(a);
  };
  for (const r of plan.rules) {
    if (r.type === 'apart' || r.type === 'separate') add(r.a, r.b);
  }
  const tagMembers = buildTagMembers(plan);
  for (const gr of plan.groupRules ?? []) {
    if (gr.sameTag) {
      const list = tagMembers.get(gr.tagA) ?? [];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) add(list[i], list[j]);
      }
    } else {
      const aList = tagMembers.get(gr.tagA) ?? [];
      const bList = tagMembers.get(gr.tagB) ?? [];
      for (const a of aList) for (const b of bList) add(a, b);
    }
  }
  return map;
}

function buildTagMembers(plan: Plan): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const g of plan.guests) {
    for (const t of g.tags) {
      if (!map.has(t)) map.set(t, []);
      map.get(t)!.push(g.id);
    }
  }
  return map;
}

// ---------- 并查集：必须同桌 / 必须相邻 连成一家 ----------

class DSU {
  parent = new Map<string, string>();
  add(x: string) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x: string): string {
    this.add(x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== cur) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

// ---------- 图工具 ----------

/** DSATUR 贪心着色，返回使用的颜色数 */
function dsatur(nodes: string[], adj: Map<string, Set<string>>): number {
  const color = new Map<string, number>();
  const sat = new Map<string, Set<number>>();
  for (const n of nodes) sat.set(n, new Set());
  const pick = (): string | null => {
    let best: string | null = null;
    let bestScore = -1;
    for (const n of nodes) {
      if (color.has(n)) continue;
      const used = new Set<number>();
      for (const m of adj.get(n) ?? []) if (color.has(m)) used.add(color.get(m)!);
      sat.set(n, used);
      const score = used.size * 1000 + (adj.get(n)?.size ?? 0);
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  };
  let maxColor = 0;
  for (let i = 0; i < nodes.length; i++) {
    const v = pick();
    if (!v) break;
    const used = sat.get(v)!;
    let c = 1;
    while (used.has(c)) c++;
    color.set(v, c);
    if (c > maxColor) maxColor = c;
  }
  return maxColor;
}

/** 精确判定 k 着色是否可行（带步数预算，仅用于给贪心兜底，防止误报） */
function kColorable(
  nodes: string[],
  adj: Map<string, Set<string>>,
  k: number,
  budget: number,
): { feasible: boolean; budgetExceeded: boolean } {
  const colors = new Map<string, number>();
  const neighborColors = new Map<string, Set<number>>();
  for (const n of nodes) neighborColors.set(n, new Set());
  let steps = 0;

  const chooseVertex = (): string | null => {
    let best: string | null = null;
    let bestScore = -1;
    for (const n of nodes) {
      if (colors.has(n)) continue;
      const score = (neighborColors.get(n)?.size ?? 0) * 1000 + (adj.get(n)?.size ?? 0);
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  };

  const dfs = (): boolean => {
    if (++steps > budget) return false;
    const v = chooseVertex();
    if (v === null) return true;
    for (let c = 1; c <= k; c++) {
      if (neighborColors.get(v)!.has(c)) continue;
      colors.set(v, c);
      const touched: string[] = [];
      for (const m of adj.get(v) ?? []) {
        if (!colors.has(m) && !neighborColors.get(m)!.has(c)) {
          neighborColors.get(m)!.add(c);
          touched.push(m);
        }
      }
      if (dfs()) return true;
      colors.delete(v);
      for (const m of touched) neighborColors.get(m)!.delete(c);
    }
    return false;
  };

  const feasible = dfs();
  return { feasible, budgetExceeded: steps > budget };
}

/** 在一个连通块里找奇环（k=2 时用），返回环上节点与边 */
function findOddCycle(
  start: string,
  component: Set<string>,
  adj: Map<string, Set<string>>,
): { nodes: string[]; edges: [string, string][] } | null {
  const parity = new Map<string, number>([[start, 0]]);
  const parent = new Map<string, string | null>([[start, null]]);
  const depth = new Map<string, number>([[start, 0]]);
  const queue = [start];
  let badEdge: [string, string] | null = null;
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of adj.get(u) ?? []) {
      if (!component.has(v)) continue;
      if (!parity.has(v)) {
        parity.set(v, parity.get(u)! ^ 1);
        parent.set(v, u);
        depth.set(v, depth.get(u)! + 1);
        queue.push(v);
      } else if (v !== parent.get(u) && (depth.get(u)! + depth.get(v)!) % 2 === 0) {
        badEdge = [u, v];
        queue.length = 0;
        break;
      }
    }
  }
  if (!badEdge) return null;
  const pathToRoot = (x: string): string[] => {
    const path = [x];
    while (parent.get(path[path.length - 1]) != null) path.push(parent.get(path[path.length - 1])!);
    return path;
  };
  const pu = pathToRoot(badEdge[0]);
  const pv = pathToRoot(badEdge[1]);
  let i = pu.length - 1;
  let j = pv.length - 1;
  while (i > 0 && j > 0 && pu[i - 1] === pv[j - 1]) { i--; j--; }
  const sideA = pu.slice(0, i + 1);
  const sideB = pv.slice(0, j + 1);
  const cycNodes = [...sideA, ...sideB.slice().reverse()];
  const edges: [string, string][] = [];
  for (let t = 0; t < cycNodes.length - 1; t++) edges.push([cycNodes[t], cycNodes[t + 1]]);
  return { nodes: cycNodes, edges };
}

/** Bron–Kerbosch（枢轴）枚举所有大小 > k 的极大团，带步数预算 */
function findLargeCliques(
  nodes: string[],
  adj: Map<string, Set<string>>,
  k: number,
  budget: number,
): { cliques: string[][]; budgetExceeded: boolean } {
  const cliques: string[][] = [];
  let steps = 0;
  let budgetExceeded = false;

  const rec = (r: Set<string>, p: Set<string>, x: Set<string>) => {
    if (budgetExceeded) return;
    if (++steps > budget) { budgetExceeded = true; return; }
    if (p.size === 0 && x.size === 0) {
      if (r.size > k) cliques.push([...r]);
      return;
    }
    let pivot = '';
    let pivotBest = -1;
    for (const u of [...p, ...x]) {
      let cnt = 0;
      for (const v of p) if (adj.get(u)?.has(v)) cnt++;
      if (cnt > pivotBest) { pivotBest = cnt; pivot = u; }
    }
    const candidates: string[] = [];
    for (const v of p) if (!adj.get(pivot)?.has(v)) candidates.push(v);
    for (const v of candidates) {
      const nv = adj.get(v) ?? new Set<string>();
      rec(
        new Set([...r, v]),
        new Set([...p].filter((q) => nv.has(q))),
        new Set([...x].filter((q) => nv.has(q))),
      );
      p.delete(v);
      x.add(v);
      if (cliques.length >= 12) return;
    }
  };

  rec(new Set(), new Set(nodes), new Set());
  return { cliques, budgetExceeded };
}

// ---------- 主入口：摆桌前核对 ----------

export function runPreflight(plan: Plan): PreflightReport {
  const guestMap = new Map(plan.guests.map((g) => [g.id, g]));
  const nameOf = (id: string) => guestMap.get(id)?.name ?? '已删除宾客';
  const groupRules = plan.groupRules ?? [];
  const hasTables = plan.tables.length > 0;
  const tableCount = plan.tables.length;
  const maxCapacity = hasTables
    ? Math.max(...plan.tables.map((t) => t.capacity))
    : DEFAULT_TABLE_CAPACITY;

  // 1. 收集禁止同桌边（成对规则 + 成组标注展开），合并来源
  const edgeMap = new Map<string, FEdge>();
  const addEdge = (a: string, b: string, src: { pairRuleId?: string; groupRuleId?: string }) => {
    if (a === b) return;
    const [ea, eb] = a < b ? [a, b] : [b, a];
    const key = edgeKey(a, b);
    let e = edgeMap.get(key);
    if (!e) {
      e = { a: ea, b: eb, pairRuleIds: [], groupRuleIds: [] };
      edgeMap.set(key, e);
    }
    if (src.pairRuleId && !e.pairRuleIds.includes(src.pairRuleId)) e.pairRuleIds.push(src.pairRuleId);
    if (src.groupRuleId && !e.groupRuleIds.includes(src.groupRuleId)) e.groupRuleIds.push(src.groupRuleId);
  };

  const validRules: Rule[] = [];
  const missingRuleIds = new Set<string>();
  for (const r of plan.rules) {
    if (!guestMap.has(r.a) || !guestMap.has(r.b)) {
      missingRuleIds.add(r.id);
      continue;
    }
    validRules.push(r);
    if (r.type === 'apart' || r.type === 'separate') addEdge(r.a, r.b, { pairRuleId: r.id });
  }

  const tagMembers = buildTagMembers(plan);
  for (const gr of groupRules) {
    if (gr.sameTag) {
      const list = tagMembers.get(gr.tagA) ?? [];
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) addEdge(list[i], list[j], { groupRuleId: gr.id });
    } else {
      for (const a of tagMembers.get(gr.tagA) ?? [])
        for (const b of tagMembers.get(gr.tagB) ?? []) addEdge(a, b, { groupRuleId: gr.id });
    }
  }

  // 2. 必须同桌 / 必须相邻 → DSU 一家
  const dsu = new DSU();
  const togetherRuleIds: string[] = [];
  validRules.forEach((r) => {
    if (r.type === 'together' || r.type === 'adjacent') {
      dsu.add(r.a);
      dsu.add(r.b);
      togetherRuleIds.push(r.id);
    }
  });
  for (const r of validRules) {
    if (r.type === 'together' || r.type === 'adjacent') dsu.union(r.a, r.b);
  }

  const rootOf = (id: string) => (dsu.parent.has(id) ? dsu.find(id) : id);

  // 所有 union 完成后再按「最终根」归集必须同桌规则，避免并查集根迁移导致漏挂
  const ruleById = new Map(validRules.map((r) => [r.id, r]));
  const togetherEdgesByComp = new Map<string, string[]>();
  for (const rid of togetherRuleIds) {
    const root = rootOf(ruleById.get(rid)!.a);
    if (!togetherEdgesByComp.has(root)) togetherEdgesByComp.set(root, []);
    togetherEdgesByComp.get(root)!.push(rid);
  }
  const members = new Map<string, Set<string>>();
  const ensureMembers = (node: string) => {
    if (!members.has(node)) members.set(node, new Set());
    return members.get(node)!;
  };
  for (const id of guestMap.keys()) {
    ensureMembers(rootOf(id)).add(id);
  }

  // 3. 禁止边投射到「一家」超节点；同一家内部即直接打架
  const superAdj = new Map<string, Set<string>>();
  const superEdgeMeta = new Map<string, FEdge>();
  const internalEdges = new Map<string, FEdge[]>();
  for (const e of edgeMap.values()) {
    const ra = rootOf(e.a);
    const rb = rootOf(e.b);
    if (ra === rb) {
      if (!internalEdges.has(ra)) internalEdges.set(ra, []);
      internalEdges.get(ra)!.push(e);
      continue;
    }
    if (!superAdj.has(ra)) superAdj.set(ra, new Set());
    if (!superAdj.has(rb)) superAdj.set(rb, new Set());
    superAdj.get(ra)!.add(rb);
    superAdj.get(rb)!.add(ra);
    const key = edgeKey(ra, rb);
    const prev = superEdgeMeta.get(key);
    if (prev) {
      for (const id of e.pairRuleIds) if (!prev.pairRuleIds.includes(id)) prev.pairRuleIds.push(id);
      for (const id of e.groupRuleIds) if (!prev.groupRuleIds.includes(id)) prev.groupRuleIds.push(id);
    } else {
      superEdgeMeta.set(key, { a: ra, b: rb, pairRuleIds: [...e.pairRuleIds], groupRuleIds: [...e.groupRuleIds] });
    }
  }

  const clusters: ConflictCluster[] = [];
  const ruleCluster = new Map<string, string>(); // ruleId -> clusterId
  const groupRuleCluster = new Map<string, string>();

  const registerCluster = (c: Omit<ConflictCluster, 'id'>): string => {
    const id = `c${clusters.length + 1}`;
    clusters.push({ ...c, id });
    for (const rid of c.ruleIds) if (!ruleCluster.has(rid)) ruleCluster.set(rid, id);
    for (const gid of c.groupRuleIds) if (!groupRuleCluster.has(gid)) groupRuleCluster.set(gid, id);
    return id;
  };

  const edgeProof = (a: string, b: string): FEdge | undefined => {
    const ra = rootOf(a);
    const rb = rootOf(b);
    return ra === rb ? undefined : superEdgeMeta.get(edgeKey(ra, rb));
  };
  const collectProof = (nodeEdges: [string, string][]): { ruleIds: string[]; groupRuleIds: string[] } => {
    const ruleIds: string[] = [];
    const groupRuleIds: string[] = [];
    for (const [a, b] of nodeEdges) {
      const meta = edgeProof(a, b);
      if (!meta) continue;
      for (const id of meta.pairRuleIds) if (!ruleIds.includes(id)) ruleIds.push(id);
      for (const id of meta.groupRuleIds) if (!groupRuleIds.includes(id)) groupRuleIds.push(id);
    }
    return { ruleIds, groupRuleIds };
  };
  const expandNodes = (nodes: string[], cap = 40): string[] => {
    const out: string[] = [];
    for (const n of nodes) for (const m of members.get(n) ?? [n]) {
      out.push(m);
      if (out.length >= cap) return out;
    }
    return out;
  };

  // 3a. 同一家内部：必须同桌 vs 禁止同桌
  for (const [root, edges] of internalEdges) {
    const mem = [...(members.get(root) ?? [root])].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh'));
    const badPairs = edges.map((e) => `${nameOf(e.a)}↔${nameOf(e.b)}`);
    // 内部边的来源就在边自身上，不能再走超节点投影
    const proofRuleIds: string[] = [];
    const proofGroupIds: string[] = [];
    for (const e of edges) {
      for (const id of e.pairRuleIds) if (!proofRuleIds.includes(id)) proofRuleIds.push(id);
      for (const id of e.groupRuleIds) if (!proofGroupIds.includes(id)) proofGroupIds.push(id);
    }
    registerCluster({
      reason: 'together-apart',
      title: '「必须同桌」与「不能同桌」打架',
      detail: `「${mem.slice(0, 8).map(nameOf).join('」「')}」${mem.length > 8 ? ' 等' : ''}被必须同桌/相邻要求连成一家（共 ${mem.length} 人），但 ${badPairs.slice(0, 5).join('、')} 又被要求不能同桌，两头无法同时满足。`,
      guestIds: mem.slice(0, 40),
      ruleIds: [...(togetherEdgesByComp.get(root) ?? []), ...proofRuleIds],
      groupRuleIds: proofGroupIds,
    });
  }

  // 3b. 超节点连通块：现有桌数是否够把禁止关系分开
  if (hasTables) {
    const visited = new Set<string>();
    for (const node of superAdj.keys()) {
      if (clusters.length >= 20) break;
      if (visited.has(node)) continue;
      const comp = new Set<string>();
      const queue = [node];
      while (queue.length) {
        const u = queue.shift()!;
        if (comp.has(u)) continue;
        comp.add(u);
        visited.add(u);
        for (const v of superAdj.get(u) ?? []) if (!comp.has(v)) queue.push(v);
      }
      const compNodes = [...comp];

      // 贪心先快速判定可行
      if (dsatur(compNodes, superAdj) <= tableCount) continue;
      // 小连通块用精确回溯兜底，避免误报
      if (compNodes.length <= 22 && kColorable(compNodes, superAdj, tableCount, 200000).feasible) continue;

      // 团：m 家两两不能同桌 → 至少 m 桌（同一连通块只取最大的一团，避免重复报）
      const { cliques: largeCliques } = findLargeCliques(compNodes, superAdj, tableCount, 200000);
      let emitted = false;
      if (largeCliques.length > 0) {
        largeCliques.sort((x, y) => y.length - x.length);
        const clique = largeCliques[0];
        const ordered = [...clique].sort((a, b) => (members.get(b)?.size ?? 1) - (members.get(a)?.size ?? 1));
        const witnessEdges: [string, string][] = [];
        for (let i = 0; i < ordered.length; i++)
          for (let j = i + 1; j < ordered.length; j++) witnessEdges.push([ordered[i], ordered[j]]);
        const proof = collectProof(witnessEdges);
        const guestPreview = expandNodes(ordered.slice(0, 12));
        registerCluster({
          reason: 'clique',
          title: `${ordered.length} 方宾客两两不能同桌，却只有 ${tableCount} 桌`,
          detail: `「${guestPreview.slice(0, 10).map(nameOf).join('」「')}」${guestPreview.length > 10 ? ' 等' : ''}两两不能坐一桌，至少要 ${ordered.length} 桌才放得下，当前只有 ${tableCount} 桌（加桌或拆掉其中一条不能同桌标注）。`,
          guestIds: expandNodes(ordered),
          ruleIds: proof.ruleIds,
          groupRuleIds: proof.groupRuleIds,
        });
        emitted = true;
      }
      if (clusters.length >= 20) break;

      // 只有 2 桌、且不是团时，奇环才是最贴切的死结解释
      if (!emitted && tableCount === 2) {
        const odd = findOddCycle(node, comp, superAdj);
        if (odd) {
          const proof = collectProof(odd.edges);
          const preview = odd.nodes
            .slice(0, 6)
            .map((n) => nameOf([...(members.get(n) ?? [n])][0]))
            .join('」「');
          registerCluster({
            reason: 'odd-cycle',
            title: `不能同桌关系绕成了 ${odd.nodes.length} 方的圈`,
            detail: `「${preview}」…的不能同桌关系首尾绕圈（奇数环），2 桌怎么分都会有一对撞在同一桌，至少需要 3 桌。`,
            guestIds: expandNodes(odd.nodes),
            ruleIds: proof.ruleIds,
            groupRuleIds: proof.groupRuleIds,
          });
          emitted = true;
        }
      }

      // 兜底：贪心/精确判定分不开，但没找到更具体的团/环
      if (!emitted) {
        const witnessEdges: [string, string][] = [];
        for (const u of compNodes)
          for (const v of superAdj.get(u) ?? []) if (u < v) witnessEdges.push([u, v]);
        const proof = collectProof(witnessEdges);
        registerCluster({
          reason: 'coloring',
          title: `不能同桌关系在 ${tableCount} 桌里分不开`,
          detail: `这组宾客共 ${compNodes.length} 方的不能同桌关系互相交织，现有 ${tableCount} 桌无法让每条都避开；请加桌，或删掉/放宽其中部分不能同桌标注。`,
          guestIds: expandNodes(compNodes.slice(0, 20)),
          ruleIds: proof.ruleIds,
          groupRuleIds: proof.groupRuleIds,
        });
      }
    }
  }

  // 4. 提前提示：一组人多到一桌放不下
  const overflows: OverflowWarning[] = [];
  const ruleOverflow = new Map<string, string>();
  let overflowIdx = 0;
  // 4a. 必须同桌连通组
  for (const [root, ruleIds] of togetherEdgesByComp) {
    const mem = [...(members.get(root) ?? [root])];
    if (mem.length <= maxCapacity) continue;
    const id = `o${++overflowIdx}`;
    const label = `「${mem.slice(0, 3).map(nameOf).join('」「')}」等必须同桌的 ${mem.length} 人`;
    overflows.push({ id, kind: 'together-group', label, size: mem.length, tableCapacity: maxCapacity, guestIds: mem.slice(0, 40) });
    for (const rid of ruleIds) ruleOverflow.set(rid, id);
  }
  // 4b. 标签组（一家亲戚 / 一拨同事）
  for (const [tag, list] of tagMembers) {
    if (list.length <= maxCapacity) continue;
    const id = `o${++overflowIdx}`;
    overflows.push({
      id,
      kind: 'tag-group',
      label: `标签「${tag}」共 ${list.length} 人`,
      size: list.length,
      tableCapacity: maxCapacity,
      guestIds: list.slice(0, 40),
      tag,
    });
  }

  // 5. 每条成对约束一句话
  const ruleStatuses: RuleStatus[] = plan.rules.map((r) => {
    if (missingRuleIds.has(r.id)) {
      return { ruleId: r.id, ok: false, message: '宾客已被删除，这条约束失效，请删掉重标。' };
    }
    const cid = ruleCluster.get(r.id);
    if (cid) {
      const cluster = clusters.find((c) => c.id === cid)!;
      return { ruleId: r.id, ok: false, clusterId: cid, message: `无法满足：${cluster.title}（见下方冲突 ${cid}）。` };
    }
    const wid = ruleOverflow.get(r.id);
    if (wid) {
      const w = overflows.find((x) => x.id === wid)!;
      return { ruleId: r.id, ok: false, warningId: wid, message: `这一组必须同桌共 ${w.size} 人，但一桌最多坐 ${w.tableCapacity} 人，注定要拆桌（见下方超员提示 ${wid}）。` };
    }
    if (r.type === 'apart' || r.type === 'separate') {
      const verb = r.type === 'apart' ? '不能同桌' : '必须分桌';
      const tail = hasTables
        ? `现有 ${tableCount} 桌分得开，落桌时会自动把他俩避开。`
        : `摆桌后落座时会自动避开（当前还没摆桌）。`;
      return { ruleId: r.id, ok: true, message: `「${nameOf(r.a)}」与「${nameOf(r.b)}」${verb}的要求可以满足，${tail}` };
    }
    // together / adjacent
    const root = dsu.find(r.a);
    const groupSize = members.get(root)?.size ?? 2;
    const verb = r.type === 'together' ? '必须同桌' : '必须相邻';
    const tail = groupSize > 2 ? `连同必须同桌链上的人共 ${groupSize} 人` : '两人';
    return {
      ruleId: r.id,
      ok: true,
      message: `「${nameOf(r.a)}」与「${nameOf(r.b)}」${verb}可以满足，${tail}，一桌（${maxCapacity} 人位）坐得下。`,
    };
  });

  // 6. 每条成组标注一句话
  const groupStatuses: GroupRuleStatus[] = groupRules.map((gr) => {
    const cid = groupRuleCluster.get(gr.id);
    if (cid) {
      const cluster = clusters.find((c) => c.id === cid)!;
      return { groupRuleId: gr.id, ok: false, clusterId: cid, message: `无法满足：${cluster.title}（见下方冲突 ${cid}）。` };
    }
    const aList = tagMembers.get(gr.tagA) ?? [];
    if (gr.sameTag) {
      const n = aList.length;
      if (n === 0) return { groupRuleId: gr.id, ok: true, message: `「${gr.tagA}」组内目前没有宾客，标注已记下，导入宾客后自动生效。` };
      const tail = hasTables
        ? (n <= tableCount ? `现有 ${tableCount} 桌足够把 ${n} 人一一拆开。` : `但人多桌少，见冲突提示。`)
        : '摆桌时会自动把同组人拆到不同桌。';
      return { groupRuleId: gr.id, ok: true, message: `「${gr.tagA}」组内 ${n} 人两两不能同桌已标出，${tail}` };
    }
    const bList = tagMembers.get(gr.tagB) ?? [];
    if (aList.length === 0 && bList.length === 0) {
      return { groupRuleId: gr.id, ok: true, message: `「${gr.tagA}」与「${gr.tagB}」目前都没有宾客，标注已记下，导入后自动生效。` };
    }
    const tail = hasTables ? `现有 ${tableCount} 桌可安排，落桌自动避开。` : '摆桌时会自动把两拨人分到不同桌。';
    return {
      groupRuleId: gr.id,
      ok: true,
      message: `「${gr.tagA}」${aList.length} 人与「${gr.tagB}」${bList.length} 人整组不能同桌已标出，${tail}`,
    };
  });

  const okCount = ruleStatuses.filter((s) => s.ok).length + groupStatuses.filter((s) => s.ok).length;
  const failCount = ruleStatuses.filter((s) => !s.ok).length + groupStatuses.filter((s) => !s.ok).length;

  return {
    hasTables,
    tableCount,
    maxCapacity,
    ruleStatuses,
    groupStatuses,
    clusters,
    overflows,
    okCount,
    failCount,
  };
}
