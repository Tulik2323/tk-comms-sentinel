// UptimeWidgets — שלושת ה-widgets של ה-Dashboard שנשענים על היסטוריית ה-poller:
// היסטוריית נפילות, יומן uptime לכל מכשיר, והסוויצ'ים הכי חמים.
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import StatusDot from '../ui/StatusDot';
import Modal from '../ui/Modal';

const REFRESH_MS = 60_000;

// טוען נתון מה-API ומרענן אותו כל דקה. שגיאה זמנית משאירה את הנתון הקודם על המסך.
function useLive(url) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!url) { setData(null); return undefined; }   // חלון סגור: אין מה לטעון
    let alive = true;
    const load = () => api.get(url)
      .then(r => { if (alive) { setData(r.data); setFailed(false); } })
      .catch(() => { if (alive) setFailed(true); });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [url]);
  return { data, failed };
}

// שתי היחידות הגדולות ביותר: "3 ימים 4 שעות" / "12 שעות 5 דק׳" / "7 דק׳"
function useDuration() {
  const { t } = useTranslation();
  return (sec) => {
    if (sec == null || !Number.isFinite(sec)) return '—';
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return h > 0 ? `${t('dur_days', { n: d })} ${t('dur_hours', { n: h })}` : t('dur_days', { n: d });
    if (h > 0) return m > 0 ? `${t('dur_hours', { n: h })} ${t('dur_min', { n: m })}` : t('dur_hours', { n: h });
    if (m > 0) return t('dur_min', { n: m });
    return t('dur_sec', { n: sec });
  };
}

const fmtTime = (sec) => sec ? new Date(sec * 1000).toLocaleString() : '—';
const fmtDate = (sec) => sec ? new Date(sec * 1000).toLocaleDateString() : '—';

const cardTitle = { margin: 0, fontSize: 14 };
const muted     = { color: 'var(--text-muted)' };
const note      = { fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 };

// ---------------------------------------------------------------------------
// היסטוריית נפילות
// ---------------------------------------------------------------------------
const RANGES = ['24h', '7d', '30d'];

export function OutagesWidget() {
  const { t } = useTranslation();
  const dur = useDuration();
  const [range, setRange] = useState('7d');
  const { data } = useLive(`/dashboard/outages?range=${range}`);

  return (
    <div className="nm-card" style={{ height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
        <h2 style={cardTitle}>📉 {t('outages_title')}</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map(r => (
            <button key={r}
              className={`nm-btn ${range === r ? 'nm-btn-primary' : 'nm-btn-ghost'}`}
              style={{ fontSize: 11, padding: '3px 9px' }}
              onClick={() => setRange(r)}>
              {t(`outages_range_${r}`)}
            </button>
          ))}
        </div>
      </div>

      {!data ? (
        <div style={{ ...muted, fontSize: 13, textAlign: 'center', padding: 20 }}>{t('loading')}</div>
      ) : data.events.length === 0 ? (
        <div style={{ color: '#4ade80', fontSize: 13, textAlign: 'center', padding: 20 }}>{t('outages_none')}</div>
      ) : (
        <>
          <div style={{ fontSize: 12, ...muted, marginBottom: 8 }}>
            {t('outages_summary', { events: data.summary.events, devices: data.summary.devices_affected })}
          </div>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table className="nm-table">
              <thead>
                <tr>
                  <th>{t('outage_col_device')}</th>
                  <th>{t('outage_col_fell')}</th>
                  <th>{t('outage_col_back')}</th>
                  <th>{t('outage_col_duration')}</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e, i) => (
                  <tr key={`${e.kind}-${e.device_id || 'p'}-${e.started_at}-${i}`}
                      style={e.kind === 'path' ? { background: 'rgba(251,191,36,0.08)' } : undefined}>
                    <td style={{ fontSize: 12 }}>
                      {e.kind === 'path' ? (
                        <span title={e.devices.map(d => d.name).join('\n')}>
                          <b style={{ color: '#fbbf24' }}>🌐 {t('outage_path')}</b>
                          <div style={{ fontSize: 11, ...muted, maxWidth: 220 }}>{t('outage_path_desc', { count: e.device_count })}</div>
                        </span>
                      ) : (
                        <Link to={`/devices/${e.device_id}`} style={{ color: 'var(--text-primary)', textDecoration: 'none' }}>
                          {e.name}
                          <div style={{ fontSize: 11, ...muted }}>{e.ip}</div>
                        </Link>
                      )}
                    </td>
                    <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{fmtTime(e.started_at)}</td>
                    <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                      {e.ongoing
                        ? <span style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', padding: '2px 7px', borderRadius: 10, fontWeight: 600 }}>{t('outage_still_down')}</span>
                        : fmtTime(e.ended_at)}
                    </td>
                    <td style={{ fontSize: 11, fontFamily: 'monospace' }}>{dur(e.duration_sec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {data && <div style={note}>{t('outages_since_note', { date: fmtDate(data.tracking_since) })}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// יומן uptime לכל מכשיר
// ---------------------------------------------------------------------------
function availColor(p) {
  if (p == null) return 'var(--text-muted)';
  if (p >= 99.9) return '#22c55e';
  if (p >= 99)   return '#f59e0b';
  return '#ef4444';
}

function Avail({ pct }) {
  return <span style={{ color: availColor(pct), fontWeight: 600 }}>{pct == null ? '—' : `${pct.toFixed(pct >= 99.99 ? 0 : 2)}%`}</span>;
}

function DeviceLogModal({ deviceId, onClose }) {
  const { t } = useTranslation();
  const dur = useDuration();
  const { data } = useLive(deviceId ? `/dashboard/uptime/${deviceId}` : null);
  const open = deviceId != null;
  const ready = data && data.device.id === deviceId;

  return (
    <Modal open={open} onClose={onClose} width={640}
      title={ready ? t('uptime_log_title', { name: data.device.name }) : t('loading')}>
      {ready && (
        <>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 14, fontSize: 13 }}>
            <div><div style={{ ...muted, fontSize: 11 }}>{t('uptime_col_running')}</div><b>{dur(data.uptime_sec)}</b></div>
            <div><div style={{ ...muted, fontSize: 11 }}>{t('uptime_col_booted')}</div><b>{fmtTime(data.booted_at)}</b></div>
            <div><div style={{ ...muted, fontSize: 11 }}>{t('uptime_col_7d')}</div><Avail pct={data.avail_7d} /></div>
            <div><div style={{ ...muted, fontSize: 11 }}>{t('uptime_col_30d')}</div><Avail pct={data.avail_30d} /></div>
          </div>
          {data.events.length === 0 ? (
            <div style={{ ...muted, fontSize: 13, textAlign: 'center', padding: 20 }}>{t('uptime_log_empty')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.events.map((e, i) => (
                <div key={`${e.type}-${e.at}-${i}`} style={{
                  padding: '8px 12px', borderRadius: 6, fontSize: 12,
                  background: e.type === 'reboot' ? 'rgba(59,130,246,0.08)' : e.path ? 'rgba(251,191,36,0.08)' : 'rgba(239,68,68,0.08)',
                  border: `1px solid ${e.type === 'reboot' ? 'rgba(59,130,246,0.25)' : e.path ? 'rgba(251,191,36,0.3)' : 'rgba(239,68,68,0.25)'}`,
                }}>
                  {e.type === 'reboot' ? (
                    <>
                      <b>🔄 {t('uptime_log_reboot')}</b> · {fmtTime(e.at)}
                      <div style={{ ...muted, fontSize: 11 }}>{t('uptime_log_reboot_desc', { prev: dur(e.prev_uptime_sec) })}</div>
                    </>
                  ) : (
                    <>
                      <b>{e.path ? `🌐 ${t('outage_path')}` : `⛔ ${t('uptime_log_outage')}`}</b> · {fmtTime(e.at)}
                      <div style={{ ...muted, fontSize: 11 }}>
                        {e.ongoing ? t('outage_still_down') : `${t('outage_col_back')}: ${fmtTime(e.ended_at)}`} · {dur(e.duration_sec)}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 14, textAlign: 'center' }}>
            <Link to={`/devices/${data.device.id}`} style={{ fontSize: 12, color: 'var(--accent)' }}>{t('uptime_log_open')} ←</Link>
          </div>
          <div style={note}>{t('uptime_avail_note', { date: fmtDate(data.tracking_since) })}</div>
        </>
      )}
    </Modal>
  );
}

// עמודות הטבלה וערך המיון של כל אחת. null תמיד יורד לסוף.
const COLUMNS = [
  { key: 'name',        label: 'col_name',            val: d => (d.name || '').toLowerCase() },
  { key: 'uptime_sec',  label: 'uptime_col_running',  val: d => d.uptime_sec },
  { key: 'booted_at',   label: 'uptime_col_booted',   val: d => d.booted_at },
  { key: 'avail_7d',    label: 'uptime_col_7d',       val: d => d.avail_7d },
  { key: 'avail_30d',   label: 'uptime_col_30d',      val: d => d.avail_30d },
  { key: 'outages_30d', label: 'uptime_col_outages',  val: d => d.outages_30d },
  { key: 'reboots_30d', label: 'uptime_col_reboots',  val: d => d.reboots_30d },
];

export function UptimeWidget() {
  const { t } = useTranslation();
  const dur = useDuration();
  const { data } = useLive('/dashboard/uptime');
  const [query, setQuery] = useState('');
  const [sort, setSort]   = useState({ key: 'uptime_sec', dir: 1 });   // ברירת מחדל: מי שאותחל לאחרונה למעלה
  const [openId, setOpenId] = useState(null);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const col = COLUMNS.find(c => c.key === sort.key);
    return data.devices
      .filter(d => !q || d.name.toLowerCase().includes(q) || d.ip.includes(q))
      .sort((a, b) => {
        const x = col.val(a), y = col.val(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
      });
  }, [data, query, sort]);

  const toggleSort = (key) => setSort(s => s.key === key ? { key, dir: -s.dir } : { key, dir: 1 });

  return (
    <div className="nm-card" style={{ height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
        <h2 style={cardTitle}>⏱ {t('uptime_title')}{data ? ` (${data.devices.length})` : ''}</h2>
        <input className="nm-input" style={{ maxWidth: 200, fontSize: 12 }}
          placeholder={t('uptime_search')} value={query} onChange={e => setQuery(e.target.value)} />
      </div>

      {!data ? (
        <div style={{ ...muted, fontSize: 13, textAlign: 'center', padding: 20 }}>{t('loading')}</div>
      ) : (
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table className="nm-table">
            <thead>
              <tr>
                {COLUMNS.map(c => (
                  <th key={c.key} onClick={() => toggleSort(c.key)} style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    {t(c.label)}{sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(d => (
                <tr key={d.id} style={{ cursor: 'pointer' }} onClick={() => setOpenId(d.id)}>
                  <td style={{ fontSize: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <StatusDot status={d.status} />
                      <span style={{ color: 'var(--text-primary)' }}>{d.name}</span>
                    </div>
                  </td>
                  <td style={{ fontSize: 11, fontFamily: 'monospace' }}>
                    {d.status === 'down'
                      ? <span style={{ color: '#f87171', fontWeight: 600 }}>{t('uptime_down_now')}</span>
                      : dur(d.uptime_sec)}
                  </td>
                  <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{fmtTime(d.booted_at)}</td>
                  <td style={{ fontSize: 11 }}><Avail pct={d.avail_7d} /></td>
                  <td style={{ fontSize: 11 }}><Avail pct={d.avail_30d} /></td>
                  <td style={{ fontSize: 11, color: d.outages_30d > 0 ? '#f87171' : 'var(--text-muted)' }}>{d.outages_30d}</td>
                  <td style={{ fontSize: 11, color: d.reboots_30d > 0 ? '#fb923c' : 'var(--text-muted)' }}>{d.reboots_30d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <div style={note}>{t('uptime_avail_note', { date: fmtDate(data.tracking_since) })}</div>}
      <DeviceLogModal deviceId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// הסוויצ'ים הכי חמים
// ---------------------------------------------------------------------------
export function HottestWidget() {
  const { t } = useTranslation();
  const { data } = useLive('/dashboard/hottest?limit=10');

  const color = (c) => c > data.crit ? '#ef4444' : c > data.warn ? '#f97316' : '#3b82f6';
  const hottest = data && data.items.length ? Math.max(data.crit, data.items[0].celsius) : 0;

  return (
    <div className="nm-card" style={{ height: '100%' }}>
      <h2 style={{ ...cardTitle, marginBottom: 14 }}>🌡 {t('hottest_title')}</h2>

      {!data ? (
        <div style={{ ...muted, fontSize: 13, textAlign: 'center', padding: 20 }}>{t('loading')}</div>
      ) : data.items.length === 0 ? (
        <div style={{ ...muted, fontSize: 13, textAlign: 'center', padding: 20 }}>{t('hottest_none')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {data.items.map(d => (
            <Link key={d.id} to={`/devices/${d.id}`} style={{ textDecoration: 'none' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                  {d.name} <span style={{ ...muted, fontSize: 11 }}>{d.ip}</span>
                </span>
                <span style={{ fontSize: 12, fontWeight: 700, color: color(d.celsius) }}
                      title={t('hottest_sensors', { count: d.sensors })}>
                  {Number.isInteger(d.celsius) ? d.celsius : d.celsius.toFixed(1)}°C
                </span>
              </div>
              <div style={{ height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  width: '100%', height: '100%', background: color(d.celsius), borderRadius: 3,
                  transform: `scaleX(${Math.min(1, d.celsius / hottest)})`, transformOrigin: 'right center',
                }} />
              </div>
            </Link>
          ))}
        </div>
      )}

      {data && (
        <>
          <div style={note}>{t('hottest_legend', { warn: data.warn, crit: data.crit })}</div>
          {data.no_data > 0 && (
            <div style={{ ...note, marginTop: 4, cursor: 'help' }}
                 title={data.no_data_devices.map(d => `${d.name} (${d.model || d.ip})`).join('\n')}>
              ⚠ {t('hottest_no_data', { count: data.no_data })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
