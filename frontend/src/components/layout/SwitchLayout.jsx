// SwitchLayout — לשונית "Switch Layout" בדף המכשיר: חזית הסוויץ' עם הפורטים צבועים, חלק אחורי (ספקי כוח ומאווררים),
// ופאנל פרטים לפורט הנבחר. לקריאה בלבד.
//
// איך זה בנוי:
//  - השרת (GET /api/layout/device/:id) מחזיר לכל חבר במחסנית את הפורטים שלו ואת מצב החומרה.
//  - אם יש תמונת חזית למשפחה, מציירים שכבת פורטים שקופה מעליה, לפי מיקומי הפורטים ב-lib/switchLayouts.json
//    (נמדדו מהתמונות בכלי tools/build-switch-layouts.py). בלי תמונה מציירים סרטוט נקי.
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import api, { formatBps } from '../../lib/api';
import { useAuth } from '../../hooks/useAuth';
import { tempLevel, TEMP_COLORS } from '../../lib/temperature';
import LAYOUTS from '../../lib/switchLayouts.json';

const REFRESH_MS = 60_000;
const MODES = ['status', 'speed', 'vlan', 'load', 'errors'];

// ---------------------------------------------------------------------------
// צבעים לפי מצב התצוגה
// ---------------------------------------------------------------------------
const C = {
  up: '#22c55e', noLink: '#0b1220', adminDown: '#64748b', unknown: '#475569',
  uplinkRing: '#38bdf8', select: '#facc15',
};
const SPEED_STEPS = [
  { max: 10e6,  color: '#94a3b8', label: '10M' },
  { max: 100e6, color: '#f59e0b', label: '100M' },
  { max: 1e9,   color: '#22c55e', label: '1G' },
  { max: 5e9,   color: '#06b6d4', label: '2.5G / 5G' },
  { max: 10e9,  color: '#3b82f6', label: '10G' },
  { max: Infinity, color: '#a855f7', label: '25G+' },
];
const isUp = (p) => p.oper === 'up';
const vlanColor = (v) => `hsl(${(v * 47) % 360} 65% 52%)`;

function loadColor(p) {
  const peak = Math.max(p.in_bps, p.out_bps);
  const frac = p.speed ? peak / p.speed : null;
  if (frac == null) return peak > 0 ? '#22c55e' : '#166534';
  if (frac > 0.8) return '#ef4444';
  if (frac > 0.6) return '#f97316';
  if (frac > 0.3) return '#eab308';
  if (frac > 0.05) return '#22c55e';
  return '#166534';
}

function portFill(p, mode) {
  if (!isUp(p)) return p.admin === 'down' ? C.adminDown : p.oper === 'down' ? C.noLink : C.unknown;
  if (mode === 'speed')  return p.speed ? SPEED_STEPS.find(s => p.speed <= s.max).color : C.up;
  if (mode === 'vlan')   return p.vlan ? vlanColor(p.vlan) : C.up;
  if (mode === 'load')   return loadColor(p);
  if (mode === 'errors') return p.errors >= 100 ? '#ef4444' : p.errors > 0 ? '#f59e0b' : '#166534';
  return C.up;
}

const isUplink = (p) => !!p.lldp || p.mac_count > 12;

// ---------------------------------------------------------------------------
// גיאומטריה: תמונה (לפי המדידות) או סרטוט נקי
// ---------------------------------------------------------------------------
function genericGeometry(ports, family) {
  const maxN = Math.max(0, ...ports.map(p => p.n));
  const uplinks = { 52: 4, 54: 6, 28: 4, 10: 2 }[maxN] || 0;
  const copper = ports.filter(p => p.n <= maxN - uplinks);
  const up = ports.filter(p => p.n > maxN - uplinks);
  const cw = 28, ch = 24, gx = 5, gy = 6, grp = 9, pad = 14;
  const rects = {};
  const cols = Math.ceil(copper.length / 2);
  copper.forEach((p, i) => {
    const col = Math.floor(i / 2), top = i % 2 === 0;
    rects[p.n] = [pad + col * (cw + gx) + Math.floor(col / 4) * grp, pad + (top ? 0 : ch + gy), cw, ch];
  });
  const x0 = pad + cols * (cw + gx) + Math.floor(cols / 4) * grp + 18;
  up.forEach((p, i) => {
    const col = Math.floor(i / 2), top = i % 2 === 0;
    rects[p.n] = [x0 + col * (cw + 8 + gx), pad + (top ? 0 : ch + gy), cw + 8, ch];
  });
  const ucols = Math.ceil(up.length / 2);
  return { w: x0 + ucols * (cw + 8 + gx) + pad, h: pad * 2 + ch * 2 + gy, rects };
}

// שלדה מודולרית (10508): כרטיסי קו בגריד 2x2, בכל כרטיס 48 פורטים בשתי שורות
function chassisGeometry(ports) {
  const slots = [...new Set(ports.map(p => p.slot))].sort((a, b) => a - b);
  const cw = 17, ch = 20, gx = 4, gy = 7, pad = 12, cardPad = 12, head = 26;
  const perRow = 24;
  const cardW = cardPad * 2 + perRow * (cw + gx) + 5 * 5, cardH = head + ch * 2 + gy + cardPad;
  const rects = {}, cards = [];
  slots.forEach((slot, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = pad + col * (cardW + 10), y = pad + row * (cardH + 10);
    cards.push({ slot, x, y, w: cardW, h: cardH, ten: ports.find(p => p.slot === slot)?.ten });
    ports.filter(p => p.slot === slot).forEach(p => {
      const idx = p.n - 1, c = Math.floor(idx / 2), top = idx % 2 === 0;
      rects[`${slot}/${p.n}`] = [x + cardPad + c * (cw + gx) + Math.floor(c / 4) * 5, y + head + (top ? 0 : ch + gy), cw, ch];
    });
  });
  const rowsN = Math.ceil(slots.length / 2);
  return { w: pad * 2 + Math.min(2, slots.length) * cardW + 10, h: pad * 2 + rowsN * cardH + (rowsN - 1) * 10, rects, cards };
}

// ---------------------------------------------------------------------------
// חזית של חבר אחד
// ---------------------------------------------------------------------------
function FrontPanel({ member, family, mode, selected, onSelect, imageUrl, t }) {
  const key = member.layout;
  const calib = key ? LAYOUTS[key] : null;
  const useImage = !!(calib && imageUrl);
  const chassis = family === '10508';

  const geo = useMemo(() => {
    if (useImage) return { w: calib.w, h: calib.h, rects: calib.ports, image: true };
    if (chassis)  return { ...chassisGeometry(member.ports), chassis: true };
    return genericGeometry(member.ports, family);
  }, [useImage, calib, member.ports, family, chassis]);

  const rectOf = (p) => (geo.chassis ? geo.rects[`${p.slot}/${p.n}`] : geo.rects[String(p.n)]);
  const placed = member.ports.filter(p => rectOf(p));
  const extra  = member.ports.filter(p => !rectOf(p));

  return (
    <div style={{ minWidth: 0 }}>
      <svg viewBox={`0 0 ${geo.w} ${geo.h}`} style={{ width: '100%', maxWidth: geo.image ? 'none' : geo.w * 2.4, display: 'block', direction: 'ltr', borderRadius: 6, background: 'var(--bg-secondary)' }}>
        {geo.image && <image href={imageUrl} x="0" y="0" width={geo.w} height={geo.h} />}
        {geo.chassis && geo.cards.map(c => (
          <g key={c.slot}>
            <rect x={c.x} y={c.y} width={c.w} height={c.h} rx="4" fill="#0b1220" stroke="#475569" />
            <text x={c.x + 10} y={c.y + 17} fill="#94a3b8" fontSize="11">Slot {c.slot} · 48 × {c.ten ? '10G SFP+' : '1G'}</text>
          </g>
        ))}
        {placed.map(p => {
          const [x, y, w, h] = rectOf(p);
          const sel = selected === p.id;
          const up = isUp(p);
          return (
            <g key={p.id} onClick={() => onSelect(p.id)} style={{ cursor: 'pointer' }}>
              <rect x={x} y={y} width={w} height={h} rx="2"
                fill={portFill(p, mode)} fillOpacity={geo.image ? (up ? 0.78 : p.admin === 'down' ? 0.7 : 0.55) : 1}
                stroke={sel ? C.select : isUplink(p) ? C.uplinkRing : geo.image ? 'rgba(0,0,0,0.35)' : '#64748b'}
                strokeWidth={sel ? 2.4 : isUplink(p) ? 1.8 : 0.8} />
              <text x={x + w / 2} y={y + h / 2 + 3} textAnchor="middle" fontSize={Math.max(7, Math.min(11, w * 0.38))}
                fill={up || geo.image ? '#fff' : '#94a3b8'} stroke={geo.image ? 'rgba(0,0,0,0.75)' : 'none'} strokeWidth={geo.image ? 2.2 : 0}
                paintOrder="stroke" pointerEvents="none">{p.n}</text>
              <title>{`${p.name}${p.alias ? ' — ' + p.alias : ''}\n${p.oper}${p.vlan ? ' · VLAN ' + p.vlan : ''}`}</title>
            </g>
          );
        })}
      </svg>
      {extra.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6, direction: 'ltr' }} title={t('sl_extra_ports')}>
          {extra.map(p => (
            <span key={p.id} onClick={() => onSelect(p.id)} style={{
              cursor: 'pointer', fontSize: 10, padding: '2px 6px', borderRadius: 4, color: '#fff',
              background: portFill(p, mode), border: `1.5px solid ${selected === p.id ? C.select : '#64748b'}`,
            }}>{p.name.replace(/^(Ten-)?GigabitEthernet/, '')}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// חלק אחורי: ספקי כוח ומאווררים
// ---------------------------------------------------------------------------
const REAR_DEFAULT = { // כמה חריצים יש בדרך כלל (כשעוד אין נתון מהסוויץ')
  '6300M': { psu: 2, fan: 4 }, '8360': { psu: 2, fan: 10 }, '5130': { psu: 2, fan: 2 },
  '2930M': { psu: 2, fan: 5 }, '2930F': { psu: 1, fan: 4 }, '10508': { psu: 6, fan: 1 },
};
const HW_COLOR = { ok: '#22c55e', fail: '#ef4444', absent: null, unknown: '#64748b', present: '#14b8a6' };

function RearPanel({ member, family, temps, hwKnown, t }) {
  const def = REAR_DEFAULT[family] || { psu: 2, fan: 2 };
  const psus = member.hw.psus || [], fans = member.hw.fans || [];
  const psuN = Math.max(def.psu, ...psus.map(p => p.slot), 0);
  const fanN = Math.max(def.fan, ...fans.map(f => f.slot), 0);
  const noData = !hwKnown;
  const bySlot = (list, n) => Array.from({ length: n }, (_, i) => list.find(x => x.slot === i + 1) || null);

  const box = (item, label, extra) => {
    const st = noData || !item ? (noData ? 'nodata' : 'absent') : item.status;
    const color = st === 'nodata' ? '#334155' : HW_COLOR[st];
    return (
      <div key={label} title={`${label}: ${t('sl_hw_' + st)}${extra ? ' · ' + extra : ''}`} style={{
        minWidth: 74, padding: '8px 10px', borderRadius: 6, textAlign: 'center', fontSize: 11,
        border: `1.5px ${color ? 'solid' : 'dashed'} ${color || '#475569'}`,
        background: color ? `${color}22` : 'transparent', color: color || 'var(--text-muted)',
      }}>
        <div style={{ fontWeight: 700 }}>{label}</div>
        <div style={{ marginTop: 2 }}>{t('sl_hw_' + st)}</div>
        {extra && <div style={{ fontSize: 10, opacity: 0.8, direction: 'ltr' }}>{extra}</div>}
      </div>
    );
  };

  return (
    <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <b style={{ fontSize: 12 }}>🔧 {t('sl_rear')}</b>
        {noData && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('sl_hw_pending')}</span>}
        {temps.slice(0, 1).map(tmp => (
          <span key={tmp.idx} style={{ fontSize: 11, fontWeight: 700, color: TEMP_COLORS[tempLevel(tmp)] }}>🌡 {Math.round(tmp.celsius * 10) / 10}°C</span>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
        {(noData || psus.length > 0) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {bySlot(psus, psuN).map((p, i) => box(p, `PSU ${i + 1}`, p && p.watts ? `${p.watts}W` : null))}
          </div>
        )}
        {(noData || fans.length > 0) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {bySlot(fans, fanN).map((f, i) => box(f, `FAN ${i + 1}`, f && f.rpm ? `${f.rpm} RPM` : null))}
          </div>
        )}
        {!noData && psus.length === 0 && fans.length === 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('sl_hw_none')}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// מקרא
// ---------------------------------------------------------------------------
function Legend({ mode, vlans, t }) {
  const dot = (color, label, ring) => (
    <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}>
      <span style={{ width: 11, height: 11, borderRadius: 2, background: color, border: `1.5px solid ${ring || 'rgba(255,255,255,0.25)'}` }} />{label}
    </span>
  );
  const common = [dot(C.noLink, t('sl_lg_nolink')), dot(C.adminDown, t('sl_lg_admindown')), dot('transparent', t('sl_lg_uplink'), C.uplinkRing)];
  let main;
  if (mode === 'speed') main = SPEED_STEPS.map(s => dot(s.color, s.label));
  else if (mode === 'vlan') main = vlans.slice(0, 8).map(v => dot(vlanColor(v.id), `${v.id}${v.name ? ' ' + v.name : ''}`));
  else if (mode === 'load') main = [dot('#166534', '<5%'), dot('#22c55e', '5-30%'), dot('#eab308', '30-60%'), dot('#f97316', '60-80%'), dot('#ef4444', '>80%')];
  else if (mode === 'errors') main = [dot('#166534', t('sl_lg_noerr')), dot('#f59e0b', '1-99'), dot('#ef4444', '100+')];
  else main = [dot(C.up, t('sl_lg_up'))];
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>{main}{common}</div>;
}

// ---------------------------------------------------------------------------
// פאנל פרטי הפורט
// ---------------------------------------------------------------------------
const fmtSpeed = (bps) => !bps ? '—' : bps >= 1e9 ? `${bps / 1e9}G` : `${Math.round(bps / 1e6)}M`;
const Field = ({ label, children }) => (
  <div style={{ minWidth: 0 }}>
    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
    <div style={{ fontSize: 13, fontWeight: 600, wordBreak: 'break-word' }}>{children || '—'}</div>
  </div>
);

function PortDetails({ port, onOpen, onClose, t }) {
  const stColor = isUp(port) ? C.up : port.admin === 'down' ? '#94a3b8' : '#f87171';
  return (
    <div className="nm-card" style={{ marginTop: 10, borderTop: '3px solid var(--accent)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('sl_selected')}</div>
          <div style={{ fontSize: 15, fontWeight: 700, direction: 'ltr', textAlign: 'start' }}>{port.name}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="nm-btn nm-btn-ghost" style={{ fontSize: 12 }} onClick={() => onOpen(port.id)}>{t('sl_open_port')}</button>
          <button className="nm-btn nm-btn-ghost" style={{ fontSize: 12 }} onClick={onClose}>✕</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
        <Field label={t('sl_state')}><span style={{ color: stColor }}>{isUp(port) ? t('sl_lg_up') : port.admin === 'down' ? t('sl_lg_admindown') : t('sl_lg_nolink')}</span></Field>
        <Field label={t('sl_speed')}>{fmtSpeed(port.speed)}</Field>
        <Field label="VLAN">{port.vlan ? (port.vlan_name ? `${port.vlan_name} (${port.vlan})` : String(port.vlan)) : null}</Field>
        <Field label={t('sl_desc')}>{port.alias}</Field>
        <Field label={t('sl_traffic')}>{isUp(port) ? <span style={{ direction: 'ltr', display: 'inline-block' }}>↓ {formatBps(port.in_bps)} · ↑ {formatBps(port.out_bps)}</span> : null}</Field>
        <Field label={t('col_errors')}>{port.errors ? String(port.errors) : '0'}</Field>
        <Field label={t('sl_neighbor')}>{port.lldp ? `${port.lldp.name || ''} ${port.lldp.port ? '(' + port.lldp.port + ')' : ''}` : null}</Field>
      </div>
      <div style={{ paddingTop: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600, letterSpacing: '0.05em' }}>{t('sl_devices')}</div>
        {port.endpoints.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {port.mac_count > 0 ? t('sl_macs_only', { count: port.mac_count }) : t('sl_no_device')}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="nm-table">
              <thead><tr><th>MAC</th><th>IP</th><th>{t('sl_hostname')}</th><th>{t('sl_class')}</th></tr></thead>
              <tbody>
                {port.endpoints.map(e => (
                  <tr key={e.mac}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12, direction: 'ltr' }}>{e.mac}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12, direction: 'ltr' }}>{e.ip || '—'}</td>
                    <td style={{ fontSize: 12 }}>{e.hostname || '—'}{e.vendor ? <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{e.vendor}</div> : null}</td>
                    <td style={{ fontSize: 12 }}>{e.category_meta ? `${e.category_meta.icon || ''} ${e.category_meta.label}` : e.category}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {port.mac_count > port.endpoints.length && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{t('sl_more_macs', { count: port.mac_count - port.endpoints.length })}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// הלשונית
// ---------------------------------------------------------------------------
export default function SwitchLayout({ deviceId, onOpenPort }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [mode, setMode] = useState('status');
  const [sel, setSel] = useState(null);   // { member, id }
  const [images, setImages] = useState({});   // key -> blob URL | null
  const [imgVersion, setImgVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);
  const uploadKey = useRef(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.get(`/layout/device/${deviceId}`)
      .then(r => { if (alive) { setData(r.data); setError(false); } })
      .catch(() => { if (alive) setError(true); });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [deviceId]);

  // תמונות חזית: נטענות עם ה-token (תג img לא שולח כותרת הרשאה), ומוצגות כ-blob
  const keys = useMemo(() => (data?.members || []).filter(m => m.layout && m.has_image).map(m => m.layout), [data]);
  const keysSig = [...new Set(keys)].sort().join(',');
  useEffect(() => {
    let alive = true;
    const made = [];
    const wanted = keysSig ? keysSig.split(',') : [];
    Promise.all(wanted.map(k => api.get(`/layout/image/${k}`, { responseType: 'blob' })
      .then(r => { const u = URL.createObjectURL(r.data); made.push(u); return [k, u]; })
      .catch(() => [k, null]))).then(pairs => { if (alive) setImages(Object.fromEntries(pairs)); });
    return () => { alive = false; made.forEach(u => URL.revokeObjectURL(u)); };
  }, [keysSig, imgVersion]);

  const vlans = useMemo(() => {
    const m = new Map();
    for (const mem of data?.members || []) for (const p of mem.ports) if (p.vlan && isUp(p)) {
      const c = m.get(p.vlan) || { id: p.vlan, name: p.vlan_name, n: 0 }; c.n++; m.set(p.vlan, c);
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  }, [data]);

  const pickImage = useCallback((key) => { uploadKey.current = key; fileRef.current?.click(); }, []);
  async function onFile(e) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file || !uploadKey.current) return;
    setBusy(true); setMsg(null);
    try {
      const fd = new FormData(); fd.append('image', file);
      await api.post(`/layout/image/${uploadKey.current}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setImgVersion(v => v + 1);
      setData(d => ({ ...d, members: d.members.map(m => (m.layout === uploadKey.current ? { ...m, has_image: true } : m)) }));
    } catch (err) { setMsg(err.response?.data?.error || t('sl_upload_failed')); }
    setBusy(false);
  }
  async function removeImage(key) {
    if (!window.confirm(t('sl_remove_confirm'))) return;
    setBusy(true); setMsg(null);
    try {
      await api.delete(`/layout/image/${key}`);
      setImgVersion(v => v + 1);
      setData(d => ({ ...d, members: d.members.map(m => (m.layout === key ? { ...m, has_image: false } : m)) }));
    } catch (err) { setMsg(err.response?.data?.error || t('sl_upload_failed')); }
    setBusy(false);
  }

  if (error && !data) return <div className="nm-card" style={{ color: 'var(--text-muted)' }}>{t('sl_load_failed')}</div>;
  if (!data) return <div className="nm-card" style={{ color: 'var(--text-muted)' }}>{t('loading')}</div>;
  if (!data.supported) return <div className="nm-card" style={{ color: 'var(--text-muted)' }}>{t('sl_unsupported')}</div>;
  if (data.members.length === 0) return <div className="nm-card" style={{ color: 'var(--text-muted)' }}>{t('sl_no_ports')}</div>;

  const isAdmin = user?.role === 'admin';
  const familyKeys = [...new Set(data.members.map(m => m.layout).filter(Boolean))];
  const selMember = sel && data.members.find(m => m.member === sel.member);
  const selPort = selMember && selMember.ports.find(p => p.id === sel.id);

  return (
    <div>
      <div className="nm-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15 }}>{t('sl_title')}</h2>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {data.members.length > 1 ? t('sl_stack_members', { count: data.members.length }) : t('sl_single')}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {MODES.map(m => (
              <button key={m} className={`nm-btn ${mode === m ? 'nm-btn-primary' : 'nm-btn-ghost'}`} style={{ fontSize: 12, padding: '5px 11px' }}
                onClick={() => setMode(m)}>{t('sl_mode_' + m)}</button>
            ))}
          </div>
        </div>
        <Legend mode={mode} vlans={vlans} t={t} />
        {isAdmin && familyKeys.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)' }}>
            {familyKeys.map(k => (
              <span key={k} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <b style={{ direction: 'ltr' }}>{k}</b>
                <button className="nm-btn nm-btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }} disabled={busy} onClick={() => pickImage(k)}>
                  {data.members.some(m => m.layout === k && m.has_image) ? t('sl_replace_image') : t('sl_add_image')}
                </button>
                {data.members.some(m => m.layout === k && m.has_image) && (
                  <button className="nm-btn nm-btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }} disabled={busy} onClick={() => removeImage(k)}>{t('sl_remove_image')}</button>
                )}
              </span>
            ))}
            <span>{t('sl_image_hint')}</span>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg" style={{ display: 'none' }} onChange={onFile} />
          </div>
        )}
        {msg && <div style={{ marginTop: 8, fontSize: 12, color: '#f87171' }}>{msg}</div>}
      </div>

      {data.members.map(m => (
        <div key={m.member} className="nm-card" style={{ marginTop: 10, padding: 12 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
            <div style={{ width: 96, flexShrink: 0, padding: '8px 10px', borderRadius: 6, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{t('sl_member')} {m.member}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('sl_ports_count', { count: m.port_count })}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                {m.ports.filter(isUp).length} / {m.port_count} ↑
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 300 }}>
              <FrontPanel member={m} family={data.family} mode={mode} t={t}
                selected={sel && sel.member === m.member ? sel.id : null}
                imageUrl={m.layout ? images[m.layout] : null}
                onSelect={(id) => setSel(s => (s && s.member === m.member && s.id === id ? null : { member: m.member, id }))} />
              <RearPanel member={m} family={data.family} temps={data.temps} hwKnown={data.hw_known} t={t} />
            </div>
          </div>
          {selPort && selMember.member === m.member && (
            <PortDetails port={selPort} t={t} onOpen={onOpenPort} onClose={() => setSel(null)} />
          )}
        </div>
      ))}
    </div>
  );
}
