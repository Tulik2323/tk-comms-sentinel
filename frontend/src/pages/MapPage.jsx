// MapPage — מפת קומה עם סוויצ'ים ב-drag&drop
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import StatusDot from '../components/ui/StatusDot';
import { formatBps } from '../lib/api';
import api from '../lib/api';

export default function MapPage() {
  const { t }        = useTranslation();
  const { user }     = useNavigate ? useAuth() : { user: null };
  const navigate     = useNavigate();
  const isAdmin      = user?.role === 'admin';

  const [hasImage,   setHasImage]   = useState(false);
  const [positions,  setPositions]  = useState([]);
  const [devices,    setDevices]    = useState([]);
  const [dragging,   setDragging]   = useState(null); // { deviceId, startX, startY }
  const [tooltip,    setTooltip]    = useState(null); // { device, x, y }
  const [editMode,   setEditMode]   = useState(false);
  const mapRef       = useRef(null);

  // טען מכשירים, מיקומים, ובדוק תמונה
  useEffect(() => {
    api.get('/map/image').then(() => setHasImage(true)).catch(() => setHasImage(false));
    api.get('/map/positions').then(r => setPositions(r.data)).catch(() => {});
    api.get('/devices').then(r => setDevices(r.data)).catch(() => {});

    // רענן מיקומים כל 30 שניות
    const iv = setInterval(() => {
      api.get('/map/positions').then(r => setPositions(r.data)).catch(() => {});
    }, 30000);
    return () => clearInterval(iv);
  }, []);

  // העלאת תמונה
  async function uploadImage(e) {
    const file = e.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append('image', file);
    await api.post('/map/image', form, { headers: { 'Content-Type': 'multipart/form-data' } });
    setHasImage(true);
  }

  // Drag start
  function onMouseDown(e, device) {
    if (!editMode || !isAdmin) return;
    e.preventDefault();
    setDragging({ device, startX: e.clientX, startY: e.clientY });
  }

  // Drag move
  function onMouseMove(e) {
    if (!dragging || !mapRef.current) return;
    const rect = mapRef.current.getBoundingClientRect();
    const x    = ((e.clientX - rect.left) / rect.width)  * 100;
    const y    = ((e.clientY - rect.top)  / rect.height) * 100;
    setPositions(prev =>
      prev.map(p => p.id === dragging.device.id
        ? { ...p, map_x: Math.max(0, Math.min(100, x)), map_y: Math.max(0, Math.min(100, y)) }
        : p
      )
    );
  }

  // Drag end — שמור
  async function onMouseUp(e) {
    if (!dragging || !mapRef.current) return;
    const pos = positions.find(p => p.id === dragging.device.id);
    if (pos) {
      await api.put(`/map/positions/${dragging.device.id}`, {
        map_x: pos.map_x, map_y: pos.map_y
      }).catch(console.error);
    }
    setDragging(null);
  }

  // מכשירים שעדיין אין להם מיקום
  const unplaced = devices.filter(d => !positions.find(p => p.id === d.id));

  // הוסף מכשיר למפה
  async function placeDevice(device) {
    await api.put(`/map/positions/${device.id}`, { map_x: 50, map_y: 50 });
    setPositions(prev => [...prev, { ...device, map_x: 50, map_y: 50 }]);
  }

  // הסר מכשיר מהמפה
  async function removeFromMap(deviceId) {
    await api.put(`/map/positions/${deviceId}`, { map_x: null, map_y: null });
    setPositions(prev => prev.filter(p => p.id !== deviceId));
  }

  return (
    <div style={{ padding: 24, height: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>🗺️ {t('map_title')}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {isAdmin && (
            <>
              <button
                onClick={() => setEditMode(m => !m)}
                className={`nm-btn ${editMode ? 'nm-btn-primary' : 'nm-btn-ghost'}`}
              >
                {editMode ? `✅ ${t('edit_mode')}` : `✏️ ${t('edit_btn')}`}
              </button>
              <label className="nm-btn nm-btn-ghost" style={{ cursor: 'pointer' }}>
                📷 {t('upload_image')}
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={uploadImage} />
              </label>
            </>
          )}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', gap: 16, overflow: 'hidden' }}>
        {/* Map area */}
        <div
          ref={mapRef}
          style={{
            flex:         1,
            position:     'relative',
            background:   hasImage ? 'transparent' : 'var(--bg-card)',
            backgroundImage: hasImage ? 'url(/api/map/image)' : 'none',
            backgroundSize:  'contain',
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'center',
            border:       '1px solid var(--border)',
            borderRadius: 12,
            overflow:     'hidden',
            cursor:       dragging ? 'grabbing' : 'default',
          }}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        >
          {!hasImage && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-muted)', textAlign: 'center',
            }}>
              <div>
                <div style={{ fontSize: 48, marginBottom: 12 }}>🗺️</div>
                <div>{t('upload_floor_plan')}</div>
                <div style={{ fontSize: 12, marginTop: 8 }}>{t('image_formats')}</div>
              </div>
            </div>
          )}

          {/* Device markers */}
          {positions.map(device => {
            const liveData = devices.find(d => d.id === device.id) || device;
            return (
              <div
                key={device.id}
                style={{
                  position:  'absolute',
                  left:      `${device.map_x}%`,
                  top:       `${device.map_y}%`,
                  transform: 'translate(-50%, -50%)',
                  cursor:    editMode && isAdmin ? 'grab' : 'pointer',
                  userSelect:'none',
                  zIndex:    dragging?.device.id === device.id ? 100 : 1,
                }}
                onMouseDown={(e) => onMouseDown(e, device)}
                onClick={() => !editMode && navigate(`/devices/${device.id}`)}
                onMouseEnter={(e) => {
                  if (!dragging) setTooltip({ device: liveData, x: e.clientX, y: e.clientY });
                }}
                onMouseLeave={() => setTooltip(null)}
              >
                {/* מכשיר icon */}
                <div style={{
                  background:   device.status === 'down' ? '#7f1d1d' : device.status === 'up' ? '#14532d' : '#374151',
                  border:       `2px solid ${device.status === 'down' ? '#ef4444' : device.status === 'up' ? '#22c55e' : '#64748b'}`,
                  borderRadius: 8,
                  padding:      '6px 10px',
                  minWidth:     100,
                  boxShadow:    '0 2px 8px rgba(0,0,0,0.4)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <StatusDot status={device.status} size={8} pulse />
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#ffffff', whiteSpace: 'nowrap' }}>
                      {device.name || device.sys_name || device.ip}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>
                    {device.ip}
                  </div>
                  {liveData.total_in_bps != null && (
                    <div style={{ fontSize: 10, color: '#22c55e', marginTop: 2 }}>
                      ↓{formatBps(liveData.total_in_bps)}
                    </div>
                  )}
                </div>

                {/* Remove button in edit mode */}
                {editMode && isAdmin && (
                  <button
                    onMouseDown={e => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); removeFromMap(device.id); }}
                    style={{
                      position:     'absolute',
                      top:          -8,
                      left:         -8,
                      background:   '#ef4444',
                      border:       'none',
                      borderRadius: '50%',
                      width:        16, height: 16,
                      cursor:       'pointer',
                      color:        '#fff',
                      fontSize:     10,
                      lineHeight:   '16px',
                      textAlign:    'center',
                    }}
                  >×</button>
                )}
              </div>
            );
          })}
        </div>

        {/* Sidebar: unplaced devices */}
        {editMode && isAdmin && unplaced.length > 0 && (
          <div style={{
            width:       220,
            background:  'var(--bg-card)',
            border:      '1px solid var(--border)',
            borderRadius: 12,
            padding:     12,
            overflowY:   'auto',
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--text-muted)' }}>
              {t('unplaced_devices', { count: unplaced.length })}
            </div>
            {unplaced.map(d => (
              <div
                key={d.id}
                style={{
                  display:      'flex',
                  alignItems:   'center',
                  justifyContent: 'space-between',
                  padding:      '6px 8px',
                  background:   'var(--bg-secondary)',
                  borderRadius: 6,
                  marginBottom: 6,
                  fontSize:     12,
                }}
              >
                <div>
                  <div style={{ color: 'var(--text-primary)' }}>{d.name || d.ip}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{d.ip}</div>
                </div>
                <button
                  className="nm-btn nm-btn-primary"
                  style={{ padding: '3px 8px', fontSize: 11 }}
                  onClick={() => placeDevice(d)}
                >+</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div style={{
          position:   'fixed',
          left:       tooltip.x + 12,
          top:        tooltip.y - 40,
          background: 'var(--bg-card)',
          border:     '1px solid var(--border)',
          borderRadius: 8,
          padding:    '8px 12px',
          fontSize:   12,
          zIndex:     1000,
          pointerEvents: 'none',
          boxShadow:  '0 4px 16px rgba(0,0,0,0.3)',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{tooltip.device.name || tooltip.device.ip}</div>
          <div style={{ color: 'var(--text-muted)' }}>{tooltip.device.ip}</div>
          <div>↓ {formatBps(tooltip.device.total_in_bps)}</div>
          <div>↑ {formatBps(tooltip.device.total_out_bps)}</div>
          {!editMode && <div style={{ color: 'var(--accent)', marginTop: 4 }}>{t('click_for_details')}</div>}
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
        {editMode ? `✏️ ${t('map_edit_hint')}` : t('map_view_hint')}
      </div>
    </div>
  );
}
