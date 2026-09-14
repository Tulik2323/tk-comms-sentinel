// AdminPage — ניהול מערכת: הגדרות, משתמשים, polling
import { useState, useEffect } from 'react';
import Modal from '../components/ui/Modal';
import api from '../lib/api';

function Section({ title, children }) {
  return (
    <div className="nm-card" style={{ marginBottom: 20 }}>
      <h2 style={{ margin: '0 0 16px', fontSize: 16, borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

function SettingField({ label, desc, name, value, onChange, type = 'text', placeholder }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
        {label}
      </label>
      {desc && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{desc}</div>}
      <input
        className="nm-input"
        type={type}
        name={name}
        value={value || ''}
        onChange={onChange}
        placeholder={placeholder}
      />
    </div>
  );
}

export default function AdminPage() {
  const [settings, setSettings]   = useState({});
  const [users,    setUsers]      = useState([]);
  const [tab,      setTab]        = useState('settings');
  const [saving,   setSaving]     = useState(false);
  const [saved,    setSaved]      = useState(false);
  const [smtpTesting, setSmtpTesting] = useState(false);
  const [smtpTest,    setSmtpTest]    = useState(null);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [newUser,  setNewUser]    = useState({ username: '', password: '', role: 'viewer' });
  const [stats,    setStats]      = useState({});
  const [updateChecking,   setUpdateChecking]   = useState(false);
  const [updateInfo,       setUpdateInfo]       = useState(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);

  function loadSettings() {
    api.get('/admin/settings').then(r => setSettings(r.data)).catch(console.error);
  }
  function loadUsers() {
    api.get('/admin/users').then(r => setUsers(r.data)).catch(console.error);
  }
  function loadStats() {
    api.get('/admin/stats').then(r => setStats(r.data)).catch(console.error);
  }

  useEffect(() => {
    loadSettings();
    loadUsers();
    loadStats();
  }, []);

  function handleSettingChange(e) {
    const { name, value } = e.target;
    setSettings(s => ({ ...s, [name]: value }));
    setSmtpTest(null);   // ההגדרות השתנו — תוצאת בדיקה קודמת כבר לא רלוונטית
  }

  // בדיקת שרת דואר. sendTest=false בודק חיבור בלבד, true שולח מייל אמיתי.
  async function testSmtp(sendTest) {
    setSmtpTesting(true);
    setSmtpTest(null);
    try {
      const res = await api.post('/admin/test-smtp', { sendTest });
      setSmtpTest(res.data);
    } catch (err) {
      setSmtpTest({ ok: false, error: err.response?.data?.error || 'שגיאה בבדיקה' });
    } finally {
      setSmtpTesting(false);
    }
  }

  // בדיקת עדכונים — קוראת את הפיד ומשווה לגרסה המותקנת (קריאה בלבד)
  async function checkUpdates() {
    setUpdateChecking(true);
    setUpdateInfo(null);
    try {
      const res = await api.get('/updates/check');
      setUpdateInfo(res.data);
    } catch (err) {
      setUpdateInfo({ ok: false, message: err.response?.data?.message || 'שגיאה בבדיקת עדכונים' });
    } finally {
      setUpdateChecking(false);
    }
  }

  // הפעלת העדכן. פעולה כבדה — דורשת אישור, והמערכת תופעל מחדש.
  async function installUpdate() {
    if (!updateInfo?.updateAvailable) return;
    if (!window.confirm(`להתקין את גרסה ${updateInfo.latest}? המערכת תופעל מחדש במהלך העדכון.`)) return;
    setUpdateInstalling(true);
    try {
      // timeout ארוך — כולל הורדה+חילוץ של חבילת העדכון לפני שהמערכת מתאתחלת
      const res = await api.post('/updates/install', {
        version:     updateInfo.latest,
        downloadUrl: updateInfo.downloadUrl,
        sha256:      updateInfo.sha256,
      }, { timeout: 180000 });
      setUpdateInfo(u => ({ ...u, installResult: res.data }));
    } catch (err) {
      // נפילת חיבור/timeout אחרי שהעדכון החל = המערכת כבר מתאתחלת (צפוי)
      const softer = (err.code === 'ECONNABORTED' || !err.response)
        ? { started: true, message: 'העדכון הופעל — המערכת מתאתחלת. המתן כדקה ורענן את הדף.' }
        : { started: false, message: err.response?.data?.message || 'שגיאה בהפעלת העדכון' };
      setUpdateInfo(u => ({ ...u, installResult: softer }));
    } finally {
      setUpdateInstalling(false);
    }
  }

  async function saveSettings(e) {
    e.preventDefault();
    setSaving(true);
    try {
      // אל תשלח שדות *** חזרה
      const toSave = Object.fromEntries(
        Object.entries(settings).filter(([, v]) => v !== '***')
      );
      await api.put('/admin/settings', toSave);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      alert(err.response?.data?.error || 'שגיאה בשמירה');
    } finally {
      setSaving(false);
    }
  }

  async function addUser(e) {
    e.preventDefault();
    try {
      await api.post('/admin/users', newUser);
      setAddUserOpen(false);
      setNewUser({ username: '', password: '', role: 'viewer' });
      loadUsers();
    } catch (err) {
      alert(err.response?.data?.error || 'שגיאה');
    }
  }

  async function deleteUser(id) {
    if (!window.confirm('מחק משתמש?')) return;
    await api.delete(`/admin/users/${id}`);
    loadUsers();
  }

  async function resetUserTotp(id) {
    await api.post(`/admin/users/${id}/reset-2fa`);
    alert('✓ 2FA אופס — המשתמש יתבקש להגדיר מחדש');
    loadUsers();
  }

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <h1 style={{ margin: '0 0 8px', fontSize: 22 }}>⚙️ ניהול מערכת</h1>

      {/* Stats row */}
      <div style={{
        display:             'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap:                 12,
        marginBottom:        24,
      }}>
        {[
          { label: 'סה"כ מכשירים', value: stats.totalDevices || 0, color: 'var(--accent)' },
          { label: 'פעילים',       value: stats.upDevices    || 0, color: '#22c55e' },
          { label: 'לא זמינים',   value: stats.downDevices  || 0, color: '#ef4444' },
          { label: 'התראות פתוחות', value: stats.openAlerts || 0, color: '#f97316' },
        ].map(s => (
          <div key={s.label} className="nm-card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)' }}>
        {[['settings', '⚙️ הגדרות'], ['users', '👤 משתמשים']].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: 'none', border: 'none', padding: '8px 16px', cursor: 'pointer',
            fontSize: 13, color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
            fontWeight: tab === t ? 700 : 400,
          }}>
            {label}
          </button>
        ))}
      </div>

      {/* Settings Tab */}
      {tab === 'settings' && (
        <form onSubmit={saveSettings}>
          <Section title="🔄 עדכוני מערכת">
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              כתובת הפיד שהמערכת בודקת מולה עדכונים. השאר ריק בשרתים ללא גישה לאינטרנט.
            </div>
            <SettingField label="כתובת פיד עדכונים (latest.json)" name="update_feed_url"
              value={settings.update_feed_url} onChange={handleSettingChange}
              placeholder="https://tulik2323.github.io/tk-comms-sentinel/latest.json" />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
              שמור את הכתובת לפני בדיקה — הבדיקה משתמשת בערך <b>השמור</b>.
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" className="nm-btn nm-btn-ghost"
                onClick={checkUpdates} disabled={updateChecking}>
                {updateChecking ? 'בודק…' : '🔍 בדוק עדכונים'}
              </button>
              {updateInfo?.current && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  גרסה מותקנת: <b style={{ color: 'var(--text-primary)' }}>{updateInfo.current}</b>
                </span>
              )}
            </div>

            {updateInfo && (
              <div style={{
                marginTop: 10, padding: '10px 12px', borderRadius: 6, fontSize: 13,
                border: '1px solid',
                background:  !updateInfo.ok ? 'rgba(30,58,138,0.25)'
                           : updateInfo.updateAvailable ? 'rgba(120,53,15,0.30)'
                           : 'rgba(22,101,52,0.25)',
                borderColor: !updateInfo.ok ? '#2563eb'
                           : updateInfo.updateAvailable ? '#d97706'
                           : '#16a34a',
                color:       !updateInfo.ok ? '#bfdbfe'
                           : updateInfo.updateAvailable ? '#fde68a'
                           : '#bbf7d0',
              }}>
                <div style={{ fontWeight: 600 }}>
                  {!updateInfo.ok
                    ? `ℹ️ ${updateInfo.message}`
                    : updateInfo.updateAvailable
                      ? `⬆️ עדכון זמין: ${updateInfo.latest}`
                      : `✅ המערכת מעודכנת (${updateInfo.current})`}
                </div>
                {updateInfo.ok && updateInfo.updateAvailable && updateInfo.notes && (
                  <div style={{ marginTop: 6, opacity: 0.9, fontSize: 12, whiteSpace: 'pre-wrap' }}>
                    {updateInfo.notes}
                  </div>
                )}
                {updateInfo.ok && updateInfo.updateAvailable && (
                  <div style={{ marginTop: 10 }}>
                    <button type="button" className="nm-btn nm-btn-primary"
                      onClick={installUpdate} disabled={updateInstalling}>
                      {updateInstalling ? 'מפעיל…' : `⬇️ התקן עדכון ${updateInfo.latest}`}
                    </button>
                  </div>
                )}
                {updateInfo.installResult && (
                  <div style={{ marginTop: 8, fontSize: 12,
                    color: updateInfo.installResult.started ? '#bbf7d0' : '#fde68a' }}>
                    {updateInfo.installResult.started ? '✅ ' : 'ℹ️ '}
                    {updateInfo.installResult.message}
                  </div>
                )}
              </div>
            )}
          </Section>

          <Section title="📧 SMTP — שליחת התראות במייל">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <SettingField label="SMTP Host" name="smtp_host" value={settings.smtp_host}
                onChange={handleSettingChange} placeholder="mail.company.local" />
              <SettingField label="SMTP Port" name="smtp_port" value={settings.smtp_port}
                onChange={handleSettingChange} placeholder="25" />
              <SettingField label="From Address" name="smtp_from" value={settings.smtp_from}
                onChange={handleSettingChange} placeholder="netmonitor@company.local" />
              <SettingField label="נמענים (מופרדים בפסיקה)" name="alert_recipients"
                value={settings.alert_recipients} onChange={handleSettingChange}
                placeholder="admin@company.local,it@company.local" />
              <SettingField label="SMTP Username (אופציונלי)" name="smtp_user"
                value={settings.smtp_user} onChange={handleSettingChange} />
              <SettingField label="SMTP Password" name="smtp_pass" type="password"
                value={settings.smtp_pass === '***' ? '' : settings.smtp_pass}
                onChange={handleSettingChange} placeholder="השאר ריק לשמירת הישן" />
            </div>

            {/* בדיקה מול השרת. שני מצבים: חיבור בלבד, או שליחה אמיתית. */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
              <button type="button" className="nm-btn nm-btn-ghost"
                onClick={() => testSmtp(false)} disabled={smtpTesting}>
                {smtpTesting ? 'בודק…' : '🔌 בדוק חיבור'}
              </button>
              <button type="button" className="nm-btn nm-btn-ghost"
                onClick={() => testSmtp(true)} disabled={smtpTesting}>
                ✉️ שלח מייל בדיקה
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                הבדיקה משתמשת בהגדרות <b>השמורות</b> — שמור לפני שאתה בודק שינויים
              </span>
            </div>

            {smtpTest && (
              <div style={{
                marginTop: 10, padding: '10px 12px', borderRadius: 6, fontSize: 13,
                border: '1px solid',
                background:  smtpTest.ok ? 'rgba(22,101,52,0.25)'  : 'rgba(127,29,29,0.25)',
                borderColor: smtpTest.ok ? '#16a34a'               : '#b91c1c',
                color:       smtpTest.ok ? '#bbf7d0'               : '#fecaca',
              }}>
                <div style={{ fontWeight: 600 }}>
                  {smtpTest.ok ? '✅ ' : '❌ '}
                  {smtpTest.ok ? smtpTest.message : smtpTest.error}
                </div>
                {smtpTest.raw && smtpTest.raw !== smtpTest.error && (
                  <div style={{ marginTop: 4, opacity: 0.75, fontSize: 11, fontFamily: 'monospace', direction: 'ltr', textAlign: 'left' }}>
                    {smtpTest.raw}
                  </div>
                )}
              </div>
            )}
          </Section>

          <Section title="🔐 Active Directory">
            <SettingField label="LDAP URL" name="ldap_url" value={settings.ldap_url}
              onChange={handleSettingChange} placeholder="ldap://dc.company.local" />
            <SettingField label="Base DN" name="ldap_base_dn" value={settings.ldap_base_dn}
              onChange={handleSettingChange} placeholder="DC=company,DC=local" />
            <SettingField label="Bind DN (Service Account)" name="ldap_bind_dn" value={settings.ldap_bind_dn}
              onChange={handleSettingChange} placeholder="CN=netmonitor_svc,OU=Service Accounts,DC=company,DC=local" />
            <SettingField label="Bind Password" name="ldap_bind_password" type="password"
              value={settings.ldap_bind_password === '***' ? '' : settings.ldap_bind_password}
              onChange={handleSettingChange} placeholder="השאר ריק לשמירת הישן" />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <SettingField label="קבוצת Admin" name="ad_admin_group" value={settings.ad_admin_group}
                onChange={handleSettingChange} placeholder="NetMonitor_Admins" />
              <SettingField label="קבוצת Viewer" name="ad_viewer_group" value={settings.ad_viewer_group}
                onChange={handleSettingChange} placeholder="NetMonitor_Viewers" />
            </div>
          </Section>

          <Section title="⏱ Polling">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <SettingField label="ברירת מחדל polling (שניות)" name="default_poll_interval"
                value={settings.default_poll_interval} onChange={handleSettingChange}
                placeholder="300" />
              <SettingField label="שמירת היסטוריה (ימים)" name="retention_days"
                value={settings.retention_days} onChange={handleSettingChange}
                placeholder="7" />
            </div>
          </Section>

          <Section title="🌙 שעות שקט (Maintenance Window)">
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              בשעות אלו מיילי התראה לא יישלחו. האירועים עדיין נרשמים ב-DB.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <SettingField label="התחלה (HH:MM)" name="alert_quiet_from"
                value={settings.alert_quiet_from} onChange={handleSettingChange}
                placeholder="02:00" />
              <SettingField label="סיום (HH:MM)" name="alert_quiet_to"
                value={settings.alert_quiet_to} onChange={handleSettingChange}
                placeholder="08:00" />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              השאר ריק כדי לבטל את החלון. תומך בחצות (לדוגמה 22:00–06:00).
            </div>
          </Section>

          <Section title="🔗 קישורים במיילי התראה">
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              כתובת הבסיס של המערכת — תופיע כקישור ישיר למכשיר בגוף המייל.
            </div>
            <SettingField label="כתובת בסיס (לדוגמה: http://10.221.0.5:8080)" name="app_base_url"
              value={settings.app_base_url} onChange={handleSettingChange}
              placeholder="http://10.221.0.5:8080" />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              השאר ריק אם אינך רוצה קישורים במיילים.
            </div>
          </Section>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="submit" className="nm-btn nm-btn-primary" disabled={saving}>
              {saving ? 'שומר...' : '💾 שמור הגדרות'}
            </button>
            {saved && <span style={{ color: '#22c55e', fontSize: 13 }}>✅ נשמר בהצלחה</span>}
          </div>
        </form>
      )}

      {/* Users Tab */}
      {tab === 'users' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <button onClick={() => setAddUserOpen(true)} className="nm-btn nm-btn-primary">
              + משתמש חדש
            </button>
          </div>
          <div className="nm-card" style={{ padding: 0 }}>
            <table className="nm-table">
              <thead>
                <tr>
                  <th>שם משתמש</th>
                  <th>הרשאה</th>
                  <th>2FA</th>
                  <th>כניסה אחרונה</th>
                  <th>פעולות</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>{u.username}</td>
                    <td>
                      <span style={{
                        background: u.role === 'admin' ? '#1e3a8a' : '#374151',
                        color:      u.role === 'admin' ? '#bfdbfe' : '#d1d5db',
                        padding:    '2px 8px', borderRadius: 999, fontSize: 11,
                      }}>
                        {u.role === 'admin' ? '🔑 Admin' : '👁 Viewer'}
                      </span>
                    </td>
                    <td>
                      {u.totp_enabled
                        ? <span style={{ color: '#22c55e', fontSize: 12 }}>✅ מופעל</span>
                        : <span style={{ color: '#64748b', fontSize: 12 }}>—</span>
                      }
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {u.last_login
                        ? new Date(u.last_login * 1000).toLocaleString('he-IL')
                        : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {u.totp_enabled && (
                          <button
                            className="nm-btn nm-btn-ghost"
                            style={{ padding: '4px 8px', fontSize: 11 }}
                            onClick={() => resetUserTotp(u.id)}
                          >↺ איפוס 2FA</button>
                        )}
                        <button
                          className="nm-btn nm-btn-danger"
                          style={{ padding: '4px 8px', fontSize: 11 }}
                          onClick={() => deleteUser(u.id)}
                        >מחק</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Modal open={addUserOpen} onClose={() => setAddUserOpen(false)} title="משתמש חדש">
            <form onSubmit={addUser}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>שם משתמש</label>
                <input className="nm-input" value={newUser.username}
                  onChange={e => setNewUser(u => ({ ...u, username: e.target.value }))} required />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>סיסמה</label>
                <input className="nm-input" type="password" value={newUser.password}
                  onChange={e => setNewUser(u => ({ ...u, password: e.target.value }))} required />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>הרשאה</label>
                <select className="nm-input" value={newUser.role}
                  onChange={e => setNewUser(u => ({ ...u, role: e.target.value }))}>
                  <option value="viewer">Viewer — קריאה בלבד</option>
                  <option value="admin">Admin — הרשאות מלאות</option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className="nm-btn nm-btn-ghost" onClick={() => setAddUserOpen(false)}>ביטול</button>
                <button type="submit" className="nm-btn nm-btn-primary">הוסף</button>
              </div>
            </form>
          </Modal>
        </div>
      )}
    </div>
  );
}
