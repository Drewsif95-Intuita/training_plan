// DOM stubs exercise renderer paths, not layout or real browser behaviour.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
export async function renderViews(snapshot) {
  const elements=new Map();
  const element=selector=>{
    if(!elements.has(selector))elements.set(selector,{innerHTML:'',textContent:'',style:{},
      classList:{add(){},remove(){},toggle(){},contains(){return false;}},
      setAttribute(){},addEventListener(){},replaceChildren(){},showModal(){},close(){}});
    return elements.get(selector);
  };
  const api={
    '/api/session':{csrf:'synthetic-only',expiresAt:'2099-01-01T00:00:00Z'},
    '/api/snapshot':{snapshot},
    '/api/status':{importedAt:'2025-02-05T09:00:00Z',latestObservation:{activities:snapshot.meta.activityLastDate}},
    '/api/journal':{checkins:[],benchmarks:[],questionnaire:{answers:{},revision:0}}
  };
  const context=vm.createContext({
    document:{querySelector:element,querySelectorAll:()=>[],body:element('body'),addEventListener(){}},
    window:{innerWidth:390,addEventListener(){},scrollTo(){}},navigator:{},
    localStorage:{getItem(){return null;},setItem(){}},location:{replace(){throw Error('Unexpected redirect');}},
    setTimeout(){},URL,Intl,Date,console,
    fetch:async path=>({ok:true,status:200,json:async()=>structuredClone(api[path])})
  });
  vm.runInContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  if(element('#app-message').innerHTML)throw Error(element('#app-message').innerHTML);
  const result={};
  for(const view of ['overview','recovery','progress','plan','journal','questions','data']) {
    vm.runInContext(`S.view=${JSON.stringify(view)};render()`,context);
    result[view]=element('#view-'+view).innerHTML;
    if(!result[view])throw Error('Empty view: '+view);
  }
  for(const sport of ['running','cycling','swimming','strength'])vm.runInContext(`S.view='progress';S.sport=${JSON.stringify(sport)};render()`,context);
  for(const week of snapshot.plan.weeks)vm.runInContext(`S.view='plan';S.week=${Number(week.week)};render()`,context);
  return {result,context,elements};
}
