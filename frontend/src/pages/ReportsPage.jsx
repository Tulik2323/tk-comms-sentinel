// ReportsPage — הרצה וניהול תזמון דוחות
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';

const REPORT_DEFS = [
  { type: 'uptime',        params: [{ name: 'period_days', default: 7,  min: 1, max: 90 }] },
  { type: 'top_ports',     params: [{ name: 'limit',       default: 20, min: 5, max: 100 }] },
  { type: 'alert_history', params: [{ name: 'period_days', default: 7,  min: 1, max: 90 }] },
  { type: 'port_errors',   params: [{ name: 'min_errors',  default: 0,  min: 0, max: 9999 }] },
];

const CRON_VALUES = [
  { key: 'cron_daily',   value: '0 8 * * *' },
  { key: 'cron_weekly',  value: '0 8 * * 1' },
  { key: 'cron_monthly', value: '0 8 1 * *' },
  { key: 'cron_hourly',  value: '0 * * * *' },
  { key: 'cron_custom',  value: '' },
];

function useReportTypes() {
  const { t } = useTranslation();
  return REPORT_DEFS.map(r => ({
    ...r,
    label:  t(`rpt_${r.type}`),
    params: r.params.map(p => ({ ...p, label: t(`prm_${p.name}`) })),
  }));
}

function useCronPresets() {
  const { t } = useTranslation();
  return CRON_VALUES.map(c => ({ label: t(c.key), value: c.value }));
}

function ReportTable({ report }) {
  const { t } = useTranslation();
  if (!report) return null;
  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
        {report.title} · {report.rows.length} {t('rows_label')}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="nm-table" style={{ minWidth: 600 }}>
          <thead>
            <tr>{report.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {report.rows.length === 0 ? (
              <tr><td colSpan={report.headers.length} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{t('no_data')}</td></tr>
            ) : report.rows.map((row, i) => (
              <tr key={i}>{row.map((cell, j) => <td key={j} style={{ fontSize: 12 }}>{cell ?? '—'}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RunReport() {
  const { t }               = useTranslation();
  const REPORT_TYPES        = useReportTypes();
  const [type,   setType]   = useState(REPORT_DEFS[0].type);
  const [params, setParams] = useState({});
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]  = useState('');

  const typeDef = REPORT_TYPES.find(x => x.type === type);

  function initParams(nextType) {
    const def = REPORT_TYPES.find(x => x.type === nextType);
    const p = {};
    for (const pd of def.params) p[pd.name] = pd.default;
    return p;
  }

  function handleTypeChange(nextType) {
    setType(nextType);
    setParams(initParams(nextType));
    setReport(null);
    setError('');
  }

  async function run() {
    setLoading(true); setError(''); setReport(null);
    try {
      const qs = new URLSearchParams({ type, ...params }).toString();
      const res = await api.get(`/reports/run?${qs}`);
      setReport(res.data);
    } catch (e) {
      setError(e.response?.data?.error || t('error'));
    } finally { setLoading(false); }
  }

  function downloadCsv() {
    const qs  = new URLSearchParams({ type, format: 'csv', ...params }).toString();
    const url = `/api/reports/run?${qs}`;
    // פתח ב-tab חדש — הדפדפן יוריד את הCSV
    const a = document.createElement('a');
    a.href = url;
    a.download = `${type}_report.csv`;
    // הוסף את token ל-header — לא אפשרי ב-anchor, אז נשתמש ב-fetch blob
    const token = localStorage.getItem('nm_token');
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.blob())
      .then(blob => {
        const objUrl = URL.createObjectURL(blob);
        a.href = objUrl;
        a.click();
        setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
      });
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'end', marginBottom: 16 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{t('report_type')}</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {REPORT_TYPES.map(rt => (
              <button key={rt.type}
                className={`nm-btn ${type === rt.type ? 'nm-btn-primary' : 'nm-btn-ghost'}`}
                style={{ fontSize: 12, padding: '6px 12px' }}
                onClick={() => handleTypeChange(rt.type)}>
                {rt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* פרמטרים */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        {typeDef?.params.map(pd => (
          <div key={pd.name}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{pd.label}</label>
            <input type="number" className="nm-input" style={{ width: 100 }}
              min={pd.min} max={pd.max}
              value={params[pd.name] ?? pd.default}
              onChange={e => setParams(p => ({ ...p, [pd.name]: Number(e.target.value) }))} />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <button className="nm-btn nm-btn-primary" disabled={loading} onClick={run}
          style={{ padding: '8px 20px' }}>
          {loading ? t('computing') : `▶ ${t('run_report_btn')}`}
        </button>
        {report && (
          <button className="nm-btn nm-btn-ghost" onClick={downloadCsv} style={{ padding: '8px 16px', fontSize: 12 }}>
            ⬇ {t('download_csv')}
          </button>
        )}
      </div>

      {error && (
        <div style={{ padding: '10px 14px', background: 'rgba(127,29,29,0.25)', border: '1px solid #b91c1c',
                      color: '#fecaca', borderRadius: 6, marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      <ReportTable report={report} />
    </div>
  );
}

function ScheduleManager() {
  const { t }                     = useTranslation();
  const REPORT_TYPES              = useReportTypes();
  const CRON_PRESETS              = useCronPresets();
  const [schedules, setSchedules] = useState([]);
  const [showForm,  setShowForm]  = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [form, setForm] = useState({
    name: '', report_type: 'uptime', cron_expr: '0 8 * * 1', email_to: '', enabled: true,
    params: { period_days: 7 },
  });
  const [cronPreset, setCronPreset] = useState('0 8 * * 1');

  useEffect(() => { loadSchedules(); }, []);

  async function loadSchedules() {
    try { const r = await api.get('/reports/schedules'); setSchedules(r.data); } catch (_) {}
  }

  async function save() {
    setSaving(true);
    try {
      await api.post('/reports/schedules', form);
      setShowForm(false);
      loadSchedules();
    } catch (e) {
      alert(e.response?.data?.error || t('save_error'));
    } finally { setSaving(false); }
  }

  async function toggle(s) {
    try {
      await api.put(`/reports/schedules/${s.id}`, { enabled: !s.enabled });
      loadSchedules();
    } catch (_) {}
  }

  async function del(id) {
    if (!confirm(t('delete_schedule_confirm'))) return;
    try { await api.delete(`/reports/schedules/${id}`); loadSchedules(); } catch (_) {}
  }

  function handlePreset(val) {
    setCronPreset(val);
    if (val) setForm(f => ({ ...f, cron_expr: val }));
  }

  const typeLabel = (rt) => REPORT_TYPES.find(x => x.type === rt)?.label || rt;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {t('schedules_hint')}
        </span>
        <button className="nm-btn nm-btn-primary" style={{ padding: '6px 14px', fontSize: 12 }}
          onClick={() => setShowForm(v => !v)}>
          {showForm ? `✕ ${t('cancel')}` : `+ ${t('new_schedule')}`}
        </button>
      </div>

      {showForm && (
        <div className="nm-card" style={{ marginBottom: 20, background: 'var(--bg-secondary)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t('schedule_name')}</label>
              <input className="nm-input" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={t('schedule_name_ph')} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t('report_type')}</label>
              <select className="nm-input" value={form.report_type}
                onChange={e => setForm(f => ({ ...f, report_type: e.target.value }))}>
                {REPORT_TYPES.map(rt => <option key={rt.type} value={rt.type}>{rt.label}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t('frequency')}</label>
              <select className="nm-input" value={cronPreset} onChange={e => handlePreset(e.target.value)}>
                {CRON_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            {(!cronPreset || cronPreset === '') && (
              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                  {t('custom_cron')}
                </label>
                <input className="nm-input" style={{ fontFamily: 'monospace' }}
                  value={form.cron_expr}
                  onChange={e => setForm(f => ({ ...f, cron_expr: e.target.value }))}
                  placeholder="0 8 * * 1" />
              </div>
            )}
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t('send_to_email')}</label>
              <input className="nm-input" type="email" value={form.email_to}
                onChange={e => setForm(f => ({ ...f, email_to: e.target.value }))}
                placeholder="it@hospital.org" />
            </div>
          </div>
          <button className="nm-btn nm-btn-primary" disabled={saving || !form.name || !form.email_to}
            onClick={save} style={{ padding: '8px 20px' }}>
            {saving ? t('saving') : `💾 ${t('save_schedule')}`}
          </button>
        </div>
      )}

      {schedules.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          {t('no_schedules')}
        </div>
      ) : (
        <table className="nm-table">
          <thead>
            <tr><th>{t('col_name')}</th><th>{t('col_type')}</th><th>{t('frequency')}</th><th>{t('col_email')}</th><th>{t('col_last_run')}</th><th>{t('col_enabled')}</th><th></th></tr>
          </thead>
          <tbody>
            {schedules.map(s => (
              <tr key={s.id}>
                <td style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</td>
                <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{typeLabel(s.report_type)}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{s.cron_expr}</td>
                <td style={{ fontSize: 12 }}>{s.email_to || '—'}</td>
                <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {s.last_run ? new Date(s.last_run * 1000).toLocaleString() : t('never_ran')}
                </td>
                <td>
                  <button className={`nm-btn ${s.enabled ? 'nm-btn-primary' : 'nm-btn-ghost'}`}
                    style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => toggle(s)}>
                    {s.enabled ? t('active_label') : t('disabled_label')}
                  </button>
                </td>
                <td>
                  <button className="nm-btn nm-btn-ghost" style={{ padding: '3px 8px', fontSize: 11, color: '#ef4444' }}
                    onClick={() => del(s.id)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function ReportsPage() {
  const { t }         = useTranslation();
  const [tab, setTab] = useState('run');

  return (
    <div style={{ padding: 24, maxWidth: 1300, margin: '0 auto' }}>
      <h1 style={{ margin: '0 0 20px', fontSize: 22 }}>📄 {t('reports_title')}</h1>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {[['run', t('run_report_tab')], ['schedule', t('scheduled_reports_tab')]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className="nm-btn nm-btn-ghost"
            style={{
              padding: '8px 20px', fontSize: 13, borderRadius: '6px 6px 0 0',
              background: tab === id ? 'var(--bg-card)' : 'transparent',
              borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === id ? 'var(--accent)' : 'var(--text-muted)',
            }}>
            {label}
          </button>
        ))}
      </div>

      <div className="nm-card">
        {tab === 'run'      && <RunReport />}
        {tab === 'schedule' && <ScheduleManager />}
      </div>
    </div>
  );
}
