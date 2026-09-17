import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString('base64url');
export const digest = x => createHash('sha256').update(x).digest('hex');
export const validHash = x => /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(x || '');
export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 14 || password.length > 256) throw Error('Use a password of 14 to 256 characters.');
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  if (!validHash(encoded) || typeof password !== 'string' || password.length > 256) return false;
  const [,salt,expected] = encoded.split('$');
  const actual = await derive(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  return timingSafeEqual(actual,Buffer.from(expected,'hex'));
}
export function equalToken(a,b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa=Buffer.from(a),bb=Buffer.from(b);
  return aa.length===bb.length && timingSafeEqual(aa,bb);
}
