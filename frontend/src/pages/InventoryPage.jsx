// InventoryPage — סיווג תחנות קצה לפי OUI (יצרן MAC)
import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../hooks/useAuth';

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

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '8px 16px', fontSize: 13, fontWeight: active ? 600 : 400,
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: active ? 'var(--accent)' : 'var(--text-muted)',
        borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
        marginBottom: -1,
      }}
    >
      {children}
    </button>
  );
}

const inputStyle = {
  padding: '5px 8px', borderRadius: 6, fontSize: 12,
  background: 'var(--bg-hover)', border: '1px solid var(--border)',
  color: 'var(--text-primary)', outline: 'none',
};

// ---- VLAN names tab ----

const NEW_CATEGORY = '__new__';

// One category's icon / colour / label, whether built-in or user-defined.
function catInfo(name, t, custom) {
  if (custom) return { icon: custom.icon, color: custom.color, label: custom.label };
  const m = CAT_META[name] || CAT_META.Unknown;
  return { icon: m.icon, color: m.color, label: t(`inv_cat_${String(name).toLowerCase()}`) };
}

function CategoryForm({ icons, initial, submitting, error, onSubmit, onCancel }) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.label || '');
  const [icon, setIcon] = useState(initial?.icon || icons[0]);

  const ready = name.trim().length > 0 && icon;

  return (
    <div className="nm-card" style={{ padding: 14, marginBottom: 14, maxWidth: 560 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
        {initial ? t('inv_cat_edit') : t('inv_cat_new')}
      </div>
      <input
        autoFocus
        value={name}
        maxLength={32}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && ready && !submitting) onSubmit(name.trim(), icon); }}
        placeholder={t('inv_cat_name_ph')}
        style={{ ...inputStyle, width: '100%', padding: '7px 10px', fontSize: 13, marginBottom: 10 }}
      />
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{t('inv_cat_icon')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {icons.map(i => (
          <button
            key={i}
            type="button"
            onClick={() => setIcon(i)}
            aria-pressed={icon === i}
            style={{
              width: 34, height: 34, fontSize: 18, cursor: 'pointer', borderRadius: 8,
              background: icon === i ? 'var(--bg-hover)' : 'transparent',
              border: `1.5px solid ${icon === i ? 'var(--accent)' : 'var(--border)'}`,
            }}
          >
            {i}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          className="nm-btn nm-btn-primary"
          style={{ padding: '5px 14px', fontSize: 12 }}
          disabled={!ready || submitting}
          onClick={() => onSubmit(name.trim(), icon)}
        >
          {submitting ? t('saving') : (initial ? t('save') : t('inv_cat_create'))}
        </button>
        <button className="nm-btn nm-btn-ghost" style={{ padding: '5px 12px', fontSize: 12 }} onClick={onCancel}>
          {t('cancel')}
        </button>
        {error && <span style={{ fontSize: 12, color: '#ef4444' }}>{error}</span>}
      </div>
    </div>
  );
}

function VlanRow({ v, categories, isAdmin, pending, onSaved, onShowDevices, onNewCategory }) {
  const { t } = useTranslation();
  const [name, setName]         = useState(v.name);
  const [category, setCategory] = useState(v.category);
  const [force, setForce]       = useState(!!v.force);
  const [saving, setSaving]     = useState(false);
  const [status, setStatus]     = useState('');

  useEffect(() => { setName(v.name); setCategory(v.category); setForce(!!v.force); }, [v.name, v.category, v.force]);

  // A category just created from this row's dropdown is selected for it (not saved yet).
  useEffect(() => {
    if (pending && pending.vlanId === v.vlan_id) { setCategory(pending.key); setStatus(''); }
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = name.trim() !== v.name || category !== v.category || (category ? force !== !!v.force : false);

  async function save() {
    setSaving(true);
    setStatus('');
    try {
      await api.put(`/inventory/vlans/${v.vlan_id}`, { name: name.trim(), category, force: category ? force : false });
      setStatus('ok');
      onSaved();
    } catch (e) {
      setStatus(e?.response?.data?.error || t('error'));
    } finally {
      setSaving(false);
    }
  }

  const cell = { padding: '7px 12px', borderBottom: '1px solid var(--border)' };
  const num  = { ...cell, color: 'var(--text-muted)', textAlign: 'end', fontVariantNumeric: 'tabular-nums' };

  const current = categories.find(c => c.key === v.category);
  const currentInfo = current ? catInfo(current.key, t, current.custom ? current : null) : null;

  return (
    <tr>
      <td style={{ ...cell, fontFamily: 'monospace', fontWeight: 600 }}>{v.vlan_id}</td>
      <td style={cell}>
        {isAdmin ? (
          <input
            value={name}
            maxLength={64}
            onChange={e => { setName(e.target.value); setStatus(''); }}
            onKeyDown={e => { if (e.key === 'Enter' && dirty) save(); }}
            placeholder={t('inv_vlan_name_ph')}
            style={{ ...inputStyle, width: 220 }}
          />
        ) : (v.name || <span style={{ color: 'var(--text-muted)' }}>—</span>)}
      </td>
      <td style={cell}>
        {isAdmin ? (
          <select
            value={category}
            onChange={e => {
              if (e.target.value === NEW_CATEGORY) { onNewCategory(v.vlan_id); return; }
              setCategory(e.target.value);
              setStatus('');
            }}
            style={inputStyle}
          >
            <option value="">{t('inv_vlan_no_category')}</option>
            {categories.map(c => {
              const i = catInfo(c.key, t, c.custom ? c : null);
              return <option key={c.key} value={c.key}>{i.icon} {i.label}</option>;
            })}
            <option value={NEW_CATEGORY}>➕ {t('inv_cat_new_option')}</option>
          </select>
        ) : (currentInfo ? `${currentInfo.icon} ${currentInfo.label}` : '—')}
      </td>
      <td style={{ ...cell, textAlign: 'center' }}>
        {isAdmin ? (
          <input
            type="checkbox"
            checked={!!category && force}
            disabled={!category}
            onChange={e => { setForce(e.target.checked); setStatus(''); }}
            title={t('inv_vlan_force_tip')}
            aria-label={t('inv_vlan_force')}
          />
        ) : (v.force ? '✓' : '')}
      </td>
      <td style={num}>{v.endpoints.toLocaleString()}</td>
      <td style={{ ...num, color: v.unknown ? CAT_META.Unknown.color : 'var(--text-muted)' }}>{v.unknown.toLocaleString()}</td>
      <td style={num}>{v.ports.toLocaleString()}</td>
      <td style={num}>{v.switches.toLocaleString()}</td>
      <td style={{ ...cell, whiteSpace: 'nowrap', minWidth: isAdmin ? 250 : 0 }}>
        {isAdmin && (
          <button
            className="nm-btn nm-btn-primary"
            style={{ padding: '4px 12px', fontSize: 12, marginInlineEnd: 6 }}
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? t('saving') : t('save')}
          </button>
        )}
        {v.endpoints > 0 && (
          <button
            className="nm-btn nm-btn-ghost"
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={() => onShowDevices(v.vlan_id)}
          >
            {t('inv_vlan_show')}
          </button>
        )}
        {status === 'ok' && <span style={{ marginInlineStart: 8, fontSize: 12, color: '#10b981' }}>✓ {t('inv_vlan_saved')}</span>}
        {status && status !== 'ok' && <span style={{ marginInlineStart: 8, fontSize: 12, color: '#ef4444' }}>{status}</span>}
      </td>
    </tr>
  );
}

function VlanTab({ isAdmin, onSaved, onShowDevices }) {
  const { t } = useTranslation();
  const [data, setData]       = useState(null);
  const [error, setError]     = useState('');
  const [filter, setFilter]   = useState('');
  const [form, setForm]       = useState(null);   // null | { edit?: category, forVlan?: number }
  const [formError, setFormError]     = useState('');
  const [submitting, setSubmitting]   = useState(false);
  const [pending, setPending]         = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api.get('/inventory/vlans');
      setData(r.data);
    } catch (_) {
      setError(t('error'));
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  function handleSaved() {
    load();
    onSaved();
  }

  function openForm(next) { setFormError(''); setForm(next); }

  async function submitForm(name, icon) {
    setSubmitting(true);
    setFormError('');
    try {
      if (form.edit) {
        await api.put(`/inventory/categories/${form.edit.id}`, { name, icon });
      } else {
        const r = await api.post('/inventory/categories', { name, icon });
        if (form.forVlan) setPending({ vlanId: form.forVlan, key: r.data.key, n: Date.now() });
      }
      setForm(null);
      handleSaved();
    } catch (e) {
      setFormError(e?.response?.data?.error || t('error'));
    } finally {
      setSubmitting(false);
    }
  }

  async function removeCategory(c) {
    const used = data.vlans.filter(v => v.category === c.key).length;
    if (!window.confirm(t('inv_cat_delete_confirm', { name: c.label, count: used }))) return;
    try {
      await api.delete(`/inventory/categories/${c.id}`);
      handleSaved();
    } catch (e) {
      setFormError(e?.response?.data?.error || t('error'));
    }
  }

  if (error)  return <div style={{ color: '#ef4444' }}>{error}</div>;
  if (!data)  return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{t('loading')}</div>;

  const q = filter.trim().toLowerCase();
  const vlans = q
    ? data.vlans.filter(v => String(v.vlan_id).includes(q) || (v.name || '').toLowerCase().includes(q))
    : data.vlans;

  const customCats = data.categories.filter(c => c.custom);

  const th = { padding: '10px 12px', textAlign: 'start', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' };
  const thNum = { ...th, textAlign: 'end' };

  return (
    <>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-muted)', maxWidth: 820 }}>
        {t('inv_vlans_hint')}
        {!isAdmin && <><br />{t('inv_vlan_readonly')}</>}
      </p>

      {/* Custom categories */}
      {(isAdmin || customCats.length > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('inv_cat_custom')}:</span>
          {customCats.map(c => (
            <span
              key={c.key}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 12,
                fontSize: 12, background: `${c.color}22`, border: `1px solid ${c.color}55`, color: c.color,
              }}
            >
              {c.icon} {c.label}
              {isAdmin && (
                <>
                  <span role="button" title={t('inv_cat_edit')} onClick={() => openForm({ edit: c })}
                        style={{ cursor: 'pointer', opacity: 0.8 }}>✏️</span>
                  <span role="button" title={t('inv_cat_delete')} onClick={() => removeCategory(c)}
                        style={{ cursor: 'pointer', opacity: 0.8 }}>✕</span>
                </>
              )}
            </span>
          ))}
          {isAdmin && (
            <button className="nm-btn nm-btn-ghost" style={{ padding: '3px 12px', fontSize: 12 }}
                    onClick={() => openForm({})}>
              ➕ {t('inv_cat_new_option')}
            </button>
          )}
        </div>
      )}

      {form && (
        <CategoryForm
          key={form.edit ? form.edit.key : `new-${form.forVlan || 0}`}
          icons={data.icons}
          initial={form.edit}
          submitting={submitting}
          error={formError}
          onSubmit={submitForm}
          onCancel={() => setForm(null)}
        />
      )}
      {!form && formError && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 10 }}>{formError}</div>}

      <div style={{ marginBottom: 14 }}>
        <input
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder={`🔍 ${t('inv_vlan_search_ph')}`}
          style={{ ...inputStyle, width: 280, padding: '7px 12px', fontSize: 13 }}
        />
      </div>
      <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg-hover)', borderBottom: '1px solid var(--border)' }}>
                <th style={th}>VLAN</th>
                <th style={th}>{t('inv_vlan_name')}</th>
                <th style={th}>{t('inv_vlan_category')}</th>
                <th style={{ ...th, textAlign: 'center' }} title={t('inv_vlan_force_tip')}>{t('inv_vlan_force')}</th>
                <th style={thNum}>{t('inv_vlan_endpoints')}</th>
                <th style={thNum}>{t('inv_vlan_unknown')}</th>
                <th style={thNum}>{t('inv_vlan_ports')}</th>
                <th style={thNum}>{t('inv_vlan_switches')}</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {vlans.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ padding: '20px 12px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    {t('no_data')}
                  </td>
                </tr>
              ) : vlans.map(v => (
                <VlanRow
                  key={v.vlan_id}
                  v={v}
                  categories={data.categories}
                  isAdmin={isAdmin}
                  pending={pending}
                  onSaved={handleSaved}
                  onShowDevices={onShowDevices}
                  onNewCategory={vlanId => openForm({ forVlan: vlanId })}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ---- Main page ----

export default function InventoryPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [tab, setTab]                 = useState('devices');
  const [vlanFilter, setVlanFilter]   = useState(null);
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
  const loadRows = useCallback(async (cat, q, pg, vlan) => {
    setLoadingRows(true);
    try {
      const r = await api.get('/inventory/entries', {
        params: { category: cat === 'All' ? '' : cat, search: q, page: pg, limit: LIMIT, vlan: vlan || '' },
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
      loadRows(selectedCat, search, 1, vlanFilter);
    }, 300);
    return () => clearTimeout(timer);
  }, [search, selectedCat, vlanFilter, loadRows]);

  // When page changes
  useEffect(() => {
    loadRows(selectedCat, search, page, vlanFilter);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleCatClick(cat) {
    const next = selectedCat === cat ? 'All' : cat;
    setSelectedCat(next);
    setPage(1);
  }

  function showVlanDevices(vlan) {
    setVlanFilter(vlan);
    setSelectedCat('All');
    setSearch('');
    setTab('devices');
  }

  // A VLAN category re-classifies Unknown rows, so the cards and table both change.
  function handleVlanSaved() {
    loadSummary();
    loadRows(selectedCat, search, page, vlanFilter);
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

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>
        <TabButton active={tab === 'devices'} onClick={() => setTab('devices')}>{t('inv_tab_devices')}</TabButton>
        <TabButton active={tab === 'vlans'} onClick={() => setTab('vlans')}>{t('inv_tab_vlans')}</TabButton>
      </div>

      {tab === 'vlans' && (
        <VlanTab isAdmin={isAdmin} onSaved={handleVlanSaved} onShowDevices={showVlanDevices} />
      )}

      <div style={{ display: tab === 'devices' ? 'block' : 'none' }}>

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
            {summary.categories.map(cat => {
              const info = catInfo(cat.name, t, cat.custom ? cat : null);
              return (
                <SummaryCard
                  key={cat.name}
                  name={info.label}
                  count={cat.count || 0}
                  icon={info.icon}
                  color={info.color}
                  selected={selectedCat === cat.name}
                  onClick={() => handleCatClick(cat.name)}
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
        {vlanFilter && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '4px 10px', borderRadius: 12, fontSize: 12,
            background: 'var(--bg-hover)', border: '1px solid var(--accent)', color: 'var(--text-primary)',
          }}>
            {t('inv_vlan_filter', { vlan: vlanFilter })}
            <span
              onClick={() => { setVlanFilter(null); setPage(1); }}
              style={{ cursor: 'pointer', color: 'var(--accent)', textDecoration: 'underline' }}
            >
              {t('inv_vlan_clear')}
            </span>
          </span>
        )}
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
                  t('inv_col_vlan'),
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
                  <td colSpan={8} style={{ padding: '20px 12px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    {t('no_data')}
                  </td>
                </tr>
              ) : rows.map((r, i) => {
                const meta = catInfo(r.category, t, r.category_meta);
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
                      <span
                        title={r.category_source === 'vlan' ? t('inv_vlan_by_vlan') : undefined}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '2px 8px', borderRadius: 10, fontSize: 11,
                          background: `${meta.color}22`,
                          border: `1px ${r.category_source === 'vlan' ? 'dashed' : 'solid'} ${meta.color}${r.category_source === 'vlan' ? '' : '55'}`,
                          color: meta.color,
                        }}
                      >
                        {meta.icon} {meta.label}
                      </span>
                    </td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', fontSize: 11 }}>
                      {r.vlan ? (
                        <span
                          onClick={() => { setVlanFilter(r.vlan); setPage(1); }}
                          style={{ cursor: 'pointer' }}
                        >
                          <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>{r.vlan}</span>
                          {r.vlan_name && <span style={{ color: 'var(--text-muted)' }}> · {r.vlan_name}</span>}
                        </span>
                      ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
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
    </div>
  );
}
