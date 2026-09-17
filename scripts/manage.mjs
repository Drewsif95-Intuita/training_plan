import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { passwordHash } from '../src/auth.mjs';
import { openStore } from '../src/db.mjs';

process.umask(0o077);
const [command,...args]=process.argv.slice(2);
let store;
try {
  if(command==='password-hash') {
    if(!process.stdin.isTTY) throw Error('Run password-hash in your own interactive terminal.');
    // Prevent a terminal echo and keep the password out of argv and shell history.
    let muted=false;
    const output=new Writable({write(chunk,encoding,callback){if(!muted)process.stdout.write(chunk,encoding);callback();}});
    const prompt=createInterface({input:process.stdin,output,terminal:true});
    process.stdout.write('New app password (14+ characters; hidden): ');muted=true;
    const value=await prompt.question('');process.stdout.write('\nConfirm password: ');
    const confirm=await prompt.question('');prompt.close();process.stdout.write('\n');
    if(value!==confirm) throw Error('Passwords do not match.');
    console.log(await passwordHash(value));
  } else if(command==='restore-sqlite') {
    if(args.length!==2) throw Error('Usage: restore-sqlite BACKUP_SQLITE NEW_DATA_DIRECTORY');
    if(existsSync(resolve(args[1],'training.sqlite'))) throw Error('Restore requires an empty target directory. Stop the app first.');
    store=openStore(resolve(args[1]));const target=store.file;store.close();store=null;
    copyFileSync(resolve(args[0]),target);chmodSync(target,0o600);
    store=openStore(resolve(args[1]));
    if(store.db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw Error('Backup integrity check failed.');
    store.db.exec('DELETE FROM sessions; DELETE FROM login_attempts;');
    console.log('Database restored; all prior sessions revoked.');
  } else {
    store=openStore(resolve(process.env.DATA_DIR||'./data'));
    if(command==='import-snapshot') {
      if(args.length!==1) throw Error('Usage: import-snapshot PRIVATE_SNAPSHOT_JSON');
      const bytes=readFileSync(resolve(args[0]));if(bytes.length>15000000)throw Error('Snapshot exceeds 15 MB.');
      store.importSnapshot(JSON.parse(bytes));console.log('Snapshot and canonical plan imported. Existing server journal entries retained.');
    } else if(command==='import-calendar') {
      if(args.length!==2) throw Error('Usage: import-calendar PRIVATE_ICS PLAN_VERSION');
      store.importCalendar(readFileSync(resolve(args[0]),'utf8'),args[1]);console.log('Original calendar preserved for this plan version.');
    } else if(command==='backup') {
      if(args.length!==1 || existsSync(resolve(args[0]))) throw Error('Usage: backup NEW_PRIVATE_BACKUP_SQLITE');
      await store.backup(resolve(args[0]));chmodSync(resolve(args[0]),0o600);console.log('Consistent database backup saved.');
    } else if(command==='export') {
      if(args.length!==1 || existsSync(resolve(args[0]))) throw Error('Usage: export NEW_PRIVATE_BACKUP_JSON');
      writeFileSync(resolve(args[0]),JSON.stringify(store.exportAll(),null,2),{mode:0o600,flag:'wx'});console.log('Account export saved.');
    } else if(command==='revoke-sessions') {
      store.db.exec('DELETE FROM sessions;');console.log('All sessions revoked.');
    } else throw Error('Commands: password-hash, import-snapshot, import-calendar, backup, export, restore-sqlite, revoke-sessions.');
  }
} catch(error) {console.error(error.message);process.exitCode=1;}
finally{store?.close();}
