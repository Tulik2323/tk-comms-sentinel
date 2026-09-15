// lib/i18n.js — תרגום עברית/אנגלית
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const he = {
  translation: {
    // ניווט
    dashboard:   'לוח בקרה',
    devices:     'מכשירים',
    topology:    'טופולוגיה',
    map:         'מפה',
    alerts:      'התראות',
    admin:       'ניהול',
    logout:      'יציאה',

    // סטטוס
    up:          'פעיל',
    down:        'לא זמין',
    unknown:     'לא ידוע',

    // מכשירים
    device:      'מכשיר',
    ip_address:  'כתובת IP',
    name:        'שם',
    status:      'סטטוס',
    location:    'מיקום',
    last_poll:   'בדיקה אחרונה',
    bandwidth_in:'תעבורה נכנסת',
    bandwidth_out:'תעבורה יוצאת',
    cpu:         'CPU',
    memory:      'זיכרון',
    ports:       'פורטים',
    uptime:      'זמן פעולה',

    // פעולות
    add:         'הוסף',
    edit:        'ערוך',
    delete:      'מחק',
    save:        'שמור',
    cancel:      'ביטול',
    search:      'חיפוש',
    refresh:     'רענן',
    scan:        'סרוק',
    import:      'ייבא',

    // הודעות
    loading:     'טוען...',
    no_data:     'אין נתונים',
    error:       'שגיאה',
    success:     'הצלחה',
    confirm_delete: 'למחוק? הפעולה בלתי הפיכה.',

    // alerts
    alert_threshold: 'סף התראה',
    open_alerts:     'התראות פתוחות',
    alert_metric:    'מטריקה',
    alert_value:     'ערך',
    alert_time:      'זמן',

    // login
    username:    'שם משתמש',
    password:    'סיסמה',
    login:       'כניסה',
    two_factor:  'קוד אימות (2FA)',
    enter_code:  'הזן קוד 6 ספרות מהאפליקציה',
    setup_2fa:   'הגדרת 2FA',
    scan_qr:     'סרוק את ה-QR עם Google Authenticator',
    enter_confirm_code: 'הזן קוד לאישור',

    // dashboard
    total_devices: 'סה"כ מכשירים',
    devices_up:    'פעילים',
    devices_down:  'לא זמינים',
    top_bandwidth: 'עומס תעבורה גבוה',
    recent_alerts: 'התראות אחרונות',

    // nav — פריטים שלא היו מתורגמים
    port_changes:  'שינויי פורטים',
    trends:        'ניתוח מגמות',
    audit:         'Audit',
    diagnostics:   'אבחון',
    reports:       'דוחות',
    license:       'רישוי',
    watchdog:      'Watchdog',

    // layout — מחרוזות ממשק
    net_monitoring:       'ניטור רשת ארגוני',
    search_placeholder:   'IP / MAC / שם...',
    no_results:           'לא נמצאו תוצאות',
    light_mode:           'מצב בהיר',
    dark_mode:            'מצב כהה',
    role_admin:           'אדמין',
    role_viewer:          'צופה',
    trial_banner:         'גרסת ניסיון — נותרו {{days}} ימים מתוך 7.',
    activate_license:     'הגדר רישוי',
    trial_expired_banner: 'תקופת הניסיון הסתיימה.',
    enter_license:        'הזן רישוי להמשך שימוש',
    contact_admin:        'פנה למנהל המערכת להפעלת רישוי.',
    grace_banner:         'הרישוי פג ב-{{expiry}} — נותרו {{days}} ימי גרייס.',
    expired_banner:       'תוקף הרישוי פג. המערכת אינה מאושרת לשימוש.',
  }
};

const en = {
  translation: {
    dashboard:   'Dashboard',
    devices:     'Devices',
    topology:    'Topology',
    map:         'Map',
    alerts:      'Alerts',
    admin:       'Admin',
    logout:      'Logout',
    up:          'Up',
    down:        'Down',
    unknown:     'Unknown',
    device:      'Device',
    ip_address:  'IP Address',
    name:        'Name',
    status:      'Status',
    location:    'Location',
    last_poll:   'Last Poll',
    bandwidth_in:'Bandwidth In',
    bandwidth_out:'Bandwidth Out',
    cpu:         'CPU',
    memory:      'Memory',
    ports:       'Ports',
    uptime:      'Uptime',
    add:         'Add',
    edit:        'Edit',
    delete:      'Delete',
    save:        'Save',
    cancel:      'Cancel',
    search:      'Search',
    refresh:     'Refresh',
    scan:        'Scan',
    import:      'Import',
    loading:     'Loading...',
    no_data:     'No data',
    error:       'Error',
    success:     'Success',
    confirm_delete: 'Delete? This action cannot be undone.',
    alert_threshold: 'Alert Threshold',
    open_alerts:     'Open Alerts',
    alert_metric:    'Metric',
    alert_value:     'Value',
    alert_time:      'Time',
    username:    'Username',
    password:    'Password',
    login:       'Login',
    two_factor:  '2FA Code',
    enter_code:  'Enter 6-digit code from your app',
    setup_2fa:   'Setup 2FA',
    scan_qr:     'Scan QR with Google Authenticator',
    enter_confirm_code: 'Enter code to confirm',
    total_devices: 'Total Devices',
    devices_up:    'Active',
    devices_down:  'Down',
    top_bandwidth: 'High Bandwidth Usage',
    recent_alerts: 'Recent Alerts',

    port_changes:  'Port Changes',
    trends:        'Trends',
    audit:         'Audit',
    diagnostics:   'Diagnostics',
    reports:       'Reports',
    license:       'License',
    watchdog:      'Watchdog',

    // layout strings
    net_monitoring:       'Enterprise Network Monitoring',
    search_placeholder:   'IP / MAC / Name...',
    no_results:           'No results found',
    light_mode:           'Light mode',
    dark_mode:            'Dark mode',
    role_admin:           'Admin',
    role_viewer:          'Viewer',
    trial_banner:         '{{days}} days left in 7-day trial.',
    activate_license:     'Activate License',
    trial_expired_banner: 'Trial period has ended.',
    enter_license:        'Enter a license key to continue',
    contact_admin:        'Contact your system administrator to activate a license.',
    grace_banner:         'License expired on {{expiry}} — {{days}} grace days remaining.',
    expired_banner:       'License has expired. The system is not authorized for use.',
  }
};

const savedLang = localStorage.getItem('nm_lang') || 'he';

i18n.use(initReactI18next).init({
  resources:   { he: he, en: en },
  lng:         savedLang,
  fallbackLng: 'he',
  interpolation: { escapeValue: false },
});

export default i18n;
