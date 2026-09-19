import type { PreflightReport } from '../constraints';

interface Stats {
  seated: number;
  capacity: number;
  emptySeats: number;
  totalGuests: number;
  unassignedCount: number;
}

export default function StatsBar({ stats, preflight }: { stats: Stats; preflight?: PreflightReport }) {
  return (
    <div className="stats-bar">
      <div className="stat-item">总宾客: <b>{stats.totalGuests}</b></div>
      <div className="stat-item">已入座: <b>{stats.seated}</b></div>
      <div className="stat-item">空座位: <b>{stats.emptySeats}</b></div>
      <div className="stat-item">未分配: <b style={{ color: stats.unassignedCount > 0 ? '#c0392b' : 'inherit' }}>{stats.unassignedCount}</b></div>
      <div className="stat-item">总容量: <b>{stats.capacity}</b></div>
      {preflight && (preflight.clusters.length > 0 || preflight.failCount > 0) && (
        <div className="stat-item stat-warn-badge bad">
          ⚠ {preflight.clusters.length} 处约束打架{preflight.failCount > 0 ? ` · ${preflight.failCount} 条无法满足` : ''}
        </div>
      )}
      {preflight && preflight.overflows.length > 0 && (
        <div className="stat-item stat-warn-badge warn">
          ⚠ {preflight.overflows.length} 组人数超单桌
        </div>
      )}
    </div>
  );
}
