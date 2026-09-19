import { useState } from 'react';
import type { Plan, Rule, Command, RuleType, RuleEndpointKind } from '../types';
import { generateId } from '../utils';

interface Props {
  plan: Plan;
  dispatch: (cmd: Command) => void;
  onOpenPrecheck: () => void;
}

export default function RulesPanel({ plan, dispatch, onOpenPrecheck }: Props) {
  const [type, setType] = useState<RuleType>('apart');
  const [aKind, setAKind] = useState<RuleEndpointKind>('guest');
  const [bKind, setBKind] = useState<RuleEndpointKind>('guest');
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');

  const addRule = () => {
    if (!aId || !bId) return;
    if (aKind === bKind && aId === bId) return;
    const rule: Rule = { id: generateId(), type, a: aId, b: bId, aKind, bKind };
    dispatch({ type: 'updateRules', rules: [...plan.rules, rule] });
    setAId('');
    setBId('');
  };

  const removeRule = (id: string) => {
    dispatch({ type: 'updateRules', rules: plan.rules.filter((r) => r.id !== id) });
  };

  const addGroup = () => {
    dispatch({
      type: 'updateGroups',
      groups: [...plan.groups, { id: generateId(), name: `家庭${plan.groups.length + 1}`, keepTogether: false }],
    });
  };

  const updateGroup = (id: string, patch: Partial<Plan['groups'][number]>) => {
    dispatch({
      type: 'updateGroups',
      groups: plan.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    });
  };

  const removeGroup = (id: string) => {
    if (!confirm('删除该派别？名下宾客会变为「未分组」，引用该派别的规则也会一起删除。')) return;
    dispatch({
      type: 'batch',
      commands: [
        { type: 'updateGroups', groups: plan.groups.filter((g) => g.id !== id) },
        { type: 'updateGuests', guests: plan.guests.map((g) => (g.groupId === id ? { ...g, groupId: undefined } : g)) },
        {
          type: 'updateRules',
          rules: plan.rules.filter((r) =>
            !((r.aKind === 'group' || (!r.aKind && !plan.guests.some((gg) => gg.id === r.a))) && r.a === id) &&
            !((r.bKind === 'group' || (!r.bKind && !plan.guests.some((gg) => gg.id === r.b))) && r.b === id)),
        },
      ],
    });
  };

  const endpointName = (id: string, kind?: RuleEndpointKind) => {
    const isGroup = kind === 'group' || (!kind && !plan.guests.some((g) => g.id === id));
    if (isGroup) {
      const grp = plan.groups.find((g) => g.id === id);
      return grp ? `${grp.name}（一家）` : '（已删除派别）';
    }
    return plan.guests.find((g) => g.id === id)?.name || '（已删除宾客）';
  };

  const typeLabel = (t: RuleType) => (t === 'together' ? '必须同桌' : t === 'apart' ? '禁止同桌' : t === 'adjacent' ? '必须相邻' : '必须分开');

  // 禁止同桌 / 必须分开才允许选整家派别
  const groupAllowed = type === 'apart' || type === 'separate' || type === 'together';
  const kindOptions: { value: RuleEndpointKind; label: string }[] = [
    { value: 'guest', label: '宾客' },
    ...(groupAllowed ? [{ value: 'group' as const, label: '整家' }] : []),
  ];

  const renderEndpoint = (side: 'a' | 'b') => {
    const kind = side === 'a' ? aKind : bKind;
    const setKind = side === 'a' ? setAKind : setBKind;
    const val = side === 'a' ? aId : bId;
    const setVal = side === 'a' ? setAId : setBId;
    return (
      <div className="rule-endpoint">
        <select className="endpoint-kind" value={kind} onChange={(e) => { setKind(e.target.value as RuleEndpointKind); setVal(''); }}>
          {kindOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={val} onChange={(e) => setVal(e.target.value)}>
          <option value="">选择{kind === 'group' ? '派别' : '宾客'}</option>
          {kind === 'group'
            ? plan.groups.map((g) => <option key={g.id} value={g.id}>{g.name}（{plan.guests.filter((x) => x.groupId === g.id).length}人）</option>)
            : plan.guests.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>
    );
  };

  return (
    <div className="rules-panel">
      <h3>约束规则</h3>
      <button className="btn-precheck" onClick={onOpenPrecheck}>📋 摆桌前核对（圈/链·打架·桌容）</button>

      {/* 派别管理 */}
      <div className="groups-section">
        <div className="groups-head">
          <h4>家庭 / 圈子（派别）</h4>
          <button onClick={addGroup}>+ 新建</button>
        </div>
        {plan.groups.length === 0 && (
          <div className="groups-hint">先建派别，如「张家亲戚」「爸爸老同事」；在宾客池里把人归入派别，就能设置两整家之间的禁止同桌。</div>
        )}
        {plan.groups.map((g) => {
          const count = plan.guests.filter((x) => x.groupId === g.id).length;
          return (
            <div key={g.id} className="group-item">
              <input
                className="group-name-input"
                value={g.name}
                onChange={(e) => updateGroup(g.id, { name: e.target.value })}
              />
              <span className="group-count">{count}人</span>
              <label className="group-keep" title="勾选后校验时要求这一家人整家坐一桌，坐不下会提前报错">
                <input
                  type="checkbox"
                  checked={g.keepTogether}
                  onChange={(e) => updateGroup(g.id, { keepTogether: e.target.checked })}
                />
                整家一桌
              </label>
              <button className="group-remove" title="删除派别" onClick={() => removeGroup(g.id)}>×</button>
            </div>
          );
        })}
      </div>

      {/* 规则表单 */}
      <div className="rule-form">
        <select value={type} onChange={(e) => setType(e.target.value as RuleType)}>
          <option value="together">必须同桌</option>
          <option value="apart">禁止同桌</option>
          <option value="adjacent">必须相邻</option>
          <option value="separate">必须分开</option>
        </select>
        {renderEndpoint('a')}
        <div className="rule-link">↔</div>
        {renderEndpoint('b')}
        <button className="rule-add-btn" onClick={addRule} disabled={!aId || !bId || (aKind === bKind && aId === bId)}>添加约束</button>
      </div>

      <div className="rules-list">
        {plan.rules.map((r) => (
          <div key={r.id} className="rule-item">
            <span className={`rule-type ${r.type}`}>{typeLabel(r.type)}</span>
            <span className="rule-endpoint-name">{endpointName(r.a, r.aKind)}</span>
            <span>↔</span>
            <span className="rule-endpoint-name">{endpointName(r.b, r.bKind)}</span>
            <button onClick={() => removeRule(r.id)}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}
