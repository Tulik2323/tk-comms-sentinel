// services/snmp.js — שאילתות SNMP למכשירים
// תומך v2c ו-v3, מחזיר Promise-based API
const snmp = require('net-snmp');

// OIDs סטנדרטיים
const OID = {
  sysDescr:      '1.3.6.1.2.1.1.1.0',
  sysName:       '1.3.6.1.2.1.1.5.0',
  sysUpTime:     '1.3.6.1.2.1.1.3.0',
  ifTable:       '1.3.6.1.2.1.2.2.1',
  ifIndex:       '1.3.6.1.2.1.2.2.1.1',
  ifDescr:       '1.3.6.1.2.1.2.2.1.2',
  ifSpeed:       '1.3.6.1.2.1.2.2.1.5',
  ifAdminStatus: '1.3.6.1.2.1.2.2.1.7',
  ifOperStatus:  '1.3.6.1.2.1.2.2.1.8',
  ifInErrors:    '1.3.6.1.2.1.2.2.1.14',
  ifOutErrors:   '1.3.6.1.2.1.2.2.1.20',
  // 64-bit counters (מדויקים יותר לממשקים מהירים)
  ifXTable:      '1.3.6.1.2.1.31.1.1.1',
  ifName:        '1.3.6.1.2.1.31.1.1.1.1',
  ifHCInOctets:  '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  // ifSpeed הוא מונה 32 סיביות ונתקע על 4294967295 בכל ממשק מעל ~4.29Gbps.
  // ifHighSpeed מדווח במגה-ביט לשנייה ולכן מייצג נכון 10G ומעלה.
  ifHighSpeed:   '1.3.6.1.2.1.31.1.1.1.15',
  ifAlias:       '1.3.6.1.2.1.31.1.1.1.18',  // תיאור חופשי שמוגדר ידנית על הסוויץ'
  // Q-Bridge VLAN (dot1q)
  dot1dBasePortIfIndex: '1.3.6.1.2.1.17.1.4.1.2',   // bridge port -> ifIndex
  dot1qPvid:            '1.3.6.1.2.1.17.7.1.4.5.1.1', // bridge port -> PVID
  // Bridge MAC table
  dot1dTpFdbPort:       '1.3.6.1.2.1.17.4.3.1.2',   // MAC(oid) -> bridge port
  dot1dTpFdbStatus:     '1.3.6.1.2.1.17.4.3.1.3',   // MAC(oid) -> status (3=learned)
  // ARP table
  ipNetToMediaPhysAddr: '1.3.6.1.2.1.4.22.1.2',      // ifIndex.ip -> MAC
  // LLDP
  lldpRemTable:  '1.0.8802.1.1.2.1.4.1',
  lldpRemSysName:'1.0.8802.1.1.2.1.4.1.1.9',
  lldpRemChassis:'1.0.8802.1.1.2.1.4.1.1.5',
  lldpRemPort:   '1.0.8802.1.1.2.1.4.1.1.7',
  // HP/Aruba CPU (ProCurve)
  hpCPU:         '1.3.6.1.4.1.11.2.14.11.5.1.9.6.1.0',
  // Aruba CX CPU
  arubaCXCPU:    '1.3.6.1.4.1.47196.4.1.1.3.9.1.1.2.1',
  // HPE Comware / H3C — משפחת 5130 ודומותיה. עץ נפרד לגמרי מ-ProCurve,
  // ולכן ה-OID של ProCurve מחזיר ריק על המכשירים האלה.
  comwareCPU:    '1.3.6.1.4.1.25506.2.6.1.1.1.1.6',
  comwareMEM:    '1.3.6.1.4.1.25506.2.6.1.1.1.1.8',
  // HPE Comware FAN/PSU/Temp — confirmed on HPE 5130 JH326A
  comwareFan:    '1.3.6.1.4.1.25506.8.35.1.1.1.5',  // 1=abnormal, 2=normal
  comwareAlarm:  '1.3.6.1.4.1.25506.2.6.1.1.1.1.3', // alarmLight: 1=ok, 2=alarm, 3=N/A
  comwareTemp:   '1.3.6.1.4.1.25506.2.6.1.1.1.1.34',// temperature in Celsius
  // Entity MIB (RFC 2737) — Aruba ProCurve + generic
  entPhysicalClass:        '1.3.6.1.2.1.47.1.1.1.1.5',  // 6=PSU, 7=fan
  // Entity Sensor MIB (RFC 3433)
  entPhySensorType:        '1.3.6.1.2.1.99.1.1.1.1',   // 8=celsius
  entPhySensorValue:       '1.3.6.1.2.1.99.1.1.1.4',   // raw sensor value
  entPhySensorOperStatus:  '1.3.6.1.2.1.99.1.1.1.5',   // 1=ok, 2=unavailable, 3=nonoperational
};

const TIMEOUT  = parseInt(process.env.SNMP_TIMEOUT_MS) || 8000;
const RETRIES  = 2;

// WeakSet מונע double-close — UV_HANDLE_CLOSING assertion crash
const _closed = new WeakSet();
function safeClose(session) {
  if (!session || _closed.has(session)) return;
  _closed.add(session);
  try { session.close(); } catch (_) {}
}

// יצירת session SNMP לפי גרסה
function createSession(device) {
  const opts = { timeout: TIMEOUT, retries: RETRIES };

  if (device.snmp_version === 'v3') {
    // רמת האבטחה נגזרת ממה שהוזן בפועל ולא מקובעת ל-authPriv.
    // סוויץ' שמוגדר noAuthNoPriv או authNoPriv היה נדחה תמיד,
    // כי הקוד שלח בקשה מוצפנת עם מפתחות ריקים.
    const hasAuth = Boolean(device.snmp_v3_auth);
    const hasPriv = Boolean(device.snmp_v3_priv);

    const v3 = { name: device.snmp_v3_user || '' };

    if (hasAuth && hasPriv) {
      v3.level        = snmp.SecurityLevel.authPriv;
      v3.authProtocol = snmp.AuthProtocols.sha;
      v3.authKey      = device.snmp_v3_auth;
      v3.privProtocol = snmp.PrivProtocols.aes;
      v3.privKey      = device.snmp_v3_priv;
    } else if (hasAuth) {
      v3.level        = snmp.SecurityLevel.authNoPriv;
      v3.authProtocol = snmp.AuthProtocols.sha;
      v3.authKey      = device.snmp_v3_auth;
    } else {
      v3.level        = snmp.SecurityLevel.noAuthNoPriv;
    }

    return snmp.createV3Session(device.ip, v3, opts);
  }

  return snmp.createSession(device.ip, device.community || 'public', {
    ...opts,
    version: snmp.Version2c
  });
}

// מתרגם שגיאת SNMP גולמית להסבר שאפשר לפעול לפיו.
// "Unknown User Name" בלוג לא אומר לאיש IT מה לעשות; ההודעה כאן כן.
function explainSnmpError(err, device) {
  const m = (err && err.message) || String(err);
  const v = device?.snmp_version === 'v3' ? 'v3' : 'v2c';

  if (/timed out/i.test(m)) {
    return v === 'v3'
      ? `אין תגובה ל-SNMPv3. בדוק שהמכשיר מאזין על UDP/161, שאין ACL חוסם, ושה-SNMP מופעל.`
      : `אין תגובה ל-SNMP ${v}. בדוק UDP/161, ACL, ושה-community נכון. ייתכן שהמכשיר מוגדר ל-v3 בלבד.`;
  }
  if (/unknown user ?name/i.test(m)) {
    return `המכשיר דוחה את שם המשתמש "${device?.snmp_v3_user || ''}" ב-SNMPv3. ` +
           `המשתמש אינו מוגדר על המכשיר, או שהשם שונה. בדוק בסוויץ' את רשימת משתמשי ה-SNMPv3.`;
  }
  if (/authentication fail|wrong digest|unsupported security level/i.test(m)) {
    return `שם המשתמש מוכר אך האימות נכשל. בדוק את סיסמת ה-auth ואת פרוטוקול ההצפנה ` +
           `(הקוד שולח SHA ל-auth ו-AES ל-priv).`;
  }
  if (/unsupported sec|decryption error|priv/i.test(m)) {
    return `כשל בהצפנה. ודא שהמכשיר מוגדר AES ולא DES, ושסיסמת ה-priv נכונה.`;
  }
  if (/community/i.test(m)) {
    return `ה-community נדחה. בדוק את מחרוזת ה-community בהגדרות המכשיר.`;
  }
  return m;
}

// GET ממשק Promise — מבקש OIDs ספציפיים
function snmpGet(session, oids) {
  return new Promise((resolve, reject) => {
    session.get(oids, (err, varbinds) => {
      if (err) return reject(err);
      const result = {};
      for (const vb of varbinds) {
        if (!snmp.isVarbindError(vb)) {
          result[vb.oid] = vb.value;
        }
      }
      resolve(result);
    });
  });
}

// WALK subtree — מחזיר כל ה-OIDs תחת OID נתון
//
// המתודה היא subtree() ולא subtreeWalk(); האחרונה אינה קיימת ב-net-snmp
// והקריאה אליה זרקה TypeError שנבלע ב-catch של הקוראים. התוצאה: כל
// ה-walks החזירו מערך ריק, ולכן פורטים, תעבורה ו-LLDP לא נאספו כלל
// ממכשיר אמיתי. נתוני הדמו הסתירו את זה כי הם נזרעו ישירות ל-DB.
function snmpWalk(session, rootOid) {
  return new Promise((resolve, reject) => {
    const results = [];
    try {
      session.subtree(rootOid,
        (varbinds) => {
          for (const vb of varbinds) {
            if (!snmp.isVarbindError(vb)) {
              results.push({ oid: vb.oid, value: vb.value, type: vb.type });
            }
          }
        },
        (err) => {
          if (err && results.length === 0) reject(err);
          else resolve(results);
        }
      );
    } catch (e) {
      reject(e);
    }
  });
}

// המרת ערך SNMP ל-BigInt.
// Counter64 (ifHCInOctets ועמיתיו) מגיע מ-net-snmp כ-Buffer בן 8 בתים
// big-endian, ולא כמספר. BigInt(buffer) זורק, ולכן חייבים לפרק ידנית.
function toBigInt(v) {
  if (v == null) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
  if (Buffer.isBuffer(v)) {
    let r = 0n;
    for (const b of v) r = (r << 8n) | BigInt(b);
    return r;
  }
  const n = Number(v);
  return Number.isFinite(n) ? BigInt(Math.trunc(n)) : null;
}

// המרה בטוחה למספר רגיל (מהירות, מוני שגיאות)
function toNum(v) {
  if (v == null) return 0;
  if (Buffer.isBuffer(v)) { const b = toBigInt(v); return b == null ? 0 : Number(b); }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// סטטוס oper/admin (1=up, 2=down, etc.)
function statusText(val) {
  const map = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' };
  return map[val] || 'unknown';
}

// קבל מידע בסיסי על מכשיר: שם, תיאור, uptime
async function getDeviceInfo(device) {
  const session = createSession(device);
  try {
    const data = await snmpGet(session, [OID.sysName, OID.sysDescr, OID.sysUpTime]);
    return {
      sys_name:   data[OID.sysName]?.toString()  || null,
      sys_descr:  data[OID.sysDescr]?.toString() || null,
      uptime_sec: data[OID.sysUpTime]            != null
        ? Math.floor(Number(data[OID.sysUpTime]) / 100)  // centiseconds -> seconds
        : null
    };
  } finally {
    safeClose(session);
  }
}

// קבל מידע על כל הפורטים: שם, תיאור, מהירות, סטטוס, counters
async function getInterfaces(device) {
  const session = createSession(device);
  try {
    // שלב 1: walk ifTable הבסיסי
    const [descrRows, speedRows, operRows, adminRows, inErrRows, outErrRows] = await Promise.all([
      snmpWalk(session, OID.ifDescr).catch(() => []),
      snmpWalk(session, OID.ifSpeed).catch(() => []),
      snmpWalk(session, OID.ifOperStatus).catch(() => []),
      snmpWalk(session, OID.ifAdminStatus).catch(() => []),
      snmpWalk(session, OID.ifInErrors).catch(() => []),
      snmpWalk(session, OID.ifOutErrors).catch(() => []),
    ]);

    // שלב 2: walk ifXTable (שמות ו-64bit counters)
    const [nameRows, inOctetRows, outOctetRows, highSpeedRows, aliasRows] = await Promise.all([
      snmpWalk(session, OID.ifName).catch(() => []),
      snmpWalk(session, OID.ifHCInOctets).catch(() => []),
      snmpWalk(session, OID.ifHCOutOctets).catch(() => []),
      snmpWalk(session, OID.ifHighSpeed).catch(() => []),
      snmpWalk(session, OID.ifAlias).catch(() => []),
    ]);

    // ממפה OID.index -> value
    const byIndex = (rows) => {
      const map = {};
      for (const r of rows) {
        const parts = r.oid.split('.');
        const idx = parts[parts.length - 1];
        map[idx] = r.value;
      }
      return map;
    };

    const descrs   = byIndex(descrRows);
    const speeds   = byIndex(speedRows);
    const opers    = byIndex(operRows);
    const admins   = byIndex(adminRows);
    const inErrs   = byIndex(inErrRows);
    const outErrs  = byIndex(outErrRows);
    const names    = byIndex(nameRows);
    const inOcts   = byIndex(inOctetRows);
    const outOcts  = byIndex(outOctetRows);
    const hiSpeeds = byIndex(highSpeedRows);
    const aliases  = byIndex(aliasRows);

    // מהירות אמיתית: ifSpeed נתקע על 2^32-1 בממשקי 10G ומעלה,
    // ואז ifHighSpeed (במגה-ביט) הוא המקור הנכון.
    const IF_SPEED_MAX = 4294967295;
    const realSpeed = (idx) => {
      const base = toNum(speeds[idx]);
      const hi   = toNum(hiSpeeds[idx]);
      if (hi > 0 && (base >= IF_SPEED_MAX || base === 0 || hi * 1e6 > base)) return hi * 1e6;
      return base;
    };

    // בנה רשימת פורטים מכל האינדקסים שנמצאו
    const indexes = new Set([
      ...Object.keys(descrs),
      ...Object.keys(opers),
    ]);

    const ports = [];
    for (const idx of indexes) {
      const aliasStr = aliases[idx]?.toString().trim() || null;
      ports.push({
        if_index:     parseInt(idx),
        if_name:      names[idx]?.toString()  || null,
        if_descr:     descrs[idx]?.toString() || null,
        if_alias:     aliasStr || null,
        if_speed:     realSpeed(idx),
        oper_status:  statusText(opers[idx]),
        admin_status: statusText(admins[idx]),
        in_errors:    toNum(inErrs[idx]),
        out_errors:   toNum(outErrs[idx]),
        raw_in_octets:  toBigInt(inOcts[idx]),
        raw_out_octets: toBigInt(outOcts[idx]),
      });
    }

    return ports;
  } finally {
    safeClose(session);
  }
}

// קבל שכנים LLDP (לטופולוגיה)
async function getLldpNeighbors(device) {
  const session = createSession(device);
  try {
    const [sysNames, chassis, ports] = await Promise.all([
      snmpWalk(session, OID.lldpRemSysName).catch(() => []),
      snmpWalk(session, OID.lldpRemChassis).catch(() => []),
      snmpWalk(session, OID.lldpRemPort).catch(() => []),
    ]);

    if (sysNames.length === 0) return [];

    // OID של lldpRemSysName: 1.0.8802.1.1.2.1.4.1.1.9.<timeMark>.<localPortNum>.<remoteIndex>
    const neighbors = [];
    for (const entry of sysNames) {
      const parts = entry.oid.split('.');
      // 3 אחרונים: timeMark.localPort.remoteIndex
      const localPortNum = parseInt(parts[parts.length - 2]);

      // מצא chassis ו-port התואמים
      const chassisEntry = chassis.find(c => c.oid.endsWith(`.${parts.slice(-3).join('.')}`));
      const portEntry    = ports.find(p => p.oid.endsWith(`.${parts.slice(-3).join('.')}`));

      neighbors.push({
        local_port_index:  localPortNum,
        remote_sys_name:   entry.value?.toString() || null,
        remote_chassis_id: chassisEntry ? Buffer.from(chassisEntry.value).toString('hex') : null,
        remote_port_id:    portEntry?.value?.toString() || null,
      });
    }

    return neighbors;
  } finally {
    safeClose(session);
  }
}

// קבל CPU ו-memory (OIDs ייעודיים ל-HP/Aruba)
async function getCpuMemory(device) {
  const session = createSession(device);
  try {
    // נסה HP ProCurve CPU
    const data = await snmpGet(session, [OID.hpCPU]).catch(() => ({}));
    if (data[OID.hpCPU] != null) {
      return { cpu_pct: Number(data[OID.hpCPU]), mem_pct: null };
    }

    // נסה Aruba CX (walk כי ה-OID הוא שורש טבלה)
    const arubaCPU = await snmpWalk(session, OID.arubaCXCPU).catch(() => []);
    if (arubaCPU.length > 0) {
      return { cpu_pct: Number(arubaCPU[0].value), mem_pct: null };
    }

    // נסה Comware / H3C. הטבלה מכילה שורה לכל ישות בשלדה — רובן 0
    // (יציאות, ספקים). הערך המשמעותי הוא הגבוה ביותר, שהוא לוח הבקרה.
    const [cwCpu, cwMem] = await Promise.all([
      snmpWalk(session, OID.comwareCPU).catch(() => []),
      snmpWalk(session, OID.comwareMEM).catch(() => []),
    ]);
    const peak = (rows) => {
      let best = null;
      for (const r of rows) {
        const n = Number(r.value);
        if (Number.isFinite(n) && n > 0 && n <= 100 && (best === null || n > best)) best = n;
      }
      return best;
    };
    if (cwCpu.length > 0 || cwMem.length > 0) {
      return { cpu_pct: peak(cwCpu), mem_pct: peak(cwMem) };
    }

    return { cpu_pct: null, mem_pct: null };
  } finally {
    safeClose(session);
  }
}

// סטטוס פורטים בזמן אמת — lightweight, ללא counters, לשימוש ב-Port Watchdog
const IF_STATUS_MAP = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' };

// סטטוס פורטים חי ל-Port Watchdog. משתמש ב-snmpWalk האמין (אותה דרך שהפולר
// סורק בה 97 מכשירים) במקום 4 subtree מקבילים עם timeout משותף — שם ה-walk
// של oper_status היה נכשל באמצע, מחזיר סטטוס רק לפורטים הראשונים, והשאר
// נותרו בלי oper_status: מסוננים מהתצוגה וגם חסרים מה-baseline של הניטור,
// כך שניתוק על אותם פורטים לא זוהה כלל.
async function getPortStatuses(device) {
  const operOid  = '1.3.6.1.2.1.2.2.1.8';
  const adminOid = '1.3.6.1.2.1.2.2.1.7';
  const nameOid  = '1.3.6.1.2.1.31.1.1.1.1'; // ifName
  const idxOf = (oid) => parseInt(oid.split('.').pop());

  async function readOnce(session) {
    const [descrRows, nameRows, operRows, adminRows] = await Promise.all([
      snmpWalk(session, OID.ifDescr).catch(() => []),
      snmpWalk(session, nameOid).catch(() => []),
      snmpWalk(session, operOid).catch(() => []),
      snmpWalk(session, adminOid).catch(() => []),
    ]);
    return { descrRows, nameRows, operRows, adminRows };
  }

  let session = createSession(device);
  let data;
  try {
    data = await readOnce(session);
    // oper_status הוא השדה הקריטי לניטור. אם ה-walk חזר ריק (blip חולף),
    // ניסיון חוזר יחיד עם session נקי — זול, ומונע baseline חסר.
    if (data.operRows.length === 0) {
      safeClose(session);
      session = createSession(device);
      const retry = await readOnce(session);
      if (retry.operRows.length > 0) data = retry;
    }
  } finally {
    safeClose(session);
  }

  const results = {};
  const ensure = (i) => (results[i] || (results[i] = { if_index: i }));
  for (const r of data.descrRows) ensure(idxOf(r.oid)).if_descr     = r.value?.toString() || '';
  for (const r of data.nameRows)  ensure(idxOf(r.oid)).if_name      = r.value?.toString() || '';
  for (const r of data.operRows)  ensure(idxOf(r.oid)).oper_status  = IF_STATUS_MAP[r.value] || 'unknown';
  for (const r of data.adminRows) ensure(idxOf(r.oid)).admin_status = (r.value === 1 ? 'up' : 'down');

  // רק פורטים שיש להם oper_status אמיתי — כדי שהתצוגה וה-baseline יהיו
  // עקביים ולא ייכללו פורטים חצי-מאוכלסים שלעולם לא ייבחנו לשינוי.
  return Object.values(results)
    .filter(p => p.if_index && p.oper_status)
    .sort((a, b) => a.if_index - b.if_index);
}

// בדיקת זמינות מהירה (ping SNMP — GET sysName)
async function pingSnmp(ip, community, snmp_version = 'v2c') {
  const tmpDevice = { ip, community: community || 'public', snmp_version: snmp_version || 'v2c' };
  const session = createSession(tmpDevice);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      safeClose(session);
      resolve(false);
    }, TIMEOUT);

    session.get([OID.sysName], (err, varbinds) => {
      clearTimeout(timer);
      safeClose(session);
      if (err || !varbinds || varbinds.length === 0) resolve(false);
      else resolve(!snmp.isVarbindError(varbinds[0]));
    });
  });
}

// מחלץ vendor ו-model מ-sysDescr (כבר נשמר בDB בכל poll)
//
// פורמט HPE Comware (הנפוץ ברשת פוריה):
//   שורה 1: "HPE Comware Platform Software, Software Version 7.1.070, Release 1308-US"
//   שורה 2: "HPE 5130 48G PoE+ 4SFP+ 1-slot HI Switch JH326A"
//   שורה 3: "Copyright (c) ..."
function parseVendorModel(desc) {
  if (!desc) return { vendor: null, model: null };

  const lines = desc.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);

  // HPE/H3C Comware: שורה ראשונה מכילה "Comware"
  if (/Comware/i.test(desc)) {
    for (const line of lines) {
      // חפש שורת דגם: מתחילה ב-HPE/H3C, לא שורת תוכנה או copyright
      if (/^(HPE|H3C)\s+/i.test(line) && !/Comware|Copyright|Platform|Software/i.test(line)) {
        return { vendor: 'HPE Comware', model: line };
      }
    }
    // fallback: כל שורה שמתחילה ב-HPE
    for (const line of lines) {
      if (/^HPE\s+\d/i.test(line)) return { vendor: 'HPE Comware', model: line };
    }
  }

  // Aruba (כל הדגמים): "Aruba [PART#] MODEL [Switch|VSF], revision..." או "Aruba [PART#] MODEL Sw[ch] FL..."
  // CX מזוהה על-ידי firmware FL. (6300) או LL. (8360); ProCurve = WC. או YC.
  if (/^Aruba\s/i.test(desc)) {
    const isCX = /\b(?:FL|LL)\.\d{2}/i.test(desc);
    const vendor = isCX ? 'Aruba CX' : 'Aruba ProCurve';
    // דלג על מספר קטלוג אופציונלי (כמו R8S91A, JL320A) — אות גדולה + 4-6 תווים
    // עצור לפני: ", revision", " Sw[itch|ch] XX.", או סוף
    const m = desc.match(
      /^Aruba\s+(?:[A-Z][A-Z0-9]{4,6}\s+)?(.+?)(?:,\s*revision|\s+Sw(?:itch|ch)?\s+[A-Z]{2}\.|$)/i
    );
    if (m) {
      const model = m[1].replace(/\s+(Switch\s+Stack|VSF\s+\S+|Switch)$/i, '').trim();
      return { vendor, model: 'Aruba ' + model };
    }
    return { vendor, model: null };
  }

  // ArubaOS-CX (פורמט ישן): "ArubaOS-CX Version 10.10..."
  if (/ArubaOS-CX/i.test(desc)) {
    const ver = desc.match(/Version\s+([\d.]+)/);
    return { vendor: 'Aruba CX', model: ver ? `ArubaOS-CX ${ver[1]}` : 'Aruba CX' };
  }

  // HP ProCurve: "HP J9772A 2530-48G..."
  const procrv = desc.match(/\bHP\s+([\w-][\w\s-]+(?:Switch|Router|PoE|GbE|SFP)[\w\s+-]*)/i);
  if (procrv) return { vendor: 'HP ProCurve', model: procrv[1].trim() };

  return { vendor: null, model: null };
}

// סטטוס חומרה: FAN / PSU / טמפרטורה — HPE Comware בלבד
//
// FANs: H3C hh3cFanStatus (1=fail, 2=ok).
//   בסביבות IRF הטבלה כוללת FANs מכל חברי ה-stack — עשרות ערכים.
//   מחזירים { okCount, failList } במקום רשימת כל FAN.
//
// PSU: סורקים alarmLight בטווח ישויות 200-260 ובוחרים את אלה שמחזירות
//   1 (ok) או 2 (alarm) — לא N/A (3). כך מתאים לכל דגם ולא רק לידועים.
//
// Temp: walk של comwareTemp (עמ' 34) — נלקחות הישויות הראשונות עם ערך חוקי.
async function getHardwareStatusComware(device) {
  const session = createSession(device);
  try {
    // ---- FANs ----
    const fanRows = await snmpWalk(session, OID.comwareFan).catch(() => []);
    const failFans = [];
    let okCount = 0;
    for (const r of fanRows) {
      const v = toNum(r.value);
      const idx = parseInt(r.oid.split('.').pop());
      if (v === 2) { okCount++; }
      else if (v === 1) { failFans.push({ idx, status: 'fail' }); }
    }
    const fans = [
      ...(okCount > 0 ? [{ idx: 0, status: 'ok', count: okCount }] : []),
      ...failFans,
    ];

    // ---- PSU ----
    const psuEidCandidates = Array.from({ length: 61 }, (_, i) => 200 + i);
    const psuOids = psuEidCandidates.map(i => OID.comwareAlarm + '.' + i);
    const psuData = await snmpGet(session, psuOids).catch(() => ({}));
    const psus = [];
    for (const eid of psuEidCandidates) {
      const v = toNum(psuData[OID.comwareAlarm + '.' + eid]);
      if (v === 1 || v === 2) {
        psus.push({ idx: psus.length + 1, entity: eid, status: v === 1 ? 'ok' : 'fail' });
        if (psus.length >= 4) break;
      }
    }
    if (psus.length === 0) psus.push({ idx: 1, status: 'unknown' });

    // ---- Temperature ----
    const tempRows = await snmpWalk(session, OID.comwareTemp).catch(() => []);
    const temps = [];
    for (const r of tempRows) {
      const celsius = toNum(r.value);
      if (celsius > 0 && celsius < 200) {
        const eid = parseInt(r.oid.split('.').pop());
        temps.push({ idx: temps.length + 1, entity: eid, celsius });
        if (temps.length >= 4) break;
      }
    }

    return { fans, temps, psus };
  } finally {
    safeClose(session);
  }
}

// Aruba ProCurve / HP ProCurve: Entity MIB + Entity Sensor MIB
// Confirmed on Aruba 2930M-40G-8SR-PoE (10.221.0.119):
//   entPhysicalClass=7 (fan) at 11001-11005 => entPhySensorOperStatus 1=ok
//   entPhysicalClass=6 (PSU) at 14001-14002  => no sensor status available, report present
//   entPhySensorType=8 (celsius) at 12001 => entPhySensorValue=24
async function getHardwareStatusAruba(device) {
  const session = createSession(device);
  try {
    // Walk Entity Physical Class to discover fan (7) and PSU (6) indices
    const classRows = await snmpWalk(session, OID.entPhysicalClass).catch(() => []);
    const fanIndices = [];
    const psuIndices = [];
    for (const r of classRows) {
      const cls = toNum(r.value);
      const idx = r.oid.split('.').pop();
      if (cls === 7) fanIndices.push(idx);
      else if (cls === 6) psuIndices.push(idx);
    }

    // Fan status via Entity Sensor MIB (only fetch sensor rows for fan indices)
    let okCount = 0;
    const failFans = [];
    if (fanIndices.length > 0) {
      const statusOids = fanIndices.map(i => OID.entPhySensorOperStatus + '.' + i);
      const statusData = await snmpGet(session, statusOids).catch(() => ({}));
      for (const idx of fanIndices) {
        const st = toNum(statusData[OID.entPhySensorOperStatus + '.' + idx]);
        // 1=ok, 2=unavailable, 3=nonoperational; 0/undefined = no sensor, assume ok
        if (st === 3) failFans.push({ idx: parseInt(idx), status: 'fail' });
        else okCount++;
      }
    }
    const fans = [
      ...(okCount > 0 ? [{ idx: 0, status: 'ok', count: okCount }] : []),
      ...failFans,
    ];

    // PSU: no status OID available on ProCurve 2930M — report as present (ok)
    const psus = psuIndices.slice(0, 4).map((idx, i) => ({
      idx: i + 1, entity: parseInt(idx), status: 'ok',
    }));

    // Temperature: find sensor entries with type=8 (celsius), then read values
    const typeRows  = await snmpWalk(session, OID.entPhySensorType).catch(() => []);
    const celsiusIndices = typeRows
      .filter(r => toNum(r.value) === 8)
      .map(r => r.oid.split('.').pop());

    const temps = [];
    if (celsiusIndices.length > 0) {
      const valOids = celsiusIndices.map(i => OID.entPhySensorValue + '.' + i);
      const valData = await snmpGet(session, valOids).catch(() => ({}));
      for (const idx of celsiusIndices) {
        const celsius = toNum(valData[OID.entPhySensorValue + '.' + idx]);
        if (celsius > 0 && celsius < 200) {
          temps.push({ idx: temps.length + 1, entity: parseInt(idx), celsius });
          if (temps.length >= 4) break;
        }
      }
    }

    if (fans.length === 0 && psus.length === 0 && temps.length === 0) return null;
    return { fans, psus, temps };
  } finally {
    safeClose(session);
  }
}

async function getHardwareStatus(device) {
  if (!device.vendor) return null;
  if (/Comware/i.test(device.vendor)) return getHardwareStatusComware(device);
  if (/Aruba|ProCurve/i.test(device.vendor)) return getHardwareStatusAruba(device);
  return null;
}

// קבל PVID (VLAN ברירת מחדל) לכל פורט — מחזיר { ifIndex: pvid }
// משתמש ב-Q-Bridge MIB (נתמך ברוב הסוויצ'ים המנוהלים)
async function getPortVlans(device) {
  const session = createSession(device);
  try {
    const [bridgeRows, pvidRows] = await Promise.all([
      snmpWalk(session, OID.dot1dBasePortIfIndex).catch(() => []),
      snmpWalk(session, OID.dot1qPvid).catch(() => []),
    ]);

    const bridgeToIf = {};
    for (const r of bridgeRows) {
      const parts = r.oid.split('.');
      bridgeToIf[parts[parts.length - 1]] = toNum(r.value);
    }

    const result = {};
    for (const r of pvidRows) {
      const parts = r.oid.split('.');
      const bPort = parts[parts.length - 1];
      const ifIdx = bridgeToIf[bPort];
      if (ifIdx) result[ifIdx] = toNum(r.value);
    }
    return result;
  } finally {
    safeClose(session);
  }
}

// קבל טבלת bridge MAC (dot1dTpFdbTable) — מחזיר [{ mac, if_index }] עם הפורט הפיזי
async function getMacBridgeTable(device) {
  const session = createSession(device);
  try {
    const prefixLen = OID.dot1dTpFdbPort.split('.').length;
    const [portRows, statusRows, bridgeRows] = await Promise.all([
      snmpWalk(session, OID.dot1dTpFdbPort).catch(() => []),
      snmpWalk(session, OID.dot1dTpFdbStatus).catch(() => []),
      snmpWalk(session, OID.dot1dBasePortIfIndex).catch(() => []),
    ]);

    // bridge port number -> ifIndex
    const bridgeToIf = {};
    for (const r of bridgeRows) {
      const parts = r.oid.split('.');
      bridgeToIf[parts[parts.length - 1]] = toNum(r.value);
    }

    // build set of OID suffixes with status=3 (learned)
    const learnedSet = new Set();
    for (const r of statusRows) {
      if (toNum(r.value) === 3) {
        const parts = r.oid.split('.');
        if (parts.length >= prefixLen + 6) learnedSet.add(parts.slice(-6).join('.'));
      }
    }

    const entries = [];
    for (const r of portRows) {
      const parts = r.oid.split('.');
      if (parts.length < prefixLen + 6) continue;
      const suffix = parts.slice(-6).join('.');
      if (!learnedSet.has(suffix)) continue;
      const mac    = parts.slice(-6).map(b => parseInt(b).toString(16).padStart(2, '0')).join(':');
      const bPort  = toNum(r.value);
      const ifIdx  = bridgeToIf[String(bPort)];
      if (!ifIdx) continue;
      entries.push({ mac, if_index: ifIdx });
    }
    return entries;
  } finally {
    safeClose(session);
  }
}

// קבל טבלת ARP מהמכשיר — מחזיר [{ mac, ip, if_index }]
async function getArpTable(device) {
  const session = createSession(device);
  try {
    const rows = await snmpWalk(session, OID.ipNetToMediaPhysAddr).catch(() => []);
    const prefixLen = OID.ipNetToMediaPhysAddr.split('.').length;
    const entries = [];

    for (const r of rows) {
      const parts = r.oid.split('.');
      if (parts.length < prefixLen + 5) continue;
      const ifIdx = parseInt(parts[prefixLen]);
      const ip    = parts.slice(prefixLen + 1, prefixLen + 5).join('.');
      if (!Buffer.isBuffer(r.value) || r.value.length !== 6) continue;
      const mac = Array.from(r.value).map(b => b.toString(16).padStart(2, '0')).join(':');
      if (ip.startsWith('127.') || ip.startsWith('224.') || ip.startsWith('255.') || ip === '0.0.0.0') continue;
      entries.push({ mac, ip, if_index: ifIdx });
    }
    return entries;
  } finally {
    safeClose(session);
  }
}

module.exports = { getDeviceInfo, getInterfaces, getLldpNeighbors, getCpuMemory, getPortStatuses, getHardwareStatus, getPortVlans, getArpTable, getMacBridgeTable, pingSnmp, explainSnmpError, parseVendorModel, OID };
