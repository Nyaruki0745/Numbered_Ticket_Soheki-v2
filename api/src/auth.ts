import type { SessionPayload, UserRole, ScopedPermission } from './types';
const TTL = 60*60*12;

export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,256);
  const h = (b: Uint8Array) => Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('');
  return `pbkdf2:${h(salt)}:${h(new Uint8Array(bits))}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo,saltHex,storedHash] = stored.split(':');
  if(algo!=='pbkdf2') return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(h=>parseInt(h,16)));
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,256);
  const hashHex = Array.from(new Uint8Array(bits)).map(b=>b.toString(16).padStart(2,'0')).join('');
  return hashHex === storedHash;
}
export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function generateToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function b64url(s:string){return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');}
function b64dec(s:string){return atob(s.replace(/-/g,'+').replace(/_/g,'/'));}
async function getKey(secret:string){
  return crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
export async function signJwt(payload: Omit<SessionPayload,'exp'>, secret: string): Promise<string> {
  const hdr = b64url(JSON.stringify({alg:'HS256',typ:'JWT'}));
  const bdy = b64url(JSON.stringify({...payload,exp:Math.floor(Date.now()/1000)+TTL}));
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${hdr}.${bdy}`));
  return `${hdr}.${bdy}.${b64url(String.fromCharCode(...new Uint8Array(sig)))}`;
}
export async function verifyJwt(token: string, secret: string): Promise<SessionPayload|null> {
  try {
    const [hdr,bdy,sig] = token.split('.');
    const key = await getKey(secret);
    const ok = await crypto.subtle.verify('HMAC',key,
      new Uint8Array(b64dec(sig).split('').map(c=>c.charCodeAt(0))),
      new TextEncoder().encode(`${hdr}.${bdy}`));
    if(!ok) return null;
    const p = JSON.parse(b64dec(bdy)) as SessionPayload;
    if(p.exp < Math.floor(Date.now()/1000)) return null;
    return p;
  } catch { return null; }
}
const PERM: Record<ScopedPermission,number> = {project_manager:40,sheet_manager:30,staff:20,viewer:10};
export function isGlobalAdmin(role: UserRole): boolean { return role==='developer'||role==='system_admin'; }
export function hasMinPermission(actual: ScopedPermission, required: ScopedPermission): boolean {
  return PERM[actual]>=PERM[required];
}