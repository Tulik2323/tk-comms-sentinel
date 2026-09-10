// AlertsPage — לוג התראות + הגדרות סף לכל מכשיר
import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useDevices } from '../hooks/useDevices';
import Modal from '../components/ui/Modal';
import api from '../lib/api';

const METRICS = [
  { key: 'bandwidth_in',      label: 'תעבורה נכנסת כוללת (%)',  icon: '↓' },
  { key: 'bandwidth_out',     label: 'תעבורה יוצאת כוללת (%)', icon: '↑' },
  { key: 'port_bandwidth_in', label: 'פורט — תעבורה נכנסת (%)', icon: '↙' },
  { key: 'port_bandwidth_out',label: 'פורט — תעבורה יוצאת (%)', icon: '↗' },
  { key: 'cpu',               label: 'CPU (%)',                  icon: '⚡' },
  { key: 'mem',               label: 'זיכרון (%)',               icon: '💾' },
  { key: 'status',            label: 'סטטוס (DOWN)',             icon: '🔴' },
  { key: 'path',              label: 'נפילת נתיב',               icon: '🔌' },
];

function ThresholdModal({ open, onClose, onSaved, devices }) {
  const [deviceId,  setDeviceId]  = useState('');
  const [metric,    setMetric]    = useState('bandwidth_in');
  const [threshold, setThreshold] = useState(80);
  const [enabled,   setEnabled]   = useState(true);
  const [loading,   setLoading]   = useState(false);

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.put('/alerts/thresholds', {
        device_id:     deviceId || null,
        metric,
        threshold_pct: threshold,
        enabled,
      });
      onSaved();
      onClose();
    } catch (err) {
      alert(err.response?.data?.error || 'שגיאה');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="הגדר סף התראה">
      <form onSubmit={submit}>
        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>מכשיר (ריק = גלובלי לכל המכשירים)</label>
          <select className="nm-input" value={deviceId} onChange={e => setDeviceId(e.target.value)}>
            <option value="">גלובלי — כל המכשירים</option>
            {devices.map(d => (
              <option key={d.id} value={d.id}>{d.name || d.ip}</option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>מטריקה</label>
          <select className="nm-input" value={metric} onChange={e => setMetric(e.target.value)}>
            {METRICS.map(m => (
              <option key={m.key} value={m.key}>{m.icon} {m.label}</option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>סף ({threshold}%)</label>
          <input
            type="range" min={10} max={99} value={threshold}
            onChange={e => setThreshold(parseInt(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
            <span>10%</span><span style={{ fontWeight: 700 }}>{threshold}%</span><span>99%</span>
          </div>
        </div>
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox" id="enabled-cb" checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
          />
          <label htmlFor="enabled-cb" style={{ fontSize: 13 }}>מופעל</label>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="nm-btn nm-btn-ghost" onClick={onClose}>ביטול</button>
          <button type="submit" className="nm-btn nm-btn-primary" disabled={loading}>שמור</button>
        </div>
      </form>
    </Modal>
  );
}

export default function AlertsPage() {
  const { user }                = useAuth();
  const { devices }             = useDevices(0);
  const isAdmin                 = user?.role === 'admin';
  const navigate                = useNavigate();

  const [events,     setEvents]     = useState([]);
  const [thresholds, setThresholds] = useState([]);
  const [tab,        setTab]        = useState('events'); // events | thresholds
  const [modalOpen,  setModalOpen]  = useState(false);
  const [page,       setPage]       = useState(0);
  const [total,      setTotal]      = useState(0);
  const PER_PAGE = 25;

  function loadEvents(p = 0) {
    api.get(`/alerts/events?limit=${PER_PAGE}&offset=${p * PER_PAGE}`)
      .then(r => { setEvents(r.data.events); setTotal(r.data.total); })
      .catch(console.error);
  }

  function loadThresholds() {
    api.get('/alerts/thresholds')
      .then(r => setThresholds(r.data))
      .catch(console.error);
  }

  useEffect(() => {
    loadEvents();
    loadThresholds();
  }, []);

  useEffect(() => { loadEvents(page); }, [page]);

  async function deleteThreshold(id) {
    if (!window.confirm('מחק סף זה?')) return;
    await api.delete(`/alerts/thresholds/${id}`);
    loadThresholds();
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>🔔 התראות</h1>
        {isAdmin && tab === 'thresholds' && (
          <button onClick={() => setModalOpen(true)} className="nm-btn nm-btn-primary">
            + הוסף סף
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {[['events', 'לוג אירועים'], ['thresholds', 'הגדרות סף']].map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background:   'none',
              border:       'none',
              padding:      '8px 16px',
              cursor:       'pointer',
              fontSize:     13,
              color:        tab === t ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              fontWeight:   tab === t ? 700 : 400,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Events Tab */}
      {tab === 'events' && (
        <div>
          <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="nm-table">
              <thead>
                <tr>
                  <th>זמן</th>
                  <th>מכשיר</th>
                  <th>פרטים</th>
                  <th>ערך</th>
                  <th>סף</th>
                  <th>סטטוס</th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
                      אין התראות 🎉
                    </td>
                  </tr>
                ) : events.map(e => (
                  <tr
                    key={e.id}
                    onClick={() => e.device_id && navigate(`/devices/${e.device_id}`)}
                    style={{ cursor: e.device_id ? 'pointer' : 'default' }}
                    title={e.device_id ? 'לחץ לפתיחת פרטי מכשיר' : ''}
                  >
                    <td style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                      {new Date(e.sent_at * 1000).toLocaleString('he-IL')}
                    </td>
                    <td style={{ fontWeight: 600 }}>
                      {e.device_id ? (
                        <Link
                          to={`/devices/${e.device_id}`}
                          style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}
                        >
                          {e.device_name || e.device_ip}
                        </Link>
                      ) : '—'}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-primary)', maxWidth: 320 }}>
                      {e.message || (METRICS.find(m => m.key === e.metric)?.label || e.metric)}
                    </td>
                    <td style={{
                      fontFamily: 'monospace',
                      color: e.value > (e.threshold || 80) ? '#ef4444' : '#f97316',
                    }}>
                      {e.value?.toFixed(1)}%
                    </td>
                    <td style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                      {e.threshold}%
                    </td>
                    <td>
                      {e.resolved_at ? (
                        <span style={{ color: '#22c55e', fontSize: 12 }}>✅ נפתר</span>
                      ) : (
                        <span style={{ color: '#f97316', fontSize: 12 }}>⚠️ פתוח</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {total > PER_PAGE && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
              <button
                disabled={page === 0}
                onClick={() => setPage(p => p - 1)}
                className="nm-btn nm-btn-ghost"
              >
                ← הקודם
              </button>
              <span style={{ lineHeight: '36px', fontSize: 13, color: 'var(--text-muted)' }}>
                עמוד {page + 1} מתוך {Math.ceil(total / PER_PAGE)}
              </span>
              <button
                disabled={page >= Math.ceil(total / PER_PAGE) - 1}
                onClick={() => setPage(p => p + 1)}
                className="nm-btn nm-btn-ghost"
              >
                הבא →
              </button>
            </div>
          )}
        </div>
      )}

      {/* Thresholds Tab */}
      {tab === 'thresholds' && (
        <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="nm-table">
            <thead>
              <tr>
                <th>מכשיר</th>
                <th>מטריקה</th>
                <th>סף</th>
                <th>סטטוס</th>
                {isAdmin && <th>פעולות</th>}
              </tr>
            </thead>
            <tbody>
              {thresholds.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
                    אין הגדרות סף
                  </td>
                </tr>
              ) : thresholds.map(t => (
                <tr key={t.id}>
                  <td style={{ fontWeight: t.device_id ? 600 : 400, color: t.device_id ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {t.device_id ? (t.device_name || t.device_ip || `#${t.device_id}`) : '🌐 גלובלי'}
                  </td>
                  <td>{METRICS.find(m => m.key === t.metric)?.label || t.metric}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 60, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{
                          width: `${t.threshold_pct}%`, height: '100%', borderRadius: 2,
                          background: t.threshold_pct > 80 ? '#ef4444' : '#f97316',
                        }} />
                      </div>
                      <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{t.threshold_pct}%</span>
                    </div>
                  </td>
                  <td>
                    <span style={{ color: t.enabled ? '#22c55e' : '#64748b', fontSize: 12 }}>
                      {t.enabled ? '✅ מופעל' : '⏸ כבוי'}
                    </span>
                  </td>
                  {isAdmin && (
                    <td>
                      <button
                        className="nm-btn nm-btn-danger"
                        style={{ padding: '4px 10px', fontSize: 12 }}
                        onClick={() => deleteThreshold(t.id)}
                      >מחק</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ThresholdModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={loadThresholds}
        devices={devices}
      />
    </div>
  );
}

const lbl = { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 };
