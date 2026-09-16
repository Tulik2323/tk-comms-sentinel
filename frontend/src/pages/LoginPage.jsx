// LoginPage — מסך האימות של TK Comms Sentinel
// שלושה שלבים: התחברות → אימות TOTP → הגדרת 2FA ראשונית.
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import api from '../lib/api';
import BrandMark from '../components/BrandMark';

// חומרת ההודעה נגזרת מקוד ה-HTTP. השרת מבדיל בין סיסמה שגויה (401),
// חשבון שאומת אך חסר הרשאה (403), ותקלת תשתית (503) — והמסך צריך
// לשקף את ההבדל, אחרת כל כשל נראה כמו "טעית בסיסמה".
function severityOf(status) {
  if (status === 403) return 'warn';
  if (status === 503 || status === 502 || status === 504) return 'info';
  return 'error';
}

function MessageIcon({ kind }) {
  const common = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'tk-msg-icon' };
  if (kind === 'info') {
    return <svg {...common}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>;
  }
  if (kind === 'warn') {
    return <svg {...common}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg>;
  }
  return <svg {...common}><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6M9 9l6 6" /></svg>;
}

export default function LoginPage() {
  const { t }           = useTranslation();
  const { login, user } = useAuth();
  const navigate        = useNavigate();

  const [step,         setStep]         = useState('login'); // login | totp | setup
  const [username,     setUsername]     = useState('');
  const [password,     setPassword]     = useState('');
  const [code,         setCode]         = useState('');
  const [tempToken,    setTempToken]    = useState('');
  const [pendingToken, setPendingToken] = useState(''); // token מלא שממתין להגדרת 2FA
  const [pendingRole,  setPendingRole]  = useState('');
  const [qrCode,       setQrCode]       = useState('');
  const [message,      setMessage]      = useState(null);   // { kind, text, detail }
  const [loading,      setLoading]      = useState(false);
  const [health,       setHealth]       = useState(null);   // null=בבדיקה, false=לא זמין
  const [logoOk,       setLogoOk]       = useState(true);   // false = קובץ הסמל חסר

  // אם כבר מחובר — עבור ל-dashboard
  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  // מצב השירות. נקודת הקצה אינה דורשת אימות, ולכן אפשר להציג את
  // המצב האמיתי עוד לפני שמישהו ניסה להתחבר.
  useEffect(() => {
    let alive = true;
    api.get('/health')
      .then(res => { if (alive) setHealth(res.data); })
      .catch(()  => { if (alive) setHealth(false); });
    return () => { alive = false; };
  }, []);

  function reportError(err, fallback) {
    const status = err.response?.status;
    setMessage({
      kind:   severityOf(status),
      text:   err.response?.data?.error || fallback,
      detail: err.response?.data?.detail || null,
    });
  }

  async function handleLogin(e) {
    e.preventDefault();
    setMessage(null);
    setLoading(true);

    try {
      const res = await api.post('/auth/login', { username, password });

      if (res.data.setupRequired) {
        // setupToken מוגבל — מותר רק ל-setup-2fa/confirm-2fa, לא לשאר ה-API
        setPendingToken(res.data.setupToken);
        setPendingRole(res.data.role);
        await loadSetup2FA(res.data.setupToken);
        return;
      }

      if (res.data.requires2fa) {
        setTempToken(res.data.tempToken);
        setStep('totp');
        return;
      }
    } catch (err) {
      reportError(err, t('server_error'));
    } finally {
      setLoading(false);
    }
  }

  async function loadSetup2FA(token) {
    try {
      const res = await api.post('/auth/setup-2fa', {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setQrCode(res.data.qrCode);
      setStep('setup');
    } catch (_) {
      navigate('/');
    }
  }

  async function handleVerifyTotp(e) {
    e.preventDefault();
    setMessage(null);
    setLoading(true);

    try {
      const res = await api.post('/auth/verify-2fa', { tempToken, code });
      login(res.data.token, { username, role: res.data.role });
      navigate('/', { replace: true });
    } catch (err) {
      reportError(err, t('wrong_code'));
      setCode('');
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmSetup(e) {
    e.preventDefault();
    setMessage(null);
    setLoading(true);

    try {
      const res = await api.post('/auth/confirm-2fa', { code }, {
        headers: { Authorization: `Bearer ${pendingToken}` }
      });
      // confirm-2fa מחזיר JWT מלא — השתמש בו ולא בsetupToken המוגבל
      login(res.data.token, { username, role: res.data.role });
      navigate('/');
    } catch (err) {
      reportError(err, t('wrong_code'));
      setCode('');
    } finally {
      setLoading(false);
    }
  }

  const cardTitle = {
    login: t('login'),
    totp:  t('totp_title'),
    setup: t('setup_title'),
  }[step];

  const cardHint = {
    login: t('login_sub'),
    totp:  t('totp_sub'),
    setup: t('setup_sub'),
  }[step];

  return (
    <div className="tk-auth">
      {/* ================= צד המותג ================= */}
      <section className="tk-brand">
        <div className="tk-brand-lockup tk-rise tk-d1">
          {logoOk ? (
            <img
              src="/brand-logo.png"
              alt="TK Comms Sentinel"
              className="tk-brand-logo"
              onError={() => setLogoOk(false)}
            />
          ) : (
            /* נפילה חזרה לוקטור אם קובץ הסמל חסר — עדיף מסמל שבור */
            <BrandMark size={168} animated idPrefix="hero" />
          )}
          <div>
            <h1 className="tk-wordmark">TK COMMS SENTINEL</h1>
            <p className="tk-tagline">Advanced Network Visibility</p>
          </div>
        </div>

        <h2 className="tk-headline tk-rise tk-d2">
          {t('tagline')}
        </h2>

        <p className="tk-sub tk-rise tk-d3">
          {t('tagline_body')}
        </p>

        <div className="tk-stats tk-rise tk-d4">
          <div>
            <p className="tk-stat-label">{t('service_status')}</p>
            <p className="tk-stat-value">
              {health === null ? (
                t('checking_dots')
              ) : health === false ? (
                <>{t('unavailable')}</>
              ) : (
                <><span className="tk-live-dot" />{t('active_label')}</>
              )}
            </p>
          </div>
          <div>
            <p className="tk-stat-label">{t('auth_label')}</p>
            <p className="tk-stat-value">{t('auth_value')}</p>
          </div>
          <div>
            <p className="tk-stat-label">{t('version_label')}</p>
            <p className="tk-stat-value">{health?.version ? `v${health.version}` : '—'}</p>
          </div>
        </div>
      </section>

      {/* ================= צד הטופס ================= */}
      <section className="tk-panel">
        <div className="tk-card tk-rise tk-d2">
          <div className="tk-card-edge" />

          <h2>{cardTitle}</h2>
          <p className="tk-card-hint">{cardHint}</p>

          {message && (
            <div className={`tk-msg tk-msg-${message.kind}`} role="alert">
              <MessageIcon kind={message.kind} />
              <span>
                {message.text}
                {message.detail && (
                  <span style={{ display: 'block', marginTop: 4, opacity: 0.75, fontSize: '0.78rem' }}>
                    {message.detail}
                  </span>
                )}
              </span>
            </div>
          )}

          {/* ---- שלב 1: שם משתמש וסיסמה ---- */}
          {step === 'login' && (
            <form onSubmit={handleLogin}>
              <div className="tk-field">
                <label className="tk-label" htmlFor="tk-user">{t('username')}</label>
                <input
                  id="tk-user"
                  className="tk-input"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
                  required
                />
              </div>

              <div className="tk-field">
                <label className="tk-label" htmlFor="tk-pass">{t('password')}</label>
                <input
                  id="tk-pass"
                  className="tk-input"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>

              <button type="submit" className="tk-submit" disabled={loading}>
                {loading ? t('logging_in') : t('login')}
              </button>
            </form>
          )}

          {/* ---- שלב 2: קוד TOTP ---- */}
          {step === 'totp' && (
            <form onSubmit={handleVerifyTotp}>
              <div className="tk-field">
                <label className="tk-label" htmlFor="tk-code">{t('enter_code')}</label>
                <input
                  id="tk-code"
                  className="tk-input tk-code"
                  inputMode="numeric"
                  placeholder="000000"
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  maxLength={6}
                  autoComplete="one-time-code"
                  autoFocus
                  required
                />
              </div>

              <button type="submit" className="tk-submit" disabled={loading || code.length !== 6}>
                {loading ? t('checking_dots') : t('two_factor')}
              </button>
              <button
                type="button"
                className="tk-ghost"
                onClick={() => { setStep('login'); setCode(''); setMessage(null); }}
              >
                {t('back_btn')}
              </button>
            </form>
          )}

          {/* ---- שלב 3: הגדרת 2FA ---- */}
          {step === 'setup' && (
            <form onSubmit={handleConfirmSetup}>
              {qrCode && <img className="tk-qr" src={qrCode} alt={t('qr_alt')} />}

              <div className="tk-field">
                <label className="tk-label" htmlFor="tk-confirm">{t('enter_confirm_code')}</label>
                <input
                  id="tk-confirm"
                  className="tk-input tk-code"
                  inputMode="numeric"
                  placeholder="000000"
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  maxLength={6}
                  autoComplete="one-time-code"
                  autoFocus
                />
              </div>

              <button type="submit" className="tk-submit" disabled={loading || code.length !== 6}>
                {loading ? t('verifying') : t('confirm_continue')}
              </button>
              <button
                type="button"
                className="tk-ghost"
                onClick={() => {
                  login(pendingToken, { username, role: pendingRole });
                  navigate('/');
                }}
              >
                {t('skip_setup')}
              </button>
            </form>
          )}

          <p className="tk-foot">TK COMMS SENTINEL · SECURE ACCESS</p>
        </div>
      </section>
    </div>
  );
}
