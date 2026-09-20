// services/poller.js — לב המערכת: לולאת polling לכל מכשיר
// פועל ברקע, בודק כל מכשיר לפי poll_interval_sec שלו
const cron = require('node-cron');
const { getDb } = require('../db/database');
const { getDeviceInfo, getInterfaces, getLldpNeighbors, getCpuMemory, getHardwareStatus, getStackMembers, getPortVlans, getArpTable, getMacBridgeTable, explainSnmpError, parseVendorModel } = require('./snmp');
const { saveMetrics, pruneOldMetrics } = require('./history');
const { checkThresholds, checkDeviceDown, resolveDeviceDown, maintainAlertEvents } = require('./alerts');
const { logAudit } = require('../db/audit');
const { refreshStaleHostnames } = require('./hostnames');

// Map: deviceId -> last poll timestamp
const lastPollTime = new Map();
// Map: deviceId_ifIndex -> { in_octets, out_octets, ts }
// משמש לחישוב בps (delta / elapsed)
const prevCounters = new Map();
// Map: deviceId -> מספר כשלונות רצופים
// התראת DOWN יוצאת רק אחרי FAIL_THRESHOLD כשלונות ברצף —
// מונע spam על blip חולף של SNMP בודד.
const failCount = new Map();
const FAIL_THRESHOLD = 3;

// MAC/ARP polling: כל כמה סבבים לסרוק ARP (לא כל poll — לחסוך SNMP load)
const macPollCount  = new Map();
const MAC_POLL_EVERY = 5;

// מספר הסוויצ'ים הפיזיים במחסנית משתנה רק כשמישהו מוסיף או מסיר חבר, ולכן די לבדוק אותו
// אחת לשעה (12 סבבים בברירת המחדל של 5 דקות). הבדיקה הראשונה רצה בסבב הראשון אחרי
// הפעלת ה-poller, כך שהמספר מתמלא מיד אחרי עדכון גרסה.
const stackPollCount  = new Map();
const STACK_POLL_EVERY = 12;

// פולל מכשיר אחד — מחזיר { ok: true/false }
//
// opts.deferDownAlert — לא לשלוח התראת DOWN מיד, אלא להחזיר את העובדה
// לקורא. הסבב כולו מחליט: אם *כל* המכשירים נפלו יחד זו נפילת נתיב אחת,
// ולא עשרות תקלות נפרדות.
async function pollDevice(device, opts = {}) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  try {
    // --- מידע בסיסי ---
    const info = await getDeviceInfo(device);

    // עדכן מידע וסטטוס UP (כולל vendor/model מה-sysDescr)
    const { vendor, model } = parseVendorModel(info.sys_descr);
    db.prepare(`
      UPDATE devices
      SET status = 'up', sys_name = ?, sys_descr = ?, uptime_sec = ?, vendor = ?, model = ?
      WHERE id = ?
    `).run(info.sys_name, info.sys_descr, info.uptime_sec, vendor, model, device.id);

    // אם חזר מ-down — סגור event ורשום audit
    if (device.status === 'down') {
      resolveDeviceDown(device);
      logAudit('info', 'poller', 'device_back_online', { device: device.name || device.ip }, { device_id: device.id, ip: device.ip });
    }

    // --- פורטים ---
    let totalInBps  = 0;
    let totalOutBps = 0;

    try {
      // קרא ערכים ישנים מה-DB לפני עדכון — לזיהוי שינויים
      const prevPortMap = {};
      try {
        const prevPorts = db.prepare(
          'SELECT if_index, if_alias, admin_status, if_speed, pvid FROM ports WHERE device_id=?'
        ).all(device.id);
        for (const p of prevPorts) prevPortMap[p.if_index] = p;
      } catch (_) {}

      // קבל interfaces ו-VLANs במקביל
      const [ports, pvids] = await Promise.all([
        getInterfaces(device),
        getPortVlans(device).catch(() => ({})),
      ]);

      // שלב pvid לכל פורט
      for (const port of ports) {
        port.pvid = pvids[port.if_index] || null;
      }

      for (const port of ports) {
        // חשב bps מ-counter delta
        const counterKey = `${device.id}_${port.if_index}`;
        const prev = prevCounters.get(counterKey);
        let inBps = 0, outBps = 0;

        if (prev && port.raw_in_octets != null && port.raw_out_octets != null) {
          const elapsed = now - prev.ts;
          if (elapsed > 0) {
            const inDelta  = Number(port.raw_in_octets  - prev.in_octets);
            const outDelta = Number(port.raw_out_octets - prev.out_octets);
            inBps  = Math.max(0, inDelta  * 8 / elapsed);
            outBps = Math.max(0, outDelta * 8 / elapsed);
          }
        }

        // שמור counters נוכחיים לpoll הבא
        if (port.raw_in_octets != null) {
          prevCounters.set(counterKey, {
            ts: now,
            in_octets:  port.raw_in_octets,
            out_octets: port.raw_out_octets,
          });
        }

        totalInBps  += inBps;
        totalOutBps += outBps;
        // שמור את ה-bps המחושב על האובייקט — לולאת port_samples למטה זקוקה לו
        port._inBps  = inBps;
        port._outBps = outBps;

        // שמור/עדכן port ב-DB (כולל pvid)
        db.prepare(`
          INSERT INTO ports (device_id, if_index, if_name, if_descr, if_alias, if_speed,
                             oper_status, admin_status, in_bps, out_bps,
                             in_errors, out_errors, pvid, last_updated)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(device_id, if_index) DO UPDATE SET
            if_name      = excluded.if_name,
            if_descr     = excluded.if_descr,
            if_alias     = CASE WHEN excluded.if_alias IS NOT NULL THEN excluded.if_alias ELSE if_alias END,
            if_speed     = excluded.if_speed,
            oper_status  = excluded.oper_status,
            admin_status = excluded.admin_status,
            in_bps       = excluded.in_bps,
            out_bps      = excluded.out_bps,
            in_errors    = excluded.in_errors,
            out_errors   = excluded.out_errors,
            pvid         = CASE WHEN excluded.pvid IS NOT NULL THEN excluded.pvid ELSE pvid END,
            last_updated = excluded.last_updated
        `).run(
          device.id, port.if_index, port.if_name, port.if_descr, port.if_alias, port.if_speed,
          port.oper_status, port.admin_status, inBps, outBps,
          port.in_errors, port.out_errors, port.pvid, now
        );
      }

      // זיהוי שינויים בפורטים ורישום ל-port_changes
      try {
        const changeStmt = db.prepare(
          'INSERT INTO port_changes (device_id, if_index, if_name, attribute, old_value, new_value) VALUES (?,?,?,?,?,?)'
        );
        for (const port of ports) {
          const prev = prevPortMap[port.if_index];
          if (!prev) continue; // פורט חדש — לא מדווחים על ה"שינוי" הראשון
          const portLabel = port.if_descr || port.if_name || String(port.if_index);

          const toStr = v => (v != null && v !== '' ? String(v) : null);
          // if_alias: רק כשSNMP החזיר ערך (לא null) ושונה מה-DB
          const newAlias = port.if_alias !== null ? toStr(port.if_alias) : toStr(prev.if_alias);
          if (toStr(prev.if_alias) !== newAlias) {
            changeStmt.run(device.id, port.if_index, portLabel, 'if_alias', toStr(prev.if_alias), newAlias);
          }
          // admin_status, if_speed, pvid — רק כשהערך הישן כבר קיים (לא null)
          // null בערך ישן = עמודה חדשה/אתחול, לא שינוי אמיתי
          for (const [attr, oldV, newV] of [
            ['admin_status', toStr(prev.admin_status), toStr(port.admin_status)],
            ['if_speed',     toStr(prev.if_speed),     toStr(port.if_speed)],
            ['pvid',         toStr(prev.pvid),          toStr(port.pvid)],
          ]) {
            if (oldV !== newV && oldV != null && newV != null) {
              changeStmt.run(device.id, port.if_index, portLabel, attr, oldV, newV);
            }
          }
        }
        // ניקוי רשומות ישנות (14 ימים)
        db.prepare("DELETE FROM port_changes WHERE changed_at < unixepoch() - 14*24*3600").run();
      } catch (_) {}

      // --- דגימות פורט לגרף היסטורי (48h) ---
      try {
        const sampleInsert = db.prepare(
          'INSERT INTO port_samples (device_id, if_index, ts, in_bps, out_bps, in_errors, out_errors) VALUES (?,?,unixepoch(),?,?,?,?)'
        );
        for (const port of ports) {
          if (port.oper_status !== 'up') continue; // רק פורטים פעילים
          sampleInsert.run(device.id, port.if_index, port._inBps || 0, port._outBps || 0, port.in_errors || 0, port.out_errors || 0);
        }
        // ניקוי חד-פעמי: מחק דגימות ישנות מכל המכשירים (לא כל poll כדי לחסוך I/O)
        if (Math.random() < 0.05) {
          db.prepare("DELETE FROM port_samples WHERE ts < unixepoch() - 48*3600").run();
        }
      } catch (_) {}

    } catch (portErr) {
      console.warn(`[Poller] שגיאת ports עבור ${device.ip}: ${portErr.message}`);
    }

    // --- CPU/Memory ---
    let cpuPct = null, memPct = null;
    try {
      const cm = await getCpuMemory(device);
      cpuPct = cm.cpu_pct;
      memPct = cm.mem_pct;
    } catch (_) {}

    // --- Hardware (FAN / PSU / Temp) — Comware only ---
    try {
      const hw = await getHardwareStatus(device);
      if (hw) {
        db.prepare('UPDATE devices SET hw_status=? WHERE id=?')
          .run(JSON.stringify(hw), device.id);
      }
    } catch (_) {}

    // --- שמור metrics ---
    const metricsData = {
      cpu_pct:       cpuPct,
      mem_pct:       memPct,
      total_in_bps:  totalInBps,
      total_out_bps: totalOutBps,
    };
    saveMetrics(device.id, metricsData);

    // --- LLDP (פחות קריטי — catch לכשלון) ---
    try {
      const neighbors = await getLldpNeighbors(device);
      for (const n of neighbors) {
        db.prepare(`
          INSERT INTO lldp_links
            (local_device_id, local_port_index, remote_chassis_id, remote_port_id, remote_sys_name, last_seen)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(local_device_id, local_port_index, remote_chassis_id) DO UPDATE SET
            remote_port_id  = excluded.remote_port_id,
            remote_sys_name = excluded.remote_sys_name,
            last_seen       = excluded.last_seen
        `).run(
          device.id, n.local_port_index,
          n.remote_chassis_id, n.remote_port_id, n.remote_sys_name,
          now
        );
      }
    } catch (_) {}

    // --- מספר סוויצ'ים פיזיים מאחורי הכתובת (מחסנית) ---
    try {
      const n = (stackPollCount.get(device.id) || 0) + 1;
      stackPollCount.set(device.id, n);
      if (n % STACK_POLL_EVERY === 1) {
        const members = await getStackMembers(device);
        if (members !== null) {
          db.prepare('UPDATE devices SET stack_members = ? WHERE id = ?').run(members, device.id);
        }
      }
    } catch (_) {}

    // --- MAC/ARP (כל MAC_POLL_EVERY polls, לחסוך SNMP load) ---
    try {
      const count = (macPollCount.get(device.id) || 0) + 1;
      macPollCount.set(device.id, count);
      if (count % MAC_POLL_EVERY === 1) {
        // ARP table → IP↔MAC mapping (if_index = VLAN interface)
        const arpEntries = await getArpTable(device);
        if (arpEntries.length > 0) {
          const upsert = db.prepare(`
            INSERT INTO mac_entries (mac_address, ip_address, device_id, if_index, last_seen)
            VALUES (?, ?, ?, ?, unixepoch())
            ON CONFLICT(mac_address, device_id) DO UPDATE SET
              ip_address = excluded.ip_address,
              if_index   = excluded.if_index,
              last_seen  = excluded.last_seen
          `);
          for (const e of arpEntries) upsert.run(e.mac, e.ip, device.id, e.if_index);
        }

        // Bridge MAC table → MAC→physical port mapping (dot1dTpFdbTable)
        const bridgeEntries = await getMacBridgeTable(device).catch(() => []);
        if (bridgeEntries.length > 0) {
          const bridgeUpsert = db.prepare(`
            INSERT INTO mac_entries (mac_address, device_id, phys_if_index, last_seen)
            VALUES (?, ?, ?, unixepoch())
            ON CONFLICT(mac_address, device_id) DO UPDATE SET
              phys_if_index = excluded.phys_if_index,
              last_seen     = CASE WHEN last_seen > excluded.last_seen THEN last_seen ELSE excluded.last_seen END
          `);
          for (const e of bridgeEntries) bridgeUpsert.run(e.mac, device.id, e.if_index);
        }

        if (arpEntries.length > 0 || bridgeEntries.length > 0) {
          db.prepare("DELETE FROM mac_entries WHERE last_seen < unixepoch() - 30*24*3600").run();
        }
      }
    } catch (_) {}

    // --- בדוק התראות ---
    const updatedDevice = db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id);
    await checkThresholds(updatedDevice, metricsData);

    // הצלחה — אפס מונה כשלונות
    failCount.delete(device.id);
    lastPollTime.set(device.id, now);
    return { ok: true };

  } catch (err) {
    // מכשיר לא מגיב — סמן DOWN
    // הסבר במקום השגיאה הגולמית: "Unknown User Name" לבדו לא אומר
    // לאיש ה-IT מה לתקן, וזה בדיוק מה שנראה ב-audit.
    const why = explainSnmpError(err, device);
    const fails = (failCount.get(device.id) || 0) + 1;
    failCount.set(device.id, fails);

    const wasUp = device.status !== 'down';

    // סמן DOWN ב-DB תמיד — אבל שלח התראה רק אחרי FAIL_THRESHOLD כשלונות ברצף.
    // כשל בודד (blip של SNMP) לא מצדיק מייל.
    db.prepare("UPDATE devices SET status = 'down' WHERE id = ?").run(device.id);
    console.warn(`[Poller] ${device.ip} DOWN (${fails}/${FAIL_THRESHOLD}): ${err.message} | ${why}`);

    lastPollTime.set(device.id, now);

    if (fails < FAIL_THRESHOLD) {
      // עדיין לא הגענו לסף — לא מתריעים
      return { ok: false, wasUp: false, why, deviceId: device.id };
    }

    // הגענו לסף — הסבב יחליט אם זו תקלה נקודתית או נפילת נתיב
    if (opts.deferDownAlert) {
      return { ok: false, wasUp, why, deviceId: device.id };
    }

    if (wasUp) {
      logAudit('warn', 'poller',
        'device_unresponsive', { device: device.name || device.ip, why, error: err.message },
        { device_id: device.id, ip: device.ip });
    }

    return { ok: false, wasUp, why, deviceId: device.id };
  }
}

// הכרעה: האם הגיע הזמן לפולל מכשיר זה?
function isDue(device) {
  const lastPoll = lastPollTime.get(device.id) || 0;
  const elapsed  = Math.floor(Date.now() / 1000) - lastPoll;
  return elapsed >= device.poll_interval_sec;
}

// כמה מכשירים לפולל במקביל.
// סדרתי לא מתאים: מכשיר שלא עונה עולה ~10 שניות (timeout כפול retry),
// ועם עשרות מכשירים סבב אחד ארוך מהמרווח בין הסבבים — כך שמכשירים
// תקינים לא נסרקים בזמן ומסומנים DOWN בטעות.
const POLL_CONCURRENCY = 4;

// מונע חפיפה בין סבבים. cron יורה כל 30 שניות גם אם הסבב הקודם
// עדיין רץ, וסבבים מצטברים היו מציפים את הרשת ואת ה-sockets.
let _cycleRunning = false;

// כמה מכשירים צריכים ליפול יחד כדי שזו תיחשב נפילת נתיב ולא תקלה נקודתית.
// נמדד בשטח: כשה-FW הפסיק לנתב, *כל* המכשירים נפלו באותו סבב בדיוק.
const PATH_OUTAGE_MIN_DEVICES = 3;

// האם אנחנו כרגע במצב נפילת נתיב. נשמר כדי לרשום רק מעברים,
// ולא הודעה זהה בכל סבב.
let _pathDown = false;

async function runCycle() {
  if (_cycleRunning) {
    console.warn('[Poller] הסבב הקודם עדיין רץ — מדלג על סבב זה');
    return;
  }
  _cycleRunning = true;
  const started = Date.now();

  try {
    const db  = getDb();
    const due = db.prepare('SELECT * FROM devices').all().filter(isDue);
    if (due.length === 0) return;

    const results = [];
    let idx = 0;
    const worker = async () => {
      while (idx < due.length) {
        const device = due[idx++];
        const r = await pollDevice(device, { deferDownAlert: true })
          .catch(err => {
            console.error(`[Poller] שגיאה קריטית עבור ${device.ip}: ${err.message}`);
            return { ok: false, wasUp: false, deviceId: device.id };
          });
        results.push(r);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(POLL_CONCURRENCY, due.length) }, worker)
    );

    const failed = results.filter(r => r && !r.ok);
    const allFailed = failed.length === results.length && results.length >= PATH_OUTAGE_MIN_DEVICES;

    if (allFailed) {
      // נפילת נתיב: התראה אחת במקום עשרות. סימון המכשירים כ-DOWN כבר
      // בוצע — הם באמת בלתי נגישים מכאן — אבל אין טעם להציף את ההיסטוריה
      // בתקלה נפרדת לכל אחד מהם.
      if (!_pathDown) {
        _pathDown = true;
        const msg = `Path outage: all ${results.length} devices unresponsive simultaneously. ` +
                    `Likely a routing or firewall issue, not the devices themselves.`;
        console.error(`[Poller] ${msg}`);
        logAudit('error', 'poller', 'path_outage', { count: results.length }, {});
        try {
          db.prepare(`
            INSERT INTO alert_events (device_id, metric, value, threshold, message)
            VALUES (NULL, 'path', ?, ?, ?)
          `).run(results.length, PATH_OUTAGE_MIN_DEVICES, msg);
        } catch (e) {
          console.error('[Poller] כשל ברישום אירוע נפילת נתיב:', e.message);
        }
      }
    } else {
      // התאוששות מוכרזת רק אם מישהו באמת ענה. בסבב שבו פחות מהסף
      // מכשירים בתור, allFailed יוצא false גם כשכולם נכשלו — ובלי
      // התנאי הזה הייתה נרשמת התאוששות שקרית.
      const anySucceeded = failed.length < results.length;
      if (_pathDown && anySucceeded) {
        _pathDown = false;
        const msg = `Path recovered: ${results.length - failed.length} of ${results.length} devices responding.`;
        console.log(`[Poller] ${msg}`);
        logAudit('info', 'poller', 'path_recovered', { responding: results.length - failed.length, total: results.length }, {});
        db.prepare(`
          UPDATE alert_events SET resolved_at = unixepoch()
          WHERE metric = 'path' AND resolved_at IS NULL
        `).run();
      }

      // תקלות נקודתיות — כל אחת מקבלת את הטיפול הרגיל
      for (const r of failed) {
        if (r.wasUp) {
          const dev = db.prepare('SELECT * FROM devices WHERE id = ?').get(r.deviceId);
          if (!dev) continue;
          logAudit('warn', 'poller',
            `מכשיר לא מגיב: ${dev.name || dev.ip} — ${r.why || 'לא ידוע'}`,
            { device_id: dev.id, ip: dev.ip });
        }
        const dev = db.prepare('SELECT * FROM devices WHERE id = ?').get(r.deviceId);
        if (dev) await checkDeviceDown(dev).catch(() => {});
      }
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[Poller] סבב הושלם: ${due.length} מכשירים ב-${secs} שניות` +
                (failed.length ? ` | ${failed.length} כשלים` : ''));
  } finally {
    _cycleRunning = false;
  }
}

// הפעל polling
function startPoller() {
  console.log('[Poller] מתחיל polling scheduler');

  // כל 30 שניות בדוק אילו מכשירים צריך לפולל
  cron.schedule('*/30 * * * * *', runCycle);

  // ניקוי metrics ישנים — פעם ביום בחצות
  cron.schedule('0 0 * * *', () => {
    pruneOldMetrics();
  });

  // אירועי התראה של מכשירים שנמחקו — סגירה אוטומטית אחרי 14 ימים. פעם בשעה, ופעם בהפעלה.
  const maintainAlerts = () => {
    try { maintainAlertEvents(); } catch (err) { console.error('[Poller] תחזוקת אירועי התראה נכשלה:', err.message); }
  };
  cron.schedule('7 * * * *', maintainAlerts);
  maintainAlerts();

  // רענון hostname (reverse DNS) לכתובות IP שנצפו ב-mac_entries — כל 5 דקות
  cron.schedule('*/5 * * * *', () => {
    refreshStaleHostnames().catch(err => console.error('[Poller] hostname refresh failed:', err.message));
  });
}

// force-poll מכשיר אחד (נקרא מ-route כשמוסיפים מכשיר חדש)
async function forcePoll(deviceId) {
  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device) throw new Error('מכשיר לא נמצא');
  return pollDevice(device);
}

// runCycle מיוצא כדי לאפשר בדיקה של זיהוי נפילת נתיב בלי להמתין ל-cron
module.exports = { startPoller, forcePoll, pollDevice, runCycle };
