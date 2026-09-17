import http from 'node:http';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './db.mjs';
import { AppError, object } from './validation.mjs';
import { validHash, verifyPassword, token, digest, equalToken } from './auth.mjs';

const root=fileURLToPath(new URL('../public/',import.meta.url));
const publicFiles=new Map([
  ['/login',['login.html','text/html']],['/login.js',['login.js','text/javascript']],
  ['/style.css',['style.css','text/css']],['/manifest.webmanifest',['manifest.webmanifest','application/manifest+json']],
  ['/sw.js',['sw.js','text/javascript']],['/icon.svg',['icon.svg','image/svg+xml']],
  ['/icon-192.png',['icon-192.png','image/png']],['/icon-512.png',['icon-512.png','image/png']]
]);
const privateFiles=new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']]]);

export function config(env=process.env) {
  const production=env.NODE_ENV==='production';
  const port=Number(env.PORT||3000);
  const origin=new URL(env.APP_ORIGIN || `http://127.0.0.1:${port}`);
  if (!validHash(env.AUTH_PASSWORD_HASH)) throw Error('AUTH_PASSWORD_HASH must contain a generated password hash.');
  if (origin.pathname!=='/' || origin.search || origin.hash || origin.username || origin.password) throw Error('APP_ORIGIN must be a plain origin.');
  if (production && origin.protocol!=='https:') throw Error('Production requires an HTTPS APP_ORIGIN.');
  if (!production && !['127.0.0.1','localhost','[::1]'].includes(origin.hostname)) throw Error('Development access is limited to localhost.');
  const dataDir=resolve(env.DATA_DIR || './data');
  if (production) {
    const mount=env.RAILWAY_VOLUME_MOUNT_PATH;
    if (!mount || !existsSync(mount)) throw Error('A mounted Railway volume is required in production.');
    const relativePath=relative(realpathSync(mount),existsSync(dataDir)?realpathSync(dataDir):dataDir);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw Error('DATA_DIR must be inside the mounted volume.');
  }
  return {production,port,origin:origin.origin,host:production?'0.0.0.0':'127.0.0.1',
    dataDir,passwordHash:env.AUTH_PASSWORD_HASH,sessionSeconds:12*60*60,allowDataImport:env.ENABLE_DATA_IMPORT==='true'};
}

async function body(req,limit=32768) {
  if (!(req.headers['content-type']||'').startsWith('application/json')) throw new AppError(415,'Send application/json.');
  if (Number(req.headers['content-length'])>limit) throw new AppError(413,'Request is too large.');
  const chunks=[];let length=0;
  for await (const chunk of req) {length+=chunk.length;if(length>limit) throw new AppError(413,'Request is too large.');chunks.push(chunk);}
  try {const x=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!object(x)) throw Error();return x;}
  catch {throw new AppError(400,'Invalid JSON object.');}
}

export function createApp(options) {
  const store=openStore(options.dataDir),db=store.db;
  const cookieName=options.production?'__Host-training_session':'training_session';
  const authVersion=digest(options.passwordHash);
  // Changing the password invalidates old sessions on every device.
  db.prepare('DELETE FROM sessions WHERE auth_version<>? OR expires<=?').run(authVersion,Date.now());
  const respond=(res,status,data,type='application/json',headers={})=>{
    res.writeHead(status,{'Content-Type':type+(type.startsWith('image/')?'':'; charset=utf-8'),...headers});
    res.end(type==='application/json'?JSON.stringify(data):data);
  };
  const sessionFor=req=>{
    const pair=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='));
    const value=pair?.slice(cookieName.length+1);
    if(!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    return db.prepare('SELECT * FROM sessions WHERE digest=? AND expires>? AND auth_version=?').get(digest(value),Date.now(),authVersion);
  };
  const cookie=(value,age)=>`${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${options.production?'; Secure':''}`;
  const handler=async(req,res)=>{
    res.setHeader('Cache-Control','no-store, private, max-age=0');
    res.setHeader('Pragma','no-cache');
    res.setHeader('Vary','Cookie');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if(options.production) res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const url=new URL(req.url,options.origin),path=url.pathname;
      if(path==='/healthz' && req.method==='GET') {
        db.prepare('SELECT 1').get();return respond(res,200,{ok:true});
      }
      if(req.headers.host!==new URL(options.origin).host) throw new AppError(400,'Invalid host.');
      const write=!['GET','HEAD','OPTIONS'].includes(req.method);
      if(write && req.headers.origin!==options.origin) throw new AppError(403,'Request origin is not allowed.');
      if(req.headers['sec-fetch-site']==='cross-site' && !['/login','/style.css','/login.js'].includes(path)) throw new AppError(403,'Cross-site request is not allowed.');
      if(path==='/api/login' && req.method==='POST') {
        const x=await body(req,2048);
        db.prepare('DELETE FROM login_attempts WHERE time<?').run(Date.now()-15*60*1000);
        if(db.prepare('SELECT count(*) AS n FROM login_attempts').get().n>=10) {
          res.setHeader('Retry-After','900');throw new AppError(429,'Too many sign-in attempts. Try again in 15 minutes.');
        }
        db.prepare('INSERT INTO login_attempts VALUES (?)').run(Date.now());
        if(!await verifyPassword(x.password,options.passwordHash)) throw new AppError(401,'Password not recognised.');
        db.exec('DELETE FROM login_attempts;');
        const old=sessionFor(req);if(old) db.prepare('DELETE FROM sessions WHERE digest=?').run(old.digest);
        const value=token();
        db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
        db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(value),token(),Date.now()+options.sessionSeconds*1000,authVersion);
        return respond(res,200,{ok:true},'application/json',{'Set-Cookie':cookie(value,options.sessionSeconds)});
      }
      if(publicFiles.has(path) && req.method==='GET') {
        const [filename,type]=publicFiles.get(path);
        return respond(res,200,readFileSync(resolve(root,filename)),type);
      }
      const session=sessionFor(req);
      if(!session) {
        if(path==='/') return respond(res,303,'','text/plain',{'Location':'/login'});
        throw new AppError(401,'Please sign in again.');
      }
      if(write && !equalToken(req.headers['x-csrf-token'],session.csrf)) throw new AppError(403,'Reload the page before saving.');
      // Temporarily enabled for private bootstrap transfers; never part of a build.
      if(['/api/import-snapshot','/api/import-calendar'].includes(path) && req.method==='POST') {
        if(!options.allowDataImport) throw new AppError(404,'Import is disabled.');
        const x=await body(req,15000000);
        if(path==='/api/import-snapshot') store.importSnapshot(x.snapshot);
        else {
          if(typeof x.calendar!=='string' || typeof x.version!=='string') throw new AppError(400,'Supply a calendar and plan version.');
          store.importCalendar(x.calendar,x.version);
        }
        return respond(res,200,{ok:true});
      }
      if(privateFiles.has(path) && req.method==='GET') {
        const [filename,type]=privateFiles.get(path);
        return respond(res,200,readFileSync(resolve(root,filename)),type);
      }
      if(path==='/api/session' && req.method==='GET') return respond(res,200,{csrf:session.csrf,expiresAt:new Date(session.expires).toISOString()});
      if(path==='/api/logout' && req.method==='POST') {
        db.prepare('DELETE FROM sessions WHERE digest=?').run(session.digest);
        return respond(res,200,{ok:true},'application/json',{'Set-Cookie':cookie('',0),'Clear-Site-Data':'"cache", "storage"'});
      }
      if(path==='/api/snapshot' && req.method==='GET') return respond(res,200,{snapshot:store.snapshot()});
      if(path==='/api/status' && req.method==='GET') {
        const snapshot=store.snapshot();
        return respond(res,200,{mode:'imported-snapshot',integrationImplemented:false,
          lastSuccessfulFetch:null,lastRefreshAttempt:null,lastRefreshError:null,
          importedAt:store.setting('importedAt'),snapshotRetrievedAt:snapshot?.meta.retrievedAt??null,
          latestObservation:{activities:snapshot?.meta.activityLastDate??null,hrv:snapshot?.meta.hrvLastDate??null,
            sleep:snapshot?.meta.sleepLastDate??null,dailyMinimumHr:snapshot?.meta.restHrLastDate??null}});
      }
      if(path==='/api/refresh' && req.method==='POST') throw new AppError(501,'Live Tredict refresh is not connected in this increment. Your saved snapshot is unchanged.');
      if(path==='/api/journal' && req.method==='GET') return respond(res,200,{
        checkins:store.journal('checkin'),benchmarks:store.journal('benchmark'),
        questionnaire:store.journal('answers')[0]||{answers:{},revision:0}});
      if(['/api/checkins','/api/benchmarks','/api/answers'].includes(path) && req.method==='POST') {
        const x=await body(req);
        const kind={'/api/checkins':'checkin','/api/benchmarks':'benchmark','/api/answers':'answers'}[path];
        return respond(res,200,store.save(kind,x.value,x.revision??0));
      }
      const deletion=path.match(/^\/api\/(checkins|benchmarks)\/([^/]+)$/);
      if(deletion && req.method==='DELETE') {
        const x=await body(req),kind=deletion[1]==='checkins'?'checkin':'benchmark';
        store.remove(kind,decodeURIComponent(deletion[2]),x.revision);return respond(res,200,{ok:true});
      }
      if(path==='/api/export' && req.method==='GET') return respond(res,200,store.exportAll(),'application/json',{'Content-Disposition':'attachment; filename="training-backup.json"'});
      if(path==='/api/plan' && req.method==='GET') return respond(res,200,store.snapshot()?.plan??null);
      if(path==='/api/calendar' && req.method==='GET') {
        const row=db.prepare('SELECT body FROM calendars WHERE version=?').get(store.setting('currentPlan')||'');
        if(!row) throw new AppError(404,'The original calendar has not been imported.');
        return respond(res,200,row.body,'text/calendar',{'Content-Disposition':'attachment; filename="training-calendar.ics"'});
      }
      throw new AppError(404,'Not found.');
    } catch(error) {
      const status=error instanceof AppError?error.status:500;
      // Never log request bodies, credentials, session cookies or health records.
      if(status===500) console.error('Request failed; inspect service configuration and storage.');
      if(!res.headersSent) respond(res,status,{error:status===500?'Unable to complete the request.':error.message});
      else res.end();
    }
  };
  const server=http.createServer({maxHeaderSize:16384},(req,res)=>void handler(req,res));
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  return {server,store};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    const options=config(),{server,store}=createApp(options);
    server.listen(options.port,options.host,()=>console.log('Training app started.'));
    for(const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>server.close(()=>{store.close();process.exit(0);}));
  } catch(error) {console.error(error.message);process.exit(1);}
}
