// TrendsPage — ניתוח מגמות: פורטים בעייתיים, התראות, CPU + AI (אופציונלי)
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
  return new Date(ts * 1000).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtErrors(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export default function TrendsPage() {
  const { t }                   = useTranslation();
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
        setAiError(t('ai_disabled'));
      } else {
        setAiError(`${t('error')}: ${msg}`);
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
        <h1 style={{ margin: 0, fontSize: 20 }}>📈 {t('trends')}</h1>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {DAYS_OPTIONS.map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`nm-btn ${days === d ? 'nm-btn-primary' : 'nm-btn-ghost'}`}
              style={{ padding: '5px 12px', fontSize: 12 }}>
              {d} {t('days_suffix')}
            </button>
          ))}
          <button onClick={load} className="nm-btn nm-btn-ghost"
            style={{ padding: '5px 10px', fontSize: 12 }} title={t('refresh')}>
            🔄
          </button>
        </div>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 60, fontSize: 14 }}>
          {t('loading_data')}
        </div>
      )}

      {!loading && !data && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 60 }}>
          {t('error_loading_data')}
        </div>
      )}

      {!loading && data && (<>

        {/* Summary Bar */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: t('devices_up_label'),   value: summary.devices_up   ?? '—', color: '#22c55e' },
            { label: t('devices_down_label'), value: summary.devices_down ?? '—', color: '#ef4444' },
            { label: t('alerts'),             value: summary.total_alerts ?? 0,   color: '#f97316' },
            { label: t('port_changes'),       value: summary.total_port_changes ?? 0, color: '#3b82f6' },
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
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{t('analysis_days')}</div>
          </div>
        </div>

        {/* Daily Changes Graph */}
        {data.dailyChanges?.length > 0 && (
          <SectionCard title={`📅 ${t('port_changes_by_day')}`}>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={data.dailyChanges} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', fontSize: 12 }}
                  formatter={(v, name) => [v, name === 'total_changes' ? t('changes_word') : t('devices_word')]}
                  labelStyle={{ color: 'var(--text-muted)' }}
                />
                <Bar dataKey="total_changes" name={t('changes_word')} fill="var(--accent)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </SectionCard>
        )}

        {/* Flapping Ports */}
        <SectionCard
          title={`⚡ ${t('flapping_title', { count: data.flappingPorts?.length || 0 })}`}
          isEmpty={!data.flappingPorts?.length}
          emptyMsg={t('flapping_empty', { days })}
        >
          <div style={{ overflowX: 'auto' }}>
            <table className="nm-table">
              <thead>
                <tr>
                  <th>{t('col_device')}</th>
                  <th>{t('col_port')}</th>
                  <th>{t('col_changes')}</th>
                  <th>Admin</th>
                  <th>{t('col_last_change')}</th>
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
                      <Badge text={`${p.change_count} ${t('changes_word')}`}
                        color={p.change_count >= 10 ? '#ef4444' : p.change_count >= 5 ? '#f97316' : '#eab308'} />
                    </td>
                    <td style={{ fontSize: 12 }}>{p.admin_changes > 0 ? `${p.admin_changes} Admin` : '—'}</td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtTime(p.last_change)}</td>
                    <td>
                      <Link to={`/devices/${p.device_id}?port=${p.if_index}`}
                        className="nm-btn nm-btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }}>
                        {t('details_btn')}
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
          title={`🔴 ${t('error_ports_title', { count: data.errorPorts?.length || 0 })}`}
          isEmpty={!data.errorPorts?.length}
          emptyMsg={t('error_ports_empty')}
        >
          <div style={{ overflowX: 'auto' }}>
            <table className="nm-table">
              <thead>
                <tr>
                  <th>{t('col_device')}</th>
                  <th>{t('col_port')}</th>
                  <th>{t('col_errors_in')}</th>
                  <th>{t('col_errors_out')}</th>
                  <th>{t('col_total_errors')}</th>
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
                        {t('details_btn')}
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
          title={`🔔 ${t('alert_devices_title', { count: data.alertDevices?.length || 0 })}`}
          isEmpty={!data.alertDevices?.length}
          emptyMsg={t('alert_devices_empty', { days })}
        >
          <div style={{ overflowX: 'auto' }}>
            <table className="nm-table">
              <thead>
                <tr>
                  <th>{t('col_device')}</th>
                  <th>{t('col_alerts')}</th>
                  <th>{t('col_metrics')}</th>
                  <th>{t('col_last_alert')}</th>
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
                      <Badge text={`${d.alert_count} ${t('col_alerts')}`}
                        color={d.alert_count >= 20 ? '#ef4444' : d.alert_count >= 10 ? '#f97316' : '#eab308'} />
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {(d.metrics || '').split(',').join(', ')}
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtTime(d.last_alert)}</td>
                    <td>
                      <Link to={`/devices/${d.device_id}`}
                        className="nm-btn nm-btn-ghost" style={{ padding: '3px 8px', fontSize: 11 }}>
                        {t('col_device')}
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
          <SectionCard title={`⚡ ${t('high_cpu_title', { count: data.highCpuDevices.length })}`}>
            <div style={{ overflowX: 'auto' }}>
              <table className="nm-table">
                <thead>
                  <tr>
                    <th>{t('col_device')}</th>
                    <th>{t('col_avg_cpu')}</th>
                    <th>{t('col_max_cpu')}</th>
                    <th>{t('col_samples')}</th>
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
                          {t('charts_btn')}
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
              <h3 style={{ margin: 0, fontSize: 14 }}>🤖 {t('ai_title')}</h3>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                {t('ai_note')}
              </div>
            </div>
            <button
              onClick={runAiAnalysis}
              disabled={aiLoading}
              className="nm-btn nm-btn-primary"
              style={{ padding: '7px 16px', fontSize: 13, flexShrink: 0 }}
            >
              {aiLoading ? `⏳ ${t('ai_analyzing')}` : `🤖 ${t('ai_analyze_btn')}`}
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
              {t('ai_sending')}
            </div>
          )}

          {aiText && !aiLoading && (
            <div style={{
              padding: '14px 16px', borderRadius: 8,
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap',
              textAlign: 'start',
            }}>
              {aiText}
            </div>
          )}

          {!aiText && !aiLoading && !aiError && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>
              {t('ai_hint')}
            </div>
          )}
        </div>

      </>)}
    </div>
  );
}
