/**
 * =====================================================================
 *  QI Anes — ระบบเก็บตัวชี้วัดคุณภาพการพยาบาลวิสัญญี (ฝั่งเซิร์ฟเวอร์)
 *  ใช้คู่กับแอป P4P Anes (หน้า "ตัวชี้วัดคุณภาพ (QI)")
 *
 *  อ้างอิง: กองการพยาบาล สป.สธ. ชุดหนังสือมาตรฐานและการประเมินคุณภาพ
 *  การบริการพยาบาลในโรงพยาบาล เล่มที่ 9 (2568) บทที่ 2 ส่วนที่ 4
 *
 *  ติดตั้งเป็น Apps Script "แยกโปรเจกต์" จาก P4P (ผูกกับ Google Sheet ไฟล์ใหม่)
 *  → ไม่แตะ Code.gs เดิมของ P4P เลย และแยกข้อมูล HN ผู้ป่วยไว้คนละไฟล์
 *  ดูขั้นตอนใน README_QI.md
 *
 *  ชีตที่ระบบสร้างให้อัตโนมัติ:
 *   - QI_Events   : 1 แถว = 1 Event (จากวิสัญญีพยาบาล)
 *   - QI_Daily    : 1 แถว = 1 วัน (ยอดผู้ป่วยรวม / ใส่ ETT จาก Admin)
 *   - QI_Monthly  : สรุป A / B / ผลลัพธ์ รายเดือน 12 เดือนล่าสุด (สำหรับรายงาน / Looker Studio)
 * =====================================================================
 */

const QI_TZ = 'Asia/Bangkok';
const SH_EVENTS = 'QI_Events';
const SH_DAILY = 'QI_Daily';
const SH_MONTHLY = 'QI_Monthly';

// PIN ของหน้า Admin — เปลี่ยนได้ที่ Project Settings > Script properties > ADMIN_PIN
// (ถ้าไม่ได้ตั้ง จะใช้ค่าเริ่มต้นนี้ ควรเปลี่ยนก่อนใช้งานจริง)
const DEFAULT_ADMIN_PIN = '2468';

const EVENT_HEADERS = ['บันทึกเมื่อ (เซิร์ฟเวอร์)', 'EventID', 'EntryID', 'วันที่เริ่มให้ยาระงับความรู้สึก', 'เวร', 'จุดปฏิบัติงาน',
  'HN', 'ชนิดการระงับความรู้สึก', 'รหัส Event', 'ตัวชี้วัด', 'ชื่อ Event', 'สาเหตุ/ชนิด', 'ระดับความรุนแรง', 'กลุ่มความรุนแรง',
  'เวลาที่ตรวจพบ', 'เวลาที่เริ่ม CPR', 'นาทีถึง CPR', 'ภายใน 4 นาที', 'รายละเอียด', 'ผู้รายงาน', 'บันทึกเมื่อ (เครื่อง)', 'สถานะ'];
const DAILY_HEADERS = ['วันที่', 'ผู้ป่วยที่ได้รับยาระงับความรู้สึกทั้งหมด', 'ผู้ป่วยที่ใส่ ETT', 'ตรวจสอบ Event แล้ว', 'ผู้บันทึก (Admin)',
  'บันทึกเมื่อ (เครื่อง)', 'บันทึกเมื่อ (เซิร์ฟเวอร์)', 'EntryID'];

const QI_EVENT_LABELS = {
  postpone_patient: 'เลื่อน/งดผ่าตัด: ผู้ป่วยไม่พร้อม',
  postpone_equip: 'เลื่อน/งดผ่าตัด: ยา/เวชภัณฑ์/เครื่องมือ/อุปกรณ์ไม่พร้อม',
  cpr: 'ภาวะคุกคามชีวิต (ต้อง CPR)',
  unplanned: 'อาการเปลี่ยนแปลงโดยไม่ได้คาดการณ์',
  complication: 'ภาวะแทรกซ้อนที่ป้องกันได้จากการระงับความรู้สึก',
  reintubation: 'ใส่ท่อช่วยหายใจซ้ำในห้องพักฟื้น',
  transfer: 'อุบัติการณ์ระหว่างส่งต่อ/เคลื่อนย้าย',
  med_error: 'ความคลาดเคลื่อนการบริหารยา/สารน้ำ',
  blood_error: 'ความคลาดเคลื่อนการให้เลือด',
  wrong_id: 'ระบุตัวผู้ป่วยผิดคน',
  fall: 'พลัดตกหกล้ม',
  positioning_injury: 'บาดเจ็บจากการจัดท่า/ผูกยึด/อุปกรณ์',
  resus_unready: 'ความไม่พร้อมต่อการช่วยชีวิตฉุกเฉิน',
  narcotic: 'อุบัติการณ์ยาเสพติดให้โทษประเภท 2',
};

/*
 * นิยามตัวชี้วัด 14 ตัวที่เก็บผ่านแอป
 *  type 'pct'   : ผลลัพธ์ = (A × 100) / B
 *  type 'count' : ผลลัพธ์ = A (นับจำนวน)
 *  rule 'zero'  : ผ่านเมื่อ A = 0 · rule 'hundred' : ผ่านเมื่อผลลัพธ์ = 100
 *  den ที่เป็นชื่อ Event = ตัวหารมาจาก Event เอง (เช่น Med error ทั้งหมดระดับ A–I)
 */
const QI_KPIS = [
  { code: '2.2', name: 'ร้อยละของการเลื่อนผ่าตัดจากผู้ป่วยไม่พร้อมระงับความรู้สึก', type: 'pct', num: 'postpone_patient', den: 'casesPlusPostponed', target: 'เท่ากับ 0', rule: 'zero' },
  { code: '2.3', name: 'ร้อยละของการเลื่อนผ่าตัดจากความไม่พร้อมของยา เวชภัณฑ์ เครื่องมือ และอุปกรณ์', type: 'pct', num: 'postpone_equip', den: 'casesPlusPostponed', target: 'เท่ากับ 0', rule: 'zero' },
  { code: '5.6', name: 'จำนวนอุบัติการณ์ความไม่พร้อมต่อการช่วยชีวิตฉุกเฉิน', type: 'count', num: 'resus_unready', target: 'เท่ากับ 0', rule: 'zero' },
  { code: '5.7', name: 'จำนวนอุบัติการณ์ไม่พึงประสงค์จากการบริหารจัดการยาเสพติดให้โทษประเภท 2', type: 'count', num: 'narcotic', target: 'เท่ากับ 0', rule: 'zero' },
  { code: '6.1', name: 'ร้อยละของผู้ป่วยภาวะคุกคามชีวิตที่ได้รับการแก้ไขทันทีภายใน 4 นาที', type: 'pct', num: 'cpr_within4', den: 'cpr', target: 'ร้อยละ 100', rule: 'hundred' },
  { code: '6.2', name: 'อัตราการเกิดอาการเปลี่ยนแปลงของผู้ป่วยโดยไม่ได้คาดการณ์', type: 'pct', num: 'unplanned', den: 'cases', target: 'เท่ากับ 0', rule: 'zero' },
  { code: '6.3', name: 'อัตราการเกิดภาวะแทรกซ้อนที่ป้องกันได้จากการระงับความรู้สึก', type: 'pct', num: 'complication', den: 'cases', target: 'เท่ากับ 0', rule: 'zero' },
  { code: '6.4', name: 'อัตราการใส่ท่อช่วยหายใจซ้ำในห้องพักฟื้น', type: 'pct', num: 'reintubation', den: 'ett', target: 'เท่ากับ 0', rule: 'zero' },
  { code: '6.5', name: 'อัตราการเกิดอุบัติการณ์ไม่พึงประสงค์ระหว่างส่งต่อหรือเคลื่อนย้าย', type: 'pct', num: 'transfer', den: 'cases', target: 'เท่ากับ 0', rule: 'zero' },
  { code: '6.6', name: 'ร้อยละของความคลาดเคลื่อนจากการบริหารยา/สารน้ำ ระดับ E–I', type: 'pct', num: 'med_error_EI', den: 'med_error', target: 'เท่ากับ 0', rule: 'zero' },
  { code: '6.7', name: 'ร้อยละของความคลาดเคลื่อนจากการให้เลือด ระดับ E–I', type: 'pct', num: 'blood_error_EI', den: 'blood_error', target: 'เท่ากับ 0', rule: 'zero' },
  { code: '6.8', name: 'จำนวนอุบัติการณ์การระบุตัวผู้ป่วยผิดคน', type: 'count', num: 'wrong_id', target: 'เท่ากับ 0', rule: 'zero' },
  { code: '6.9', name: 'ร้อยละของการพลัดตกหกล้ม ระดับ E–I', type: 'pct', num: 'fall_EI', den: 'fall', target: 'เท่ากับ 0', rule: 'zero' },
  { code: '6.10', name: 'อัตราการเกิดการบาดเจ็บจากการจัดท่า ผูกยึด หรือการใช้อุปกรณ์และเครื่องมือ', type: 'pct', num: 'positioning_injury', den: 'cases', target: 'เท่ากับ 0', rule: 'zero' },
];
const DEN_FROM_EVENTS = { cpr: true, med_error: true, blood_error: true, fall: true };
const SEVERE = { E: true, F: true, G: true, H: true, I: true };

/* =====================================================================
   Web App entry points
===================================================================== */
function doGet(e) {
  const p = (e && e.parameter) || {};
  let out;
  try {
    switch (p.action) {
      case 'qi_check': out = qiCheck_(p.hn, p.date); break;
      case 'qi_verify_pin': out = { ok: String(p.pin || '') === getPin_() }; break;
      case 'qi_dashboard': out = qiDashboard_(p.month); break;
      default: out = { ok: true, service: 'QI Anes' };
    }
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return json_(out);
}

function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    ensureSheets_();
    if (data.action === 'qi_event') return json_(saveEvents_(data));
    if (data.action === 'qi_event_delete') return json_(deleteEntry_(data.entryId));
    if (data.action === 'qi_daily') return json_(saveDaily_(data));
    return json_({ ok: false, error: 'unknown action' });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getPin_() {
  return PropertiesService.getScriptProperties().getProperty('ADMIN_PIN') || DEFAULT_ADMIN_PIN;
}

/* =====================================================================
   Sheets
===================================================================== */
function ensureSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [[SH_EVENTS, EVENT_HEADERS], [SH_DAILY, DAILY_HEADERS]].forEach(function (pair) {
    let sh = ss.getSheetByName(pair[0]);
    if (!sh) {
      sh = ss.insertSheet(pair[0]);
      sh.getRange(1, 1, 1, pair[1].length).setValues([pair[1]]).setFontWeight('bold').setBackground('#fff1e8');
      sh.setFrozenRows(1);
    }
  });
}

// ใส่ ' นำหน้าเพื่อให้ Google Sheets เก็บเป็นข้อความ (กัน HN เลข 0 นำหน้าหาย / วันที่-เวลาถูกแปลงรูปแบบ)
function txt_(v) { return (v === null || v === undefined || v === '') ? '' : "'" + String(v); }

function normDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, QI_TZ, 'yyyy-MM-dd');
  return String(v || '').replace(/^'/, '').slice(0, 10);
}

function readEvents_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_EVENTS);
  if (!sh || sh.getLastRow() < 2) return [];
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, EVENT_HEADERS.length).getValues();
  return rows.map(function (r) {
    return {
      eventId: String(r[1]), entryId: String(r[2]), date: normDate_(r[3]), shift: String(r[4]), location: String(r[5]),
      hn: String(r[6]).replace(/^'/, ''), anesType: String(r[7]), type: String(r[8]), kpi: String(r[9]), label: String(r[10]),
      reason: String(r[11]), severity: String(r[12]).replace(/^'/, ''), within4: r[17] === true || String(r[17]).toUpperCase() === 'TRUE' || r[17] === 'ใช่',
      reporter: String(r[19]), clientTs: String(r[20]), status: String(r[21]),
    };
  }).filter(function (e) { return e.status !== 'deleted'; });
}

function readDaily_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_DAILY);
  if (!sh || sh.getLastRow() < 2) return [];
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, DAILY_HEADERS.length).getValues();
  return rows.map(function (r) {
    return { date: normDate_(r[0]), cases: Number(r[1]) || 0, ett: Number(r[2]) || 0,
      verified: r[3] === true || String(r[3]).toUpperCase() === 'TRUE' || r[3] === 'ใช่', admin: String(r[4]) };
  }).filter(function (d) { return d.date; });
}

/* =====================================================================
   POST handlers
===================================================================== */
function saveEvents_(entry) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_EVENTS);
  const existing = {};
  if (sh.getLastRow() >= 2) {
    sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { existing[String(r[0])] = true; });
  }
  const events = Array.isArray(entry.events) ? entry.events : [];
  let added = 0;
  events.forEach(function (ev) {
    if (!ev.eventId || existing[ev.eventId]) return; // กันบันทึกซ้ำเมื่อแอป retry / ส่งซ้ำ
    const sev = String(ev.severity || '');
    sh.appendRow([
      new Date(), ev.eventId, entry.entryId, txt_(entry.date), entry.shift || '', entry.location || '',
      txt_(entry.hn), entry.anesType || '', ev.type, ev.kpi || '', QI_EVENT_LABELS[ev.type] || ev.type,
      ev.reason || '', sev, sev ? (SEVERE[sev] ? 'E–I' : 'A–D') : '',
      txt_(ev.detectTime), txt_(ev.cprTime), (ev.minutes === 0 || ev.minutes) ? ev.minutes : '',
      ev.type === 'cpr' ? (ev.within4 ? 'ใช่' : 'ไม่ใช่') : '',
      ev.detail || '', entry.reporter || '', entry.timestamp || '', 'active',
    ]);
    existing[ev.eventId] = true;
    added++;
  });
  return { ok: true, added: added };
}

function deleteEntry_(entryId) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_EVENTS);
  if (!entryId || sh.getLastRow() < 2) return { ok: true, deleted: 0 };
  const ids = sh.getRange(2, 3, sh.getLastRow() - 1, 1).getValues();
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(entryId)) {
      sh.getRange(i + 2, EVENT_HEADERS.length).setValue('deleted'); // เก็บแถวไว้เป็นหลักฐาน แค่เปลี่ยนสถานะ
      n++;
    }
  }
  return { ok: true, deleted: n };
}

function saveDaily_(d) {
  if (String(d.pin || '') !== getPin_()) return { ok: false, error: 'pin' };
  const date = String(d.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'date' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SH_DAILY);
  const row = [txt_(date), Number(d.totalCases) || 0, Number(d.ettCases) || 0, d.verified ? 'ใช่' : 'ไม่ใช่', d.admin || '',
    d.timestamp || '', new Date(), d.entryId || ''];
  if (sh.getLastRow() >= 2) {
    const vals = sh.getRange(2, 1, sh.getLastRow() - 1, DAILY_HEADERS.length).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (normDate_(vals[i][0]) === date) {
        // 1 วัน = 1 แถว · แก้ไขทับได้ แต่ไม่ให้ข้อมูลเก่า (จากการส่งซ้ำ) ทับข้อมูลใหม่กว่า
        if (String(vals[i][5]) && String(d.timestamp || '') < String(vals[i][5])) return { ok: true, skipped: 'older' };
        sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
        return { ok: true, updated: true };
      }
    }
  }
  sh.appendRow(row);
  return { ok: true, added: true };
}

/* =====================================================================
   GET handlers
===================================================================== */
function qiCheck_(hn, date) {
  hn = String(hn || '').trim();
  date = String(date || '').slice(0, 10);
  if (!hn || !date) return { ok: true, events: [] };
  const list = readEvents_().filter(function (e) { return e.hn === hn && e.date === date; })
    .map(function (e) { return { type: e.type, label: e.label, shift: e.shift, reporter: e.reporter, location: e.location }; });
  return { ok: true, events: list };
}

function monthKey_(d) { return String(d).slice(0, 7); }

function shiftMonth_(ym, delta) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + delta;
  const dt = new Date(y, m, 1);
  return dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2);
}

function computeKpis_(daily, events) {
  const c = { cases: 0, ett: 0, cpr_within4: 0 };
  daily.forEach(function (d) { c.cases += Number(d.cases) || 0; c.ett += Number(d.ett) || 0; });
  events.forEach(function (e) {
    c[e.type] = (c[e.type] || 0) + 1;
    if (SEVERE[e.severity]) c[e.type + '_EI'] = (c[e.type + '_EI'] || 0) + 1;
    if (e.type === 'cpr' && e.within4) c.cpr_within4++;
  });
  c.casesPlusPostponed = c.cases + (c.postpone_patient || 0) + (c.postpone_equip || 0);

  return QI_KPIS.map(function (k) {
    const a = c[k.num] || 0;
    const out = { code: k.code, name: k.name, type: k.type, target: k.target, a: a, b: null, value: null, status: 'na', note: '' };
    if (k.type === 'count') {
      out.value = a;
      out.status = a === 0 ? 'pass' : 'fail';
      return out;
    }
    const b = c[k.den] || 0;
    out.b = b;
    if (b === 0) {
      if (DEN_FROM_EVENTS[k.den]) { out.status = 'none'; out.note = 'ไม่มีเหตุการณ์'; }
      else { out.status = 'na'; out.note = 'ยังไม่มียอดผู้ป่วย'; }
      return out;
    }
    out.value = Math.round(a * 100 / b * 100) / 100;
    if (k.rule === 'hundred') out.status = (a === b) ? 'pass' : 'fail';
    else out.status = a === 0 ? 'pass' : 'fail';
    return out;
  });
}

function qiDashboard_(month) {
  const now = Utilities.formatDate(new Date(), QI_TZ, 'yyyy-MM-dd');
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) month = now.slice(0, 7);
  const allEvents = readEvents_();
  const allDaily = readDaily_();

  const evM = allEvents.filter(function (e) { return monthKey_(e.date) === month; });
  const dyM = allDaily.filter(function (d) { return monthKey_(d.date) === month; });

  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const daysInMonth = new Date(y, m, 0).getDate();
  const lastDay = (month === now.slice(0, 7)) ? Number(now.slice(8, 10)) : (month > now.slice(0, 7) ? 0 : daysInMonth);

  const byDay = {};
  dyM.forEach(function (d) { byDay[d.date] = d; });
  const evByDay = {};
  evM.forEach(function (e) { evByDay[e.date] = (evByDay[e.date] || 0) + 1; });

  const daily = [];
  const missing = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = month + '-' + ('0' + d).slice(-2);
    const rec = byDay[iso];
    daily.push({ date: iso, cases: rec ? rec.cases : null, ett: rec ? rec.ett : null, verified: rec ? rec.verified : false, events: evByDay[iso] || 0 });
    if (d <= lastDay && !rec) missing.push(iso);
  }

  const eventTypes = {};
  evM.forEach(function (e) { eventTypes[e.type] = (eventTypes[e.type] || 0) + 1; });

  const trend = [];
  for (let i = 11; i >= 0; i--) {
    const ym = shiftMonth_(month, -i);
    const ev = allEvents.filter(function (e) { return monthKey_(e.date) === ym; });
    const dy = allDaily.filter(function (d) { return monthKey_(d.date) === ym; });
    const k = computeKpis_(dy, ev);
    const vals = {};
    k.forEach(function (x) { vals[x.code] = x.value; });
    trend.push({ month: ym, cases: dy.reduce(function (s, d) { return s + d.cases; }, 0), events: ev.length, values: vals });
  }

  return {
    ok: true, month: month, generated: new Date().toISOString(),
    summary: {
      cases: dyM.reduce(function (s, d) { return s + d.cases; }, 0),
      ett: dyM.reduce(function (s, d) { return s + d.ett; }, 0),
      events: evM.length, daysInMonth: daysInMonth, daysElapsed: lastDay,
      daysWithTotals: dyM.length, daysVerified: dyM.filter(function (d) { return d.verified; }).length,
    },
    kpis: computeKpis_(dyM, evM), eventTypes: eventTypes, daily: daily, missingDays: missing, trend: trend,
  };
}

/* =====================================================================
   สรุปรายเดือนลงชีต QI_Monthly (สำหรับรายงาน / Looker Studio)
===================================================================== */
function refreshQiMonthly() {
  ensureSheets_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SH_MONTHLY);
  if (!sh) sh = ss.insertSheet(SH_MONTHLY);
  sh.clear();
  const header = ['เดือน', 'ตัวชี้วัด', 'ชื่อตัวชี้วัด', 'A (ตัวตั้ง)', 'B (ตัวหาร)', 'ผลลัพธ์', 'ค่าเป้าหมาย', 'ผลการประเมิน'];
  const out = [header];
  const thisMonth = Utilities.formatDate(new Date(), QI_TZ, 'yyyy-MM');
  const allEvents = readEvents_();
  const allDaily = readDaily_();
  const STATUS = { pass: 'ผ่าน', fail: 'ไม่ผ่าน', none: 'ไม่มีเหตุการณ์', na: 'รอข้อมูล' };
  for (let i = 11; i >= 0; i--) {
    const ym = shiftMonth_(thisMonth, -i);
    const k = computeKpis_(allDaily.filter(function (d) { return monthKey_(d.date) === ym; }),
      allEvents.filter(function (e) { return monthKey_(e.date) === ym; }));
    k.forEach(function (x) {
      out.push(["'" + ym, "'" + x.code, x.name, x.a, x.b === null ? '' : x.b, x.value === null ? '' : x.value, x.target, STATUS[x.status] || x.status]);
    });
  }
  sh.getRange(1, 1, out.length, header.length).setValues(out);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#fff1e8');
  sh.setFrozenRows(1);
}

/** รันครั้งเดียว: ตั้งให้สรุป QI_Monthly ใหม่อัตโนมัติทุกวัน 19:30 น. */
function setupQiTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshQiMonthly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshQiMonthly').timeBased().everyDays(1).atHour(19).nearMinute(30).inTimezone(QI_TZ).create();
  ensureSheets_();
  refreshQiMonthly();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('QI Anes')
    .addItem('สรุปรายเดือน (QI_Monthly) ตอนนี้', 'refreshQiMonthly')
    .addItem('ตั้งค่าสรุปอัตโนมัติทุกวัน (ทำครั้งเดียว)', 'setupQiTriggers')
    .addToUi();
}
