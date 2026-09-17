// Layout — מעטפת כל הדפים: sidebar + topbar + תוכן
import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import { useState, useEffect, useRef } from 'react';
import i18n from '../lib/i18n';
import BrandMark from './BrandMark';
import api from '../lib/api';

// אייקונים SVG פשוטים
const Icons = {
  dashboard:   '⚡',
  devices:     '🖧',
  topology:    '🕸️',
  map:         '🗺️',
  alerts:      '🔔',
  portChanges: '🔀',
  trends:      '📈',
  audit:       '📋',
  tools:       '🧰',
  reports:     '📄',
  admin:       '⚙️',
  license:     '🔑',
  watchdog:    '🔌',
  inventory:   '📦',
  logout:      '🚪',
  dark:        '🌙',
  light:       '☀️',
  lang:        '🌐',
};

function NavItem({ to, icon, label }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => `nm-sidebar-item ${isActive ? 'active' : ''}`}
    >
      <span style={{ fontSize: 16 }}>{icon}</span>
      <span>{label}</span>
    </NavLink>
  );
}

export default function Layout({ children }) {
  const { t }      = useTranslation();
  const { user, logout } = useAuth();
  const navigate   = useNavigate();
  const [theme, setTheme]   = useState(localStorage.getItem('nm_theme') || 'dark');
  const [lang,  setLang]    = useState(localStorage.getItem('nm_lang')  || 'he');

  // מצב רישוי — נטען פעם אחת בעלייה
  const [licenseStatus, setLicenseStatus] = useState(null);
  useEffect(() => {
    api.get('/license/status').then(r => setLicenseStatus(r.data)).catch(() => {});
  }, []);

  // חיפוש גלובלי MAC/IP
  const [searchQ,       setSearchQ]       = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchOpen,    setSearchOpen]    = useState(false);
  const searchRef = useRef(null);

  // debounce חיפוש
  useEffect(() => {
    if (searchQ.length < 2) { setSearchResults([]); setSearchOpen(false); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.get('/search', { params: { q: searchQ } });
        setSearchResults(r.data);
        setSearchOpen(true);
      } catch (_) {}
    }, 300);
    return () => clearTimeout(t);
  }, [searchQ]);

  // סגור dropdown בלחיצה מחוץ
  useEffect(() => {
    function handler(e) {
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function goToResult(r) {
    setSearchQ('');
    setSearchOpen(false);
    if (r.type === 'device') {
      navigate(`/devices/${r.id}`);
    } else if (r.device_id) {
      const portIdx = r.phys_if_index || r.if_index;
      navigate(`/devices/${r.device_id}${portIdx ? `?port=${portIdx}` : ''}`);
    }
  }

  // החל theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [theme, lang]);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('nm_theme', next);
  }

  function toggleLang() {
    const next = lang === 'he' ? 'en' : 'he';
    setLang(next);
    localStorage.setItem('nm_lang', next);
    i18n.changeLanguage(next);
  }

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      {/* Sidebar */}
      <aside className="nm-sidebar">
        {/* Logo */}
        <div style={{
          padding:      '16px 16px 12px',
          borderBottom: '1px solid var(--border)',
          marginBottom: 8,
          display:      'flex',
          alignItems:   'center',
          gap:          10,
        }}>
          <BrandMark size={38} idPrefix="nav" />
          <div>
            <div style={{
              fontSize: 14, fontWeight: 700, lineHeight: 1.2, direction: 'ltr',
              fontFamily: 'var(--tk-font-display)', letterSpacing: '0.03em',
              color: 'var(--text-primary)',
            }}>
              TK COMMS SENTINEL
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('net_monitoring')}
            </div>
          </div>
        </div>

        {/* Global Search */}
        <div ref={searchRef} style={{ padding: '0 8px 8px', position: 'relative' }}>
          <input
            type="text"
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            placeholder={`🔍 ${t('search_placeholder')}`}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '7px 10px', borderRadius: 6, fontSize: 12,
              background: 'var(--bg-hover)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', outline: 'none',
            }}
          />
          {searchOpen && searchResults.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 8, right: 8, zIndex: 200,
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
              maxHeight: 320, overflowY: 'auto',
            }}>
              {searchResults.map((r, i) => (
                <div
                  key={i}
                  onClick={() => goToResult(r)}
                  style={{
                    padding: '8px 12px', cursor: 'pointer', fontSize: 12,
                    borderBottom: i < searchResults.length - 1 ? '1px solid var(--border)' : 'none',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  {r.type === 'device' ? (
                    <>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        🖧 {r.name || r.ip}
                      </div>
                      <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{r.ip}</div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                        📡 {r.mac_address}
                      </div>
                      <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                        {r.ip_address && <span>{r.ip_address} · </span>}
                        {r.hostname && <span>{r.hostname} · </span>}
                        {r.device_name || r.device_ip}
                        {(r.if_alias || r.if_descr || r.if_name) && (
                          <span> · {r.if_alias || r.if_descr || r.if_name}</span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {searchOpen && searchResults.length === 0 && searchQ.length >= 2 && (
            <div style={{
              position: 'absolute', top: '100%', left: 8, right: 8, zIndex: 200,
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '10px 12px', fontSize: 12,
              color: 'var(--text-muted)',
            }}>
              {t('no_results')}
            </div>
          )}
        </div>

        {/* Nav Links */}
        <nav style={{ flex: 1 }}>
          <NavItem to="/"             icon={Icons.dashboard}   label={t('dashboard')}    />
          <NavItem to="/devices"      icon={Icons.devices}     label={t('devices')}      />
          <NavItem to="/topology"     icon={Icons.topology}    label={t('topology')}     />
          <NavItem to="/map"          icon={Icons.map}         label={t('map')}          />
          <NavItem to="/alerts"       icon={Icons.alerts}      label={t('alerts')}       />
          <NavItem to="/port-changes" icon={Icons.portChanges} label={t('port_changes')} />
          <NavItem to="/watchdog"     icon={Icons.watchdog}    label={t('watchdog')}     />
          <NavItem to="/trends"       icon={Icons.trends}      label={t('trends')}       />
          <NavItem to="/inventory"    icon={Icons.inventory}   label={t('inventory')}    />
          <NavItem to="/audit"        icon={Icons.audit}       label={t('audit')}        />
          {user?.role === 'admin' && (
            <NavItem to="/tools"   icon={Icons.tools}     label={t('diagnostics')} />
          )}
          {user?.role === 'admin' && (
            <NavItem to="/reports" icon={Icons.reports}   label={t('reports')}     />
          )}
          {user?.role === 'admin' && (
            <NavItem to="/admin"   icon={Icons.admin}     label={t('admin')}       />
          )}
          {user?.role === 'admin' && (
            <NavItem to="/license" icon={Icons.license}   label={t('license')}     />
          )}
        </nav>

        {/* Bottom: user info + controls */}
        <div style={{
          borderTop: '1px solid var(--border)',
          padding:   '12px 8px',
        }}>
          {/* Theme + Lang toggles */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            <button
              onClick={toggleTheme}
              className="nm-btn nm-btn-ghost"
              style={{ flex: 1, justifyContent: 'center', padding: '6px 8px', fontSize: 16 }}
              title={theme === 'dark' ? t('light_mode') : t('dark_mode')}
            >
              {theme === 'dark' ? Icons.light : Icons.dark}
            </button>
            <button
              onClick={toggleLang}
              className="nm-btn nm-btn-ghost"
              style={{ flex: 1, justifyContent: 'center', padding: '6px 8px', fontSize: 13 }}
            >
              {lang === 'he' ? 'EN' : 'HE'}
            </button>
          </div>

          {/* User info */}
          <div style={{
            padding:    '8px 8px',
            borderRadius: 6,
            background: 'var(--bg-hover)',
            marginBottom: 6,
          }}>
            <div style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 600 }}>
              👤 {user?.username}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {user?.role === 'admin' ? `🔑 ${t('role_admin')}` : `👁 ${t('role_viewer')}`}
            </div>
          </div>

          <button
            onClick={handleLogout}
            className="nm-btn nm-btn-ghost"
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {Icons.logout} {t('logout')}
          </button>

          <div style={{
            marginTop: 8, textAlign: 'center',
            fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)',
            opacity: 0.6, direction: 'ltr',
          }}>
            v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'}
            {typeof __BUILD_ID__ !== 'undefined' && (
              <span style={{ opacity: 0.7 }}> · {__BUILD_ID__}</span>
            )}
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main style={{
        flex:      1,
        overflow:  'auto',
        display:   'flex',
        flexDirection: 'column',
      }}>
        {/* License banners */}
        {licenseStatus?.status === 'trial' && (
          <div style={{
            padding: '10px 20px', textAlign: 'center', fontSize: 13, fontWeight: 600,
            background: 'rgba(59,130,246,0.12)', borderBottom: '1px solid rgba(59,130,246,0.35)',
            color: '#60a5fa',
          }}>
            🕐 {t('trial_banner', { days: licenseStatus.trialDaysLeft })}{' '}
            {user?.role === 'admin' && (
              <a onClick={() => navigate('/license')} style={{ cursor:'pointer', textDecoration:'underline', color:'inherit' }}>
                {t('activate_license')}
              </a>
            )}
          </div>
        )}
        {licenseStatus?.status === 'trial-expired' && (
          <div style={{
            padding: '10px 20px', textAlign: 'center', fontSize: 13, fontWeight: 600,
            background: 'rgba(239,68,68,0.15)', borderBottom: '1px solid rgba(239,68,68,0.4)',
            color: '#ef4444',
          }}>
            🚫 {t('trial_expired_banner')}{' '}
            {user?.role === 'admin'
              ? <a onClick={() => navigate('/license')} style={{ cursor:'pointer', textDecoration:'underline', color:'inherit' }}>{t('enter_license')}</a>
              : t('contact_admin')
            }
          </div>
        )}
        {licenseStatus?.status === 'grace' && (
          <div style={{
            padding: '10px 20px', textAlign: 'center', fontSize: 13, fontWeight: 600,
            background: 'rgba(245,158,11,0.15)', borderBottom: '1px solid rgba(245,158,11,0.4)',
            color: '#f59e0b',
          }}>
            ⏳ {t('grace_banner', { expiry: licenseStatus.expiry, days: licenseStatus.graceDaysLeft })}{' '}
            <a onClick={() => navigate('/license')} style={{ cursor:'pointer', textDecoration:'underline', color:'inherit' }}>
              {t('activate_license')}
            </a>
          </div>
        )}
        {licenseStatus?.status === 'expired' && (
          <div style={{
            padding: '10px 20px', textAlign: 'center', fontSize: 13, fontWeight: 600,
            background: 'rgba(239,68,68,0.15)', borderBottom: '1px solid rgba(239,68,68,0.4)',
            color: '#ef4444',
          }}>
            🚫 {t('expired_banner')}{' '}
            <a onClick={() => navigate('/license')} style={{ cursor:'pointer', textDecoration:'underline', color:'inherit' }}>
              {t('activate_license')}
            </a>
          </div>
        )}
        {children}
      </main>

    </div>
  );
}
