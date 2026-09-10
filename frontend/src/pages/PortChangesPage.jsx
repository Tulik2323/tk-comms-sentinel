// PortChangesPage — יומן שינויי פורטים גלובלי עם בוחר מכשיר בצד
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import api from '../lib/api';
import StatusDot from '../components/ui/StatusDot';

const ATTR_LABELS = {
  if_alias:     'תיאור פורט',
  admin_status: 'סטטוס Admin',
  if_speed:     'מהירות',
  pvid:         'VLAN',
};

const ATTR_COLORS = {
  admin_status: { up: '#22c55e', down: '#ef4444' },
  pvid:         '#a78bfa',
  if_speed:     '#60a5fa',
  if_alias:     'var(--text-secondary)',
};

function fmtVal(attr, v) {
  if (v == null) return '—';
  if (attr === 'if_speed') {
    const n = Number(v);
    if (!n) return v;
    if (n >= 1e9) return `${n / 1e9} Gbps`;
    if (n >= 1e6) return `${n / 1e6} Mbps`;
    return `${n} bps`;
  }
  return v;
}

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleString('he-IL', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtAgo(ts) {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60)   return `לפני ${diff}ש'`;
  if (diff < 3600) return `לפני ${Math.floor(diff / 60)} דק'`;
  if (diff < 86400) return `לפני ${Math.floor(diff / 3600)} שע'`;
  return `לפני ${Math.floor(diff / 86400)} ימים`;
}

export default function PortChangesPage() {
  const [devices,      setDevices]      = useState([]);
  const [selectedId,   setSelectedId]   = useState('all');
  const [changes,      setChanges]      = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [attrFilter,   setAttrFilter]   = useState('all');
  const [devSearch,    setDevSearch]    = useState('');
  const [autoRefresh,  setAutoRefresh]  = useState(true);

  // טען רשימת מכשירים עם שינויים
  useEffect(() => {
    api.get('/port-changes/devices').then(r => setDevices(r.data)).catch(() => {});
  }, []);

  // טען שינויים עבור המכשיר הנבחר
  const loadChanges = useCallback(() => {
    setLoading(true);
    const params = { limit: 500 };
    if (selectedId !== 'all') params.device_id = selectedId;
    if (attrFilter !== 'all') params.attr = attrFilter;
    api.get('/port-changes', { params })
      .then(r => setChanges(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedId, attrFilter]);

  useEffect(() => { loadChanges(); }, [loadChanges]);

  // auto-refresh כל 30 שניות
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(loadChanges, 30_000);
    return () => clearInterval(t);
  }, [autoRefresh, loadChanges]);

  const filteredDevices = devices.filter(d =>
    devSearch.length < 2 ||
    d.name?.toLowerCase().includes(devSearch.toLowerCase()) ||
    d.ip?.includes(devSearch)
  );

  const selected = selectedId === 'all' ? null : devices.find(d => String(d.id) === String(selectedId));

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 'calc(100vh - 0px)' }}>

      {/* פאנל שמאל — בוחר מכשיר */}
      <aside style={{
        width: 240, flexShrink: 0, borderLeft: '1px solid var(--border)',
        background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column',
        overflowY: 'auto',
      }}>
        <div style={{ padding: '16px 12px 8px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>
            📋 יומן שינויי פורטים
          </div>
          <input
            type="text"
            placeholder="סנן מכשיר..."
            value={devSearch}
            onChange={e => setDevSearch(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '6px 8px',
              background: 'var(--bg-hover)', border: '1px solid var(--border)',
              borderRadius: 6, fontSize: 12, color: 'var(--text-primary)',
            }}
          />
        </div>

        {/* כל המכשירים */}
        <button
          onClick={() => setSelectedId('all')}
          style={{
            width: '100%', padding: '10px 14px', border: 'none', cursor: 'pointer',
            background: selectedId === 'all' ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'transparent',
            borderBottom: '1px solid var(--border)', textAlign: 'right',
            color: selectedId === 'all' ? 'var(--accent)' : 'var(--text-secondary)',
            fontSize: 13, fontWeight: selectedId === 'all' ? 700 : 400,
            borderRight: selectedId === 'all' ? '3px solid var(--accent)' : '3px solid transparent',
          }}
        >
          🌐 כל המכשירים
          <span style={{
            float: 'left', fontSize: 11,
            background: 'var(--bg-hover)', padding: '1px 6px', borderRadius: 10,
            color: 'var(--text-muted)',
          }}>
            {devices.reduce((s, d) => s + (d.change_count || 0), 0)}
          </span>
        </button>

        {/* רשימת מכשירים */}
        {filteredDevices.map(d => (
          <button
            key={d.id}
            onClick={() => setSelectedId(String(d.id))}
            style={{
              width: '100%', padding: '10px 14px', border: 'none', cursor: 'pointer',
              background: String(selectedId) === String(d.id)
                ? 'color-mix(in srgb, var(--accent) 15%, transparent)'
                : 'transparent',
              borderBottom: '1px solid var(--border)', textAlign: 'right',
              color: String(selectedId) === String(d.id) ? 'var(--accent)' : 'var(--text-secondary)',
              fontSize: 12,
              borderRight: String(selectedId) === String(d.id) ? '3px solid var(--accent)' : '3px solid transparent',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <StatusDot status={d.status} size={7} />
              <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {d.name}
              </span>
              <span style={{
                fontSize: 11, background: 'var(--bg-hover)', padding: '1px 5px',
                borderRadius: 10, color: 'var(--text-muted)', flexShrink: 0,
              }}>
                {d.change_count}
              </span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, paddingRight: 13 }}>
              {d.ip} · {fmtAgo(d.last_change)}
            </div>
          </button>
        ))}

        {filteredDevices.length === 0 && (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
            אין מכשירים עם שינויים
          </div>
        )}
      </aside>

      {/* תוכן ראשי */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* כותרת + פילטרים */}
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          background: 'var(--bg-secondary)',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              {selected
                ? <><Link to={`/devices/${selected.id}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>🖧 {selected.name}</Link> — שינויי פורטים</>
                : '🌐 כל השינויים'}
            </div>
            {selected && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{selected.ip}</div>
            )}
          </div>

          {/* פילטר סוג שינוי */}
          <select
            value={attrFilter}
            onChange={e => setAttrFilter(e.target.value)}
            style={{
              padding: '5px 10px', borderRadius: 6, fontSize: 12,
              background: 'var(--bg-hover)', border: '1px solid var(--border)',
              color: 'var(--text-primary)',
            }}
          >
            <option value="all">כל הסוגים</option>
            {Object.entries(ATTR_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>

          {/* Auto-refresh */}
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
            />
            רענון אוטומטי
          </label>

          <button
            onClick={loadChanges}
            disabled={loading}
            style={{
              padding: '5px 12px', borderRadius: 6, fontSize: 12,
              background: 'var(--bg-hover)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', cursor: 'pointer',
            }}
          >
            {loading ? '⏳' : '🔄'} רענן
          </button>
        </div>

        {/* טבלת שינויים */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0' }}>
          {loading && changes.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>טוען...</div>
          ) : changes.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
              אין שינויים ב-14 הימים האחרונים
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{
                  position: 'sticky', top: 0, background: 'var(--bg-secondary)',
                  zIndex: 10, borderBottom: '2px solid var(--border)',
                }}>
                  {selectedId === 'all' && (
                    <th style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>מכשיר</th>
                  )}
                  <th style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>זמן</th>
                  <th style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11 }}>פורט</th>
                  <th style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11 }}>שינוי</th>
                  <th style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11 }}>מ</th>
                  <th style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11 }}>אל</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c, i) => (
                  <tr
                    key={c.id}
                    style={{
                      borderBottom: '1px solid var(--border)',
                      background: i % 2 === 0 ? 'transparent' : 'color-mix(in srgb, var(--bg-hover) 40%, transparent)',
                    }}
                  >
                    {selectedId === 'all' && (
                      <td style={{ padding: '9px 16px', whiteSpace: 'nowrap' }}>
                        <Link
                          to={`/devices/${c.device_id}`}
                          style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 12, fontWeight: 600 }}
                        >
                          {c.device_name}
                        </Link>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{c.device_ip}</div>
                      </td>
                    )}
                    <td style={{ padding: '9px 16px', whiteSpace: 'nowrap' }}>
                      <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>{fmtTime(c.changed_at)}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmtAgo(c.changed_at)}</div>
                    </td>
                    <td style={{ padding: '9px 16px', whiteSpace: 'nowrap' }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{c.if_name || `#${c.if_index}`}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>if_index {c.if_index}</div>
                    </td>
                    <td style={{ padding: '9px 16px' }}>
                      <span style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 12,
                        background: 'var(--bg-hover)', color: 'var(--text-secondary)',
                      }}>
                        {ATTR_LABELS[c.attribute] || c.attribute}
                      </span>
                    </td>
                    <td style={{ padding: '9px 16px', fontFamily: 'monospace', fontSize: 12, color: '#ef4444' }}>
                      {fmtVal(c.attribute, c.old_value)}
                    </td>
                    <td style={{ padding: '9px 16px', fontFamily: 'monospace', fontSize: 12, color: '#22c55e' }}>
                      {fmtVal(c.attribute, c.new_value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ padding: '8px 20px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)' }}>
          {changes.length} שינויים · שמירה ל-14 ימים · {autoRefresh ? 'מתרענן כל 30 שניות' : 'רענון ידני'}
        </div>
      </div>
    </div>
  );
}
