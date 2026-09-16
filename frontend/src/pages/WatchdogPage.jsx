// WatchdogPage — ניטור שינויי פורטים בזמן אמת
// מוציא מה-DevicesPage Modal לדף עצמאי נקי.
// מציג רק פורטים שהשתנו, לפי סדר הזמן — לא את כל הפורטים.
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../lib/i18n';
import { useDevices } from '../hooks/useDevices';

const POLL_MS   = 3000;
const MAX_ITEMS = 100;

function beep(kind) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const play = (freq, at, dur) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + dur + 0.02);
    };
    if (kind === 'down') { play(392, 0, 0.18); play(294, 0.22, 0.28); }
    else                 { play(784, 0, 0.22); }
  } catch (_) {}
}

function sendNotification(c) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(
        c.curr === 'down'
          ? `🔴 ${i18n.t('notif_port_down')}`
          : `🟢 ${i18n.t('notif_port_up')}`,
        { body: `${c.devName}\n${c.if_name}`, tag: `${c.deviceId}_${c.if_index}` }
      );
      setTimeout(() => { try { n.close(); } catch (_) {} }, 8000);
    }
  } catch (_) {}
}

async function fetchLiveStatus(id, token) {
  const r = await fetch(`/api/devices/${id}/ports/live-status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return [];
  return r.json();
}

function buildIndex(portsArr) {
  const idx = {};
  for (const p of portsArr) idx[p.if_index] = p.oper_status;
  return idx;
}

export default function WatchdogPage() {
  const { t }                   = useTranslation();
  const { devices }             = useDevices();
  const upDevices               = devices.filter(d => d.status === 'up');

  const [devSearch, setDevSearch]     = useState('');
  const [selected,  setSelected]      = useState(new Set());
  const [running,   setRunning]       = useState(false);
  const [changes,   setChanges]       = useState([]);   // [{id, ts, devName, if_name, prev, curr}]
  const [notifyOk,  setNotifyOk]      = useState(false);
  const [error,     setError]         = useState('');

  const intervalRef = useRef(null);
  const inFlightRef = useRef(false);
  const prevRef     = useRef({});      // { deviceId: { if_index: oper_status } }

  const token = localStorage.getItem('nm_token');

  function toggleDevice(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function start() {
    setError('');
    if (selected.size === 0) { setError(t('select_switch_first')); return; }

    // בקש הרשאת התראות
    try {
      if ('Notification' in window) {
        if (Notification.permission === 'granted') setNotifyOk(true);
        else if (Notification.permission === 'default') {
          const p = await Notification.requestPermission();
          setNotifyOk(p === 'granted');
        }
      }
    } catch (_) {}

    // Baseline snapshot
    const ids    = [...selected];
    const devMap = Object.fromEntries(devices.map(d => [String(d.id), d]));
    const base   = {};
    await Promise.all(ids.map(async id => {
      const ports = await fetchLiveStatus(id, token).catch(() => []);
      base[id]    = buildIndex(ports);
    }));
    prevRef.current = base;
    setChanges([]);
    setRunning(true);

    inFlightRef.current = false;
    intervalRef.current = setInterval(async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const fresh = [];
        await Promise.all(ids.map(async id => {
          const ports   = await fetchLiveStatus(id, token).catch(() => []);
          const currIdx = buildIndex(ports);
          const prevIdx = prevRef.current[id] || {};
          const dev     = devMap[String(id)];
          const ts      = new Date().toLocaleTimeString('he-IL');
          for (const [ifIdx, status] of Object.entries(currIdx)) {
            const prev = prevIdx[ifIdx];
            if (prev && prev !== status) {
              const portInfo = ports.find(p => String(p.if_index) === String(ifIdx));
              const c = {
                id:       `${id}_${ifIdx}_${Date.now()}`,
                deviceId: id,
                devName:  dev?.name || dev?.ip || id,
                if_index: ifIdx,
                if_name:  portInfo?.if_name || portInfo?.if_descr || `Port ${ifIdx}`,
                prev, curr: status, ts,
              };
              fresh.push(c);
              beep(status === 'down' ? 'down' : 'up');
              sendNotification(c);
            }
          }
          prevRef.current[id] = currIdx;
        }));
        if (fresh.length > 0) {
          setChanges(prev => [...fresh, ...prev].slice(0, MAX_ITEMS));
        }
      } finally {
        inFlightRef.current = false;
      }
    }, POLL_MS);
  }

  function stop() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    prevRef.current = {};
    setRunning(false);
  }

  // ניקוי בעת עזיבת הדף
  useEffect(() => () => stop(), []);   // eslint-disable-line react-hooks/exhaustive-deps

  const filteredDevices = (() => {
    const q = devSearch.trim().toLowerCase();
    return q
      ? upDevices.filter(d =>
          (d.name || '').toLowerCase().includes(q) ||
          (d.ip   || '').includes(q))
      : upDevices;
  })();

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>

      {/* ── Left panel — device selector ──────────────────────────────── */}
      <aside style={{
        width: 260, minWidth: 220, flexShrink: 0,
        borderInlineEnd: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        padding: '16px 12px',
        background: 'var(--bg-card)',
      }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12, color: 'var(--text-primary)' }}>
          🔌 Port Watchdog
        </div>

        <input
          className="nm-input"
          placeholder={`🔎 ${t('search_switch')}`}
          value={devSearch}
          onChange={e => setDevSearch(e.target.value)}
          style={{ fontSize: 12, marginBottom: 8 }}
        />

        <div style={{ flex: 1, overflowY: 'auto', marginBottom: 12 }}>
          {filteredDevices.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 8, textAlign: 'center' }}>
              {t('no_active_switches')}
            </div>
          )}
          {filteredDevices.map(d => {
            const id  = String(d.id);
            const sel = selected.has(id);
            return (
              <label
                key={id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 8px', borderRadius: 6, cursor: 'pointer',
                  background: sel ? 'rgba(59,130,246,0.12)' : 'transparent',
                  marginBottom: 2,
                }}
              >
                <input
                  type="checkbox"
                  checked={sel}
                  disabled={running}
                  onChange={() => toggleDevice(id)}
                  style={{ accentColor: '#3b82f6' }}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {d.name || d.ip}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{d.ip}</div>
                </div>
              </label>
            );
          })}
        </div>

        {/* Controls */}
        {error && (
          <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 8 }}>{error}</div>
        )}

        {!running ? (
          <button
            className="nm-btn"
            onClick={start}
            disabled={selected.size === 0}
            style={{
              width: '100%', justifyContent: 'center',
              background: selected.size > 0 ? '#3b82f6' : undefined,
              color:      selected.size > 0 ? '#fff'    : undefined,
              opacity:    selected.size > 0 ? 1 : 0.5,
            }}
          >
            ▶ {t('start_monitoring')}
          </button>
        ) : (
          <button
            className="nm-btn nm-btn-ghost"
            onClick={stop}
            style={{ width: '100%', justifyContent: 'center', color: '#ef4444' }}
          >
            ⏹ {t('stop_monitoring')}
          </button>
        )}

        {running && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
            {notifyOk ? `🔔 ${t('notifications_on')}` : `🔕 ${t('notifications_off')}`}
          </div>
        )}
      </aside>

      {/* ── Main area — change log ─────────────────────────────────────── */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '16px 20px', overflow: 'auto' }}>

        {/* Status bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          {running ? (
            <>
              <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                             background: '#22c55e', boxShadow: '0 0 6px #22c55e' }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: '#22c55e' }}>{t('monitoring_active')}</span>
              {[...selected].map(id => {
                const d = devices.find(x => String(x.id) === id);
                return d ? (
                  <span key={id} style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 10,
                    background: 'rgba(59,130,246,0.15)', color: '#60a5fa',
                  }}>
                    {d.name || d.ip}
                  </span>
                ) : null;
              })}
            </>
          ) : (
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {changes.length > 0 ? t('changes_stopped', { count: changes.length }) : t('select_switch_hint')}
            </span>
          )}

          {changes.length > 0 && (
            <button
              className="nm-btn nm-btn-ghost"
              style={{ marginInlineStart: 'auto', fontSize: 11, padding: '3px 10px' }}
              onClick={() => setChanges([])}
            >
              {t('clear_list')}
            </button>
          )}
        </div>

        {/* Change list */}
        {changes.length === 0 ? (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)', fontSize: 13,
          }}>
            {running ? `⏳ ${t('waiting_changes')}` : ''}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {changes.map(c => (
              <div
                key={c.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 14px', borderRadius: 8,
                  background: c.curr === 'down'
                    ? 'rgba(239,68,68,0.1)'
                    : 'rgba(34,197,94,0.1)',
                  border: `1px solid ${c.curr === 'down' ? 'rgba(239,68,68,0.25)' : 'rgba(34,197,94,0.25)'}`,
                }}
              >
                <span style={{ fontSize: 18 }}>
                  {c.curr === 'down' ? '🔴' : '🟢'}
                </span>
                <span style={{
                  fontFamily: 'monospace', fontSize: 11,
                  color: 'var(--text-muted)', minWidth: 60,
                }}>
                  {c.ts}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {c.devName}
                </span>
                <span style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text-primary)' }}>
                  {c.if_name}
                </span>
                <span style={{
                  marginInlineStart: 'auto', fontSize: 11, fontWeight: 700,
                  color: c.curr === 'down' ? '#ef4444' : '#22c55e',
                }}>
                  {c.curr === 'down' ? `↓ ${t('port_went_down')}` : `↑ ${t('port_went_up')}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
