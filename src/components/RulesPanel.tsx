import { useMemo, useState } from 'react';
import type { Plan, Rule, Command, RuleType, GroupRule } from '../types';
import { generateId } from '../utils';
import { TAG_OPTIONS } from '../types';
import type { PreflightReport } from '../constraints';

interface Props {
  plan: Plan;
  dispatch: (cmd: Command) => void;
  preflight: PreflightReport;
}

const RULE_LABEL: Record<RuleType, string> = {
  together: '必须同桌',
  apart: '不能同桌',
  adjacent: '必须相邻',
  separate: '必须分桌',
};

export default function RulesPanel({ plan, dispatch, preflight }: Props) {
  const [type, setType] = useState<RuleType>('apart');
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');

  // 成组标注
  const groupRules = plan.groupRules ?? [];
  const [tagA, setTagA] = useState(TAG_OPTIONS[0]);
  const [tagB, setTagB] = useState(TAG_OPTIONS[1] ?? TAG_OPTIONS[0]);
  const [sameTag, setSameTag] = useState(false);

  const addRule = () => {
    if (!aId || !bId || aId === bId) return;
    const rule: Rule = { id: generateId(), type, a: aId, b: bId };
    dispatch({ type: 'updateRules', rules: [...plan.rules, rule] });
    setAId('');
    setBId('');
  };

  const removeRule = (id: string) => {
    dispatch({ type: 'updateRules', rules: plan.rules.filter((r) => r.id !== id) });
  };

  const addGroupRule = () => {
    if (!sameTag && tagA === tagB) return;
    const dup = groupRules.some(
      (g) => g.sameTag === sameTag && g.tagA === tagA && (sameTag || g.tagB === tagB),
    );
    if (dup) {
      alert('这一组不能同桌关系已经标过了');
      return;
    }
    const gr: GroupRule = {
      id: generateId(),
      type: 'apart',
      tagA,
      tagB: sameTag ? tagA : tagB,
      sameTag,
      createdAt: Date.now(),
    };
    dispatch({ type: 'updateGroupRules', groupRules: [...groupRules, gr] });
  };

  const removeGroupRule = (id: string) => {
    dispatch({ type: 'updateGroupRules', groupRules: groupRules.filter((g) => g.id !== id) });
  };

  const getName = (id: string) => plan.guests.find((g) => g.id === id)?.name || id;
  const statusOfRule = useMemo(
    () => new Map(preflight.ruleStatuses.map((s) => [s.ruleId, s])),
    [preflight],
  );
  const statusOfGroup = useMemo(
    () => new Map(preflight.groupStatuses.map((s) => [s.groupRuleId, s])),
    [preflight],
  );

  const scrollToCluster = (id: string) => {
    document.getElementById(`cluster-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  const scrollToOverflow = (id: string) => {
    document.getElementById(`overflow-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  return (
    <div className="rules-panel">
      <h3>约束规则</h3>

      {/* 摆桌前核对总览 */}
      <div className={`preflight-summary ${preflight.failCount > 0 || preflight.clusters.length > 0 || preflight.overflows.length > 0 ? 'has-issue' : ''}`}>
        <div className="preflight-title">摆桌前核对</div>
        <div className="preflight-counts">
          <span className="ok">{preflight.okCount} 条可满足</span>
          {preflight.failCount > 0 && <span className="bad">{preflight.failCount} 条无法满足</span>}
        </div>
        {preflight.clusters.length > 0 && (
          <div className="preflight-flag bad">
            ⚠ {preflight.clusters.length} 处约束互相打架
          </div>
        )}
        {preflight.overflows.length > 0 && (
          <div className="preflight-flag warn">
            ⚠ {preflight.overflows.length} 组人数一桌放不下
          </div>
        )}
        {preflight.clusters.length === 0 && preflight.overflows.length === 0 && preflight.failCount === 0 && (
          <div className="preflight-flag ok">✓ 没有绕圈/打架，标注可正常落桌</div>
        )}
        {!preflight.hasTables && (
          <div className="preflight-hint">当前还没摆桌，容量按一桌 {preflight.maxCapacity} 人预估；「能不能用现有桌数分开」会在摆桌后核对。</div>
        )}
      </div>

      {/* 成组标注：整组不能同桌 */}
      <div className="group-rule-section">
        <div className="section-label">成组标注（整组不能同桌）</div>
        <div className="group-rule-form">
          <select value={tagA} onChange={(e) => setTagA(e.target.value)}>
            {TAG_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {!sameTag && (
            <>
              <span className="group-vs">↔</span>
              <select value={tagB} onChange={(e) => setTagB(e.target.value)}>
                {TAG_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </>
          )}
          <label className="same-tag-toggle">
            <input type="checkbox" checked={sameTag} onChange={(e) => setSameTag(e.target.checked)} />
            组内两两避开
          </label>
          <button onClick={addGroupRule} disabled={!sameTag && tagA === tagB}>标注整组避开</button>
        </div>
        <div className="group-rules-list">
          {groupRules.length === 0 && <div className="muted-hint">例：「男方亲属」↔「女方同事」整组不坐一桌；勾选组内则同组人两两拆开。</div>}
          {groupRules.map((gr) => {
            const st = statusOfGroup.get(gr.id);
            return (
              <div key={gr.id} className={`rule-item group ${st && !st.ok ? 'rule-fail' : 'rule-ok'}`}>
                <span className="rule-type apart">{gr.sameTag ? '组内避开' : '整组避开'}</span>
                <span className="group-rule-names">
                  {gr.sameTag ? gr.tagA : `${gr.tagA} ↔ ${gr.tagB}`}
                </span>
                <button onClick={() => removeGroupRule(gr.id)}>×</button>
                {st && (
                  <p className={`rule-status-line ${st.ok ? 'ok' : 'bad'}`}>
                    {st.clusterId ? (
                      <a onClick={() => scrollToCluster(st.clusterId!)}>{st.message}</a>
                    ) : st.message}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 成对约束 */}
      <div className="section-label">宾客两两标注</div>
      <div className="rule-form">
        <select value={type} onChange={(e) => setType(e.target.value as RuleType)}>
          {(Object.keys(RULE_LABEL) as RuleType[]).map((t) => (
            <option key={t} value={t}>{RULE_LABEL[t]}</option>
          ))}
        </select>
        <select value={aId} onChange={(e) => setAId(e.target.value)}>
          <option value="">选择宾客 A</option>
          {plan.guests.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <select value={bId} onChange={(e) => setBId(e.target.value)}>
          <option value="">选择宾客 B</option>
          {plan.guests.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <button onClick={addRule}>添加</button>
      </div>
      <div className="rules-list">
        {plan.rules.length === 0 && <div className="muted-hint">在上方选择两名宾客，标注「不能同桌」等关系。</div>}
        {plan.rules.map((r) => {
          const st = statusOfRule.get(r.id);
          return (
            <div key={r.id} className={`rule-item ${st && !st.ok ? 'rule-fail' : st ? 'rule-ok' : ''}`}>
              <div className="rule-row">
                <span className={`rule-type ${r.type}`}>{RULE_LABEL[r.type]}</span>
                <span>{getName(r.a)}</span>
                <span>↔</span>
                <span>{getName(r.b)}</span>
                <button onClick={() => removeRule(r.id)}>×</button>
              </div>
              {st && (
                <p className={`rule-status-line ${st.ok ? 'ok' : 'bad'}`}>
                  {st.clusterId ? (
                    <a onClick={() => scrollToCluster(st.clusterId!)}>{st.message}</a>
                  ) : st.warningId ? (
                    <a onClick={() => scrollToOverflow(st.warningId!)}>{st.message}</a>
                  ) : st.message}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* 互相打架的约束（单独列一处） */}
      {preflight.clusters.length > 0 && (
        <div className="preflight-block">
          <div className="preflight-block-title bad">互相打架的约束（{preflight.clusters.length}）</div>
          {preflight.clusters.map((c) => (
            <div key={c.id} id={`cluster-${c.id}`} className={`issue-card ${c.reason}`}>
              <div className="issue-head">
                <span className="issue-id">{c.id}</span>
                <span className="issue-title">{c.title}</span>
              </div>
              <p className="issue-detail">{c.detail}</p>
              <div className="issue-tags">
                {c.ruleIds.map((rid) => {
                  const r = plan.rules.find((x) => x.id === rid);
                  return r ? (
                    <span key={rid} className={`mini-tag ${r.type}`}>
                      {RULE_LABEL[r.type]}:{getName(r.a)}↔{getName(r.b)}
                    </span>
                  ) : null;
                })}
                {c.groupRuleIds.map((gid) => {
                  const g = groupRules.find((x) => x.id === gid);
                  return g ? (
                    <span key={gid} className="mini-tag apart">
                      {g.sameTag ? `组内:${g.tagA}` : `${g.tagA}↔${g.tagB}`}
                    </span>
                  ) : null;
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 人数一桌放不下（提前提示） */}
      {preflight.overflows.length > 0 && (
        <div className="preflight-block">
          <div className="preflight-block-title warn">人数一桌放不下（{preflight.overflows.length}）</div>
          {preflight.overflows.map((w) => (
            <div key={w.id} id={`overflow-${w.id}`} className="issue-card overflow">
              <div className="issue-head">
                <span className="issue-id">{w.id}</span>
                <span className="issue-title">{w.label}超过单桌容量</span>
              </div>
              <p className="issue-detail">
                {w.kind === 'together-group'
                  ? `这 ${w.size} 人被「必须同桌/相邻」要求绑在一起，但一桌最多 ${w.tableCapacity} 人——排到一半必然被迫拆桌。请提前分组，或把 ${w.size - w.tableCapacity} 人的同桌要求解除。`
                  : `「${w.tag}」一共 ${w.size} 人，一桌最多 ${w.tableCapacity} 人，至少要分 ${Math.ceil(w.size / w.tableCapacity)} 桌；如没有互相避开要求，按 ${w.tableCapacity} 人一拨提前分好即可。`}
              </p>
              <div className="issue-tags">
                {w.guestIds.slice(0, 10).map((gid) => (
                  <span key={gid} className="mini-tag neutral">{getName(gid)}</span>
                ))}
                {w.guestIds.length > 10 && <span className="mini-tag neutral">等 {w.size} 人</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
