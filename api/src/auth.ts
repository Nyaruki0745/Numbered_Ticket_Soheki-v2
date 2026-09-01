import type { SessionPayload, UserRole, ScopedPermission } from './types';

const SESSION_TTL = 60 * 60 * 12; // 12時間

// ============================================================
// PBKDF2 パスワードハッシュ (SubtleCrypto)
// ============================================================
export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hashArr = Array.from(new Uint8Array(bits));
  const saltArr = Array.from(salt);
  const hashHex = hashArr.map(b => b.toString(16).padStart(2,'0')).join('');
  const saltHex = saltArr.map(b => b.toString(16).padStart(2,'0')).join('');
  return `pbkdf2:${saltHex}:${hashHex}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
  const saltHex = parts[1];
  const storedHash = parts[2];
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hashArr = Array.from(new Uint8Array(bits));
  const hashHex = hashArr.map(b => b.toString(16).padStart(2,'0')).join('');
  return hashHex === storedHash;
}

// ============================================================
// cancelToken ハッシュ (SHA-256)
// ============================================================
export async function hashToken(token: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

export function generateToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2,'0')).join('');
}

// ============================================================
// JWT (HS256 - SubtleCrypto)
// ============================================================
function b64url(str: string): string {
  return btoa(str).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function b64urlDecode(s: string): string {
  return atob(s.replace(/-/g,'+').replace(/_/g,'/'));
}

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign','verify']
  );
}

export async function signJwt(payload: SessionPayload, secret: string): Promise<string> {
  const header = b64url(JSON.stringify({ alg:'HS256', typ:'JWT' }));
  const body   = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now()/1000) + SESSION_TTL }));
  const key    = await getKey(secret);
  const sig    = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${header}.${body}`)
  );
  const sigB64 = b64url(String.fromCharCode(...new Uint8Array(sig)));
  return `${header}.${body}.${sigB64}`;
}

export async function verifyJwt(token: string, secret: string): Promise<SessionPayload | null> {
  try {
    const [header, body, sig] = token.split('.');
    const key = await getKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC', key,
      new Uint8Array(b64urlDecode(sig).split('').map(c => c.charCodeAt(0))),
      new TextEncoder().encode(`${header}.${body}`)
    );
    if (!valid) return null;
    const payload = JSON.parse(b64urlDecode(body)) as SessionPayload & { exp: number };
    if (payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}

// ============================================================
// 権限チェックヘルパー
// ============================================================
const ROLE_LEVEL: Record<UserRole, number> = {
  developer: 100, system_admin: 90, user: 0,
};
const PERM_LEVEL: Record<ScopedPermission, number> = {
  project_manager: 40, sheet_manager: 30, staff: 20, viewer: 10,
};

export function isGlobalAdmin(role: UserRole): boolean {
  return role === 'developer' || role === 'system_admin';
}

export function hasMinPermission(
  actual: ScopedPermission, required: ScopedPermission
): boolean {
  return PERM_LEVEL[actual] >= PERM_LEVEL[required];
}
