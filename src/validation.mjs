export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = message => { throw new AppError(400, message); };
export const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
export const day = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)
  && !Number.isNaN(Date.parse(x)) && new Date(x).toISOString().slice(0,10) === x;
export const todayLondon = () => new Intl.DateTimeFormat('en-CA', {
  timeZone:'Europe/London', year:'numeric', month:'2-digit', day:'2-digit'
}).format(new Date());
export function text(x, max = 2000, required = false) {
  if (x == null && !required) return '';
  if (typeof x !== 'string' || x.length > max || (required && !x.trim())) bad('Invalid text field.');
  return x;
}
function numeric(x, min, max, integer = false) {
  if (x === null || x === undefined || x === '') return null;
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max || (integer && !Number.isInteger(x))) bad('Invalid numeric field.');
  return x;
}
function choice(x, options) {
  x = x ?? '';
  if (!options.includes(x)) bad('Invalid selection.');
  return x;
}
export function checkin(x) {
  if (!object(x) || !day(x.date) || x.date > todayLondon()) bad('Choose a valid date, today or earlier.');
  return {
    date:x.date, energy:numeric(x.energy,1,5,true), legSoreness:numeric(x.legSoreness,0,10,true),
    anklePain:numeric(x.anklePain,0,10,true), sleepQuality:numeric(x.sleepQuality,1,5,true),
    jumpContacts:numeric(x.jumpContacts,0,5000,true), gymMinutes:numeric(x.gymMinutes,0,600,true),
    ankleSide:choice(x.ankleSide,['','Left','Right','Both','Neither']),
    instability:choice(x.instability,['','No','Yes']),
    gymFocus:choice(x.gymFocus,['','Upper body / arms','Lower body','Ankle / calf work','Mixed session','No gym']),
    notes:text(x.notes,1200), source:'Manual check-in'
  };
}
export function benchmark(x) {
  if (!object(x) || !day(x.date) || x.date > todayLondon()) bad('Choose a valid benchmark date.');
  const value = numeric(x.value,0.1,1e7);
  if (value == null) bad('Enter a benchmark value.');
  return {id:text(x.id,100,true),date:x.date,kind:choice(x.kind,['FTP','CSS','5k','10k','HM','marathon','strength']),
    value,method:text(x.method,120,true),notes:text(x.notes,700),source:'User-entered benchmark'};
}
export function questionnaire(x, ids) {
  if (!object(x) || Object.keys(x).length > 100) bad('Invalid answers.');
  const out = {};
  for (const [key, val] of Object.entries(x)) {
    if (!ids.includes(key) || ['__proto__','constructor','prototype'].includes(key)) bad('Unknown question.');
    out[key] = text(val,1600);
  }
  return out;
}
export function validateSnapshot(x) {
  if (!object(x) || x.schemaVersion !== '1.0' || !object(x.meta) || !day(x.meta.asOfDate)) bad('Expected a dashboard snapshot with schemaVersion 1.0.');
  if (!object(x.athlete) || !object(x.capacityIssue) || !object(x.plan) || !Array.isArray(x.plan.weeks)) bad('Missing athlete, capacity or plan data.');
  for (const key of ['activities','recovery','sources','reportedBenchmarks']) if (!Array.isArray(x[key])) bad('Missing snapshot collection.');
  if (x.activities.length>50000 || x.recovery.length>20000 || x.plan.weeks.length>104) bad('Snapshot collection is too large.');
  text(x.plan.version,100,true);
  const ids = new Set();
  for (const a of x.activities) {
    if (!object(a) || typeof a.id!=='string' || ids.has(a.id) || !day(a.date)) bad('Invalid or duplicate activity.');
    ids.add(a.id);
    if (!['running','cycling','swimming','strength','mobility','walking'].includes(a.sport)) bad('Unknown activity sport.');
    text(a.title,500,true);text(a.subSport,100,true);
    if (numeric(a.activeSeconds,0,1e7)==null || numeric(a.elapsedSeconds,0,1e7)==null || a.elapsedSeconds<a.activeSeconds) bad('Invalid activity duration.');
    for (const k of ['distanceM','avgHr','avgPowerW','cadence','ascentM']) numeric(a[k],0,1e8);
  }
  const dates = new Set();
  for (const r of x.recovery) {
    if (!object(r) || !day(r.date) || dates.has(r.date)) bad('Invalid or duplicate recovery date.');
    dates.add(r.date);
    for (const k of ['hrvMs','hrvBaselineMs','sleepSeconds','sleepBaselineSeconds','restHr']) numeric(r[k],0,1e7);
  }
  for (const w of x.plan.weeks) {
    if (!Number.isInteger(w.week) || !day(w.start_date) || !day(w.end_date) || !Array.isArray(w.days)) bad('Invalid plan week.');
    for (const k of ['core_slot_minutes','upper_range_slot_minutes','run_minutes','optional_cycle_minutes','weekly_ceiling_minutes']) numeric(w[k],0,10080);
    for (const entry of w.days) {
      if (!['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].includes(entry.day)) bad('Invalid plan day.');
      text(entry.sport,200,true);text(entry.description,20000);numeric(entry.slot_minutes,0,1440);numeric(entry.max_minutes,0,1440);
    }
  }
  for (const s of x.sources) {text(s.title,500,true);text(s.detail,10000);}
  for (const c of x.manualCheckins || []) checkin(c);
  for (const b of x.manualBenchmarks || []) benchmark(b);
  return x;
}
