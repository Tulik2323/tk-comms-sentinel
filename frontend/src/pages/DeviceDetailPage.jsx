// DeviceDetailPage — פירוט מכשיר: פורטים + גרפים היסטוריים
import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { useMetrics } from '../hooks/useMetrics';
import StatusDot from '../components/ui/StatusDot';
import { formatBps, formatUptime } from '../lib/api';
import api from '../lib/api';

// טיפ בגרף
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 6, padding: '8px 12px', fontSize: 12,
    }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>
        {new Date(label * 1000).toLocaleString()}
      </div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {p.dataKey.includes('bps') ? formatBps(p.value) : `${Math.round(p.value)}%`}
        </div>
      ))}
    </div>
  );
}

export default function DeviceDetailPage() {
  const { t }     = useTranslation();
  const { id }    = useParams();
  const [searchParams] = useSearchParams();
  const highlightIfIndex = Number(searchParams.get('port')) || null;
  const highlightRef = useRef(null);

  const [device,  setDevice]  = useState(null);
  const [ports,   setPorts]   = useState([]);
  const [hours,   setHours]   = useState(24);
  const [portFilter,  setPortFilter]  = useState('all'); // all | up | down
  const [portSortKey, setPortSortKey] = useState('if_index');
  const [portSortDir, setPortSortDir] = useState('asc');
  const [portChanges, setPortChanges] = useState(null); // null = not loaded
  const [changesOpen, setChangesOpen] = useState(false);
  const [selectedPort,   setSelectedPort]   = useState(null);
  const [portThresh,     setPortThresh]     = useState(null);
  const [threshEdit,     setThreshEdit]     = useState({});
  const [durEdit,        setDurEdit]        = useState({}); // metric -> משך בדקות (ריק = ירושה)
  const [threshSaving,   setThreshSaving]   = useState(false);
  const [portEndpoints,  setPortEndpoints]  = useState(null);
  const [portHistory,    setPortHistory]    = useState(null); // [{ts,in_bps,out_bps}]

  const { metrics, summary, loading: metricsLoading } = useMetrics(id, hours);

  useEffect(() => {
    api.get(`/devices/${id}`)      .then(r => setDevice(r.data)).catch(console.error);
    api.get(`/devices/${id}/ports`).then(r => setPorts(r.data)) .catch(console.error);
  }, [id]);

  async function openPortModal(port) {
    setSelectedPort(port);
    setPortThresh(null);
    setThreshEdit({});
    setDurEdit({});
    setPortEndpoints(null);
    setPortHistory(null);
    const [threshRes, endpRes, histRes] = await Promise.allSettled([
      api.get(`/devices/${id}/port-threshold/${port.if_index}`),
      api.get(`/devices/${id}/port-endpoints/${port.if_index}`),
      api.get(`/devices/${id}/port-history/${port.if_index}?hours=24`),
    ]);
    if (threshRes.status === 'fulfilled') {
      setPortThresh(threshRes.value.data);
      const init = {};
      for (const [m, v] of Object.entries(threshRes.value.data.portOverrides || {})) {
        init[m] = String(v);
      }
      setThreshEdit(init);
      const initDur = {};
      for (const [m, v] of Object.entries(threshRes.value.data.portOverrideDurations || {})) {
        if (v != null) initDur[m] = String(v);
      }
      setDurEdit(initDur);
    } else {
      setPortThresh({ effective: {}, portOverrides: {} });
    }
    setPortEndpoints(endpRes.status === 'fulfilled' ? endpRes.value.data : []);
    setPortHistory(histRes.status === 'fulfilled' ? histRes.value.data : []);
  }

  // זיהוי יצרן לפי OUI (3 בתים ראשונים של MAC)
  function identifyMac(mac) {
    if (!mac) return null;
    const oui = mac.substring(0, 8).toLowerCase();
    const VM_OUIS = { '00:50:56': 'VMware', '00:0c:29': 'VMware', '52:54:00': 'QEMU/KVM', 'fa:16:3e': 'OpenStack', '00:15:5d': 'Hyper-V' };
    const NET_OUIS = {
      '00:00:0c': 'Cisco', 'c8:9c:1d': 'Cisco', 'f0:25:72': 'Cisco', '70:df:2f': 'Cisco',
      '3c:57:31': 'Cisco', 'e4:c7:22': 'Cisco', '00:17:df': 'Cisco',
      '9c:8e:99': 'HP/Aruba', 'b0:5a:da': 'HP/Aruba', 'f0:92:1c': 'HP/Aruba',
      '00:1b:11': 'HP/Aruba', '94:71:ac': 'Aruba', 'ec:b9:10': 'Aruba',
      '24:de:c6': 'Juniper', '00:23:9c': 'Juniper', '28:8a:1c': 'Juniper',
      '00:e0:52': 'Brocade', '00:27:f8': 'Brocade',
    };
    if (VM_OUIS[oui]) return { type: 'vm', vendor: VM_OUIS[oui] };
    if (NET_OUIS[oui]) return { type: 'net', vendor: NET_OUIS[oui] };
    return null;
  }

  // טוען מחדש את הסף בפועל מהשרת: המשך יכול לעבור בירושה מסף המכשיר/הגלובלי,
  // ורק השרת יודע מה הערך שנכנס לתוקף.
  async function reloadPortThreshold() {
    const r = await api.get(`/devices/${id}/port-threshold/${selectedPort.if_index}`);
    setPortThresh(r.data);
  }

  async function savePortThreshold(metric) {
    const val = Number(threshEdit[metric]);
    if (!val || val < 1 || val > 100) return;
    // משך ריק = ירושה
    const durRaw = durEdit[metric];
    const dur    = durRaw === undefined || durRaw === '' ? null : Number(durRaw);
    if (dur !== null && (!Number.isInteger(dur) || dur < 0 || dur > 1440)) {
      alert(t('duration_invalid'));
      return;
    }
    setThreshSaving(true);
    try {
      await api.put(`/devices/${id}/port-threshold/${selectedPort.if_index}`, { metric, threshold_pct: val, duration_min: dur });
      await reloadPortThreshold();
    } catch (err) {
      alert(err.response?.data?.error || t('error'));
    } finally { setThreshSaving(false); }
  }

  async function removePortThreshold(metric) {
    setThreshSaving(true);
    try {
      await api.delete(`/devices/${id}/port-threshold/${selectedPort.if_index}/${metric}`);
      await reloadPortThreshold();
      setThreshEdit(prev => { const n = { ...prev }; delete n[metric]; return n; });
      setDurEdit(prev => { const n = { ...prev }; delete n[metric]; return n; });
    } catch (err) {
      alert(err.response?.data?.error || t('error'));
    } finally { setThreshSaving(false); }
  }

  async function togglePortChanges() {
    if (!changesOpen && portChanges === null) {
      try {
        const r = await api.get(`/devices/${id}/ports/changes`);
        setPortChanges(r.data);
      } catch (_) { setPortChanges([]); }
    }
    setChangesOpen(v => !v);
  }

  // גלול לפורט המסומן (מגיע מחיפוש MAC/IP)
  useEffect(() => {
    if (highlightRef.current) {
      setTimeout(() => highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400);
    }
  }, [ports, highlightIfIndex]);

  if (!device) {
    return <div style={{ padding: 32, color: 'var(--text-muted)' }}>{t('loading_device')}</div>;
  }

  function togglePortSort(key) {
    if (portSortKey === key) setPortSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setPortSortKey(key); setPortSortDir(key === 'if_index' ? 'asc' : 'desc'); }
  }

  const PORT_SORTERS = {
    if_index: p => p.if_index,
    if_name:  p => (p.if_name || '').toLowerCase(),
    if_speed: p => Number(p.if_speed) || 0,
    in_bps:   p => Number(p.in_bps)  || 0,
    out_bps:  p => Number(p.out_bps) || 0,
    in_errors:p => Number(p.in_errors) || 0,
  };

  const filteredPorts = ports
    .filter(p => portFilter === 'all' || p.oper_status === portFilter)
    .sort((a, b) => {
      const fn = PORT_SORTERS[portSortKey] || (p => p.if_index);
      const va = fn(a), vb = fn(b);
      return portSortDir === 'asc'
        ? (va < vb ? -1 : va > vb ? 1 : 0)
        : (va > vb ? -1 : va < vb ? 1 : 0);
    });

  const upPorts   = ports.filter(p => p.oper_status === 'up').length;
  const downPorts = ports.filter(p => p.oper_status !== 'up').length;

  // HW status (FANs, PSU, Temp) — מגיע מה-DB כ-JSON
  const hw = (() => {
    try { return device.hw_status ? JSON.parse(device.hw_status) : null; } catch { return null; }
  })();

  // הכן נתוני גרף (downsampled)
  const chartData = metrics.filter((_, i) => i % Math.max(1, Math.floor(metrics.length / 100)) === 0);

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      {/* Breadcrumb */}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
        <Link to="/devices" style={{ color: 'var(--accent)' }}>{t('devices')}</Link>
        {' › '}
        {device.name || device.ip}
      </div>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
        <div style={{
          width: 48, height: 48, borderRadius: 10,
          background: 'var(--bg-secondary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 24,
        }}>🖧</div>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
            <StatusDot status={device.status} size={12} pulse />
            {device.name || device.sys_name || device.ip}
          </h1>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            {device.ip}
            {device.model && <span style={{ marginInlineStart: 8, color: 'var(--accent)', fontWeight: 600 }}>· {device.model}</span>}
            {!device.model && device.sys_name && <span style={{ marginInlineStart: 8 }}>· {device.sys_name}</span>}
            <span style={{ marginInlineStart: 8 }}>· Uptime: {formatUptime(device.uptime_sec)}</span>
          </div>
        </div>

        {/* Stats row */}
        <div style={{ display: 'flex', gap: 16 }}>
          {[
            { label: t('active_ports'), value: `${upPorts}/${ports.length}`, color: '#22c55e' },
            { label: 'CPU',   value: summary?.max_cpu   ? `${Math.round(summary.max_cpu)}%`      : '—', color: 'var(--accent)' },
            { label: 'Max ↓', value: summary?.max_in_bps ? formatBps(summary.max_in_bps)          : '—', color: '#22c55e' },
            { label: 'Max ↑', value: summary?.max_out_bps ? formatBps(summary.max_out_bps)        : '—', color: '#3b82f6' },
          ].map(s => (
            <div key={s.label} style={{
              textAlign: 'center', padding: '8px 14px',
              background: 'var(--bg-card)', borderRadius: 8, border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
        {/* Bandwidth Chart */}
        <div className="nm-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>📊 {t('col_traffic')}</h3>
            <div style={{ display: 'flex', gap: 4 }}>
              {[6, 24, 72, 168].map(h => (
                <button key={h} onClick={() => setHours(h)}
                  className={`nm-btn ${hours === h ? 'nm-btn-primary' : 'nm-btn-ghost'}`}
                  style={{ padding: '3px 8px', fontSize: 11 }}>
                  {h < 24 ? `${h}h` : `${h/24}d`}
                </button>
              ))}
            </div>
          </div>
          {metricsLoading ? (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
              {t('loading')}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="inGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#22c55e" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="outGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="ts" tickFormatter={ts => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                <YAxis tickFormatter={v => formatBps(v)} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} width={70} />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <Area type="monotone" dataKey="total_in_bps"  name={t('in_word')}  stroke="#22c55e" fill="url(#inGrad)"  strokeWidth={2} dot={false} />
                <Area type="monotone" dataKey="total_out_bps" name={t('out_word')} stroke="#3b82f6" fill="url(#outGrad)" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* CPU Chart */}
        <div className="nm-card">
          <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>⚡ CPU</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="ts" tickFormatter={ts => new Date(ts * 1000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
              <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
              <Tooltip content={<CustomTooltip />} />
              <Line type="monotone" dataKey="cpu_pct" name="CPU" stroke="#f97316" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Hardware Status (FAN / PSU / Temp) — מוצג רק למכשירי Comware עם נתונים */}
      {hw && (
        <div className="nm-card" style={{ marginBottom: 20 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>🔧 {t('hw_status')}</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {/* FANs — badge ירוק כולל עם מונה, ו-badge אדום לכל FAN כושל */}
            {hw.fans && (() => {
              const okEntry   = hw.fans.find(f => f.idx === 0 && f.status === 'ok');
              const failFans  = hw.fans.filter(f => f.idx !== 0 && f.status === 'fail');
              const totalFail = failFans.length;
              return (<>
                {okEntry && (
                  <div style={{
                    padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                    background: 'rgba(34,197,94,0.12)', border: '1px solid #22c55e', color: '#22c55e',
                  }}>
                    💨 {okEntry.count} FANs ✓
                    {totalFail > 0 && <span style={{ color: '#ef4444', marginInlineStart: 6 }}>+{totalFail} ✗</span>}
                  </div>
                )}
                {failFans.map(f => (
                  <div key={'fan' + f.idx} style={{
                    padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                    background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444', color: '#ef4444',
                  }}>
                    💨 FAN {f.idx} ✗
                  </div>
                ))}
              </>);
            })()}
            {/* PSU */}
            {hw.psus && hw.psus.map(p => (
              <div key={'psu' + p.idx} style={{
                padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                background: p.status === 'ok' ? 'rgba(34,197,94,0.12)' : p.status === 'fail' ? 'rgba(239,68,68,0.15)' : 'rgba(100,116,139,0.1)',
                border: `1px solid ${p.status === 'ok' ? '#22c55e' : p.status === 'fail' ? '#ef4444' : '#64748b'}`,
                color: p.status === 'ok' ? '#22c55e' : p.status === 'fail' ? '#ef4444' : 'var(--text-muted)',
              }}>
                ⚡ PSU {p.idx} {p.status === 'ok' ? '✓' : p.status === 'fail' ? '✗' : '?'}
              </div>
            ))}
            {/* Temperature */}
            {hw.temps && hw.temps.map(tmp => (
              <div key={'temp' + tmp.idx} style={{
                padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                background: tmp.celsius > 60 ? 'rgba(239,68,68,0.15)' : tmp.celsius > 45 ? 'rgba(249,115,22,0.12)' : 'rgba(59,130,246,0.1)',
                border: `1px solid ${tmp.celsius > 60 ? '#ef4444' : tmp.celsius > 45 ? '#f97316' : '#3b82f6'}`,
                color: tmp.celsius > 60 ? '#ef4444' : tmp.celsius > 45 ? '#f97316' : '#3b82f6',
              }}>
                🌡 {tmp.celsius}°C
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ports Table */}
      <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{
          padding: '12px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
        }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>
            🔌 {t('ports_header', { up: upPorts, down: downPorts })}
          </h3>
          <div style={{ display: 'flex', gap: 6 }}>
            {['all', 'up', 'down'].map(f => (
              <button key={f}
                onClick={() => setPortFilter(f)}
                className={`nm-btn ${portFilter === f ? 'nm-btn-primary' : 'nm-btn-ghost'}`}
                style={{ padding: '4px 10px', fontSize: 11 }}>
                {f === 'all' ? t('filter_all') : f === 'up' ? '✅' : '❌'}
              </button>
            ))}
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="nm-table">
            <thead>
              <tr>
                {[
                  ['if_index', '#'],
                  ['if_name',  t('col_port_name')],
                  [null,       t('col_description')],
                  ['pvid',     'VLAN'],
                  ['if_speed', t('col_speed')],
                  [null,       'Admin'],
                  [null,       'Oper'],
                  ['in_bps',   `${t('col_traffic')} ↓`],
                  ['out_bps',  `${t('col_traffic')} ↑`],
                  ['in_errors',t('col_errors_in')],
                ].map(([key, label]) => (
                  <th key={label}
                    onClick={key ? () => togglePortSort(key) : undefined}
                    style={{ cursor: key ? 'pointer' : 'default', userSelect: 'none', whiteSpace: 'nowrap' }}
                    title={key ? t('sort_hint') : ''}
                  >
                    {label}
                    {key && (
                      <span style={{ marginInlineStart: 4, opacity: portSortKey === key ? 1 : 0.25,
                        color: portSortKey === key ? 'var(--accent)' : 'inherit', fontSize: 10 }}>
                        {portSortKey === key ? (portSortDir === 'asc' ? '▲' : '▼') : '⇅'}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredPorts.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20 }}>
                    {t('no_ports')}
                  </td>
                </tr>
              ) : filteredPorts.map(p => {
                const isHighlighted = highlightIfIndex && p.if_index === highlightIfIndex;
                return (
                <tr key={p.if_index}
                    ref={isHighlighted ? highlightRef : null}
                    onClick={() => openPortModal(p)}
                    style={{
                      cursor: 'pointer',
                      ...(isHighlighted ? {
                        background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
                        outline: '2px solid var(--accent)',
                        outlineOffset: '-2px',
                      } : {}),
                    }}
                >
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{p.if_index}</td>
                  <td style={{ fontWeight: 600, fontSize: 12 }}>
                    {p.if_alias || p.if_descr || p.if_name || '—'}
                    {p.if_alias && (p.if_descr || p.if_name) && (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>{p.if_descr || p.if_name}</div>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{p.if_descr || p.if_name || '—'}</td>
                  <td style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                    {p.pvid ?? '—'}
                  </td>
                  <td style={{ fontSize: 12, fontFamily: 'monospace' }}>
                    {p.if_speed ? formatBps(p.if_speed) : '—'}
                  </td>
                  <td>
                    <StatusDot status={p.admin_status === 'up' ? 'up' : 'down'} size={8} />
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <StatusDot status={p.oper_status === 'up' ? 'up' : 'down'} size={8} />
                      <span style={{ fontSize: 11 }}>{p.oper_status}</span>
                    </div>
                  </td>
                  <td style={{ color: '#22c55e', fontSize: 12, fontFamily: 'monospace' }}>
                    {formatBps(p.in_bps)}
                  </td>
                  <td style={{ color: '#3b82f6', fontSize: 12, fontFamily: 'monospace' }}>
                    {formatBps(p.out_bps)}
                  </td>
                  <td style={{ color: p.in_errors > 0 ? '#ef4444' : 'var(--text-muted)', fontSize: 12 }}>
                    {p.in_errors > 0 ? p.in_errors.toLocaleString() : '—'}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Port Change Log */}
      <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
        <button
          onClick={togglePortChanges}
          style={{
            width: '100%', textAlign: 'start', padding: '12px 16px',
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            color: 'var(--text-primary)', fontSize: 14, fontWeight: 600,
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {portChanges ? `${portChanges.length} ${t('changes_word')}` : t('click_to_load')}
          </span>
          <span>
            📋 {t('port_changes_log')}
            <span style={{ marginInlineStart: 6, fontSize: 12, opacity: 0.6 }}>
              {changesOpen ? '▲' : '▼'}
            </span>
          </span>
        </button>

        {changesOpen && (
          <div style={{ borderTop: '1px solid var(--border)', overflowX: 'auto' }}>
            {!portChanges || portChanges.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                {portChanges === null ? t('loading') : t('no_changes_recorded')}
              </div>
            ) : (
              <table className="nm-table">
                <thead>
                  <tr>
                    <th>{t('col_time')}</th>
                    <th>{t('col_port')}</th>
                    <th>{t('col_field')}</th>
                    <th>{t('col_before')}</th>
                    <th>{t('col_after')}</th>
                  </tr>
                </thead>
                <tbody>
                  {portChanges.map(c => {
                    const ATTR_LABELS = {
                      if_alias:     t('col_description'),
                      admin_status: 'Admin',
                      if_speed:     t('col_speed'),
                      pvid:         'VLAN',
                    };
                    const fmtSpeed = v => {
                      const n = Number(v);
                      if (!n) return v;
                      if (n >= 1e9) return `${n/1e9}G`;
                      if (n >= 1e6) return `${n/1e6}M`;
                      return v;
                    };
                    const fmt = (attr, v) =>
                      attr === 'if_speed' ? fmtSpeed(v) : (v || '—');
                    return (
                      <tr key={c.id}>
                        <td style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                          {new Date(c.changed_at * 1000).toLocaleString()}
                        </td>
                        <td style={{ fontSize: 12, fontWeight: 600 }}>{c.if_name || `#${c.if_index}`}</td>
                        <td style={{ fontSize: 12 }}>{ATTR_LABELS[c.attribute] || c.attribute}</td>
                        <td style={{ fontSize: 12, color: '#ef4444' }}>{fmt(c.attribute, c.old_value)}</td>
                        <td style={{ fontSize: 12, color: '#22c55e' }}>{fmt(c.attribute, c.new_value)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* ===== Port Detail Modal ===== */}
      {selectedPort && (
        <div
          onClick={() => setSelectedPort(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 14, padding: 24, width: 480, maxWidth: '95vw',
              maxHeight: '90vh', overflowY: 'auto', direction: 'rtl',
              boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>
                  🔌 {selectedPort.if_alias || selectedPort.if_name || `Port ${selectedPort.if_index}`}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                  {selectedPort.if_name} · if_index {selectedPort.if_index}
                  {selectedPort.if_speed ? ` · ${selectedPort.if_speed >= 1e9 ? `${selectedPort.if_speed/1e9}G` : `${selectedPort.if_speed/1e6}M`}` : ''}
                </div>
              </div>
              <button onClick={() => setSelectedPort(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-muted)', lineHeight: 1 }}>
                ✕
              </button>
            </div>

            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
              {[
                { label: 'Oper Status', value: selectedPort.oper_status, color: selectedPort.oper_status === 'up' ? '#22c55e' : '#ef4444' },
                { label: 'Admin Status', value: selectedPort.admin_status, color: selectedPort.admin_status === 'up' ? '#22c55e' : '#94a3b8' },
                { label: 'VLAN', value: selectedPort.pvid ?? '—', color: 'var(--text-primary)' },
                { label: `${t('col_traffic')} ↓`, value: formatBps(selectedPort.in_bps),  color: '#22c55e' },
                { label: `${t('col_traffic')} ↑`, value: formatBps(selectedPort.out_bps), color: '#3b82f6' },
                { label: t('col_errors_in'),  value: selectedPort.in_errors  > 0 ? selectedPort.in_errors.toLocaleString()  : '—', color: selectedPort.in_errors  > 0 ? '#ef4444' : 'var(--text-muted)' },
                { label: t('col_errors_out'), value: selectedPort.out_errors > 0 ? selectedPort.out_errors.toLocaleString() : '—', color: selectedPort.out_errors > 0 ? '#ef4444' : 'var(--text-muted)' },
              ].map(s => (
                <div key={s.label} style={{
                  padding: '8px 12px', borderRadius: 8,
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.label}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: s.color, marginTop: 2 }}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Port Traffic History */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>📈 {t('port_history_24h')}</div>
              {portHistory === null && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('loading')}</div>}
              {portHistory !== null && portHistory.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('no_data_yet_poll')}</div>
              )}
              {portHistory !== null && portHistory.length > 0 && (() => {
                const fmt = ts => {
                  const d = new Date(ts * 1000);
                  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                };
                const chartData = portHistory.map(r => ({
                  t: fmt(r.ts), in: Math.round((r.in_bps || 0) / 1e6 * 10) / 10,
                  out: Math.round((r.out_bps || 0) / 1e6 * 10) / 10,
                }));
                return (
                  <ResponsiveContainer width="100%" height={120}>
                    <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="t" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} unit="M" width={32} />
                      <Tooltip formatter={(v, n) => [`${v} Mbps`, n === 'in' ? `↓ ${t('in_word')}` : `↑ ${t('out_word')}`]}
                        contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', fontSize: 11 }} />
                      <Area type="monotone" dataKey="in"  stroke="#22c55e" fill="rgba(34,197,94,0.15)"  strokeWidth={1.5} dot={false} />
                      <Area type="monotone" dataKey="out" stroke="#3b82f6" fill="rgba(59,130,246,0.15)" strokeWidth={1.5} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                );
              })()}
            </div>

            {/* Endpoints */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>🖥️ {t('connected_endpoints')}</div>
              {portEndpoints === null && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('loading')}</div>
              )}
              {portEndpoints !== null && portEndpoints.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('no_endpoints_found')}
                </div>
              )}
              {portEndpoints !== null && portEndpoints.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: 'var(--text-muted)', textAlign: 'start' }}>
                      <th style={{ padding: '4px 8px', fontWeight: 500 }}>MAC</th>
                      <th style={{ padding: '4px 8px', fontWeight: 500 }}>IP</th>
                      <th style={{ padding: '4px 8px', fontWeight: 500 }}>{t('col_hostname')}</th>
                      <th style={{ padding: '4px 8px', fontWeight: 500 }}>{t('last_seen')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {portEndpoints.map((e, i) => {
                      const id_ = identifyMac(e.mac_address);
                      return (
                        <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '5px 8px', fontFamily: 'monospace', fontSize: 11, color: 'var(--text-secondary)' }}>
                            {e.mac_address}
                            {id_ && (
                              <span style={{
                                marginRight: 6, fontSize: 10, padding: '1px 5px', borderRadius: 4,
                                background: id_.type === 'vm' ? 'rgba(168,85,247,0.15)' : 'rgba(234,179,8,0.15)',
                                color: id_.type === 'vm' ? '#a855f7' : '#ca8a04',
                              }}>
                                {id_.type === 'vm' ? '🖥️' : '🔀'} {id_.vendor}
                              </span>
                            )}
                          </td>
                          <td style={{ padding: '5px 8px', fontFamily: 'monospace', color: e.ip_address ? 'var(--accent)' : 'var(--text-muted)' }}>
                            {e.ip_address || '—'}
                          </td>
                          <td style={{ padding: '5px 8px', color: e.hostname ? 'var(--text-primary)' : 'var(--text-muted)', fontSize: 11 }}>
                            {e.hostname || '—'}
                          </td>
                          <td style={{ padding: '5px 8px', color: 'var(--text-muted)', whiteSpace: 'nowrap', fontSize: 11 }}>
                            {e.last_seen ? new Date(e.last_seen * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Threshold Settings */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>⚙️ {t('port_threshold_title')}</div>

              {!portThresh && (
                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{t('loading')}</div>
              )}

              {portThresh && ['bandwidth_in', 'bandwidth_out'].map(metric => {
                const eff     = portThresh.effective[metric];
                const hasPort = portThresh.portOverrides?.[metric] != null;
                const editVal = threshEdit[metric] ?? '';
                const sourceLabel = { port: t('src_port'), device: t('src_device'), global: t('src_global') };

                return (
                  <div key={metric} style={{
                    marginBottom: 14, padding: '10px 12px', borderRadius: 8,
                    background: hasPort ? 'rgba(var(--accent-rgb,0,128,255),0.06)' : 'var(--bg-secondary)',
                    border: `1px solid ${hasPort ? 'var(--accent)' : 'var(--border)'}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>
                        {metric === 'bandwidth_in' ? `↓ ${t('metric_port_bandwidth_in')}` : `↑ ${t('metric_port_bandwidth_out')}`}
                      </span>
                      {eff && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {t('now_label')}: {eff.threshold_pct}% · {eff.duration_min} {t('minutes_short')} ({sourceLabel[eff.source] || eff.source})
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="number" min="1" max="100"
                        value={editVal}
                        onChange={e => setThreshEdit(prev => ({ ...prev, [metric]: e.target.value }))}
                        placeholder={eff ? String(eff.threshold_pct) : '80'}
                        style={{
                          flex: 1, minWidth: 60, padding: '5px 9px', borderRadius: 6,
                          border: '1px solid var(--border)', background: 'var(--bg-card)',
                          color: 'var(--text-primary)', fontSize: 13,
                        }}
                      />
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>%</span>
                      <input
                        type="number" min="0" max="1440" step="1"
                        value={durEdit[metric] ?? ''}
                        onChange={e => setDurEdit(prev => ({ ...prev, [metric]: e.target.value }))}
                        placeholder={eff ? String(eff.duration_min) : '5'}
                        title={t('port_duration_label')}
                        aria-label={t('port_duration_label')}
                        style={{
                          width: 64, padding: '5px 9px', borderRadius: 6,
                          border: '1px solid var(--border)', background: 'var(--bg-card)',
                          color: 'var(--text-primary)', fontSize: 13,
                        }}
                      />
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('minutes_short')}</span>
                      <button
                        onClick={() => savePortThreshold(metric)}
                        disabled={threshSaving || !editVal}
                        className="nm-btn nm-btn-primary"
                        style={{ padding: '5px 11px', fontSize: 12 }}
                      >
                        {t('save')}
                      </button>
                      {hasPort && (
                        <button
                          onClick={() => removePortThreshold(metric)}
                          disabled={threshSaving}
                          className="nm-btn nm-btn-ghost"
                          style={{ padding: '5px 9px', fontSize: 12, color: '#ef4444' }}
                          title={t('reset_override_title')}
                        >
                          ✕ {t('reset_override')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                {t('port_threshold_hint')}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
