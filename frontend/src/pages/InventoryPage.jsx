// InventoryPage — סיווג תחנות קצה לפי OUI (יצרן MAC)
import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';

// ---- Category metadata ----

const CAT_META = {
  Computers: { icon: '💻', color: '#3b82f6' },
  Printers:  { icon: '🖨️', color: '#8b5cf6' },
  APs:       { icon: '📡', color: '#06b6d4' },
  Cameras:   { icon: '📷', color: '#f59e0b' },
  Medical:   { icon: '🏥', color: '#ef4444' },
  Network:   { icon: '🔀', color: '#10b981' },
  VMs:       { icon: '☁️', color: '#6366f1' },
  Unknown:   { icon: '❓', color: '#6b7280' },
};

const CAT_ORDER = ['Computers', 'Printers', 'APs', 'Cameras', 'Medical', 'Network', 'VMs', 'Unknown'];

// ---- Helpers ----

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString(undefined, {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function SummaryCard({ name, count, icon, color, selected, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background:  selected ? `${color}22` : 'var(--bg-card)',
        border:      `1.5px solid ${selected ? color : 'var(--border)'}`,
        borderRadius: 10,
        padding:     '14px 18px',
        cursor:      'pointer',
        transition:  'border-color 0.15s',
        minWidth:    110,
        flex:        '1 1 130px',
      }}
    >
      <div style={{ fontSize: 26, marginBottom: 6 }}>{icon}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{count.toLocaleString()}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{name}</div>
    </div>
  );
}

// ---- Main page ----

export default function InventoryPage() {
  const { t } = useTranslation();

  const [summary, setSummary]         = useState(null);
  const [rows, setRows]               = useState([]);
  const [total, setTotal]             = useState(0);
  const [loading, setLoading]         = useState(true);
  const [loadingRows, setLoadingRows] = useState(false);
  const [error, setError]             = useState('');

  const [selectedCat, setSelectedCat] = useState('All');
  const [search, setSearch]           = useState('');
  const [page, setPage]               = useState(1);
  const LIMIT = 100;

  const searchRef = useRef(null);

  // Load summary cards
  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get('/inventory');
      setSummary(r.data);
    } catch (e) {
      setError(t('error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Load table rows
  const loadRows = useCallback(async (cat, q, pg) => {
    setLoadingRows(true);
    try {
      const r = await api.get('/inventory/entries', {
        params: { category: cat === 'All' ? '' : cat, search: q, page: pg, limit: LIMIT },
      });
      setRows(r.data.rows);
      setTotal(r.data.total);
    } catch (_) {
      setRows([]);
      setTotal(0);
    } finally {
      setLoadingRows(false);
    }
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      loadRows(selectedCat, search, 1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search, selectedCat, loadRows]);

  // When page changes
  useEffect(() => {
    loadRows(selectedCat, search, page);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleCatClick(cat) {
    const next = selectedCat === cat ? 'All' : cat;
    setSelectedCat(next);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
          {t('inventory_title')}
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
          {t('inventory_subtitle')}
        </p>
      </div>

      {/* Summary cards */}
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 24 }}>{t('loading')}</div>
      ) : error ? (
        <div style={{ color: '#ef4444', marginBottom: 24 }}>{error}</div>
      ) : summary && (
        <>
          {/* Total badge */}
          <div style={{ marginBottom: 14, fontSize: 13, color: 'var(--text-muted)' }}>
            {t('inventory_total', { count: summary.total.toLocaleString() })}
            {selectedCat !== 'All' && (
              <span
                onClick={() => setSelectedCat('All')}
                style={{ marginInlineStart: 10, cursor: 'pointer', color: 'var(--accent)', textDecoration: 'underline', fontSize: 12 }}
              >
                {t('filter_all')}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 24 }}>
            {CAT_ORDER.map(name => {
              const meta = CAT_META[name] || { icon: '❓', color: '#6b7280' };
              const cat  = summary.categories.find(c => c.name === name);
              return (
                <SummaryCard
                  key={name}
                  name={t(`inv_cat_${name.toLowerCase()}`)}
                  count={cat?.count || 0}
                  icon={meta.icon}
                  color={meta.color}
                  selected={selectedCat === name}
                  onClick={() => handleCatClick(name)}
                />
              );
            })}
          </div>
        </>
      )}

      {/* Search bar */}
      <div style={{ marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={`🔍 ${t('inventory_search_ph')}`}
          style={{
            flex: 1, maxWidth: 380, padding: '7px 12px', borderRadius: 6, fontSize: 13,
            background: 'var(--bg-hover)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', outline: 'none',
          }}
        />
        {loadingRows && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('loading')}</span>
        )}
      </div>

      {/* Table */}
      <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg-hover)', borderBottom: '1px solid var(--border)' }}>
                {[
                  t('inv_col_mac'),
                  t('inv_col_ip'),
                  t('col_hostname'),
                  t('inv_col_vendor'),
                  t('inv_col_category'),
                  t('inv_col_device'),
                  t('last_seen'),
                ].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'start', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loadingRows ? (
                <tr>
                  <td colSpan={7} style={{ padding: '20px 12px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    {t('no_data')}
                  </td>
                </tr>
              ) : rows.map((r, i) => {
                const meta = CAT_META[r.category] || CAT_META.Unknown;
                return (
                  <tr
                    key={`${r.mac_address}-${r.device_id}-${i}`}
                    style={{ borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: 'var(--text-primary)' }}>
                      {r.mac_address || '—'}
                    </td>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                      {r.ip_address || '—'}
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--text-muted)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.hostname || '—'}
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--text-primary)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={r.vendor || ''}>
                      {r.vendor || <span style={{ color: 'var(--text-muted)' }}>—</span>}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '2px 8px', borderRadius: 10, fontSize: 11,
                        background: `${meta.color}22`, border: `1px solid ${meta.color}55`,
                        color: meta.color,
                      }}>
                        {meta.icon} {t(`inv_cat_${r.category.toLowerCase()}`)}
                      </span>
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 11 }}>
                      <div>{r.device_name || r.device_ip}</div>
                      {(r.if_alias || r.if_name) && (
                        <div style={{ opacity: 0.7 }}>{r.if_alias || r.if_name}</div>
                      )}
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--text-muted)', whiteSpace: 'nowrap', fontSize: 11 }}>
                      {fmtTime(r.last_seen)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', borderTop: '1px solid var(--border)',
          fontSize: 12, color: 'var(--text-muted)',
        }}>
          <span>{t('inventory_footer', { count: total, page, pages: totalPages })}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="nm-btn nm-btn-ghost"
              style={{ padding: '4px 12px', fontSize: 12 }}
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
            >
              {t('prev_page')}
            </button>
            <button
              className="nm-btn nm-btn-ghost"
              style={{ padding: '4px 12px', fontSize: 12 }}
              disabled={page >= totalPages}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            >
              {t('next_page')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
