// TrendsPage — ניתוח מגמות: פורטים בעייתיים, התראות, CPU + AI (אופציונלי)
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import api from '../lib/api';

const DAYS_OPTIONS = [7, 14, 30];

function SectionCard({ title, children, isEmpty, emptyMsg }) {
  return (
    <div className="nm-card" style={{ marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 14px', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
        {title}
      </h3>
      {isEmpty
        ? <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0' }}>{emptyMsg}</div>
        : children}
    </div>
  );
}

function Badge({ text, color }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: 10, fontSize: 11,
      background: `${color}22`, border: `1px solid ${color}55`, color,
    }}>{text}</span>
  );
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtErrors(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export default function TrendsPage() {
  const [days, setDays]         = useState(7);
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [aiLoading, setAiLoad]  = useState(false);
  const [aiText, setAiText]     = useState('');
  const [aiError, setAiError]   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setAiText('');
    setAiError('');
    try {
      const r = await api.get(`/trends?days=${days}`);
      setData(r.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  async function runAiAnalysis() {
    if (!data) return;
    setAiLoad(true);
    setAiText('');
    setAiError('');
    try {
      const r = await api.post('/trends/ai-analyze', { trendData: data });
      setAiText(r.data.analysis || '');
    } catch (err) {
      const msg = err.response?.data?.message || err.response?.data?.error || err.message;
      if (err.response?.data?.error === 'AI_NOT_CONFIGURED') {
        setAiError('ניתוח AI מושבת — הגדר CLAUDE_API_KEY ב-.env ואתחל את ה-App Pool.');
      } else {
        setAiError(`שגיאה: ${msg}`);
      }
    } finally {
      setAiLoad(false);
    }
  }

  const summary = data?.summary || {};

  return (
    <div style={{ padding: 24, maxWidth: 1300, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>📈 ניתוח מגמות</h1>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {DAYS_OPTIONS.map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`nm-btn ${days === d ? 'nm-btn-primary' : 'nm-btn-ghost'}`}
              style={{ padding: '5px 12px', fontSize: 12 }}>
              {d} ימים
            </button>
          ))}
          <button onClick={load} className="nm-btn nm-btn-ghost"
            style={{ padding: '5px 10px', fontSize: 12 }} title="רענן">
            🔄
          </button>
        </div>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 60, fontSize: 14 }}>
          טוען נתונים...
        </div>
      )}

      {!loading && !data && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 60 }}>
          שגיאה בטעינת נתונים
        </div>
      )}

      {!loading && data && (<>

        {/* Summary Bar */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'מכשירים UP',    value: summary.devices_up   ?? '—', color: '#22c55e' },
            { label: 'מכשירים DOWN',  value: summary.devices_down ?? '—', color: '#ef4444' },
            { label: 'התראות',        value: summary.total_alerts ?? 0,   color: '#f97316' },
            { label: 'שינויי פורטים', value: summary.total_port_changes ?? 0, color: '#3b82f6' },
          ].map(s => (
            <div key={s.label} style={{
              padding: '10px 18px', borderRadius: 10,
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              textAlign: 'center', minWidth: 110,
            }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
          <div style={{
            padding: '10px 18px', borderRadius: 10,
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            textAlign: 'center', minWidth: 110,
          }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>{days}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>ימי ניתוח</div>
          </div>
        </div>

        {/* Daily Changes Graph */}
        {data.dailyChanges?.length > 0 && (
          <SectionCard title="📅 שינויי פורטים לפי יום">
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={data.dailyChanges} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', fontSize: 12 }}
                  formatter={(v, name) => [v, name === 'total_changes' ? 'שינויים' : 'מכשירים']}
                  labelStyle={{ color: 'var(--text-muted)' }}
                />
                <Bar dataKey="total_changes" name="שינויים" fill="var(--accent)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </SectionCard>
        )}

        {/* Flapping Ports */}
        <SectionCard
          title={`⚡ פורטים עם שינויים תכופים (Flapping) — ${data.flappingPorts?.length || 0} נמצאו`}
          isEmpty={!data.flappingPorts?.length}
          emptyMsg={`לא נמצאו פורטים עם שינויים חוזרים ב-${days} ימים האחרונים ✅`}
        >
          <div style={{ overflowX: 'auto' }}>
            <table className="nm-table">
              <thead>
                <tr>
                  <th>מכשיר</th>
                  <th>פורט</th>
                  <th>שינויים</th>
                  <th>Admin</th>
                  <th>שינוי אחרון</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.flappingPorts.map(p => (
                  <tr key={`${p.device_id}-${p.if_index}`}>
                    <td style={{ fontWeight: 600, fontSize: 12 }}>
                      <Link to={`/devices/${p.device_id}`} style={{ color: 'var(--accent)' }}>
                        {p.device_name || p.device_ip}
                      </Link>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p.device_ip}</div>
                    </td>
                    <td style={{ fontSize: 12 }}>{p.if_name || `if_index ${p.if_index}`}</td>
                    <td>
                      <Badge text={`${p.change_count} שינויים`}
                        color={p.change_count >= 10 ? '#ef4444' : p.change_count >= 5 ? '#f97316' : '#eab308'} />
                    </td>
                    <td style={{ fontSize: 12 }}>{p.admin_changes > 0 ? `${p.admin_changes} Admin` : '—'}</td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtTime(p.last_change)}</td>
                    <td>
                      <Link to={`/devices/${p.device_id}?port=${p.if_index}`}
                        className="nm-btn nm-btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }}>
                        פרטים
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* Error Ports */}
        <SectionCard
          title={`🔴 פורטים עם שגיאות גבוהות — ${data.errorPorts?.length || 0} נמצאו`}
          isEmpty={!data.errorPorts?.length}
          emptyMsg="לא נמצאו פורטים עם שגיאות ✅"
        >
          <div style={{ overflowX: 'auto' }}>
            <table className="nm-table">
              <thead>
                <tr>
                  <th>מכשיר</th>
                  <th>פורט</th>
                  <th>שגיאות ↓</th>
                  <th>שגיאות ↑</th>
                  <th>סה"כ שגיאות</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.errorPorts.map(p => (
                  <tr key={`${p.device_id}-${p.if_index}`}>
                    <td style={{ fontWeight: 600, fontSize: 12 }}>
                      <Link to={`/devices/${p.device_id}`} style={{ color: 'var(--accent)' }}>
                        {p.device_name || p.device_ip}
                      </Link>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p.device_ip}</div>
                    </td>
                    <td style={{ fontSize: 12 }}>{p.if_alias || p.if_name || `if_index ${p.if_index}`}</td>
                    <td style={{ color: '#ef4444', fontFamily: 'monospace', fontSize: 12 }}>
                      {fmtErrors(p.in_errors)}
                    </td>
                    <td style={{ color: '#f97316', fontFamily: 'monospace', fontSize: 12 }}>
                      {fmtErrors(p.out_errors)}
                    </td>
                    <td>
                      <Badge text={fmtErrors(p.total_errors)}
                        color={p.total_errors >= 100000 ? '#ef4444' : p.total_errors >= 10000 ? '#f97316' : '#eab308'} />
                    </td>
                    <td>
                      <Link to={`/devices/${p.device_id}?port=${p.if_index}`}
                        className="nm-btn nm-btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }}>
                        פרטים
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* Alert Devices */}
        <SectionCard
          title={`🔔 מכשירים עם הכי הרבה התראות — ${data.alertDevices?.length || 0} נמצאו`}
          isEmpty={!data.alertDevices?.length}
          emptyMsg={`לא נרשמו התראות ב-${days} ימים האחרונים ✅`}
        >
          <div style={{ overflowX: 'auto' }}>
            <table className="nm-table">
              <thead>
                <tr>
                  <th>מכשיר</th>
                  <th>התראות</th>
                  <th>מטריקות</th>
                  <th>התראה אחרונה</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.alertDevices.map(d => (
                  <tr key={d.device_id}>
                    <td style={{ fontWeight: 600, fontSize: 12 }}>
                      <Link to={`/devices/${d.device_id}`} style={{ color: 'var(--accent)' }}>
                        {d.device_name || d.device_ip}
                      </Link>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{d.device_ip}</div>
                    </td>
                    <td>
                      <Badge text={`${d.alert_count} התראות`}
                        color={d.alert_count >= 20 ? '#ef4444' : d.alert_count >= 10 ? '#f97316' : '#eab308'} />
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {(d.metrics || '').split(',').join(', ')}
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtTime(d.last_alert)}</td>
                    <td>
                      <Link to={`/devices/${d.device_id}`}
                        className="nm-btn nm-btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }}>
                        מכשיר
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* High CPU */}
        {data.highCpuDevices?.length > 0 && (
          <SectionCard title={`⚡ מכשירים עם CPU גבוה (ממוצע > 50%) — ${data.highCpuDevices.length} נמצאו`}>
            <div style={{ overflowX: 'auto' }}>
              <table className="nm-table">
                <thead>
                  <tr>
                    <th>מכשיר</th>
                    <th>CPU ממוצע</th>
                    <th>CPU מקסימום</th>
                    <th>דגימות</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.highCpuDevices.map(d => (
                    <tr key={d.device_id}>
                      <td style={{ fontWeight: 600, fontSize: 12 }}>
                        <Link to={`/devices/${d.device_id}`} style={{ color: 'var(--accent)' }}>
                          {d.device_name || d.device_ip}
                        </Link>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{d.device_ip}</div>
                      </td>
                      <td>
                        <Badge text={`${d.avg_cpu}%`}
                          color={d.avg_cpu >= 90 ? '#ef4444' : d.avg_cpu >= 70 ? '#f97316' : '#eab308'} />
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: 12, color: '#f97316' }}>
                        {d.max_cpu}%
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{d.sample_count}</td>
                      <td>
                        <Link to={`/devices/${d.device_id}`}
                          className="nm-btn nm-btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }}>
                          גרפים
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        )}

        {/* AI Analysis */}
        <div className="nm-card">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 14 }}>🤖 ניתוח AI — המלצות לתיקון</h3>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                מחייב גישה לאינטרנט + CLAUDE_API_KEY ב-.env | עובד גם ללא AI (ניתוח ידני למעלה)
              </div>
            </div>
            <button
              onClick={runAiAnalysis}
              disabled={aiLoading}
              className="nm-btn nm-btn-primary"
              style={{ padding: '7px 16px', fontSize: 13, flexShrink: 0 }}
            >
              {aiLoading ? '⏳ מנתח...' : '🤖 נתח עם AI'}
            </button>
          </div>

          {aiError && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, fontSize: 13,
              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
              color: '#ef4444',
            }}>
              {aiError}
            </div>
          )}

          {aiLoading && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0' }}>
              שולח נתונים ל-Claude ומקבל המלצות...
            </div>
          )}

          {aiText && !aiLoading && (
            <div style={{
              padding: '14px 16px', borderRadius: 8,
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap',
              direction: 'rtl', textAlign: 'right',
            }}>
              {aiText}
            </div>
          )}

          {!aiText && !aiLoading && !aiError && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>
              לחץ "נתח עם AI" לקבלת המלצות מותאמות על בסיס הנתונים שלמעלה.
            </div>
          )}
        </div>

      </>)}
    </div>
  );
}
