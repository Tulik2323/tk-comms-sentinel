// AuditPage — לוג אירועי מערכת
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import { formatAuditMessage } from '../lib/auditFormat';
import api from '../lib/api';

const LEVEL_COLOR = {
  info:  '#22c55e',
  warn:  '#f97316',
  error: '#ef4444',
};

const SOURCE_LABEL = {
  poller: '📡 Poller',
  auth:   '🔑 Auth',
  admin:  '⚙️ Admin',
  system: '🖥️ System',
};

function Badge({ text, color }) {
  return (
    <span style={{
      display:      'inline-block',
      padding:      '2px 8px',
      borderRadius: 4,
      fontSize:     11,
      fontWeight:   600,
      background:   color + '22',
      color,
      border:       `1px solid ${color}44`,
    }}>
      {text}
    </span>
  );
}

export default function AuditPage() {
  const { t }     = useTranslation();
  const { user }  = useAuth();
  const isAdmin   = user?.role === 'admin';

  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ level: '', source: '', limit: 200 });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', filters.limit);
      if (filters.level)  params.set('level',  filters.level);
      if (filters.source) params.set('source', filters.source);
      const res = await api.get(`/audit?${params}`);
      setRows(res.data);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  // רענון אוטומטי כל 30 שניות
  useEffect(() => {
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  async function clearOld() {
    if (!window.confirm(t('clean_old_confirm'))) return;
    await api.delete('/audit?older_than_days=30');
    load();
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>📋 {t('audit_title')}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} className="nm-btn nm-btn-ghost">↺ {t('refresh')}</button>
          {isAdmin && (
            <button onClick={clearOld} className="nm-btn nm-btn-danger" style={{ fontSize: 12, padding: '6px 12px' }}>
              🗑 {t('clean_old')}
            </button>
          )}
        </div>
      </div>

      {/* פילטרים */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          className="nm-input"
          style={{ width: 140 }}
          value={filters.level}
          onChange={e => setFilters(f => ({ ...f, level: e.target.value }))}
        >
          <option value="">{t('all_levels')}</option>
          <option value="info">✅ Info</option>
          <option value="warn">⚠️ Warn</option>
          <option value="error">❌ Error</option>
        </select>

        <select
          className="nm-input"
          style={{ width: 160 }}
          value={filters.source}
          onChange={e => setFilters(f => ({ ...f, source: e.target.value }))}
        >
          <option value="">{t('all_sources')}</option>
          <option value="poller">📡 Poller</option>
          <option value="auth">🔑 Auth</option>
          <option value="admin">⚙️ Admin</option>
          <option value="system">🖥️ System</option>
        </select>

        <select
          className="nm-input"
          style={{ width: 130 }}
          value={filters.limit}
          onChange={e => setFilters(f => ({ ...f, limit: e.target.value }))}
        >
          <option value="100">100 {t('rows_suffix')}</option>
          <option value="200">200 {t('rows_suffix')}</option>
          <option value="500">500 {t('rows_suffix')}</option>
          <option value="1000">1000 {t('rows_suffix')}</option>
        </select>

        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {t('events_count', { count: rows.length })}
        </span>
      </div>

      {/* טבלה */}
      {loading ? (
        <div style={{ color: 'var(--text-muted)', padding: 20 }}>{t('loading')}</div>
      ) : rows.length === 0 ? (
        <div className="nm-card" style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
          <div>{t('no_events_yet')}</div>
          <div style={{ fontSize: 12, marginTop: 8 }}>{t('no_events_hint')}</div>
        </div>
      ) : (
        <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="nm-table">
            <thead>
              <tr>
                <th style={{ width: 160 }}>{t('col_time')}</th>
                <th style={{ width: 70 }}>{t('col_level')}</th>
                <th style={{ width: 110 }}>{t('col_source')}</th>
                <th>{t('col_message')}</th>
                <th style={{ width: 160 }}>{t('col_device')}</th>
                <th style={{ width: 120 }}>{t('col_user_ip')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id}>
                  <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {new Date(row.ts * 1000).toLocaleString()}
                  </td>
                  <td>
                    <Badge
                      text={row.level.toUpperCase()}
                      color={LEVEL_COLOR[row.level] || '#6b7280'}
                    />
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {SOURCE_LABEL[row.source] || row.source}
                  </td>
                  <td style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                    {formatAuditMessage(row, t)}
                  </td>
                  <td>
                    {row.device_id ? (
                      <Link to={`/devices/${row.device_id}`} style={{ color: 'var(--accent)', fontSize: 12, textDecoration: 'none' }}>
                        {row.device_name || row.device_ip || `#${row.device_id}`}
                      </Link>
                    ) : (
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                    )}
                  </td>
                  <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {row.username && <div>👤 {row.username}</div>}
                    {row.ip && <div>🌐 {row.ip}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
