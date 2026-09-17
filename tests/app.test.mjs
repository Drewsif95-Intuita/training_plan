import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createApp, config } from '../src/server.mjs';
import { passwordHash, verifyPassword } from '../src/auth.mjs';
import { openStore } from '../src/db.mjs';
import { checkin, validateSnapshot } from '../src/validation.mjs';
import { fixture } from './fixture.mjs';

const directories=[];
const temporary=()=>{const dir=mkdtempSync(join(tmpdir(),'training-test-'));directories.push(dir);return dir;};
const password='synthetic-passphrase-for-tests-only';
let hash;
before(async()=>{hash=await passwordHash(password);});
after(()=>directories.forEach(dir=>rmSync(dir,{recursive:true,force:true})));
async function setup(t,changes={}) {
  const options={production:false,port:0,origin:'http://127.0.0.1',host:'127.0.0.1',dataDir:temporary(),passwordHash:hash,sessionSeconds:43200,...changes};
  const app=createApp(options);app.store.importSnapshot(fixture());
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  options.origin='http://127.0.0.1:'+app.server.address().port;
  const close=async()=>{if(app.server.listening){app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}try{app.store.close();}catch{}};
  t.after(close);
  const request=(path,init={})=>fetch(options.origin+path,{redirect:'manual',...init,headers:{Origin:options.origin,...init.headers}});
  const login=async()=>{const r=await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];const s=await request('/api/session',{headers:{Cookie:cookie}});return {cookie,csrf:(await s.json()).csrf};};
  const mutate=(path,auth,value,method='POST')=>request(path,{method,headers:{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf,'Content-Type':'application/json'},body:JSON.stringify(value)});
  return {...app,options,request,login,mutate,close};
}

test('authentication protects all athlete pages, API and export paths',async t=>{
  const a=await setup(t);
  for(const path of ['/api/snapshot','/api/journal','/api/export','/api/status','/api/plan','/api/calendar','/app.js','/data/training.sqlite','/snapshot.json','/api/checkins']) {
    const r=await a.request(path);assert.equal(r.status,401,path);assert.match(r.headers.get('cache-control'),/no-store/);assert.doesNotMatch(await r.text(),/synthetic-run-a|Demo athlete/);
  }
  const r=await a.request('/');assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/login');
  const health=await a.request('/healthz');assert.deepEqual(await health.json(),{ok:true});
});

test('password hashing, login, origin protection, CSRF and logout revoke the session',async t=>{
  assert.equal(await verifyPassword('wrong-password',hash),false);
  const a=await setup(t);
  const bad=await a.request('/api/login',{method:'POST',headers:{Origin:'https://another.example','Content-Type':'application/json'},body:JSON.stringify({password})});assert.equal(bad.status,403);
  const auth=await a.login();
  const noCsrf=await a.request('/api/checkins',{method:'POST',headers:{Cookie:auth.cookie,'Content-Type':'application/json'},body:JSON.stringify({value:{date:'2025-02-02'}})});assert.equal(noCsrf.status,403);
  const r=await a.mutate('/api/logout',auth,{});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await a.request('/api/snapshot',{headers:{Cookie:auth.cookie}})).status,401);
});

test('server-side records persist across a restart and are visible to another device',async t=>{
  const a=await setup(t),auth=await a.login();
  const r=await a.mutate('/api/checkins',auth,{value:{date:'2025-02-02',energy:4,gymMinutes:25,notes:'Fictional gym note'},revision:0});assert.equal(r.status,200);
  assert.equal((await r.json()).anklePain,null);
  const second=await a.login(),journal=await a.request('/api/journal',{headers:{Cookie:second.cookie}});assert.equal((await journal.json()).checkins[0].gymMinutes,25);
  await a.close();
  const reloaded=openStore(a.options.dataDir);
  assert.equal(reloaded.journal('checkin')[0].notes,'Fictional gym note');assert.equal(reloaded.snapshot().activities.length,1);reloaded.close();
});

test('record revisions prevent stale overwrites and stale deletes across devices',async t=>{
  const a=await setup(t),auth=await a.login(),v={date:'2025-02-02',energy:3};
  assert.equal((await a.mutate('/api/checkins',auth,{value:v,revision:0})).status,200);
  assert.equal((await a.mutate('/api/checkins',auth,{value:{...v,energy:5},revision:0})).status,409);
  assert.equal((await a.mutate('/api/checkins/2025-02-02',auth,{revision:0},'DELETE')).status,409);
  assert.equal((await a.mutate('/api/checkins/2025-02-02',auth,{revision:1},'DELETE')).status,200);
});

test('blank symptoms stay null and invalid dates, ranges and numeric strings are rejected',()=>{
  assert.equal(checkin({date:'2025-02-02'}).instability,'');assert.equal(checkin({date:'2025-02-02',anklePain:0}).anklePain,0);
  for(const value of [{date:'2025-02-30'},{date:'2099-01-01'},{date:'2025-02-02',energy:0},{date:'2025-02-02',anklePain:11},{date:'2025-02-02',gymMinutes:'<img>'}])assert.throws(()=>checkin(value));
});

test('invalid or duplicate imports fail without changing the last good snapshot',async t=>{
  const a=await setup(t),previous=a.store.snapshot();
  for(const mutate of [x=>x.activities.push(x.activities[0]),x=>x.activities[0].elapsedSeconds=1,x=>x.recovery[0].hrvMs='bad',x=>x.plan.weeks[0].days[0].slot_minutes='bad']) {
    const x=fixture();mutate(x);assert.throws(()=>a.store.importSnapshot(x));assert.deepEqual(a.store.snapshot(),previous);
  }
});

test('imports are idempotent and retain server journal records and immutable plan versions',async t=>{
  const a=await setup(t);a.store.save('checkin',{date:'2025-02-02',energy:5},0);a.store.importSnapshot(fixture());
  assert.equal(a.store.snapshot().activities.length,1);assert.equal(a.store.journal('checkin')[0].energy,5);
  const changed=fixture();changed.plan.workingFtpW=200;assert.throws(()=>a.store.importSnapshot(changed),/version/);
  changed.plan.version='demo-v2';a.store.importSnapshot(changed);assert.equal(a.store.exportAll().plans.length,2);
});

test('question answers and benchmarks persist and are included in the account export',async t=>{
  const a=await setup(t),auth=await a.login();
  assert.equal((await a.mutate('/api/answers',auth,{value:{'demo-context':'Unknown symptoms; fictional'},revision:0})).status,200);
  assert.equal((await a.mutate('/api/benchmarks',auth,{value:{id:'fictional-benchmark',date:'2025-02-02',kind:'FTP',value:180,method:'Synthetic protocol'},revision:0})).status,200);
  assert.equal((await a.mutate('/api/answers',auth,{value:{unlisted:'test'},revision:1})).status,400);
  const r=await a.request('/api/export',{headers:{Cookie:auth.cookie}}),x=await r.json();assert.equal(x.answers[0].answers['demo-context'],'Unknown symptoms; fictional');assert.equal(x.benchmarks.length,1);assert.equal('sessions' in x,false);
});

test('not-connected refresh is explicit and never advances freshness or overwrites data',async t=>{
  const a=await setup(t),auth=await a.login(),previous=a.store.snapshot();
  const r=await a.mutate('/api/refresh',auth,{});assert.equal(r.status,501);assert.deepEqual(a.store.snapshot(),previous);
  const status=await (await a.request('/api/status',{headers:{Cookie:auth.cookie}})).json();assert.equal(status.lastSuccessfulFetch,null);assert.equal(status.latestObservation.activities,'2025-02-03');
});

test('original calendar retains stable UIDs and exact bytes through authenticated export',async t=>{
  const a=await setup(t),auth=await a.login();
  const ics='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:synthetic-calendar-id@example.invalid\r\nDTSTART;VALUE=DATE:20250203\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  a.store.importCalendar(ics,'demo-v1');
  const r=await a.request('/api/calendar',{headers:{Cookie:auth.cookie}});assert.equal(r.status,200);assert.equal(await r.text(),ics);assert.match(r.headers.get('cache-control'),/no-store/);
});

test('SQLite backup restores plan, journal and data while revoking sessions',async t=>{
  const a=await setup(t);await a.login();a.store.save('checkin',{date:'2025-02-02',energy:4},0);
  const backup=join(temporary(),'backup.sqlite'),target=temporary();await a.store.backup(backup);
  const r=spawnSync(process.execPath,['scripts/manage.mjs','restore-sqlite',backup,target],{cwd:new URL('..',import.meta.url),encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const restored=openStore(target);assert.equal(restored.journal('checkin')[0].energy,4);assert.equal(restored.snapshot().plan.version,'demo-v1');assert.equal(restored.db.prepare('SELECT count(*) AS n FROM sessions').get().n,0);restored.close();
});

test('login rate limits reject an eleventh concurrent attempt',async t=>{
  const a=await setup(t);
  const result=await Promise.all(Array.from({length:11},()=>a.request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'incorrect'})})));
  assert.equal(result.filter(r=>r.status===429).length,1);
});

test('production fails closed without HTTPS, a password hash and a mounted volume',()=>{
  assert.throws(()=>config({NODE_ENV:'production'}),/PASSWORD/);
  assert.throws(()=>config({NODE_ENV:'production',AUTH_PASSWORD_HASH:hash,APP_ORIGIN:'http://example.invalid'}),/HTTPS/);
  assert.throws(()=>config({NODE_ENV:'production',AUTH_PASSWORD_HASH:hash,APP_ORIGIN:'https://example.invalid'}),/volume/);
});

test('production cookies are Secure, HttpOnly, same-site and use the Host prefix',async t=>{
  const a=await setup(t,{production:true});
  const r=await a.request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
  assert.equal(r.status,200);const c=r.headers.get('set-cookie');for(const text of ['__Host-training_session','Secure','HttpOnly','SameSite=Strict','Path=/'])assert.ok(c.includes(text));
});

test('expired and modified session cookies cannot read private data',async t=>{
  const a=await setup(t),auth=await a.login();
  assert.equal((await a.request('/api/snapshot',{headers:{Cookie:auth.cookie+'x'}})).status,401);
  a.store.db.exec('UPDATE sessions SET expires=0');assert.equal((await a.request('/api/snapshot',{headers:{Cookie:auth.cookie}})).status,401);
});

test('source HTML contains no embedded snapshot, browser journal store or external scripts',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.doesNotMatch(html,/snapshot-data|__SNAPSHOT_JSON__|<script>|<script src="http/);
  for(const match of js.matchAll(/localStorage\.(?:getItem|setItem)\('([^']+)'/g))assert.equal(match[1],'training-theme');
});
