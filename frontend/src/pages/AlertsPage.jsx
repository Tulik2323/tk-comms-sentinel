// AlertsPage — לוג התראות + הגדרות סף לכל מכשיר
import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import { useDevices } from '../hooks/useDevices';
import Modal from '../components/ui/Modal';
import { formatAlert } from '../lib/alertFormat';
import api from '../lib/api';

const METRIC_ICONS = {
  bandwidth_in: '↓', bandwidth_out: '↑',
  port_bandwidth_in: '↙', port_bandwidth_out: '↗',
  cpu: '⚡', mem: '💾', status: '🔴', path: '🔌',
};
const METRIC_KEYS = Object.keys(METRIC_ICONS);

// המטריקות שהמנוע באמת בודק — רק אותן אפשר להגדיר. שורות ישנות של מטריקות אחרות
// (שנשמרו בעבר ולא עשו כלום) עדיין מוצגות בטבלה, וניתן למחוק אותן.
const SETTABLE_METRICS = ['bandwidth_in', 'bandwidth_out', 'cpu', 'mem'];
const DEFAULT_DURATION_MIN = 5;

function useMetricList() {
  const { t } = useTranslation();
  return METRIC_KEYS.map(key => ({ key, icon: METRIC_ICONS[key], label: t(`metric_${key}`) }));
}

// initial: השורה שעורכים (או null להוספה). thresholds: כל השורות, למילוי אוטומטי
// כשהמכשיר והמטריקה שנבחרו כבר מוגדרים.
function ThresholdModal({ open, onClose, onSaved, devices, thresholds, initial }) {
  const { t } = useTranslation();
  const METRICS = useMetricList().filter(m => SETTABLE_METRICS.includes(m.key));
  const [deviceId,  setDeviceId]  = useState('');
  const [metric,    setMetric]    = useState('bandwidth_in');
  const [threshold, setThreshold] = useState(80);
  const [duration,  setDuration]  = useState(String(DEFAULT_DURATION_MIN));
  const [enabled,   setEnabled]   = useState(true);
  const [loading,   setLoading]   = useState(false);

  // שורת סף גלובלית או של מכשיר (לא של פורט) לפי מכשיר ומטריקה
  function findRow(devId, m) {
    return thresholds.find(x => x.scope !== 'port' && String(x.device_id ?? '') === String(devId) && x.metric === m);
  }

  function fillFrom(row) {
    setThreshold(row.threshold_pct);
    setDuration(String(row.duration_min ?? DEFAULT_DURATION_MIN));
    setEnabled(!!row.enabled);
  }

  // בכל פתיחה: ערכי השורה הנערכת, או השורה הקיימת של ברירת המחדל (גלובלי + תעבורה נכנסת)
  useEffect(() => {
    if (!open) return;
    const start = initial || findRow('', 'bandwidth_in');
    setDeviceId(initial?.device_id != null ? String(initial.device_id) : '');
    setMetric(initial?.metric || 'bandwidth_in');
    setThreshold(80);
    setDuration(String(DEFAULT_DURATION_MIN));
    setEnabled(true);
    if (start) fillFrom(start);
  }, [open, initial]);

  function pick(nextDevice, nextMetric) {
    setDeviceId(nextDevice);
    setMetric(nextMetric);
    const row = findRow(nextDevice, nextMetric);
    if (row) fillFrom(row);
  }

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.put('/alerts/thresholds', {
        device_id:     deviceId || null,
        metric,
        threshold_pct: threshold,
        duration_min:  Number(duration),
        enabled,
      });
      onSaved();
      onClose();
    } catch (err) {
      alert(err.response?.data?.error || t('error'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('set_threshold_title')}>
      <form onSubmit={submit}>
        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>{t('device_label')}</label>
          <select className="nm-input" value={deviceId} onChange={e => pick(e.target.value, metric)}>
            <option value="">{t('global_all_devices')}</option>
            {devices.map(d => (
              <option key={d.id} value={d.id}>{d.name || d.ip}</option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>{t('metric_label')}</label>
          <select className="nm-input" value={metric} onChange={e => pick(deviceId, e.target.value)}>
            {METRICS.map(m => (
              <option key={m.key} value={m.key}>{m.icon} {m.label}</option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>{t('threshold_label', { pct: threshold })}</label>
          <input
            type="range" min={10} max={99} value={threshold}
            onChange={e => setThreshold(parseInt(e.target.value))}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
            <span>10%</span><span style={{ fontWeight: 700 }}>{threshold}%</span><span>99%</span>
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={lbl} htmlFor="duration-in">{t('duration_label')}</label>
          <input
            id="duration-in" type="number" className="nm-input" required
            min={0} max={1440} step={1}
            value={duration} onChange={e => setDuration(e.target.value)}
          />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{t('duration_hint')}</div>
        </div>
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox" id="enabled-cb" checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
          />
          <label htmlFor="enabled-cb" style={{ fontSize: 13 }}>{t('enabled_label')}</label>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="nm-btn nm-btn-ghost" onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className="nm-btn nm-btn-primary" disabled={loading}>{t('save')}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function AlertsPage() {
  const { t }                   = useTranslation();
  const METRICS                 = useMetricList();
  const { user }                = useAuth();
  const { devices }             = useDevices(0);
  const isAdmin                 = user?.role === 'admin';
  const navigate                = useNavigate();

  const [events,     setEvents]     = useState([]);
  const [thresholds, setThresholds] = useState([]);
  const [tab,        setTab]        = useState('events'); // events | thresholds
  const [modalOpen,  setModalOpen]  = useState(false);
  const [editRow,    setEditRow]    = useState(null); // השורה שעורכים; null = הוספה
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

  function openModal(row) {
    setEditRow(row || null);
    setModalOpen(true);
  }

  async function deleteThreshold(th) {
    if (!window.confirm(t('delete_threshold_confirm'))) return;
    try {
      // סף פורט נמחק דרך המכשיר שלו, כי ה-id שלו שייך לטבלה נפרדת
      if (th.scope === 'port') {
        await api.delete(`/devices/${th.device_id}/port-threshold/${th.port_if_index}/${th.metric}`);
      } else {
        await api.delete(`/alerts/thresholds/${th.id}`);
      }
    } catch (err) {
      alert(err.response?.data?.error || t('error'));
    }
    loadThresholds();
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>🔔 {t('alerts')}</h1>
        {isAdmin && tab === 'thresholds' && (
          <button onClick={() => openModal(null)} className="nm-btn nm-btn-primary">
            + {t('add_threshold')}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {[['events', t('event_log')], ['thresholds', t('threshold_settings')]].map(([tabId, label]) => (
          <button
            key={tabId}
            onClick={() => setTab(tabId)}
            style={{
              background:   'none',
              border:       'none',
              padding:      '8px 16px',
              cursor:       'pointer',
              fontSize:     13,
              color:        tab === tabId ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: tab === tabId ? '2px solid var(--accent)' : '2px solid transparent',
              fontWeight:   tab === tabId ? 700 : 400,
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
                  <th>{t('col_time')}</th>
                  <th>{t('col_device')}</th>
                  <th>{t('col_details')}</th>
                  <th>{t('col_value')}</th>
                  <th>{t('col_threshold')}</th>
                  <th>{t('status')}</th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
                      {t('no_alerts_msg')}
                    </td>
                  </tr>
                ) : events.map(e => (
                  <tr
                    key={e.id}
                    onClick={() => e.device_id && navigate(`/devices/${e.device_id}`)}
                    style={{ cursor: e.device_id ? 'pointer' : 'default' }}
                  >
                    <td style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                      {new Date(e.sent_at * 1000).toLocaleString()}
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
                      {formatAlert(e, t)}
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
                        <span style={{ color: '#22c55e', fontSize: 12 }}>✅ {t('resolved')}</span>
                      ) : (
                        <span style={{ color: '#f97316', fontSize: 12 }}>⚠️ {t('alert_open')}</span>
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
                ← {t('prev_page')}
              </button>
              <span style={{ lineHeight: '36px', fontSize: 13, color: 'var(--text-muted)' }}>
                {t('page_of', { page: page + 1, total: Math.ceil(total / PER_PAGE) })}
              </span>
              <button
                disabled={page >= Math.ceil(total / PER_PAGE) - 1}
                onClick={() => setPage(p => p + 1)}
                className="nm-btn nm-btn-ghost"
              >
                {t('next_page')} →
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
                <th>{t('col_device')}</th>
                <th>{t('col_metric')}</th>
                <th>{t('col_threshold')}</th>
                <th>{t('col_duration')}</th>
                <th>{t('status')}</th>
                {isAdmin && <th>{t('col_actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {thresholds.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
                    {t('no_thresholds')}
                  </td>
                </tr>
              ) : thresholds.map(th => (
                <tr key={`${th.scope}-${th.id}`}>
                  <td style={{ fontWeight: th.device_id ? 600 : 400, color: th.device_id ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {th.device_id
                      ? `${th.device_name || th.device_ip || `#${th.device_id}`}${th.scope === 'port' ? ` · ${th.port_label || `${t('port_label')} ${th.port_if_index}`}` : ''}`
                      : `🌐 ${t('global_label')}`}
                  </td>
                  <td>
                    {th.scope === 'port'
                      ? t(`metric_port_${th.metric}`)   // סף פורט בודד, לא סך המכשיר
                      : (METRICS.find(m => m.key === th.metric)?.label || th.metric)}
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 60, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{
                          width: `${th.threshold_pct}%`, height: '100%', borderRadius: 2,
                          background: th.threshold_pct > 80 ? '#ef4444' : '#f97316',
                        }} />
                      </div>
                      <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{th.threshold_pct}%</span>
                    </div>
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {th.duration_min == null && th.scope === 'port'
                      ? <span style={{ color: 'var(--text-muted)' }}>{t('duration_inherited')}</span>
                      : `${th.duration_min ?? DEFAULT_DURATION_MIN} ${t('minutes_short')}`}
                  </td>
                  <td>
                    <span style={{ color: th.enabled ? '#22c55e' : '#64748b', fontSize: 12 }}>
                      {th.enabled ? `✅ ${t('threshold_enabled')}` : `⏸ ${t('threshold_disabled')}`}
                    </span>
                  </td>
                  {isAdmin && (
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {th.scope !== 'port' && (
                        <button
                          className="nm-btn nm-btn-ghost"
                          style={{ padding: '4px 10px', fontSize: 12, marginInlineEnd: 6 }}
                          onClick={() => openModal(th)}
                        >{t('edit_btn')}</button>
                      )}
                      <button
                        className="nm-btn nm-btn-danger"
                        style={{ padding: '4px 10px', fontSize: 12 }}
                        onClick={() => deleteThreshold(th)}
                      >{t('delete_btn')}</button>
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
        thresholds={thresholds}
        initial={editRow}
      />
    </div>
  );
}

const lbl = { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 };
