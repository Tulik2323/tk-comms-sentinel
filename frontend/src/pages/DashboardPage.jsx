// DashboardPage — לוח בקרה ראשי עם widgets ניתנים לסידור מחדש
import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDevices } from '../hooks/useDevices';
import StatusDot from '../components/ui/StatusDot';
import { formatBps } from '../lib/api';
import api from '../lib/api';

// ---- סדר ברירת מחדל של ה-widgets ----
const DEFAULT_ORDER = ['top-bandwidth', 'recent-alerts', 'top-ports', 'problem-ports', 'top-cpu', 'duplicate-ips', 'all-devices'];

function loadOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem('nm_dash_order'));
    if (Array.isArray(saved)) {
      // תאימות שדרוג: widget חדש שנוסף אחרי שהמשתמש כבר שמר סדר —
      // מוסיפים אותו בלי לאפס את כל הסידור שהמשתמש בחר.
      const missing = DEFAULT_ORDER.filter(id => !saved.includes(id));
      const stale   = saved.filter(id => !DEFAULT_ORDER.includes(id));
      if (missing.length || stale.length) {
        const merged = [...saved.filter(id => DEFAULT_ORDER.includes(id)), ...missing];
        localStorage.setItem('nm_dash_order', JSON.stringify(merged));
        return merged;
      }
      return saved;
    }
  } catch (_) {}
  return DEFAULT_ORDER;
}

// ---- רכיבי עזר ----

function StatCard({ label, value, color, icon, sub, to }) {
  const card = (
    <div className="nm-card" style={{ textAlign: 'center', cursor: to ? 'pointer' : 'default' }}>
      <div style={{ fontSize: 28, marginBottom: 6 }}>{icon}</div>
      <div style={{ fontSize: 32, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
  if (!to) return card;
  return <Link to={to} style={{ textDecoration: 'none', display: 'block' }}>{card}</Link>;
}

function BandwidthBar({ bps, label }) {
  const mbps = (bps || 0) / 1e6;
  const pct  = Math.min(100, mbps / 10);
  const color = pct > 80 ? '#ef4444' : pct > 60 ? '#f97316' : '#22c55e';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 120 }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 12 }}>{label}</span>
      <div style={{ flex: 1, height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          width: '100%', height: '100%', background: color, borderRadius: 3,
          transform: `scaleX(${pct / 100})`, transformOrigin: 'right center',
          transition: 'transform 0.5s',
        }} />
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 55, textAlign: 'left' }}>
        {formatBps(bps)}
      </span>
    </div>
  );
}

function CpuBar({ pct }) {
  const color = pct > 80 ? '#ef4444' : pct > 60 ? '#f97316' : '#22c55e';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          width: '100%', height: '100%', background: color, borderRadius: 3,
          transform: `scaleX(${(pct || 0) / 100})`, transformOrigin: 'right center',
          transition: 'transform 0.5s',
        }} />
      </div>
      <span style={{ fontSize: 12, color, fontWeight: 600, minWidth: 38 }}>{pct?.toFixed(1)}%</span>
    </div>
  );
}

// ---- Widget: Top Bandwidth ----
function TopBandwidthWidget({ devices }) {
  const top = [...devices]
    .sort((a, b) => ((b.total_in_bps || 0) + (b.total_out_bps || 0)) - ((a.total_in_bps || 0) + (a.total_out_bps || 0)))
    .slice(0, 5);
  return (
    <div className="nm-card" style={{ height: '100%' }}>
      <h2 style={{ margin: '0 0 14px', fontSize: 14, color: 'var(--text-primary)' }}>📊 Top 5 — תעבורה</h2>
      <table className="nm-table">
        <thead><tr><th>שם</th><th>IP</th><th colSpan={2}>תעבורה</th><th>סה"כ</th></tr></thead>
        <tbody>
          {top.length === 0 ? (
            <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>אין נתונים</td></tr>
          ) : top.map(d => (
            <Link key={d.id} to={`/devices/${d.id}`} style={{ textDecoration: 'none', display: 'contents' }}>
              <tr style={{ cursor: 'pointer' }}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <StatusDot status={d.status} />
                    <span style={{ color: 'var(--text-primary)', fontSize: 12 }}>{d.name || d.ip}</span>
                  </div>
                </td>
                <td style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{d.ip}</td>
                <td><BandwidthBar bps={d.total_in_bps} label="↓" /></td>
                <td><BandwidthBar bps={d.total_out_bps} label="↑" /></td>
                <td style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                  {formatBps((d.total_in_bps || 0) + (d.total_out_bps || 0))}
                </td>
              </tr>
            </Link>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Widget: Recent Alerts ----
function RecentAlertsWidget({ alerts }) {
  const navigate = useNavigate();
  return (
    <div className="nm-card" style={{ height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 14 }}>🔔 התראות אחרונות</h2>
        <Link to="/alerts" style={{ fontSize: 12, color: 'var(--accent)' }}>הכל ←</Link>
      </div>
      {alerts.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>אין התראות 🎉</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {alerts.slice(0, 6).map(a => (
            <div key={a.id}
              onClick={() => a.device_id && navigate(`/devices/${a.device_id}`)}
              style={{
                padding: '7px 10px', borderRadius: 6, fontSize: 12, display: 'flex', gap: 8, alignItems: 'flex-start',
                background: a.resolved_at ? 'rgba(34,197,94,0.06)' : 'rgba(249,115,22,0.07)',
                border: `1px solid ${a.resolved_at ? 'rgba(34,197,94,0.18)' : 'rgba(249,115,22,0.18)'}`,
                cursor: a.device_id ? 'pointer' : 'default',
              }}>
              <span style={{
                marginTop: 3, flexShrink: 0,
                width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
                background: a.resolved_at ? '#22c55e' : '#f97316',
              }} />
              <div>
                <div style={{ color: 'var(--text-primary)', marginBottom: 2 }}>{a.message}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                  {new Date(a.sent_at * 1000).toLocaleString('he-IL')}
                  {a.resolved_at && ' · נפתר'}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Widget: Top Ports ----
function TopPortsWidget() {
  const [ports, setPorts] = useState([]);

  useEffect(() => {
    api.get('/dashboard/top-ports?limit=10')
      .then(r => setPorts(r.data))
      .catch(() => {});
  }, []);

  return (
    <div className="nm-card" style={{ height: '100%' }}>
      <h2 style={{ margin: '0 0 14px', fontSize: 14 }}>🔌 Top 10 — פורטים עמוסים</h2>
      <div style={{ overflowX: 'auto' }}>
        <table className="nm-table">
          <thead>
            <tr>
              <th>מכשיר</th>
              <th>פורט</th>
              <th>תיאור</th>
              <th>כניסה</th>
              <th>יציאה</th>
              <th>שגיאות</th>
            </tr>
          </thead>
          <tbody>
            {ports.length === 0 ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>אין נתוני פורטים</td></tr>
            ) : ports.map(p => (
              <Link key={p.id} to={`/devices/${p.device_id}`} style={{ textDecoration: 'none', display: 'contents' }}>
                <tr style={{ cursor: 'pointer' }}>
                  <td style={{ fontSize: 12 }}>{p.device_name || p.device_ip}</td>
                  <td style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                    {p.if_name || `#${p.if_index}`}
                  </td>
                  <td style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.if_alias || p.if_descr || '—'}
                  </td>
                  <td style={{ fontSize: 11, fontFamily: 'monospace' }}>{formatBps(p.in_bps)}</td>
                  <td style={{ fontSize: 11, fontFamily: 'monospace' }}>{formatBps(p.out_bps)}</td>
                  <td style={{ fontSize: 11, color: (p.in_errors + p.out_errors) > 0 ? '#f97316' : 'var(--text-muted)' }}>
                    {p.in_errors + p.out_errors}
                  </td>
                </tr>
              </Link>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Widget: Problem Ports ----
function ProblemPortsWidget() {
  const [ports, setPorts] = useState([]);

  useEffect(() => {
    api.get('/dashboard/problem-ports?limit=10')
      .then(r => setPorts(r.data))
      .catch(() => {});
  }, []);

  return (
    <div className="nm-card" style={{ height: '100%' }}>
      <h2 style={{ margin: '0 0 14px', fontSize: 14 }}>🚨 Top 10 — פורטים בעייתיים (24h)</h2>
      <div style={{ overflowX: 'auto' }}>
        <table className="nm-table">
          <thead>
            <tr>
              <th>מכשיר</th>
              <th>פורט</th>
              <th>התראות (24h)</th>
              <th>שגיאות</th>
              <th>תעבורה</th>
            </tr>
          </thead>
          <tbody>
            {ports.length === 0 ? (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>אין בעיות פורטים ✅</td></tr>
            ) : ports.map(p => (
              <Link key={p.id} to={`/devices/${p.device_id}?port=${p.if_index}`} style={{ textDecoration: 'none', display: 'contents' }}>
                <tr style={{ cursor: 'pointer' }}>
                  <td style={{ fontSize: 12 }}>{p.device_name || p.device_ip}</td>
                  <td style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                    {p.if_alias || p.if_name || `#${p.if_index}`}
                  </td>
                  <td style={{ fontSize: 11 }}>
                    {p.alert_count > 0 ? (
                      <span style={{
                        background: 'rgba(249,115,22,0.15)', color: '#fb923c',
                        padding: '2px 7px', borderRadius: 10, fontWeight: 600,
                      }}>{p.alert_count}</span>
                    ) : '—'}
                  </td>
                  <td style={{ fontSize: 11 }}>
                    {p.total_errors > 0 ? (
                      <span style={{
                        background: 'rgba(239,68,68,0.15)', color: '#f87171',
                        padding: '2px 7px', borderRadius: 10, fontWeight: 600,
                      }}>{p.total_errors}</span>
                    ) : '—'}
                  </td>
                  <td style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                    ↓{formatBps(p.in_bps)} ↑{formatBps(p.out_bps)}
                  </td>
                </tr>
              </Link>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Widget: Top CPU ----
function TopCpuWidget() {
  const [cpuData, setCpuData] = useState([]);

  useEffect(() => {
    api.get('/dashboard/top-cpu?limit=5')
      .then(r => setCpuData(r.data))
      .catch(() => {});
  }, []);

  return (
    <div className="nm-card" style={{ height: '100%' }}>
      <h2 style={{ margin: '0 0 14px', fontSize: 14 }}>🔥 Top 5 — עומס CPU</h2>
      {cpuData.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>אין נתוני CPU</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {cpuData.map(d => (
            <Link key={d.id} to={`/devices/${d.id}`} style={{ textDecoration: 'none' }}>
              <div style={{ padding: '8px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <StatusDot status={d.status} />
                    <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{d.name || d.ip}</span>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{d.ip}</span>
                </div>
                <CpuBar pct={d.cpu_pct || 0} />
                {d.mem_pct != null && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                    זיכרון: {d.mem_pct.toFixed(1)}%
                  </div>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Widget: All Devices Grid ----
function AllDevicesWidget({ devices }) {
  return (
    <div className="nm-card">
      <h2 style={{ margin: '0 0 14px', fontSize: 14 }}>🖧 כל המכשירים ({devices.length})</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 8 }}>
        {devices.map(d => (
          <Link key={d.id} to={`/devices/${d.id}`} style={{ textDecoration: 'none' }}>
            <div style={{
              padding: '9px 11px', background: 'var(--bg-secondary)', borderRadius: 7,
              border: `1px solid ${d.status === 'down' ? '#ef4444' : d.status === 'up' ? '#1a3a1a' : 'var(--border)'}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <StatusDot status={d.status} pulse />
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {d.name || d.sys_name || d.ip}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{d.ip}</div>
              {d.total_in_bps != null && (
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 3 }}>
                  ↓{formatBps(d.total_in_bps)} ↑{formatBps(d.total_out_bps)}
                </div>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---- Widget: Duplicate IP / IP Conflicts ----
function DuplicateIpWidget() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/dashboard/duplicate-ips')
      .then(r => setData(r.data))
      .catch(() => setData({ nameConflicts: [], lldpConflicts: [] }))
      .finally(() => setLoading(false));
  }, []);

  const total = (data?.nameConflicts?.length || 0) + (data?.lldpConflicts?.length || 0);

  return (
    <div className="nm-card" style={{ height: '100%' }}>
      <h2 style={{ margin: '0 0 14px', fontSize: 14 }}>⚠️ IP Conflicts</h2>
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 16 }}>בודק...</div>
      ) : total === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', color: '#4ade80', fontSize: 13 }}>
          <span style={{ fontSize: 18 }}>✅</span> לא נמצאו conflicts
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.nameConflicts.map((c, i) => (
            <div key={i} style={{ padding: '7px 10px', background: 'rgba(239,68,68,0.12)',
                                  border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, fontSize: 12 }}>
              <div style={{ color: '#f87171', fontWeight: 600 }}>⚡ {c.ip}</div>
              <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                מוגדר: <b>{c.name}</b> &nbsp;|&nbsp; SNMP מדווח: <b>{c.sys_name}</b>
              </div>
            </div>
          ))}
          {data.lldpConflicts.map((c, i) => (
            <div key={`l${i}`} style={{ padding: '7px 10px', background: 'rgba(251,191,36,0.1)',
                                        border: '1px solid rgba(251,191,36,0.3)', borderRadius: 6, fontSize: 12 }}>
              <div style={{ color: '#fbbf24', fontWeight: 600 }}>🔁 LLDP: {c.device_ip}</div>
              <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                <b>{c.device_name}</b> נראה ב-<b>{c.seen_on_switch}</b> תחת שם <b>{c.remote_sys_name}</b>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Widget Wrapper עם Drag ----
function DraggableWidget({ id, onDragStart, onDragOver, onDrop, children, isDragTarget }) {
  return (
    <div
      draggable
      onDragStart={() => onDragStart(id)}
      onDragOver={(e) => { e.preventDefault(); onDragOver(id); }}
      onDrop={() => onDrop(id)}
      style={{
        cursor:     'grab',
        outline:    isDragTarget ? '2px dashed var(--accent)' : 'none',
        borderRadius: 8,
        transition: 'outline 0.15s',
      }}
    >
      {children}
    </div>
  );
}

// ---- Dashboard ראשי ----
export default function DashboardPage() {
  const { t }               = useTranslation();
  const { devices, loading } = useDevices(30);
  const [alerts, setAlerts]  = useState([]);
  const [order,  setOrder]   = useState(loadOrder);
  const dragFrom = useRef(null);
  const [dragTarget, setDragTarget] = useState(null);

  const up      = devices.filter(d => d.status === 'up').length;
  const down    = devices.filter(d => d.status === 'down').length;
  const unknown = devices.filter(d => d.status === 'unknown').length;

  useEffect(() => {
    api.get('/alerts/events?limit=10')
      .then(r => setAlerts(r.data.events || []))
      .catch(() => {});
  }, []);

  function handleDragStart(id) { dragFrom.current = id; }
  function handleDragOver(id)  { setDragTarget(id); }
  function handleDrop(id) {
    if (!dragFrom.current || dragFrom.current === id) { setDragTarget(null); return; }
    const next = [...order];
    const from = next.indexOf(dragFrom.current);
    const to   = next.indexOf(id);
    if (from === -1 || to === -1) return;
    next.splice(from, 1);
    next.splice(to, 0, dragFrom.current);
    setOrder(next);
    localStorage.setItem('nm_dash_order', JSON.stringify(next));
    dragFrom.current = null;
    setDragTarget(null);
  }

  const WIDGETS = {
    'top-bandwidth': <TopBandwidthWidget devices={devices} />,
    'recent-alerts': <RecentAlertsWidget alerts={alerts} />,
    'top-ports':     <TopPortsWidget />,
    'problem-ports': <ProblemPortsWidget />,
    'top-cpu':       <TopCpuWidget />,
    'duplicate-ips': <DuplicateIpWidget />,
    'all-devices':   <AllDevicesWidget devices={devices} />,
  };

  // all-devices נמתח על כל הרוחב — widgets אחרים ב-2 עמודות
  const mainOrder   = order.filter(id => id !== 'all-devices');
  const allDevicesId = 'all-devices';

  if (loading) {
    return <div style={{ padding: 32, color: 'var(--text-muted)' }}>{t('loading')}</div>;
  }

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22, color: 'var(--text-primary)' }}>⚡ {t('dashboard')}</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>גרור widgets לסידור</span>
          {order.join() !== DEFAULT_ORDER.join() && (
            <button className="nm-btn nm-btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}
              onClick={() => { setOrder(DEFAULT_ORDER); localStorage.removeItem('nm_dash_order'); }}>
              ↺ איפוס סדר
            </button>
          )}
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>מתרענן כל 30 שניות</span>
        </div>
      </div>

      {/* Stat Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 16, marginBottom: 24 }}>
        <StatCard label={t('total_devices')} value={devices.length} color="var(--accent)" icon="🖧" to="/devices" />
        <StatCard label={t('devices_up')} value={up} color="var(--status-up)" icon="✅"
          sub={devices.length ? `${Math.round(up / devices.length * 100)}%` : ''} to="/devices?status=up" />
        <StatCard label={t('devices_down')} value={down} color="var(--status-down)" icon="❌" to="/devices?status=down" />
        <StatCard label="לא ידוע" value={unknown} color="var(--status-unknown)" icon="❓" to="/devices?status=unknown" />
        <StatCard
          label={t('open_alerts')}
          value={alerts.filter(a => !a.resolved_at).length}
          color={alerts.filter(a => !a.resolved_at).length > 0 ? 'var(--status-warn)' : 'var(--status-up)'}
          icon="🔔" to="/alerts" />
      </div>

      {/* Down Banner */}
      {down > 0 && (
        <div style={{
          background: '#7f1d1d', border: '1px solid #ef4444', borderRadius: 8,
          padding: '12px 16px', marginBottom: 20, color: '#fecaca',
        }}>
          ⚠️ {down} מכשיר{down > 1 ? 'ים' : ''} לא זמינים:{' '}
          {devices.filter(d => d.status === 'down').map(d =>
            <Link key={d.id} to={`/devices/${d.id}`} style={{ color: '#fca5a5', marginLeft: 8 }}>
              {d.name || d.ip}
            </Link>
          )}
        </div>
      )}

      {/* Draggable Widgets Grid (2 עמודות) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        {mainOrder.map(id => (
          <DraggableWidget key={id} id={id}
            onDragStart={handleDragStart} onDragOver={handleDragOver} onDrop={handleDrop}
            isDragTarget={dragTarget === id}>
            {WIDGETS[id]}
          </DraggableWidget>
        ))}
      </div>

      {/* All Devices — רוחב מלא, ניתן לגרור */}
      <DraggableWidget id={allDevicesId}
        onDragStart={handleDragStart} onDragOver={handleDragOver} onDrop={handleDrop}
        isDragTarget={dragTarget === allDevicesId}>
        {WIDGETS[allDevicesId]}
      </DraggableWidget>
    </div>
  );
}
