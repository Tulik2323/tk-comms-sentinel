// LicensePage — הצגת מצב רישוי + הפעלת מפתח (admin only)
import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../hooks/useAuth';

const STATUS_META = {
  valid:       { icon: '✅', key: 'lic_valid',      color: 'var(--tk-green)' },
  grace:       { icon: '⏳', key: 'lic_grace',      color: '#f59e0b' },
  expired:     { icon: '🚫', key: 'lic_expired',    color: '#ef4444' },
  invalid:     { icon: '⚠️', key: 'lic_invalid',    color: '#ef4444' },
  unlicensed:  { icon: '🔓', key: 'lic_unlicensed', color: 'var(--text-muted)' },
};

export default function LicensePage() {
  const { t }    = useTranslation();
  const { user } = useAuth();
  const isAdmin  = user?.role === 'admin';

  const [status,  setStatus]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [key,     setKey]     = useState('');
  const [saving,  setSaving]  = useState(false);
  const [msg,     setMsg]     = useState(null);  // { ok, text }
  const [copied,  setCopied]  = useState(false);
  const textRef = useRef(null);

  async function loadStatus() {
    try {
      setLoading(true);
      const { data } = await api.get('/license/status');
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadStatus(); }, []);

  function copyFingerprint() {
    if (!status?.fingerprint) return;
    navigator.clipboard.writeText(status.fingerprint).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // fallback for older browsers
      if (textRef.current) {
        textRef.current.select();
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    });
  }

  async function handleActivate(e) {
    e.preventDefault();
    if (!key.trim()) return;
    setSaving(true);
    setMsg(null);
    try {
      const { data } = await api.post('/license/activate', { key: key.trim() });
      setStatus(data.status);
      setKey('');
      setMsg({ ok: true, text: t('lic_activated') });
    } catch (err) {
      const errText = err.response?.data?.error || t('unexpected_error');
      setMsg({ ok: false, text: errText });
    } finally {
      setSaving(false);
    }
  }

  const meta = status ? (STATUS_META[status.status] || STATUS_META.unlicensed) : null;
  const info = meta ? { ...meta, text: t(meta.key) } : null;

  return (
    <div style={{ padding: '32px 40px', maxWidth: 680, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
        🔑 {t('license_title')}
      </h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: 32, fontSize: 13 }}>
        {t('license_sub')}
      </p>

      {/* ─── Machine Fingerprint ─── */}
      <section style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 12, padding: '24px 28px', marginBottom: 24,
      }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {t('machine_fingerprint')}
        </h2>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
          {t('fingerprint_hint')}
        </p>
        {loading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>{t('loading')}</div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              ref={textRef}
              readOnly
              value={status?.fingerprint || '—'}
              style={{
                flex: 1, fontFamily: 'monospace', fontSize: 18, fontWeight: 700,
                letterSpacing: '0.12em', padding: '12px 16px', borderRadius: 8,
                background: 'var(--bg-hover)', border: '1px solid var(--border)',
                color: 'var(--tk-blue)', textAlign: 'center', direction: 'ltr',
              }}
            />
            <button
              onClick={copyFingerprint}
              className="nm-btn"
              style={{ padding: '12px 20px', whiteSpace: 'nowrap', minWidth: 100 }}
            >
              {copied ? `✅ ${t('copied')}` : `📋 ${t('copy_btn')}`}
            </button>
          </div>
        )}
      </section>

      {/* ─── License Status ─── */}
      {status && info && (
        <section style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 12, padding: '24px 28px', marginBottom: 24,
        }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {t('current_license')}
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <span style={{ fontSize: 28 }}>{info.icon}</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: info.color }}>{info.text}</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px', fontSize: 13 }}>
            {status.customer && (
              <>
                <span style={{ color: 'var(--text-muted)' }}>{t('customer')}</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{status.customer}</span>
              </>
            )}
            {status.expiry && (
              <>
                <span style={{ color: 'var(--text-muted)' }}>{t('valid_until')}</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{status.expiry}</span>
              </>
            )}
            {status.status === 'valid' && (
              <>
                <span style={{ color: 'var(--text-muted)' }}>{t('days_left')}</span>
                <span style={{ color: status.daysLeft <= 30 ? '#f59e0b' : 'var(--tk-green)', fontWeight: 700 }}>
                  {status.daysLeft} {t('day_unit')}
                </span>
              </>
            )}
            {status.status === 'grace' && (
              <>
                <span style={{ color: 'var(--text-muted)' }}>{t('grace_days_left')}</span>
                <span style={{ color: '#f59e0b', fontWeight: 700 }}>
                  {status.graceDaysLeft} {t('day_unit')} ({t('of_word')} {status.graceDays})
                </span>
              </>
            )}
          </div>

          {status.status === 'unlicensed' && (
            <div style={{
              marginTop: 16, padding: '12px 16px', borderRadius: 8,
              background: 'rgba(79,195,247,0.08)', border: '1px solid rgba(79,195,247,0.2)',
              fontSize: 13, color: 'var(--text-muted)',
            }}>
              {t('pilot_note')}
            </div>
          )}
        </section>
      )}

      {/* ─── Activate License (admin only) ─── */}
      {isAdmin && (
        <section style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 12, padding: '24px 28px',
        }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {t('activate_key_title')}
          </h2>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
            {t('activate_key_hint')}
          </p>
          <form onSubmit={handleActivate}>
            <textarea
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder={t('paste_key_ph')}
              rows={4}
              style={{
                width: '100%', boxSizing: 'border-box',
                fontFamily: 'monospace', fontSize: 11,
                padding: '12px 14px', borderRadius: 8,
                background: 'var(--bg-hover)', border: '1px solid var(--border)',
                color: 'var(--text-primary)', resize: 'vertical', marginBottom: 14,
                direction: 'ltr',
              }}
            />
            {msg && (
              <div style={{
                padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13,
                background: msg.ok ? 'rgba(165,224,99,0.12)' : 'rgba(239,68,68,0.12)',
                color: msg.ok ? 'var(--tk-green)' : '#ef4444',
                border: `1px solid ${msg.ok ? 'rgba(165,224,99,0.3)' : 'rgba(239,68,68,0.3)'}`,
              }}>
                {msg.ok ? '✅ ' : '❌ '}{msg.text}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="submit"
                className="nm-btn"
                disabled={saving || !key.trim()}
                style={{ padding: '10px 28px' }}
              >
                {saving ? t('activating') : `🔑 ${t('activate_license_btn')}`}
              </button>
              {key && (
                <button type="button" className="nm-btn nm-btn-ghost" onClick={() => { setKey(''); setMsg(null); }}>
                  {t('clear_btn')}
                </button>
              )}
            </div>
          </form>
        </section>
      )}

      {!isAdmin && status?.status === 'unlicensed' && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 16, textAlign: 'center' }}>
          {t('contact_admin')}
        </p>
      )}
    </div>
  );
}
