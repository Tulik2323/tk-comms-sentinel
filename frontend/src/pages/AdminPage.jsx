// AdminPage — ניהול מערכת: הגדרות, משתמשים, polling
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t }                     = useTranslation();
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
      setSmtpTest({ ok: false, error: err.response?.data?.error || t('test_error') });
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
      setUpdateInfo({ ok: false, message: err.response?.data?.message || t('update_check_error') });
    } finally {
      setUpdateChecking(false);
    }
  }

  // הפעלת העדכן. פעולה כבדה — דורשת אישור, והמערכת תופעל מחדש.
  async function installUpdate() {
    if (!updateInfo?.updateAvailable) return;
    if (!window.confirm(t('update_install_confirm', { ver: updateInfo.latest }))) return;
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
        ? { started: true, message: t('update_started') }
        : { started: false, message: err.response?.data?.message || t('update_error') };
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
      alert(err.response?.data?.error || t('save_error'));
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
      alert(err.response?.data?.error || t('error'));
    }
  }

  async function deleteUser(id) {
    if (!window.confirm(t('delete_user_confirm'))) return;
    await api.delete(`/admin/users/${id}`);
    loadUsers();
  }

  async function resetUserTotp(id) {
    await api.post(`/admin/users/${id}/reset-2fa`);
    alert(t('twofa_reset_ok'));
    loadUsers();
  }

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <h1 style={{ margin: '0 0 8px', fontSize: 22 }}>⚙️ {t('admin_title')}</h1>

      {/* Stats row */}
      <div style={{
        display:             'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap:                 12,
        marginBottom:        24,
      }}>
        {[
          { label: t('total_devices'),    value: stats.totalDevices || 0, color: 'var(--accent)' },
          { label: t('devices_up'),       value: stats.upDevices    || 0, color: '#22c55e' },
          { label: t('devices_down'),     value: stats.downDevices  || 0, color: '#ef4444' },
          { label: t('open_alerts_label'), value: stats.openAlerts  || 0, color: '#f97316' },
        ].map(s => (
          <div key={s.label} className="nm-card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)' }}>
        {[['settings', `⚙️ ${t('settings_tab')}`], ['users', `👤 ${t('users_tab')}`]].map(([tabId, label]) => (
          <button key={tabId} onClick={() => setTab(tabId)} style={{
            background: 'none', border: 'none', padding: '8px 16px', cursor: 'pointer',
            fontSize: 13, color: tab === tabId ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: tab === tabId ? '2px solid var(--accent)' : '2px solid transparent',
            fontWeight: tab === tabId ? 700 : 400,
          }}>
            {label}
          </button>
        ))}
      </div>

      {/* Settings Tab */}
      {tab === 'settings' && (
        <form onSubmit={saveSettings}>
          <Section title={`🔄 ${t('updates_section')}`}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              {t('update_feed_hint')}
            </div>
            <SettingField label={t('update_feed_label')} name="update_feed_url"
              value={settings.update_feed_url} onChange={handleSettingChange}
              placeholder="https://tulik2323.github.io/tk-comms-sentinel/latest.json" />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
              {t('save_before_check')}
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" className="nm-btn nm-btn-ghost"
                onClick={checkUpdates} disabled={updateChecking}>
                {updateChecking ? t('checking_dots') : `🔍 ${t('check_updates')}`}
              </button>
              {updateInfo?.current && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('installed_version')}: <b style={{ color: 'var(--text-primary)' }}>{updateInfo.current}</b>
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
                      ? `⬆️ ${t('update_available', { ver: updateInfo.latest })}`
                      : `✅ ${t('system_up_to_date', { ver: updateInfo.current })}`}
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
                      {updateInstalling ? t('installing') : `⬇️ ${t('install_update', { ver: updateInfo.latest })}`}
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

          <Section title={`📧 ${t('smtp_section')}`}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <SettingField label="SMTP Host" name="smtp_host" value={settings.smtp_host}
                onChange={handleSettingChange} placeholder="mail.company.local" />
              <SettingField label="SMTP Port" name="smtp_port" value={settings.smtp_port}
                onChange={handleSettingChange} placeholder="25" />
              <SettingField label="From Address" name="smtp_from" value={settings.smtp_from}
                onChange={handleSettingChange} placeholder="netmonitor@company.local" />
              <SettingField label={t('recipients_label')} name="alert_recipients"
                value={settings.alert_recipients} onChange={handleSettingChange}
                placeholder="admin@company.local,it@company.local" />
              <SettingField label={t('smtp_user_label')} name="smtp_user"
                value={settings.smtp_user} onChange={handleSettingChange} />
              <SettingField label="SMTP Password" name="smtp_pass" type="password"
                value={settings.smtp_pass === '***' ? '' : settings.smtp_pass}
                onChange={handleSettingChange} placeholder={t('keep_existing_ph')} />
            </div>

            {/* בדיקה מול השרת. שני מצבים: חיבור בלבד, או שליחה אמיתית. */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
              <button type="button" className="nm-btn nm-btn-ghost"
                onClick={() => testSmtp(false)} disabled={smtpTesting}>
                {smtpTesting ? t('checking_dots') : `🔌 ${t('test_connection')}`}
              </button>
              <button type="button" className="nm-btn nm-btn-ghost"
                onClick={() => testSmtp(true)} disabled={smtpTesting}>
                ✉️ {t('send_test_email')}
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {t('smtp_test_hint')}
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
              onChange={handleSettingChange} placeholder={t('keep_existing_ph')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <SettingField label={t('ad_admin_group')} name="ad_admin_group" value={settings.ad_admin_group}
                onChange={handleSettingChange} placeholder="NetMonitor_Admins" />
              <SettingField label={t('ad_viewer_group')} name="ad_viewer_group" value={settings.ad_viewer_group}
                onChange={handleSettingChange} placeholder="NetMonitor_Viewers" />
            </div>
          </Section>

          <Section title="⏱ Polling">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <SettingField label={t('default_poll_label')} name="default_poll_interval"
                value={settings.default_poll_interval} onChange={handleSettingChange}
                placeholder="300" />
              <SettingField label={t('retention_label')} name="retention_days"
                value={settings.retention_days} onChange={handleSettingChange}
                placeholder="7" />
            </div>
          </Section>

          <Section title={`🌙 ${t('quiet_hours_section')}`}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              {t('quiet_hours_hint')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <SettingField label={t('quiet_from')} name="alert_quiet_from"
                value={settings.alert_quiet_from} onChange={handleSettingChange}
                placeholder="02:00" />
              <SettingField label={t('quiet_to')} name="alert_quiet_to"
                value={settings.alert_quiet_to} onChange={handleSettingChange}
                placeholder="08:00" />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              {t('quiet_hours_note')}
            </div>
          </Section>

          <Section title={`🔗 ${t('links_section')}`}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              {t('base_url_hint')}
            </div>
            <SettingField label={t('base_url_label')} name="app_base_url"
              value={settings.app_base_url} onChange={handleSettingChange}
              placeholder="http://10.221.0.5:8080" />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              {t('base_url_note')}
            </div>
          </Section>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="submit" className="nm-btn nm-btn-primary" disabled={saving}>
              {saving ? t('saving') : `💾 ${t('save_settings')}`}
            </button>
            {saved && <span style={{ color: '#22c55e', fontSize: 13 }}>✅ {t('saved_ok')}</span>}
          </div>
        </form>
      )}

      {/* Users Tab */}
      {tab === 'users' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <button onClick={() => setAddUserOpen(true)} className="nm-btn nm-btn-primary">
              + {t('new_user')}
            </button>
          </div>
          <div className="nm-card" style={{ padding: 0 }}>
            <table className="nm-table">
              <thead>
                <tr>
                  <th>{t('col_username')}</th>
                  <th>{t('col_role')}</th>
                  <th>2FA</th>
                  <th>{t('col_last_login')}</th>
                  <th>{t('col_actions')}</th>
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
                        ? <span style={{ color: '#22c55e', fontSize: 12 }}>✅ {t('enabled_word')}</span>
                        : <span style={{ color: '#64748b', fontSize: 12 }}>—</span>
                      }
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {u.last_login
                        ? new Date(u.last_login * 1000).toLocaleString()
                        : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {u.totp_enabled && (
                          <button
                            className="nm-btn nm-btn-ghost"
                            style={{ padding: '4px 8px', fontSize: 11 }}
                            onClick={() => resetUserTotp(u.id)}
                          >↺ {t('reset_2fa')}</button>
                        )}
                        <button
                          className="nm-btn nm-btn-danger"
                          style={{ padding: '4px 8px', fontSize: 11 }}
                          onClick={() => deleteUser(u.id)}
                        >{t('delete_btn')}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Modal open={addUserOpen} onClose={() => setAddUserOpen(false)} title={t('new_user')}>
            <form onSubmit={addUser}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>{t('col_username')}</label>
                <input className="nm-input" value={newUser.username}
                  onChange={e => setNewUser(u => ({ ...u, username: e.target.value }))} required />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>{t('password')}</label>
                <input className="nm-input" type="password" value={newUser.password}
                  onChange={e => setNewUser(u => ({ ...u, password: e.target.value }))} required />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>{t('col_role')}</label>
                <select className="nm-input" value={newUser.role}
                  onChange={e => setNewUser(u => ({ ...u, role: e.target.value }))}>
                  <option value="viewer">{t('role_viewer_desc')}</option>
                  <option value="admin">{t('role_admin_desc')}</option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className="nm-btn nm-btn-ghost" onClick={() => setAddUserOpen(false)}>{t('cancel')}</button>
                <button type="submit" className="nm-btn nm-btn-primary">{t('add')}</button>
              </div>
            </form>
          </Modal>
        </div>
      )}
    </div>
  );
}
