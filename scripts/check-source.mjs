import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const allowedRoot=new Set(['.git','.gitignore','.dockerignore','.env.example','.github','package.json','README.md','Dockerfile','railway.toml','src','public','scripts','tests']);
const problems=[];
for(const entry of readdirSync(root))if(!allowedRoot.has(entry))problems.push(`Unexpected source entry: ${entry}`);
function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory()){walk(path);continue;}const rel=relative(root,path);
  if(/\.(?:sqlite|db|fit|gpx|tcx|ics|zip)(?:$|[.-])/i.test(entry.name))problems.push(`Private artifact in source: ${rel}`);
  if(entry.name.endsWith('.png')){if(!['icon-192.png','icon-512.png'].includes(entry.name))problems.push(`Unexpected image: ${rel}`);continue;}
  const content=readFileSync(path,'utf8');
  if(/-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}/.test(content))problems.push(`Possible credential in ${rel}`);
  if(rel.startsWith('public/') && /__SNAPSHOT_JSON__|snapshot-data/.test(content))problems.push(`Snapshot embedding in ${rel}`);
}}
for(const dir of ['src','public','scripts','tests','.github'])walk(join(root,dir));
if(problems.length){console.error(problems.join('\n'));process.exitCode=1;}else console.log('Source boundary check passed.');
