import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, validateSnapshot, checkin, benchmark, questionnaire } from './validation.mjs';
import { digest } from './auth.mjs';

export function openStore(dir) {
  mkdirSync(dir,{recursive:true,mode:0o700});
  const file=join(dir,'training.sqlite');
  const db=new DatabaseSync(file);
  chmodSync(file,0o600);
  if(db.prepare('PRAGMA user_version').get().user_version>1) {
    db.close();throw Error('This database needs a newer app version.');
  }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activities (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recovery (date TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plans (version TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, imported_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS journals (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS calendars (version TEXT PRIMARY KEY REFERENCES plans(version), body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL, auth_version TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS login_attempts (time INTEGER NOT NULL);
    PRAGMA user_version=1;`);
  const setting = key => {const r=db.prepare('SELECT body FROM settings WHERE key=?').get(key);return r?JSON.parse(r.body):null;};
  const set = (key,x) => db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key,JSON.stringify(x));
  const rows = table => db.prepare(`SELECT body FROM ${table}`).all().map(r=>JSON.parse(r.body));
  function journal(kind) {
    return db.prepare('SELECT body, revision, updated_at FROM journals WHERE kind=? ORDER BY id DESC').all(kind)
      .map(r=>({...JSON.parse(r.body),revision:r.revision,updatedAt:r.updated_at}));
  }
  function saveJournal(kind,id,value,revision=0) {
    if (!Number.isInteger(revision) || revision<0) throw new AppError(400,'Invalid record revision.');
    const current=db.prepare('SELECT revision FROM journals WHERE kind=? AND id=?').get(kind,id);
    if ((current?.revision || 0)!==revision) throw new AppError(409,'This entry changed on another device. Reload before saving.');
    const updatedAt=new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO journals VALUES (?,?,?,?,?)').run(kind,id,JSON.stringify(value),revision+1,updatedAt);
    return {...value,revision:revision+1,updatedAt};
  }
  function snapshot() {
    const x=setting('snapshot');if (!x) return null;
    return {...x,plan:JSON.parse(db.prepare('SELECT body FROM plans WHERE version=?').get(setting('currentPlan')).body),
      activities:rows('activities').sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id)),
      recovery:rows('recovery').sort((a,b)=>a.date.localeCompare(b.date)),
      manualCheckins:journal('checkin'),manualBenchmarks:journal('benchmark')};
  }
  function importSnapshot(input) {
    const x=structuredClone(validateSnapshot(input));
    const encoded=JSON.stringify(x.plan), hash=digest(encoded);
    const prior=db.prepare('SELECT digest FROM plans WHERE version=?').get(x.plan.version);
    if (prior && prior.digest!==hash) throw new AppError(409,'This plan version already exists with different content. Supply a new version ID.');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO plans VALUES (?,?,?,?)').run(x.plan.version,encoded,hash,new Date().toISOString());
      set('currentPlan',x.plan.version);
      db.exec('DELETE FROM activities; DELETE FROM recovery;');
      for (const a of x.activities) db.prepare('INSERT INTO activities VALUES (?,?)').run(a.id,JSON.stringify(a));
      for (const r of x.recovery) db.prepare('INSERT INTO recovery VALUES (?,?)').run(r.date,JSON.stringify(r));
      for (const [kind,list,normalise] of [['checkin',x.manualCheckins||[],checkin],['benchmark',x.manualBenchmarks||[],benchmark]]) {
        for (const entry of list) {
          const v=normalise(entry),id=kind==='checkin'?v.date:v.id;
          // Snapshot re-imports never replace newer server journal entries.
          if (!db.prepare('SELECT 1 FROM journals WHERE kind=? AND id=?').get(kind,id)) saveJournal(kind,id,v,0);
        }
      }
      const {plan,activities,recovery,manualCheckins,manualBenchmarks,...metadata}=x;
      set('snapshot',metadata);set('importedAt',new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {db.exec('ROLLBACK');throw error;}
  }
  function save(kind,value,revision) {
    if (kind==='checkin') {const x=checkin(value);return saveJournal(kind,x.date,x,revision);}
    if (kind==='benchmark') {const x=benchmark(value);return saveJournal(kind,x.id,x,revision);}
    if (kind==='answers') {
      const ids=(snapshot()?.plan.questions||[]).map(q=>q.id);
      const x=questionnaire(value,ids);return saveJournal(kind,'current',{answers:x},revision);
    }
    throw new AppError(400,'Unknown journal type.');
  }
  function remove(kind,id,revision) {
    const r=db.prepare('SELECT revision FROM journals WHERE kind=? AND id=?').get(kind,id);
    if (!r) throw new AppError(404,'Entry not found.');
    if (r.revision!==revision) throw new AppError(409,'This entry changed on another device. Reload before deleting.');
    db.prepare('DELETE FROM journals WHERE kind=? AND id=?').run(kind,id);
  }
  function importCalendar(ics, version) {
    if (!db.prepare('SELECT 1 FROM plans WHERE version=?').get(version)) throw new AppError(400,'Import the corresponding plan first.');
    if (ics.length>5000000 || !ics.startsWith('BEGIN:VCALENDAR') || !ics.includes('END:VCALENDAR')) throw new AppError(400,'Invalid calendar.');
    const prior=db.prepare('SELECT body FROM calendars WHERE version=?').get(version);
    if(prior && prior.body!==ics) throw new AppError(409,'Calendar version already exists with different content.');
    db.prepare('INSERT OR IGNORE INTO calendars VALUES (?,?)').run(version,ics);
  }
  function exportAll() {
    return {format:'training-backup',version:1,exportedAt:new Date().toISOString(),snapshot:snapshot(),
      plans:rows('plans'),calendars:db.prepare('SELECT version, body FROM calendars').all(),
      checkins:journal('checkin'),benchmarks:journal('benchmark'),answers:journal('answers')};
  }
  function applyRefresh({activities,recovery,metadata,status}) {
    const current=snapshot();
    if(!current) throw new AppError(409,'Import the existing plan before refreshing.');
    validateSnapshot({...current,activities,recovery,meta:{...current.meta,...metadata}});
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM activities; DELETE FROM recovery;');
      for(const row of activities) db.prepare('INSERT INTO activities VALUES (?,?)').run(row.id,JSON.stringify(row));
      for(const row of recovery) db.prepare('INSERT INTO recovery VALUES (?,?)').run(row.date,JSON.stringify(row));
      const stored=setting('snapshot');set('snapshot',{...stored,meta:{...stored.meta,...metadata}});
      set('tredictSync',status);db.exec('COMMIT');
    } catch(error){db.exec('ROLLBACK');throw error;}
  }
  return {db,file,setting,set,journal,snapshot,importSnapshot,applyRefresh,save,remove,importCalendar,exportAll,
    backup:dest=>backup(db,dest),close:()=>db.close()};
}
