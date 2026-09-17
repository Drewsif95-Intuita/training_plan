import { setTimeout as delay } from 'node:timers/promises';
import { AppError, day, object } from './validation.mjs';

const BASE='https://www.tredict.com/api/oauth/v2/';
const DAY=86400000, INTERVAL=DAY, WINDOW_DAYS=120;
const SOURCES=['activities','hrv','sleep','dailyMinimumHr'];
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const ukDay=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const invalid=()=>{throw new AppError(502,'Tredict returned an unexpected data format. Saved data was kept.');};
function number(x,max=1e8) {if(x==null)return null;if(!finite(x)||x<0||x>max)invalid();return x;}
function timestamp(value) {
  const n=typeof value==='number'?value*1000:typeof value==='string'?Date.parse(value):NaN;
  if(!Number.isFinite(n)||n<0||n>8640000000000000)invalid();return n;
}
function dateTag(tag) {const date=tag.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');if(!/^\d{8}$/.test(tag)||!day(date))invalid();return date;}
function label(value,fallback,max) {if(value==null||value==='')return fallback;if(typeof value!=='string'||value.length>max)invalid();return value;}

export function normalizeActivity(a) {
  if(!object(a)||typeof a.id!=='string'||!a.id||a.id.length>200||!object(a.summary))invalid();
  const summary=a.summary,subSport=label(a.subSportType,'generic',100);
  let sport=a.sportType;
  if(sport==='misc') {
    const sub=subSport.toLowerCase().replace(/[^a-z]/g,'');
    sport=['strength','strengthtraining','weighttraining'].includes(sub)?'strength':
      ['yoga','pilates','mobility'].includes(sub)?'mobility':['walking','hiking'].includes(sub)?'walking':'other';
  }
  if(!['running','cycling','swimming','strength','mobility','walking','other'].includes(sport))invalid();
  let date;
  try {date=new Intl.DateTimeFormat('en-CA',{timeZone:a.timezone||'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(timestamp(a.date)));}
  catch {invalid();}
  const activeSeconds=number(summary.duration,1e7),elapsedSeconds=number(summary.durationTotal,1e7);
  if(activeSeconds===null||elapsedSeconds===null||elapsedSeconds<activeSeconds)invalid();
  return {id:a.id,date,sport,subSport,title:label(a.title,'Untitled activity',500),
    activeSeconds,elapsedSeconds,distanceM:number(summary.distance),avgHr:number(summary.heartrate),
    avgPowerW:number(summary.power),cadence:number(summary.cadence),ascentM:number(summary.altitude?.ascent),
    source:'Tredict Personal API'};
}

export function normalizeDaily(payload,key) {
  if(!object(payload)||!object(payload[key]))invalid();
  return Object.entries(payload[key]).map(([tag,pair])=>{
    if(!Array.isArray(pair)||pair.length!==2)invalid();
    const [value,baseline]=pair.map(x=>number(x,key==='sleep'?86400:500));
    return {date:dateTag(tag),...(key==='hrv'?{hrvMs:value,hrvBaselineMs:baseline}:{sleepSeconds:value,sleepBaselineSeconds:baseline})};
  });
}

export function normalizeMinimumHeartRate(payload) {
  if(!object(payload)||!Array.isArray(payload.bodyvalues))invalid();
  const dates=new Map();
  for(const revision of payload.bodyvalues) {
    if(!object(revision))invalid();
    // Sparse revisions do not imply a new daily measurement. Never use the static setting.
    if(!Object.hasOwn(revision,'hrRestDynamic'))continue;
    const value=number(revision.hrRestDynamic,300),time=timestamp(revision.timestamp);
    const offset=revision.timezoneOffsetInSeconds;
    if(offset!=null&&(!finite(offset)||Math.abs(offset)>50400))invalid();
    const date=offset==null?ukDay(new Date(time)):new Date(time+offset*1000).toISOString().slice(0,10);
    if(!dates.has(date)||dates.get(date).time<time)dates.set(date,{date,restHr:value,time});
  }
  return [...dates.values()].map(({time,...row})=>row);
}

function publicError(error) {
  if(error instanceof AppError)return error.message;
  return 'Tredict could not be reached or returned an incomplete response. Saved data was kept.';
}

function client(token,fetchImpl,signal,spacing) {
  let nextRequest=0;
  return async function get(url,path) {
    const address=new URL(url);
    if(address.origin!=='https://www.tredict.com'||address.username||address.password||address.hash||address.pathname!=='/api/oauth/v2/'+path)invalid();
    const wait=Math.max(0,nextRequest-Date.now());nextRequest=Math.max(nextRequest,Date.now())+spacing;
    if(wait)await delay(wait,undefined,{signal});
    const response=await fetchImpl(address.href,{method:'GET',redirect:'error',
      headers:{Authorization:'Bearer '+token,Accept:'application/json'},
      signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
    if(response.status===401||response.status===403)throw new AppError(502,'Tredict rejected the token. Check its read permissions and visit Tredict to reactivate an inactive personal token.');
    if(response.status===429) {
      const raw=response.headers.get('retry-after');
      const seconds=/^\d+$/.test(raw||'')?Number(raw):Math.max(0,(Date.parse(raw)-Date.now())/1000);
      const error=new AppError(429,'Tredict is rate limiting requests. Saved data was kept; wait before retrying.');
      error.retryAfter=Math.min(DAY,Math.max(60000,Number.isFinite(seconds)?seconds*1000:300000));throw error;
    }
    if(!response.ok)throw new AppError(502,'Tredict returned a service error. Saved data was kept.');
    if(!/json/i.test(response.headers.get('content-type')||''))invalid();
    if(Number(response.headers.get('content-length'))>8000000)invalid();
    const reader=response.body?.getReader();if(!reader)invalid();
    const chunks=[];let length=0;
    try {for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>8000000)invalid();chunks.push(value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{invalid();}
  };
}

export function createTredictSync(store,{token='',enabled=true,fetchImpl=fetch,now=()=>Date.now(),requestSpacingMs=150}={}) {
  const configured=!!token&&enabled;
  let running=null,timer=null,stopped=false,controller=null;
  const latest=()=>{
    const x=store.snapshot();
    const last=(rows,field)=>rows.filter(r=>field?finite(r[field]):true).map(r=>r.date).sort().at(-1)||null;
    return {activities:last(x?.activities||[]),hrv:last(x?.recovery||[],'hrvMs'),sleep:last(x?.recovery||[],'sleepSeconds'),dailyMinimumHr:last(x?.recovery||[],'restHr')};
  };
  function status() {
    const saved=store.setting('tredictSync')||{};
    return {...saved,mode:configured?'tredict':'imported-snapshot',integrationImplemented:true,configured,
      refreshing:!!running,lastSuccessfulFetch:saved.lastSuccessfulFetch||null,lastRefreshAttempt:saved.lastRefreshAttempt||null,
      lastRefreshError:saved.lastRefreshError||null,importedAt:store.setting('importedAt'),snapshotRetrievedAt:store.snapshot()?.meta.retrievedAt||null,
      latestObservation:latest(),sources:saved.sources||{},refreshWindowDays:WINDOW_DAYS,
      nextScheduledRefresh:configured?new Date(Math.max(saved.nextAllowedAt||0,(Date.parse(saved.lastRefreshAttempt)||0)+INTERVAL,now())).toISOString():null};
  }
  async function perform() {
    const attempt=new Date(now()).toISOString(),asOf=ukDay(new Date(now()));
    const start=new Date(now()-(WINDOW_DAYS-1)*DAY).toISOString().slice(0,10),end=new Date(now()).toISOString();
    // Fetch an extra UTC day so positive recording offsets do not lose the first local day.
    const activityLowerBound=new Date(Date.parse(start+'T00:00:00Z')-DAY).toISOString();
    const previous=store.setting('tredictSync')||{};
    store.set('tredictSync',{...previous,lastRefreshAttempt:attempt,lastRefreshError:null});
    controller=new AbortController();
    const get=client(token,fetchImpl,AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]),requestSpacingMs);
    const windowed=rows=>rows.filter(x=>x.date>=start&&x.date<=asOf);
    const activityTask=async()=>{
      let url=BASE+'activityList?'+new URLSearchParams({pageSize:'500',extendedSummary:'1',startDate:end,endDate:activityLowerBound});
      const visited=new Set(),rows=new Map();
      for(let page=0;url;page++) {
        if(page>=20||visited.has(url))invalid();visited.add(url);
        const data=await get(url,'activityList'),entries=data?._embedded?.activityList;
        if(!Array.isArray(entries))invalid();
        for(const entry of entries){const normalized=normalizeActivity(entry);if(!rows.has(normalized.id))rows.set(normalized.id,normalized);}
        const next=data?._links?.next?.href;
        if(next!=null&&typeof next!=='string')invalid();
        url=next||null;
      }
      return windowed([...rows.values()]);
    };
    const query=new URLSearchParams({startDate:end,endDate:start+'T00:00:00.000Z'});
    const results=await Promise.allSettled([activityTask(),
      get(BASE+'hrv?'+query,'hrv').then(x=>windowed(normalizeDaily(x,'hrv'))),
      get(BASE+'sleep?'+query,'sleep').then(x=>windowed(normalizeDaily(x,'sleep'))),
      get(BASE+'bodyvalues','bodyvalues').then(x=>windowed(normalizeMinimumHeartRate(x)))]);
    if(stopped)return;
    const failed=results.filter(r=>r.status==='rejected');
    const sources={...previous.sources};
    for(let i=0;i<SOURCES.length;i++) {
      const key=SOURCES[i],r=results[i];
      sources[key]={...sources[key],lastAttempt:attempt,coverage:{start,end:asOf},
        lastResult:r.status==='rejected'?'error':failed.length?'retained':'success',
        lastError:r.status==='rejected'?publicError(r.reason):null,
        ...(r.status==='fulfilled'&&!failed.length?{lastSuccessfulFetch:attempt,observations:r.value.length}:{} )};
    }
    if(failed.length) {
      store.set('tredictSync',{...previous,lastRefreshAttempt:attempt,lastRefreshError:publicError(failed[0].reason),sources,
        nextAllowedAt:now()+Math.max(60000,...failed.map(r=>r.reason?.retryAfter||0))});return;
    }
    const [activities,hrv,sleep,minimumHr]=results.map(r=>r.value);
    const saved=store.snapshot();if(!saved)throw new AppError(409,'Import the existing plan before refreshing.');
    const mergedActivities=new Map(saved.activities.map(x=>[x.id,x]));
    for(const activity of activities)mergedActivities.set(activity.id,{...mergedActivities.get(activity.id),...activity});
    const recovery=new Map(saved.recovery.map(x=>[x.date,x]));
    for(const row of [...hrv,...sleep,...minimumHr])recovery.set(row.date,{...recovery.get(row.date),...row});
    const last=(rows,key)=>rows.filter(x=>key?finite(x[key]):true).map(x=>x.date).sort().at(-1)||null;
    const activityRows=[...mergedActivities.values()],recoveryRows=[...recovery.values()];
    const metadata={asOfDate:asOf,activityWindowStart:[saved.meta.activityWindowStart,...activityRows.map(x=>x.date)].filter(Boolean).sort()[0],
      activityWindowEnd:asOf,activityLastDate:last(activityRows),hrvLastDate:last(recoveryRows,'hrvMs'),sleepLastDate:last(recoveryRows,'sleepSeconds'),
      restHrLastDate:last(recoveryRows,'restHr'),lastLiveFetchAt:attempt};
    store.applyRefresh({activities:activityRows,recovery:recoveryRows,metadata,
      status:{lastRefreshAttempt:attempt,lastSuccessfulFetch:attempt,lastRefreshError:null,nextAllowedAt:now()+60000,sources}});
  }
  function refresh() {
    if(!configured)throw new AppError(503,'Tredict is not connected. Add its Personal API token in the private server settings. Your saved data is unchanged.');
    if(!store.snapshot())throw new AppError(409,'Import the existing plan before refreshing.');
    if(running)return {accepted:true,alreadyRunning:true};
    if(now()<(store.setting('tredictSync')?.nextAllowedAt||0))throw new AppError(429,'Please wait before refreshing again. Your saved data is unchanged.');
    running=perform().catch(error=>{
      if(!stopped)store.set('tredictSync',{...(store.setting('tredictSync')||{}),lastRefreshError:publicError(error),nextAllowedAt:now()+60000});
    }).finally(()=>{running=null;controller=null;});
    return {accepted:true,alreadyRunning:false};
  }
  function tick() {
    if(!configured||running||stopped||!store.snapshot())return;
    const saved=store.setting('tredictSync')||{};
    if(now()>=(saved.nextAllowedAt||0)&&now()>=(Date.parse(saved.lastRefreshAttempt)||0)+INTERVAL)refresh();
  }
  function start(){if(!timer&&configured){stopped=false;timer=setInterval(tick,60000);timer.unref();tick();}}
  function stop(){stopped=true;if(timer)clearInterval(timer);timer=null;controller?.abort();}
  return {status,refresh,tick,start,stop,settled:()=>running||Promise.resolve()};
}
