import { useMemo } from 'react';
import type { Plan } from '../types';
import { precheck } from '../seating/engine';

interface Props {
  plan: Plan;
  onClose: () => void;
  onAutoSeat: () => void;
}

const STATUS_TEXT: Record<string, string> = {
  satisfiable: '可满足',
  conflicting: '满足不了',
  warning: '待确认',
};

export default function PrecheckPanel({ plan, onClose, onAutoSeat }: Props) {
  const report = useMemo(
    () =>
      precheck({
        guests: plan.guests.map((g) => ({ id: g.id, name: g.name, partySize: g.partySize, groupId: g.groupId })),
        groups: plan.groups.map((g) => ({ id: g.id, name: g.name, keepTogether: g.keepTogether })),
        tables: plan.tables.map((t) => ({ id: t.id, label: t.label, capacity: t.capacity })),
        rules: plan.rules,
      }),
    [plan],
  );

  const verdictCount = {
    satisfiable: report.ruleVerdicts.filter((v) => v.status === 'satisfiable').length,
    conflicting: report.ruleVerdicts.filter((v) => v.status === 'conflicting').length,
    warning: report.ruleVerdicts.filter((v) => v.status === 'warning').length,
  };

  const ruleById = new Map(plan.rules.map((r) => [r.id, r]));

  return (
    <div className="precheck-overlay" onClick={onClose}>
      <div className="precheck-modal" onClick={(e) => e.stopPropagation()}>
        <div className="precheck-header">
          <h3>摆桌前核对</h3>
          <button className="precheck-close" onClick={onClose}>×</button>
        </div>

        <div className="precheck-body">
          {/* 总览 */}
          <div className={`precheck-summary ${report.feasible ? 'ok' : 'bad'}`}>
            {report.feasible ? (
              <div className="summary-title">✓ 核对通过：{report.tableCount} 桌 / {report.totalCapacity} 座，{report.totalPeople} 人，可以开始摆桌。</div>
            ) : (
              <div className="summary-title">✕ 先别急着摆：有约束互相打架或桌不够，处理完下面的问题再排座。</div>
            )}
            <div className="summary-meta">
              约束 {report.ruleVerdicts.length} 条：
              <span className="tag-ok">可满足 {verdictCount.satisfiable}</span>
              <span className="tag-bad">满足不了 {verdictCount.conflicting}</span>
              <span className="tag-warn">待确认 {verdictCount.warning}</span>
            </div>
          </div>

          {report.notices.length > 0 && (
            <div className="precheck-section">
              <h4>整体提示</h4>
              <ul className="notice-list">
                {report.notices.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          )}

          {/* 人太多一桌放不下 */}
          {report.oversizes.length > 0 && (
            <div className="precheck-section">
              <h4>某一家人太多、一桌放不下（提前提示）</h4>
              {report.oversizes.map((o, i) => (
                <div key={i} className={`oversize-item ${o.severity}`}>
                  <div className="oversize-title">
                    {o.severity === 'error' ? '⛔ ' : '⚠️ '}
                    {o.people} 人 &gt; 单桌 {o.maxCapacity} 座
                  </div>
                  <div className="oversize-msg">{o.message}</div>
                </div>
              ))}
            </div>
          )}

          {/* 互相打架的约束簇 */}
          {report.clusters.length > 0 && (
            <div className="precheck-section">
              <h4>互相打架的约束（{report.clusters.length} 处）</h4>
              {report.clusters.map((c) => (
                <div key={c.id} className={`cluster-card ${c.severity}`}>
                  <div className="cluster-summary">
                    <span className="cluster-badge">
                      {c.kind === 'direct' ? '自相矛盾' : c.kind === 'cycle' ? '三方互斥' : c.kind === 'oversize' ? '一桌放不下' : '桌数不够'}
                    </span>
                    {c.summary}
                  </div>
                  <ul className="cluster-details">
                    {c.details.map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                  <div className="cluster-rules">
                    涉及约束：
                    {c.ruleIds.map((rid) => {
                      const r = ruleById.get(rid);
                      if (!r) return null;
                      return <span key={rid} className="cluster-rule-id">{rid.slice(0, 4)}</span>;
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 圈 / 链 */}
          {report.rings.length > 0 && (
            <div className="precheck-section">
              <h4>互斥关系里的圈 / 链（摆桌前心里有数）</h4>
              {report.rings.map((ring, i) => (
                <div key={i} className={`ring-item ${ring.feasible ? 'ok' : 'bad'}`}>
                  <span className="ring-kind">{ring.kind === 'cycle' ? '圈' : '链'}</span>
                  <div>
                    <div className="ring-names">{ring.names.join(ring.kind === 'cycle' ? ' ↔ ' : ' ↔ ')}</div>
                    <div className="ring-msg">{ring.message}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 每条约束一句话 */}
          <div className="precheck-section">
            <h4>每条约束的单独结论</h4>
            <div className="verdict-list">
              {report.ruleVerdicts.length === 0 && <div className="verdict-empty">还没有约束规则，可在右侧「约束规则」里添加（端点支持选整家派别）。</div>}
              {report.ruleVerdicts.map((v) => (
                <div key={v.ruleId} className={`verdict-item ${v.status}`}>
                  <span className={`verdict-status ${v.status}`}>{STATUS_TEXT[v.status]}</span>
                  <span className="verdict-msg">{v.message}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="precheck-footer">
          <button className="btn-auto-seat" disabled={!report.feasible} onClick={onAutoSeat}>
            {report.feasible ? '一键自动排桌（按这些约束分桌）' : '有矛盾未处理，不能自动排桌'}
          </button>
          <button className="btn-close" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
