import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/db.mjs';
import { createTredictSync, normalizeActivity, normalizeDaily, normalizeMinimumHeartRate } from '../src/tredict.mjs';
import { fixture } from './fixture.mjs';

const TOKEN='synthetic-token-not-an-account-credential';
const TIME=Date.parse('2025-02-05T12:00:00Z');
export const activity=()=>({id:'synthetic-new-run',date:'2025-02-05T07:00:00Z',sportType:'running',subSportType:'street',title:'Synthetic API run',
  summary:{duration:1800,durationTotal:1860,distance:5000,heartrate:130,cadence:162,altitude:{ascent:12}}});
export function provider(overrides={}) {
  const data={activityList:{_embedded:{activityList:[activity()]},_links:{}},hrv:{hrv:{20250205:[40,42]}},
    sleep:{sleep:{20250205:[27000,28800]}},bodyvalues:{bodyvalues:[{timestamp:'2025-02-05T06:00:00Z',timezoneOffsetInSeconds:0,hrRestDynamic:53}]},...overrides};
  return async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer '+TOKEN);
    assert.equal(options.redirect,'error');assert.equal(options.method,'GET');
    const path=new URL(url).pathname.split('/').at(-1),value=data[path];
    if(value instanceof Response)return value.clone();
    return Response.json(typeof value==='function'?await value(url):value);
  };
}
function setup(t,overrides={},options={}) {
  const dir=mkdtempSync(join(tmpdir(),'training-sync-test-')),store=openStore(dir);store.importSnapshot(fixture());
  const sync=createTredictSync(store,{token:TOKEN,fetchImpl:provider(overrides),now:()=>TIME,requestSpacingMs:0,...options});
  t.after(()=>{sync.stop();store.close();rmSync(dir,{recursive:true,force:true});});return {store,sync,dir};
}

test('normalisers preserve units, recording timezones and missing observations',()=>{
  const raw=activity();raw.date='2025-07-01T23:30:00Z';raw.timezone='Europe/London';
  const value=normalizeActivity(raw);assert.equal(value.date,'2025-07-02');assert.equal(value.cadence,162);assert.equal(value.avgPowerW,null);assert.equal(value.distanceM,5000);
  assert.equal(normalizeActivity({...raw,sportType:'misc',subSportType:'unclassified'}).sport,'other');
  assert.deepEqual(normalizeDaily({sleep:{20250205:[27000,null]}},'sleep'),[{date:'2025-02-05',sleepSeconds:27000,sleepBaselineSeconds:null}]);
  assert.deepEqual(normalizeDaily({hrv:{20250205:[null,42]}},'hrv'),[{date:'2025-02-05',hrvMs:null,hrvBaselineMs:42}]);
  assert.throws(()=>normalizeDaily({hrv:{20250230:[42,40]}},'hrv'));
  assert.throws(()=>normalizeActivity({...raw,summary:{duration:200,durationTotal:100}}));
  assert.throws(()=>normalizeActivity({...raw,summary:{...raw.summary,heartrate:'130'}}));
});

test('daily minimum HR uses sparse dynamic observations and supplied date offsets',()=>{
  const rows=normalizeMinimumHeartRate({bodyvalues:[
    {timestamp:'2025-02-04T23:30:00Z',timezoneOffsetInSeconds:3600,hrRestDynamic:56},
    {timestamp:'2025-02-05T07:00:00Z',hrRestDynamic:54},
    {timestamp:'2025-02-05T08:00:00Z',restingHeartrate:48,weightInKilograms:70},
    {timestamp:'2025-02-06T08:00:00Z',restingHeartrate:48}]});
  assert.deepEqual(rows,[{date:'2025-02-05',restHr:54}]);
});

test('successful refresh preserves plans, calendars, journals, imported history and original retrieval time',async t=>{
  const a=setup(t),before=a.store.snapshot(),importedAt=a.store.setting('importedAt');
  const calendar='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';a.store.importCalendar(calendar,'demo-v1');
  a.sync.refresh();a.store.save('checkin',{date:'2025-02-02',energy:4,notes:'Concurrent synthetic note'},0);
  await a.sync.settled();const after=a.store.snapshot(),status=a.sync.status();
  assert.deepEqual(after.plan,before.plan);assert.equal(a.store.exportAll().calendars[0].body,calendar);
  assert.equal(a.store.journal('checkin')[0].notes,'Concurrent synthetic note');assert.equal(after.activities.length,2);
  assert.equal(after.recovery.find(r=>r.date==='2025-02-05').sleepSeconds,27000);
  assert.equal(after.meta.retrievedAt,before.meta.retrievedAt);assert.equal(a.store.setting('importedAt'),importedAt);
  assert.equal(status.lastSuccessfulFetch,new Date(TIME).toISOString());assert.equal(status.sources.sleep.lastResult,'success');
  assert.equal(status.latestObservation.activities,'2025-02-05');assert.equal(status.refreshing,false);
  assert.ok(!JSON.stringify(a.store.exportAll()).includes(TOKEN));assert.ok(!JSON.stringify(status).includes(TOKEN));
  const second=openStore(a.dir);assert.equal(second.setting('tredictSync').lastSuccessfulFetch,status.lastSuccessfulFetch);second.close();
});

test('activity pagination is followed and duplicate identifiers do not create duplicate sessions',async t=>{
  let calls=0;
  const a=setup(t,{activityList:url=>{
    calls++;return calls===1?{_embedded:{activityList:[activity()]},_links:{next:{href:'https://www.tredict.com/api/oauth/v2/activityList?pageSize=500&startDate=2025-02-04T12%3A00%3A00Z'}}}:
      {_embedded:{activityList:[activity(),{...activity(),id:'synthetic-second-run',date:'2025-02-04T07:00:00Z'}]},_links:{}};
  }});
  a.sync.refresh();await a.sync.settled();assert.equal(calls,2);assert.equal(a.store.snapshot().activities.length,3);assert.equal(a.sync.status().lastRefreshError,null);
});

test('unsafe pagination cannot transmit the bearer token and retains the whole saved snapshot',async t=>{
  const visited=[];
  const a=setup(t,{}, {fetchImpl:async(url,options)=>{
    visited.push(url);
    if(url.includes('/activityList'))return Response.json({_embedded:{activityList:[activity()]},_links:{next:{href:'https://untrusted.invalid/collect'}}});
    return provider()(url,options);
  }});
  const before=a.store.snapshot();a.sync.refresh();await a.sync.settled();
  assert.ok(visited.every(url=>new URL(url).origin==='https://www.tredict.com'));assert.deepEqual(a.store.snapshot(),before);
  assert.equal(a.sync.status().sources.activities.lastResult,'error');assert.equal(a.sync.status().sources.hrv.lastResult,'retained');
});

test('failed or malformed health responses keep the last good data and fetch timestamp',async t=>{
  let fail=false;
  const a=setup(t,{sleep:()=>fail?{sleep:{20250205:['bad',28800]}}:{sleep:{20250205:[27000,28800]}}},{now:()=>TIME+(fail?120000:0)});
  a.sync.refresh();await a.sync.settled();const before=a.store.snapshot(),success=a.sync.status().lastSuccessfulFetch;
  fail=true;a.sync.refresh();await a.sync.settled();
  assert.deepEqual(a.store.snapshot(),before);assert.equal(a.sync.status().lastSuccessfulFetch,success);
  assert.equal(a.sync.status().sources.sleep.lastResult,'error');assert.equal(a.sync.status().sources.hrv.lastResult,'retained');
  assert.ok(a.sync.status().lastRefreshError);
});

test('authentication errors are sanitised and Retry-After prevents premature retries',async t=>{
  let clock=TIME;
  const a=setup(t,{hrv:new Response('private upstream text '+TOKEN,{status:403})});
  a.sync.refresh();await a.sync.settled();assert.match(a.sync.status().lastRefreshError,/token/);assert.ok(!JSON.stringify(a.sync.status()).includes(TOKEN));
  const b=setup(t,{sleep:new Response('private upstream text',{status:429,headers:{'Retry-After':'600'}})},{now:()=>clock});
  b.sync.refresh();await b.sync.settled();clock+=120000;assert.throws(()=>b.sync.refresh(),error=>error.status===429);
  assert.equal(b.sync.status().lastSuccessfulFetch,null);assert.ok(b.sync.status().nextAllowedAt>=TIME+600000);
});

test('concurrent requests share one refresh and the daily schedule survives process restarts',async t=>{
  let clock=TIME,release;const gate=new Promise(resolve=>{release=resolve;});let calls=0;
  const a=setup(t,{}, {now:()=>clock,fetchImpl:async(url,options)=>{calls++;await gate;return provider()(url,options);}});
  a.sync.tick();assert.equal(a.sync.refresh().alreadyRunning,true);release();await a.sync.settled();assert.equal(calls,4);
  a.sync.tick();assert.equal(calls,4);
  const restarted=createTredictSync(a.store,{token:TOKEN,fetchImpl:provider(),now:()=>clock,requestSpacingMs:0});
  restarted.tick();assert.equal(restarted.status().refreshing,false);
  clock+=86400000;restarted.tick();await restarted.settled();assert.equal(restarted.status().lastSuccessfulFetch,new Date(clock).toISOString());restarted.stop();
});

test('absent credentials never issue requests or alter saved data',t=>{
  const a=setup(t,{}, {token:'',fetchImpl:()=>{throw Error('Unexpected request');}}),before=a.store.snapshot();
  a.sync.tick();assert.throws(()=>a.sync.refresh(),error=>error.status===503);assert.deepEqual(a.store.snapshot(),before);assert.equal(a.sync.status().configured,false);
});
