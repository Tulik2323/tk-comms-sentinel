// DevicesPage — רשימת כל המכשירים עם filter ו-drill-down
import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../lib/i18n';
import { useDevices } from '../hooks/useDevices';
import { useAuth } from '../hooks/useAuth';
import StatusDot from '../components/ui/StatusDot';
import Modal from '../components/ui/Modal';
import { formatBps, formatUptime } from '../lib/api';
import api from '../lib/api';

function AddDeviceModal({ open, onClose, onAdded }) {
  const { t } = useTranslation();
  const [form, setForm]   = useState({
    ip: '', name: '', community: 'public', snmp_version: 'v2c',
    poll_interval_sec: 300, location: '', notes: ''
  });
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/devices', form);
      onAdded();
      onClose();
      setForm({ ip: '', name: '', community: 'public', snmp_version: 'v2c', poll_interval_sec: 300, location: '', notes: '' });
    } catch (err) {
      setError(err.response?.data?.error || t('error'));
    } finally {
      setLoading(false);
    }
  }

  const field = (label, key, type = 'text', extra = {}) => (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
        {label}
      </label>
      <input
        className="nm-input"
        type={type}
        value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        {...extra}
      />
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={t('add_device_title')}>
      {error && (
        <div style={{ background: '#7f1d1d', color: '#fecaca', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}
      <form onSubmit={submit}>
        {field(t('ip_address_req'), 'ip', 'text', { required: true, placeholder: '192.168.1.1' })}
        {field(t('name_optional'), 'name', 'text', { placeholder: 'Core-SW-01' })}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t('snmp_version_label')}</label>
          <select
            className="nm-input"
            value={form.snmp_version}
            onChange={e => setForm(f => ({ ...f, snmp_version: e.target.value }))}
          >
            <option value="v2c">v2c (Community String)</option>
            <option value="v3">{t('snmp_v3_secure')}</option>
          </select>
        </div>
        {form.snmp_version === 'v2c'
          ? field('Community String', 'community', 'text', { placeholder: 'public' })
          : <>
            {field('SNMPv3 Username', 'snmp_v3_user')}
            {field('Auth Password', 'snmp_v3_auth', 'password')}
            {field('Priv Password', 'snmp_v3_priv', 'password')}
          </>
        }
        {field(t('poll_interval_label'), 'poll_interval_sec', 'number', { min: 30 })}
        {field(t('location_label'), 'location', 'text', { placeholder: t('location_ph') })}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" className="nm-btn nm-btn-ghost" onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className="nm-btn nm-btn-primary" disabled={loading}>
            {loading ? t('adding') : t('add_device_btn')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ScanModal({ open, onClose, onDone }) {
  const { t } = useTranslation();
  const [startIp,     setStartIp]     = useState('');
  const [endIp,       setEndIp]       = useState('');
  const [cidr,        setCidr]        = useState('');
  const [community,   setCommunity]   = useState('public');
  const [snmpVersion, setSnmpVersion] = useState('v2c');
  const [loading,     setLoading]     = useState(false);
  const [result,      setResult]      = useState(null);
  const [error,       setError]       = useState('');

  function reset() {
    setResult(null); setError('');
  }

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    reset();
    try {
      const body = cidr
        ? { cidr, community, snmp_version: snmpVersion }
        : { start_ip: startIp, end_ip: endIp, community, snmp_version: snmpVersion };
      const res = await api.post('/devices/scan', body);
      setResult(res.data);
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || t('scan_error'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`🔍 ${t('scan_network_title')}`}>
      {!result ? (
      <form onSubmit={submit}>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
            {t('cidr_label')}
          </label>
          <input className="nm-input" value={cidr} onChange={e => { setCidr(e.target.value); if (e.target.value) { setStartIp(''); setEndIp(''); } }} placeholder="10.221.0.0/24" />
        </div>
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginBottom: 8 }}>— {t('or_word')} —</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>{t('ip_start')}</label>
            <input className="nm-input" value={startIp} onChange={e => { setStartIp(e.target.value); if (e.target.value) setCidr(''); }} placeholder="10.221.0.1" />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>{t('ip_end')}</label>
            <input className="nm-input" value={endIp} onChange={e => { setEndIp(e.target.value); if (e.target.value) setCidr(''); }} placeholder="10.221.0.254" />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Community String:</label>
            <input className="nm-input" value={community} onChange={e => setCommunity(e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>SNMP Version:</label>
            <select className="nm-input" value={snmpVersion} onChange={e => setSnmpVersion(e.target.value)}>
              <option value="v2c">v2c</option>
              <option value="v3">v3</option>
            </select>
          </div>
        </div>
        {loading && (
          <div style={{ padding: '10px 12px', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)',
                        borderRadius: 6, marginBottom: 12, fontSize: 13, color: 'var(--accent)', textAlign: 'center' }}>
            ⏳ {t('scan_in_progress')}
          </div>
        )}
        {error && (
          <div style={{ padding: '8px 12px', background: 'rgba(127,29,29,0.25)', border: '1px solid #b91c1c',
                        color: '#fecaca', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="nm-btn nm-btn-ghost" onClick={onClose}>{t('close_btn')}</button>
          <button type="submit" className="nm-btn nm-btn-primary" disabled={loading}>
            {loading ? `⏳ ${t('scanning')}` : `🔍 ${t('scan')}`}
          </button>
        </div>
      </form>
      ) : (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
            {[[t('scanned_label'), result.total], [t('snmp_responded'), result.found], [t('newly_added'), result.added]].map(([label, val]) => (
              <div key={label} style={{ textAlign: 'center', padding: '12px 8px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: val > 0 ? 'var(--accent)' : 'var(--text-primary)' }}>{val}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>
          {result.devices?.length > 0 && (
            <div style={{ maxHeight: 160, overflowY: 'auto', marginBottom: 16 }}>
              {result.devices.map(ip => (
                <div key={ip} style={{ fontFamily: 'monospace', fontSize: 12, padding: '3px 8px',
                                       borderRadius: 4, background: 'rgba(0,128,255,0.08)', marginBottom: 3 }}>
                  ✅ {ip}
                </div>
              ))}
            </div>
          )}
          {result.found === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16, textAlign: 'center' }}>
              {t('no_snmp_found')}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="nm-btn nm-btn-ghost" onClick={() => reset()}>{t('scan_again')}</button>
            <button className="nm-btn nm-btn-primary" onClick={onClose}>{t('close_btn')}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// מודל עריכת מכשיר קיים
function EditDeviceModal({ device, onClose, onSaved }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    ip:               device.ip           || '',
    name:             device.name         || '',
    community:        '',   // השרת לא מחזיר את ה-community; ריק = ללא שינוי
    snmp_version:     device.snmp_version || 'v2c',
    snmp_v3_user:     device.snmp_v3_user || '',
    snmp_v3_auth:     '',
    snmp_v3_priv:     '',
    poll_interval_sec: device.poll_interval_sec || 300,
    location:         device.location     || '',
    notes:            device.notes        || '',
  });
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // שלח רק שדות שאינם ריקים (אל תדרוס סיסמאות v3 ריקות)
      const body = { ...form };
      if (!body.community)    delete body.community;
      if (!body.snmp_v3_auth) delete body.snmp_v3_auth;
      if (!body.snmp_v3_priv) delete body.snmp_v3_priv;
      await api.put(`/devices/${device.id}`, body);
      onSaved();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || t('save_error'));
    } finally {
      setLoading(false);
    }
  }

  const field = (label, key, type = 'text', extra = {}) => (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</label>
      <input
        className="nm-input"
        type={type}
        value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        {...extra}
      />
    </div>
  );

  return (
    <Modal open onClose={onClose} title={`✏️ ${t('edit_device_title')} — ${device.name || device.ip}`}>
      {error && (
        <div style={{ background: '#7f1d1d', color: '#fecaca', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}
      <form onSubmit={submit}>
        {field(t('ip_address_req'), 'ip', 'text', { required: true })}
        {field(t('col_name'), 'name', 'text', { placeholder: 'Core-SW-01' })}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t('snmp_version_label')}</label>
          <select className="nm-input" value={form.snmp_version} onChange={e => setForm(f => ({ ...f, snmp_version: e.target.value }))}>
            <option value="v2c">v2c (Community String)</option>
            <option value="v3">{t('snmp_v3_secure')}</option>
          </select>
        </div>
        {form.snmp_version === 'v2c'
          ? field(t('keep_existing_community'), 'community', 'password')
          : <>
            {field('SNMPv3 Username', 'snmp_v3_user')}
            {field(t('keep_existing_auth'), 'snmp_v3_auth', 'password')}
            {field(t('keep_existing_priv'), 'snmp_v3_priv', 'password')}
          </>
        }
        {field(t('poll_interval_label'), 'poll_interval_sec', 'number', { min: 30 })}
        {field(t('location_label'), 'location', 'text', { placeholder: t('location_ph') })}
        {field(t('notes_label'), 'notes', 'text')}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" className="nm-btn nm-btn-ghost" onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className="nm-btn nm-btn-primary" disabled={loading}>
            {loading ? t('saving') : `💾 ${t('save')}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// מודל ייבוא CSV
function CsvImportModal({ open, onClose, onImported }) {
  const { t } = useTranslation();
  const [csvText,  setCsvText]  = useState('');
  const [loading,  setLoading]  = useState(false);
  const [result,   setResult]   = useState(null);
  const [error,    setError]    = useState('');

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setCsvText(ev.target.result);
    reader.readAsText(file, 'UTF-8');
  }

  async function submit(e) {
    e.preventDefault();
    if (!csvText.trim()) { setError(t('enter_csv_content')); return; }
    setError('');
    setLoading(true);
    setResult(null);
    try {
      const res = await api.post('/devices/import-csv', { csv: csvText });
      setResult(res.data);
      onImported();
    } catch (err) {
      setError(err.response?.data?.error || t('import_error'));
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setCsvText(''); setResult(null); setError('');
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title={`📥 ${t('import_csv_title')}`}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, background: 'var(--bg-secondary)', padding: '8px 12px', borderRadius: 6 }}>
        {t('csv_format_hint')} <code>ip,name,community,snmp_version,location</code><br />
        {t('csv_example')} <code>10.221.0.1,Core-SW-01,POCrd19,v2c,Floor 1</code><br />
        {t('csv_comment_hint')} <code>snmp_version</code> {t('csv_default')}
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
          {t('upload_csv')}
        </label>
        <input type="file" accept=".csv,.txt" onChange={handleFile}
          style={{ fontSize: 12, color: 'var(--text-secondary)' }} />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
          {t('paste_csv')}
        </label>
        <textarea
          className="nm-input"
          rows={8}
          style={{ fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
          value={csvText}
          onChange={e => setCsvText(e.target.value)}
          placeholder={'192.168.1.1,SW-Core,public,DC\n192.168.1.2,SW-Floor1,public,Floor 1'}
        />
      </div>
      {error && (
        <div style={{ background: '#7f1d1d', color: '#fecaca', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}
      {result && (
        <div style={{ background: '#14532d', color: '#bbf7d0', padding: '10px 14px', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          ✅ {t('added_label')}: {result.added?.length || 0} &nbsp;|&nbsp;
          {t('existing_label')}: {result.skipped?.length || 0} &nbsp;|&nbsp;
          {t('errors_label')}: {result.errors?.length || 0}
          {result.added?.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 11, color: '#86efac' }}>
              {result.added.join(', ')}
            </div>
          )}
          {result.errors?.length > 0 && (
            <button className="nm-btn nm-btn-ghost" style={{ marginTop: 8, fontSize: 11, padding: '4px 10px' }}
              onClick={() => {
                const csv = '﻿ip,error\n' + result.errors.map(e => `${e.ip},"${(e.error||'').replace(/"/g,'""')}"`).join('\n');
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
                const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
                a.download = 'import_errors.csv'; a.click();
              }}>
              ⬇ {t('download_errors', { count: result.errors.length })}
            </button>
          )}
        </div>
      )}
      <form onSubmit={submit}>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="nm-btn nm-btn-ghost" onClick={handleClose}>{t('close_btn')}</button>
          <button type="submit" className="nm-btn nm-btn-primary" disabled={loading || !!result}>
            {loading ? t('importing') : `📥 ${t('import')}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function DevicesPage() {
  const { t }                = useTranslation();
  const { user }             = useAuth();
  const { devices, loading, refetch } = useDevices(30);
  const [searchParams]       = useSearchParams();

  const [search, setSearch]     = useState('');
  const [filter, setFilter]     = useState(searchParams.get('status') || 'all');
  const [addOpen,      setAddOpen]      = useState(false);
  const [scanOpen,     setScanOpen]     = useState(false);
  const [csvOpen,      setCsvOpen]      = useState(false);
  const [watchdogOpen,    setWatchdogOpen]    = useState(false);
  const [watchdogDeviceId, setWatchdogDeviceId] = useState(null);
  const [editDevice, setEditDevice] = useState(null);
  const [sortKey, setSortKey]         = useState('name');
  const [tempFilter, setTempFilter]   = useState(false);
  const [endpResults, setEndpResults] = useState(null); // תוצאות חיפוש endpoint
  const endpTimer = useRef(null);
  const [pollingIds, setPollingIds] = useState(new Set());
  const [sortDir, setSortDir] = useState('asc');

  const isAdmin = user?.role === 'admin';

  async function checkDevice(id) {
    setPollingIds(s => new Set(s).add(id));
    try {
      await api.post(`/devices/${id}/poll`);
      await refetch();
    } catch (_) {}
    setPollingIds(s => { const n = new Set(s); n.delete(id); return n; });
  }

  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  // סנכרן filter כש-URL params משתנים (ניווט מdashboard)
  useEffect(() => {
    const s = searchParams.get('status');
    if (s) setFilter(s);
  }, [searchParams]);

  // פתח Port Watchdog כש-URL כולל ?watchdog=1 (ניווט מדף ההתראות)
  useEffect(() => {
    if (searchParams.get('watchdog') === '1') {
      const devId = searchParams.get('device') || null;
      setWatchdogDeviceId(devId);
      setWatchdogOpen(true);
    }
  }, [searchParams]);

  function onSearchChange(val) {
    setSearch(val);
    clearTimeout(endpTimer.current);
    if (val.trim().length < 3) { setEndpResults(null); return; }
    endpTimer.current = setTimeout(async () => {
      try {
        const r = await api.get(`/devices/endpoint-search?q=${encodeURIComponent(val.trim())}`);
        setEndpResults(r.data.length > 0 ? r.data : null);
      } catch { setEndpResults(null); }
    }, 350);
  }

  const getTemp = (d) => {
    try { const h = JSON.parse(d.hw_status || 'null'); return h?.temps?.[0]?.celsius ?? null; }
    catch { return null; }
  };

  const filtered = devices.filter(d => {
    const matchStatus = filter === 'all' || d.status === filter;
    const q = search.toLowerCase();
    const matchSearch = !q ||
      (d.name || '').toLowerCase().includes(q) ||
      d.ip.includes(q) ||
      (d.sys_name || '').toLowerCase().includes(q) ||
      (d.location || '').toLowerCase().includes(q);
    const matchTemp = !tempFilter || (getTemp(d) != null && getTemp(d) > 50);
    return matchStatus && matchSearch && matchTemp;
  });

  // IP חייב מיון מספרי לפי אוקטטות. מיון טקסטואלי היה מציב
  // 10.221.0.106 לפני 10.221.0.25, וזה בדיוק מה שמקשה למצוא מכשיר.
  const ipToNum = (ip) =>
    String(ip || '').split('.').reduce((acc, o) => acc * 256 + (parseInt(o, 10) || 0), 0);

  const SORTERS = {
    status:   d => (d.status === 'up' ? 0 : d.status === 'down' ? 2 : 1),
    name:     d => (d.name || d.sys_name || '').toLowerCase(),
    model:    d => (d.model || '').toLowerCase(),
    ip:       d => ipToNum(d.ip),
    in_bps:   d => Number(d.total_in_bps)  || 0,
    out_bps:  d => Number(d.total_out_bps) || 0,
    cpu:      d => (d.cpu_pct == null ? -1 : Number(d.cpu_pct)),
    uptime:   d => (d.uptime_sec == null ? -1 : Number(d.uptime_sec)),
    location: d => (d.location || '').toLowerCase(),
    temp:     d => { try { const h = JSON.parse(d.hw_status||'null'); return h?.temps?.[0]?.celsius ?? -1; } catch { return -1; } },
  };

  const sorted = [...filtered].sort((a, b) => {
    const get = SORTERS[sortKey] || SORTERS.name;
    const va = get(a), vb = get(b);
    let cmp;
    if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
    else cmp = String(va).localeCompare(String(vb), 'he', { numeric: true });
    return sortDir === 'asc' ? cmp : -cmp;
  });

  async function deleteDevice(id, e) {
    e.preventDefault();
    if (!window.confirm(t('confirm_delete'))) return;
    await api.delete(`/devices/${id}`);
    refetch();
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>🖧 {t('devices')} ({devices.length})</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {isAdmin && <>
            <button onClick={() => setScanOpen(true)} className="nm-btn nm-btn-ghost">🔍 {t('scan')}</button>
            <button onClick={() => setCsvOpen(true)} className="nm-btn nm-btn-ghost">📥 {t('import_csv')}</button>
            <button onClick={() => setWatchdogOpen(true)} className="nm-btn nm-btn-ghost" title="Port Watchdog">🔌 Watchdog</button>
          </>}
          <button onClick={() => {
            const token = localStorage.getItem('nm_token');
            fetch('/api/devices/export', { headers: { Authorization: `Bearer ${token}` } })
              .then(r => r.blob()).then(blob => {
                const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
                a.download = 'devices_export.csv'; a.click();
              });
          }} className="nm-btn nm-btn-ghost">⬇ {t('export_btn')}</button>
          {isAdmin && (
            <button onClick={() => setAddOpen(true)} className="nm-btn nm-btn-primary">+ {t('add')}</button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <div style={{ position: 'relative' }}>
          <input
            className="nm-input"
            style={{ maxWidth: 280 }}
            placeholder={`🔎 ${t('search_device_ph')}`}
            value={search}
            onChange={e => onSearchChange(e.target.value)}
          />
          {endpResults && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, zIndex: 200,
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
              minWidth: 380, maxWidth: 480, marginTop: 4,
            }}>
              <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
                🖥️ {t('endpoints_found', { count: endpResults.length })}
              </div>
              {endpResults.map((r, i) => (
                <Link
                  key={i}
                  to={`/devices/${r.device_id}${r.phys_if_index ? `?port=${r.phys_if_index}` : ''}`}
                  onClick={() => { setEndpResults(null); setSearch(''); }}
                  style={{ display: 'block', textDecoration: 'none', padding: '9px 14px',
                    borderBottom: i < endpResults.length - 1 ? '1px solid var(--border)' : 'none',
                    color: 'var(--text-primary)',
                    opacity: r.is_uplink ? 0.55 : 1,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontFamily: 'monospace', color: 'var(--accent)', fontSize: 13 }}>
                        {r.ip_address || r.mac_address}
                      </span>
                      {r.hostname && (
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginInlineStart: 8 }}>
                          {r.hostname}
                        </span>
                      )}
                      {r.ip_address && r.mac_address && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginInlineStart: 8 }}>
                          {r.mac_address}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'end' }}>
                      {r.device_name || r.device_ip}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{t('port_label')}: {r.if_alias || r.if_name || (r.phys_if_index ? `if_index ${r.phys_if_index}` : '—')}</span>
                    {r.phys_if_index != null && (
                      r.is_uplink ? (
                        <span style={{ fontSize: 10, color: '#94a3b8' }}>
                          ⬆ uplink{r.macs_on_port != null ? ` · ${r.macs_on_port} MAC` : ''}
                        </span>
                      ) : (
                        <span style={{ fontSize: 10, color: '#4ade80', fontWeight: 600 }}>
                          🔌 {t('edge_port')}{r.macs_on_port != null ? ` · ${r.macs_on_port} MAC` : ''}
                        </span>
                      )
                    )}
                  </div>
                </Link>
              ))}
              <div style={{ padding: '6px 14px', borderTop: '1px solid var(--border)' }}>
                <button onClick={() => setEndpResults(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)' }}>
                  {t('close_btn')}
                </button>
              </div>
            </div>
          )}
        </div>
        {['all','up','down'].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`nm-btn ${filter === f ? 'nm-btn-primary' : 'nm-btn-ghost'}`}
            style={{ padding: '6px 14px' }}
          >
            {f === 'all' ? t('filter_all') : f === 'up' ? `✅ ${t('filter_up')}` : `❌ ${t('filter_down')}`}
          </button>
        ))}
        <button
          onClick={() => setTempFilter(tf => !tf)}
          className={`nm-btn ${tempFilter ? 'nm-btn-primary' : 'nm-btn-ghost'}`}
          style={{ padding: '6px 14px' }}
        >
          🌡️ {t('temp_filter')}
        </button>
        <button onClick={refetch} className="nm-btn nm-btn-ghost" title={t('refresh')}>↺</button>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)', padding: 20 }}>{t('loading')}</div>
      ) : (
        <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="nm-table">
            <thead>
              <tr>
                {[
                  ['status',   t('status')],
                  ['name',     t('col_name')],
                  ['model',    t('col_model')],
                  ['ip',       'IP'],
                  ['in_bps',   `${t('col_traffic')} ↓`],
                  ['out_bps',  `${t('col_traffic')} ↑`],
                  ['cpu',      'CPU'],
                  ['uptime',   t('col_uptime')],
                  ['temp',     t('col_temp')],
                  ['location', t('col_location')],
                ].map(([key, label]) => (
                  <th
                    key={key}
                    onClick={() => toggleSort(key)}
                    title={t('sort_hint')}
                    style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                  >
                    {label}
                    <span style={{
                      marginInlineStart: 5,
                      opacity: sortKey === key ? 1 : 0.25,
                      color: sortKey === key ? 'var(--accent)' : 'inherit',
                    }}>
                      {sortKey === key ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                    </span>
                  </th>
                ))}
                {isAdmin && <th>{t('col_actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 10 : 9} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
                    {t('no_data')}
                  </td>
                </tr>
              ) : sorted.map(d => (
                <tr key={d.id}>
                  <td>
                    <StatusDot status={d.status} pulse />
                  </td>
                  <td>
                    <Link to={`/devices/${d.id}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>
                      {d.name || d.sys_name || '—'}
                    </Link>
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.model || '—'}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{d.ip}</td>
                  <td style={{ color: '#22c55e', fontFamily: 'monospace', fontSize: 12 }}>
                    {formatBps(d.total_in_bps)}
                  </td>
                  <td style={{ color: '#3b82f6', fontFamily: 'monospace', fontSize: 12 }}>
                    {formatBps(d.total_out_bps)}
                  </td>
                  <td>
                    {d.cpu_pct != null ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{
                          width: 50, height: 6, background: 'var(--border)',
                          borderRadius: 3, overflow: 'hidden',
                        }}>
                          <div style={{
                            width: `${d.cpu_pct}%`, height: '100%',
                            background: d.cpu_pct > 80 ? '#ef4444' : d.cpu_pct > 60 ? '#f97316' : '#22c55e',
                            borderRadius: 3,
                          }} />
                        </div>
                        <span style={{ fontSize: 11 }}>{Math.round(d.cpu_pct)}%</span>
                      </div>
                    ) : '—'}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {formatUptime(d.uptime_sec)}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                    {(() => {
                      const c = getTemp(d);
                      if (c == null) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
                      const color = c > 65 ? '#ef4444' : c > 50 ? '#f97316' : '#22c55e';
                      return <span style={{ color, fontWeight: c > 50 ? 600 : 400 }}>{c}°C</span>;
                    })()}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {d.location || '—'}
                  </td>
                  {isAdmin && (
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {d.status === 'down' && (
                          <button
                            className="nm-btn"
                            style={{ padding: '4px 10px', fontSize: 12, background: '#1d4ed8', color: '#fff', opacity: pollingIds.has(d.id) ? 0.6 : 1 }}
                            disabled={pollingIds.has(d.id)}
                            onClick={() => checkDevice(d.id)}
                          >
                            {pollingIds.has(d.id) ? '⏳' : `🔍 ${t('check_btn')}`}
                          </button>
                        )}
                        <button
                          className="nm-btn nm-btn-ghost"
                          style={{ padding: '4px 10px', fontSize: 12 }}
                          onClick={() => setEditDevice(d)}
                        >
                          ✏️ {t('edit_btn')}
                        </button>
                        <button
                          className="nm-btn nm-btn-danger"
                          style={{ padding: '4px 10px', fontSize: 12 }}
                          onClick={(e) => deleteDevice(d.id, e)}
                        >
                          {t('delete_btn')}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AddDeviceModal open={addOpen} onClose={() => setAddOpen(false)} onAdded={refetch} />
      <ScanModal open={scanOpen} onClose={() => setScanOpen(false)} onDone={refetch} />
      <CsvImportModal open={csvOpen} onClose={() => setCsvOpen(false)} onImported={refetch} />
      <WatchdogModal open={watchdogOpen} onClose={() => { setWatchdogOpen(false); setWatchdogDeviceId(null); }} devices={devices.filter(d => d.status === 'up')} initialDeviceId={watchdogDeviceId} />
      {editDevice && (
        <EditDeviceModal
          device={editDevice}
          onClose={() => setEditDevice(null)}
          onSaved={refetch}
        />
      )}
    </div>
  );
}

// ---- Port Watchdog Modal ----
function WatchdogModal({ open, onClose, devices, initialDeviceId }) {
  const { t } = useTranslation();
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [running,     setRunning]     = useState(false);
  const [baseline,    setBaseline]    = useState(null);
  const [current,     setCurrent]     = useState(null);
  const [changed,     setChanged]     = useState([]);
  const [error,       setError]       = useState('');
  const [devSearch,   setDevSearch]   = useState('');   // #1 — סינון רשימת המתגים
  const [notifyOk,    setNotifyOk]    = useState(false); // האם התראות דפדפן אושרו
  const intervalRef  = useRef(null);
  const inFlightRef   = useRef(false); // האם קריאת סטטוס עדיין רצה (מונע חפיפת טיקים)
  const prevIdxRef    = useRef(null);  // מצב הפורטים ב-poll הקודם — להשוואת מעברים
  const audioCtx     = useRef(null);

  // צליל התראה קצר דרך Web Audio — בלי קובץ חיצוני. ירידה = צליל נמוך כפול
  // (מדאיג יותר), עלייה = צליל גבוה בודד.
  function beep(kind) {
    try {
      if (!audioCtx.current) {
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx.current = new AC();
      }
      const ctx = audioCtx.current;
      const play = (freq, at, dur) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
        gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
        osc.start(ctx.currentTime + at);
        osc.stop(ctx.currentTime + at + dur + 0.02);
      };
      if (kind === 'down') { play(392, 0, 0.18); play(294, 0.22, 0.28); }
      else { play(784, 0, 0.22); }
    } catch (_) {}
  }

  // התראה על שינוי בודד — צליל + Notification של הדפדפן (קופצת גם כשה-tab
  // ברקע / החלון ממוזער, בדיוק לתרחיש "מנתקים כבל בארון ורצים לראות").
  function notifyChange(c) {
    beep(c.curr === 'down' ? 'down' : 'up');
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(
          c.curr === 'down' ? `🔴 ${i18n.t('notif_port_down')}` : `🟢 ${i18n.t('notif_port_up')}`,
          { body: `${c.name}\n${i18n.t('port_label')} ${c.if_name} · ${c.ts}`, tag: `${c.deviceId}_${c.if_index}` }
        );
        setTimeout(() => { try { n.close(); } catch (_) {} }, 8000);
      }
    } catch (_) {}
  }

  // כש-modal נפתח עם initialDeviceId (ניווט מהתראה) — טען אוטומטית
  useEffect(() => {
    if (open && initialDeviceId) {
      setSelectedIds(new Set([String(initialDeviceId)]));
    } else if (!open) {
      setSelectedIds(new Set());
    }
  }, [open, initialDeviceId]);

  const token = localStorage.getItem('nm_token');

  const MAX_SELECT = 5;

  function toggleDevice(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); }
      else if (next.size < MAX_SELECT) { next.add(id); }
      return next;
    });
    reset();
  }

  async function fetchStatuses(ids) {
    const results = {};
    await Promise.all(ids.map(async (id) => {
      try {
        const r = await fetch(`/api/devices/${id}/ports/live-status`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (r.ok) results[id] = await r.json();
      } catch (_) {}
    }));
    return results;
  }

  function buildIndex(data) {
    const idx = {};
    for (const [devId, ports] of Object.entries(data)) {
      idx[devId] = {};
      for (const p of ports) idx[devId][p.if_index] = p.oper_status;
    }
    return idx;
  }

  function detectChanges(base, curr, devMap, rawData) {
    const changes = [];
    for (const [devId, portIdx] of Object.entries(curr)) {
      const basePortIdx = base[devId] || {};
      const dev = devMap[devId];
      for (const [ifIdx, status] of Object.entries(portIdx)) {
        const prev = basePortIdx[ifIdx];
        if (prev && prev !== status) {
          // rawData[devId] הוא מערך הפורטים המלא (עם if_name) — ה-index מחזיק
          // רק סטטוס. בלי זה השם היה נופל ל-"Port <if_index>" (למשל 224
          // במקום GigabitEthernet4/0/35).
          const portInfo = (rawData?.[devId] || []).find(p => String(p.if_index) === String(ifIdx));
          changes.push({
            deviceId: devId, ip: dev?.ip, name: dev?.name || dev?.ip,
            if_index: ifIdx,
            if_name: portInfo?.if_name || portInfo?.if_descr || `Port ${ifIdx}`,
            prev, curr: status, ts: new Date().toLocaleTimeString('he-IL'),
          });
        }
      }
    }
    return changes;
  }

  async function start() {
    setError(''); setChanged([]);
    const ids = [...selectedIds];
    if (ids.length === 0) { setError(t('select_at_least_one')); return; }

    // אתחול אודיו תחת מחוות המשתמש (לחיצה) — אחרת הדפדפן חוסם צליל.
    try {
      if (!audioCtx.current) {
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx.current = new AC();
      }
      if (audioCtx.current.state === 'suspended') audioCtx.current.resume();
    } catch (_) {}

    // בקשת הרשאת התראות דפדפן (חד-פעמי)
    try {
      if ('Notification' in window) {
        if (Notification.permission === 'granted') setNotifyOk(true);
        else if (Notification.permission === 'default') {
          const p = await Notification.requestPermission();
          setNotifyOk(p === 'granted');
        }
      }
    } catch (_) {}

    const rawBase = await fetchStatuses(ids);
    if (Object.keys(rawBase).length === 0) { setError(t('read_status_failed')); return; }

    const baseIdx = buildIndex(rawBase);
    prevIdxRef.current = baseIdx;  // נקודת ההשוואה הראשונה = הבסיס
    setBaseline(baseIdx);
    setCurrent(rawBase);
    setRunning(true);

    const devMap = {};
    for (const d of devices) devMap[String(d.id)] = d;

    // קריאת סטטוס מלאה של מתג גדול (מאות ממשקים) לוקחת כמה שניות — יותר
    // מה-interval. בלי משמר, קריאות היו חופפות ומצטברות ומחמירות עומס SNMP.
    // inFlight מדלג על טיק כל עוד הקודם עדיין רץ (כמו _cycleRunning בפולר).
    inFlightRef.current = false;
    intervalRef.current = setInterval(async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const rawCurr = await fetchStatuses(ids);
        const currIdx = buildIndex(rawCurr);
        setCurrent(rawCurr);

        // משווים מול מצב ה-poll הקודם — לא מול baseline קבוע. כך *כל* מעבר
        // נתפס: גם down וגם החזרה ל-up. השוואה מול baseline קבוע פספסה את
        // חזרת הפורט ל-up (baseline=up, current=up → אין הבדל). זה גם מייתר
        // dedup: פורט שנשאר down זהה ל-poll הקודם ולכן לא מדווח שוב.
        const fresh = detectChanges(prevIdxRef.current, currIdx, devMap, rawCurr);
        prevIdxRef.current = currIdx;
        if (fresh.length > 0) {
          for (const c of fresh) notifyChange(c);
          setChanged(prev => [...fresh, ...prev].slice(0, 50));
        }
      } finally {
        inFlightRef.current = false;
      }
    }, 3000);
  }

  function stop() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    setRunning(false);
  }

  function reset() {
    stop(); setBaseline(null); setCurrent(null); setChanged([]); setError('');
    prevIdxRef.current = null;
  }

  if (!open) return null;

  const devMap = {};
  for (const d of devices) devMap[String(d.id)] = d;

  // בניית טבלת פורטים נוכחיים לתצוגה
  const portRows = [];
  if (current) {
    for (const [devId, ports] of Object.entries(current)) {
      const dev = devMap[devId];
      for (const p of ports) {
        const baseStatus = baseline?.[devId]?.[p.if_index];
        const statusChanged = baseStatus && baseStatus !== p.oper_status;
        portRows.push({ dev, p, statusChanged, baseStatus });
      }
    }
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} title={`🔌 ${t('port_watchdog_title')}`}>
      {/* בחירת מכשירים — checkboxes, עד 5 */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {t('select_switches', { max: MAX_SELECT, selected: selectedIds.size })}
          </label>
          {selectedIds.size > 0 && (
            <button className="nm-btn nm-btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={() => { setSelectedIds(new Set()); reset(); }}>
              {t('clear_all')}
            </button>
          )}
        </div>
        <input
          className="nm-input"
          style={{ width: '100%', marginBottom: 6, fontSize: 13 }}
          placeholder={`🔎 ${t('search_switch_ph')}`}
          value={devSearch}
          onChange={e => setDevSearch(e.target.value)}
        />
        <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px' }}>
          {devices.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 8, textAlign: 'center' }}>{t('no_active_devices')}</div>
          ) : (() => {
            const q = devSearch.trim().toLowerCase();
            const list = q
              ? devices.filter(d => (d.name || '').toLowerCase().includes(q)
                                  || (d.ip || '').includes(q)
                                  || (d.sys_name || '').toLowerCase().includes(q))
              : devices;
            if (list.length === 0) {
              return <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 8, textAlign: 'center' }}>{t('no_matching_switch')}</div>;
            }
            return list.map(d => {
            const id = String(d.id);
            const checked = selectedIds.has(id);
            const disabled = !checked && selectedIds.size >= MAX_SELECT;
            return (
              <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px',
                cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
                background: checked ? 'rgba(59,130,246,0.1)' : 'transparent', borderRadius: 4, marginBottom: 2 }}>
                <input type="checkbox" checked={checked} disabled={disabled}
                  onChange={() => !disabled && toggleDevice(id)} style={{ accentColor: 'var(--accent)' }} />
                <span style={{ fontSize: 13, fontWeight: checked ? 600 : 400 }}>{d.name || d.ip}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 'auto' }}>{d.ip}</span>
              </label>
            );
            });
          })()}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {!running ? (
          <button className="nm-btn nm-btn-primary" onClick={start} disabled={selectedIds.size === 0}
            style={{ padding: '8px 18px', opacity: selectedIds.size === 0 ? 0.5 : 1 }}>
            ▶ {t('start_monitoring')}
          </button>
        ) : (
          <button className="nm-btn nm-btn-ghost" onClick={stop} style={{ padding: '8px 18px', color: '#ef4444' }}>⏹ {t('stop_monitoring')}</button>
        )}
        {baseline && <button className="nm-btn nm-btn-ghost" onClick={reset} style={{ fontSize: 12 }}>↺ {t('reset_btn')}</button>}
      </div>

      {error && <div style={{ color: '#f87171', fontSize: 13, marginBottom: 10 }}>⚠ {error}</div>}

      {/* באנר בולט לשינוי האחרון — נראה מיד גם בלי לקרוא את הרשימה */}
      {running && changed.length > 0 && (
        <div style={{
          padding: '14px 16px', marginBottom: 12, borderRadius: 10,
          background: changed[0].curr === 'down' ? 'rgba(239,68,68,0.18)' : 'rgba(34,197,94,0.16)',
          border: `2px solid ${changed[0].curr === 'down' ? '#ef4444' : '#22c55e'}`,
          animation: 'pulse 1s ease-in-out 3',
        }}>
          <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 2,
            color: changed[0].curr === 'down' ? '#f87171' : '#4ade80' }}>
            {changed[0].curr === 'down' ? `🔴 ${t('port_down_banner')}` : `🟢 ${t('port_up_banner')}`}
          </div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {changed[0].name} — {t('port_label')} <span style={{ fontFamily: 'monospace' }}>{changed[0].if_name}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{changed[0].ts}</div>
        </div>
      )}

      {running && (
        <div style={{ fontSize: 11, color: notifyOk ? '#4ade80' : 'var(--text-muted)', marginBottom: 8 }}>
          {notifyOk ? `🔔 ${t('notify_ok')}` : `🔕 ${t('notify_blocked')}`}
        </div>
      )}

      {!baseline && !running && selectedIds.size === 0 && (
        <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--text-muted)', fontSize: 13 }}>
          {t('watchdog_hint')}
        </div>
      )}

      {changed.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-muted)' }}>{t('changes_detected')}:</div>
          {changed.map((c, i) => (
            <div key={i} style={{
              padding: '7px 10px', marginBottom: 4, borderRadius: 6, fontSize: 12,
              background: c.curr === 'down' ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.12)',
              border: `1px solid ${c.curr === 'down' ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.3)'}`,
              animation: i === 0 ? 'pulse 1s ease-in-out 3' : 'none',
            }}>
              <span style={{ fontWeight: 700, color: c.curr === 'down' ? '#f87171' : '#4ade80' }}>
                {c.curr === 'down' ? `🔴 ${t('port_went_down')}` : `🟢 ${t('port_went_up')}`}
              </span>
              {' '}<b>{c.name}</b> — {t('port_label')} <b>{c.if_name}</b>
              <span style={{ color: 'var(--text-muted)', marginRight: 6 }}>{c.ts}</span>
            </div>
          ))}
        </div>
      )}

      {portRows.length > 0 && (
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
          <table className="nm-table" style={{ fontSize: 12 }}>
            <thead><tr><th>{t('col_device')}</th><th>{t('col_port')}</th><th>{t('status')}</th><th>{t('col_base')}</th></tr></thead>
            <tbody>
              {portRows.filter(r => r.p.oper_status === 'up' || r.p.oper_status === 'down' || r.statusChanged).map((r, i) => (
                <tr key={i} style={{
                  background: r.statusChanged
                    ? r.p.oper_status === 'down' ? 'rgba(239,68,68,0.18)' : 'rgba(34,197,94,0.12)'
                    : 'transparent',
                }}>
                  <td style={{ color: 'var(--text-muted)' }}>{r.dev?.name || r.dev?.ip}</td>
                  <td style={{ fontFamily: 'monospace' }}>{r.p.if_name || r.p.if_descr || `Port ${r.p.if_index}`}</td>
                  <td style={{ fontWeight: r.statusChanged ? 700 : 400,
                               color: r.p.oper_status === 'up' ? '#4ade80' : r.p.oper_status === 'down' ? '#f87171' : 'var(--text-muted)' }}>
                    {r.p.oper_status}
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{r.baseStatus || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {running && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, textAlign: 'center' }}>
          ● {t('polling_status', { switches: selectedIds.size, ports: portRows.length })}
        </div>
      )}
    </Modal>
  );
}
