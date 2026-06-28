/**
 * Eclipse Universal Addon
 * Sources (in priority order):
 *   MUSIC:    HiFi instances → SoundCloud → Internet Archive
 *   PODCASTS: Podcast Index → Taddy → Apple Podcasts
 *   AUDIOBOOKS: LibriVox → Internet Archive
 *   RADIO:    Radio Browser
 *
 * All API keys are optional and passed via query string when installing:
 *   https://your-addon.vercel.app/{token}/manifest.json
 *
 * Token format (base64url of JSON):
 *   { hifi, sc, pi_key, pi_secret, taddy_key, taddy_uid }
 */

import { Hono } from 'hono';

// ─── safeYear: always returns Int for Android JSON parser ─────────────────────
function safeYear(val) {
  if (val === null || val === undefined || val === '' || val === 0) return 0;
  const n = parseInt(String(val).replace(/[^0-9]/g, '').slice(0, 4), 10);
  return (isNaN(n) || n < 1000 || n > 2100) ? 0 : n;
}



const app = new Hono();

const memCache = new Map();
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const textHeaders = { 'content-type': 'text/html; charset=utf-8' };


async function cacheGet(key) {
  const v = memCache.get(key);
  if (!v) return null;
  if (v.exp && v.exp < Date.now()) { memCache.delete(key); return null; }
  return v.value;
}

async function cacheSet(key, value, ttl = 300) {
  memCache.set(key, { value, exp: Date.now() + ttl * 1000 });
}

// ─── Inflight deduplication ───────────────────────────────────────────────────
// Two simultaneous requests for the same stream share ONE outbound call.
const _inflight = new Map();
async function dedupeCall(key, fn) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}


// ─── Axios-compatible fetch shim (Workers-safe) ──────────────────────────────
function buildUrl(url, params) {
  if (!params || Object.keys(params).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

const axios = {
  get: async (url, config = {}) => {
    const fullUrl = buildUrl(url, config.params);
    const ctrl = new AbortController();
    const timer = config.timeout ? setTimeout(() => ctrl.abort(), config.timeout) : null;
    try {
      const res = await fetch(fullUrl, {
        method: 'GET',
        headers: config.headers || {},
        signal: ctrl.signal,
        redirect: 'follow',
      });
      const text = await res.text();
      const ct = res.headers.get('content-type') || '';
      let data = text;
      if (ct.includes('json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      if (!res.ok) {
        const err = new Error(`Request failed with status ${res.status}`);
        err.response = { status: res.status, data, headers: res.headers };
        throw err;
      }
      return { status: res.status, data, headers: res.headers };
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
  post: async (url, body, config = {}) => {
    const ctrl = new AbortController();
    const timer = config.timeout ? setTimeout(() => ctrl.abort(), config.timeout) : null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(config.headers || {}) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal: ctrl.signal,
        redirect: 'follow',
      });
      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch { data = text; }
      if (!res.ok) {
        const err = new Error(`Request failed with status ${res.status}`);
        err.response = { status: res.status, data, headers: res.headers };
        throw err;
      }
      return { status: res.status, data, headers: res.headers };
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};

// ─── Token / Config Parsing ──────────────────────────────────────────────────
function parseToken(tokenStr) {
  if (!tokenStr || tokenStr === 'noop') return {};
  // Strip optional ~addonName suffix before JSON decode
  var raw = tokenStr.includes('~') ? tokenStr.split('~')[0] : tokenStr;
  try {
    const json = decodeBase64Url(raw);
    const parsed = JSON.parse(json);
    // Re-attach embedded addon name if present
    if (tokenStr.includes('~') && !parsed.addon_name) {
      try { parsed.addon_name = decodeBase64Url(tokenStr.split('~')[1]); } catch {}
    }
    return parsed;
  } catch {
    try {
      const json = decodeBase64(raw);
      return JSON.parse(json);
    } catch { return {}; }
  }
}


function decodeBase64Url(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4 || 4)) % 4);
  return atob(padded);
}

function decodeBase64(str) {
  return atob(String(str || ''));
}

function encodeBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function upstashCmd(env, ...args) {
  if (!env?.UPSTASH_REDIS_REST_URL || !env?.UPSTASH_REDIS_REST_TOKEN) return null;
  try {
    const cmd = args[0]?.toUpperCase();
    if (cmd === 'MSET') {
      const pairs = args.slice(1);
      const pipeline = [];
      for (let i = 0; i < pairs.length; i += 2) {
        pipeline.push(['SET', pairs[i], pairs[i + 1], 'EX', '3600']);
      }
      const r = await fetch(env.UPSTASH_REDIS_REST_URL + '/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.UPSTASH_REDIS_REST_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(pipeline),
      });
      return r.ok ? 'OK' : null;
    }
    const r = await fetch(env.UPSTASH_REDIS_REST_URL + '/' + args.map(encodeURIComponent).join('/'), {
      headers: { Authorization: 'Bearer ' + env.UPSTASH_REDIS_REST_TOKEN },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ?? null;
  } catch { return null; }
}

function getConfig(c) {
  const token = c.req.param('token') || '';
  const cfg = parseToken(token);
  const VALID_QUALITIES = ['HIRES_192', 'HIRES_96', 'LOSSLESS', 'HIGH', 'LOW'];
  return {
    hifiInstances: cfg.hifi
      ? cfg.hifi.split(',').map(u => u.trim()).filter(Boolean)
      : (c.env.HIFI_INSTANCES
          ? c.env.HIFI_INSTANCES.split(',').map(u => u.trim()).filter(Boolean)
          : []),
    scClientId:   cfg.sc       || c.env.SC_CLIENT_ID    || null,
    scOAuthToken: cfg.sc_oauth || c.env.SC_OAUTH_TOKEN  || null,
    piKey: (cfg.pi_key || c.env.PI_KEY || '').trim() || null,
    piSecret: (cfg.pi_secret || c.env.PI_SECRET || '').trim() || null,
    taddyKey: (cfg.taddy_key || c.env.TADDY_KEY || '').trim() || null,
    taddyUid: (cfg.taddy_uid || c.env.TADDY_UID || '').trim() || null,
    preferredQuality: VALID_QUALITIES.includes(cfg.q) ? cfg.q : null,
    // Source flags — undefined/missing means "enabled" (backward-compatible)
    noHifi:      !!(cfg.no_hifi      === true || cfg.no_hifi      === 1 || cfg.no_hifi      === "true"),
    noSc:        !!(cfg.no_sc        === true || cfg.no_sc        === 1 || cfg.no_sc        === "true"),
    noIa:        !!(cfg.no_ia        === true || cfg.no_ia        === 1 || cfg.no_ia        === "true"),
    noQobuz:     !!(cfg.no_qobuz     === true || cfg.no_qobuz     === 1 || cfg.no_qobuz     === "true"),
    noPodcast:   !!(cfg.no_podcast   === true || cfg.no_podcast   === 1 || cfg.no_podcast   === "true"),
    noAudiobook: !!(cfg.no_audiobook === true || cfg.no_audiobook === 1 || cfg.no_audiobook === "true"),
    noRadio:     !!(cfg.no_radio     === true || cfg.no_radio     === 1 || cfg.no_radio     === "true"),
    noExplicit:  !!(cfg.no_explicit  === true || cfg.no_explicit  === 1 || cfg.no_explicit  === "true"),
    noDeezer:    (!!(cfg.no_deezer === true || cfg.no_deezer === 1 || cfg.no_deezer === "true")) || (!c.env?.DEEZER_ARL && !cfg.deezer_arl),
    deezerArl:      cfg.deezer_arl       || c.env?.DEEZER_ARL       || null,
    qobuzUserToken: cfg.qobuz_user_token || c.env?.QOBUZ_USER_TOKEN || null,
    qobuzSecret:    cfg.qobuz_secret     || c.env?.QOBUZ_SECRET     || null,
    qobuzAppId:     cfg.qobuz_app_id     || c.env?.QOBUZ_APP_ID     || null,
    // Ordered priority arrays for search/stream (empty = all enabled, default order)
    searchOrder: Array.isArray(cfg.search_order) ? cfg.search_order : [],
    streamOrder: Array.isArray(cfg.stream_order) ? cfg.stream_order : [],
    // Blocked ISRCs — tracks matching these will be filtered from search results
    blockedIsrcs: Array.isArray(cfg.blocked_isrcs)
      ? cfg.blocked_isrcs.map(i => String(i).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean)
      : [],
    // ISRC enrichment source toggles (default: all enabled)
    noMusicBrainz: !!cfg.no_musicbrainz,
    noTheAudioDB:  !!cfg.no_theaudiodb,
    noDeezerIsrc:  !!cfg.no_deezer_isrc,
    noQobuzIsrc:   !!cfg.no_qobuz_isrc,
    noLibrivox:    !!(cfg.no_librivox === true || cfg.no_librivox === 1 || cfg.no_librivox === "true"),
  };
}

// ─── SoundCloud Client ID Auto-Discovery ─────────────────────────────────────
let _scClientIdCache = null;
let _scClientIdExpiry = 0;

async function getSCClientId(providedId) {
  if (providedId) return providedId;
  if (_scClientIdCache && Date.now() < _scClientIdExpiry) return _scClientIdCache;
  const cached = await cacheGet('sc:client_id');
  if (cached) {
    _scClientIdCache = cached;
    _scClientIdExpiry = Date.now() + 3600000;
    return cached;
  }
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36' };
    const page = await axios.get('https://soundcloud.com', { headers, timeout: 8000 });
    const scriptUrls = [...new Set((page.data.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"']+\.js/g) || []))];
    for (const url of scriptUrls.slice(-5).reverse()) {
      try {
        const js = await axios.get(url, { headers, timeout: 5000 });
        const m = js.data.match(/client_id[:"'\s=]+([a-zA-Z0-9]{32})/);
        if (m) {
          _scClientIdCache = m[1];
          _scClientIdExpiry = Date.now() + 3600000;
          await cacheSet('sc:client_id', m[1], 3600);
          console.log('[SC] Auto-discovered client_id:', m[1].slice(0, 8) + '...');
          return m[1];
        }
      } catch {}
    }
  } catch (e) {
    console.warn('[SC] client_id discovery failed:', e.message);
  }
  return null;
}

// ─── HiFi Instance Helpers ───────────────────────────────────────────────────
const DEFAULT_HIFI_INSTANCES = [
  'https://hifi-api1.onrender.com',
  'https://hifi-api.thevolecitor.qzz.io/',
  'https://hifi-api-bffw.onrender.com',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

const DEEZER_API = 'https://api.deezer.com/';

const QOBUZ_INSTANCES = [
  'https://qobuz-api1.onrender.com',
  'https://trypt-hifi-dl-456461932686.us-west1.run.app',
  'https://qobuz-api.stremio123.duckdns.org',
];

// ─── Qobuz Native Stream Credentials ────────────────────────────────────────
const QOBUZ_APP_ID     = '312369995';
const QOBUZ_USER_TOKEN = '3GrgNWkOKdBMmMrEGnY_IS6Zksf0NXLJo_-QTcFeugsSvryxHinS3MKDpogrTtmb8HE9bSaog3jefTRvLmO6DA';
const QOBUZ_SECRET     = 'e79f8b9be485692b0e5f9dd895826368';

// ─── Compact MD5 (Qobuz request signature) ───────────────────────────────────
function md5(str) {
  function RL(v,n){return(v<<n)|(v>>>(32-n));}
  function AU(x,y){const x8=(x&0x80000000),y8=(y&0x80000000),x4=(x&0x40000000),y4=(y&0x40000000),r=(x&0x3FFFFFFF)+(y&0x3FFFFFFF);if(x4&y4)return(r^0x80000000^x8^y8);if(x4|y4){if(r&0x40000000)return(r^0xC0000000^x8^y8);return(r^0x40000000^x8^y8);}return(r^x8^y8);}
  function F(x,y,z){return(x&y)|((~x)&z);}function G(x,y,z){return(x&z)|(y&(~z));}function H(x,y,z){return x^y^z;}function I(x,y,z){return y^(x|(~z));}
  function FF(a,b,c,d,x,s,ac){a=AU(a,AU(AU(F(b,c,d),x),ac));return AU(RL(a,s),b);}
  function GG(a,b,c,d,x,s,ac){a=AU(a,AU(AU(G(b,c,d),x),ac));return AU(RL(a,s),b);}
  function HH(a,b,c,d,x,s,ac){a=AU(a,AU(AU(H(b,c,d),x),ac));return AU(RL(a,s),b);}
  function II(a,b,c,d,x,s,ac){a=AU(a,AU(AU(I(b,c,d),x),ac));return AU(RL(a,s),b);}
  function CW(s){const ml=s.length,nw_t1=ml+8,nw_t2=(nw_t1-(nw_t1%64))/64,nw=(nw_t2+1)*16,wa=Array(nw-1);let bp=0,bc=0;while(bc<ml){const wc=(bc-(bc%4))/4,pos=(bc%4)*8;wa[wc]=(wa[wc]|(s.charCodeAt(bc)<<pos));bc++;}const wc2=(bc-(bc%4))/4;wa[wc2]=(wa[wc2]|(0x80<<((bc%4)*8)));wa[nw-2]=ml<<3;wa[nw-1]=ml>>>29;return wa;}
  function WH(v){let r='',t='',byte,c;for(c=0;c<=3;c++){byte=(v>>>(c*8))&255;t='0'+byte.toString(16);r+=t.substr(t.length-2,2);}return r;}
  const x=CW(str);let k,a=0x67452301,b=0xEFCDAB89,c2=0x98BADCFE,d=0x10325476,AA,BB,CC,DD;
  const S11=7,S12=12,S13=17,S14=22,S21=5,S22=9,S23=14,S24=20,S31=4,S32=11,S33=16,S34=23,S41=6,S42=10,S43=15,S44=21;
  for(k=0;k<x.length;k+=16){AA=a;BB=b;CC=c2;DD=d;a=FF(a,b,c2,d,x[k],S11,0xD76AA478);d=FF(d,a,b,c2,x[k+1],S12,0xE8C7B756);c2=FF(c2,d,a,b,x[k+2],S13,0x242070DB);b=FF(b,c2,d,a,x[k+3],S14,0xC1BDCEEE);a=FF(a,b,c2,d,x[k+4],S11,0xF57C0FAF);d=FF(d,a,b,c2,x[k+5],S12,0x4787C62A);c2=FF(c2,d,a,b,x[k+6],S13,0xA8304613);b=FF(b,c2,d,a,x[k+7],S14,0xFD469501);a=FF(a,b,c2,d,x[k+8],S11,0x698098D8);d=FF(d,a,b,c2,x[k+9],S12,0x8B44F7AF);c2=FF(c2,d,a,b,x[k+10],S13,0xFFFF5BB1);b=FF(b,c2,d,a,x[k+11],S14,0x895CD7BE);a=FF(a,b,c2,d,x[k+12],S11,0x6B901122);d=FF(d,a,b,c2,x[k+13],S12,0xFD987193);c2=FF(c2,d,a,b,x[k+14],S13,0xA679438E);b=FF(b,c2,d,a,x[k+15],S14,0x49B40821);a=GG(a,b,c2,d,x[k+1],S21,0xF61E2562);d=GG(d,a,b,c2,x[k+6],S22,0xC040B340);c2=GG(c2,d,a,b,x[k+11],S23,0x265E5A51);b=GG(b,c2,d,a,x[k],S24,0xE9B6C7AA);a=GG(a,b,c2,d,x[k+5],S21,0xD62F105D);d=GG(d,a,b,c2,x[k+10],S22,0x02441453);c2=GG(c2,d,a,b,x[k+15],S23,0xD8A1E681);b=GG(b,c2,d,a,x[k+4],S24,0xE7D3FBC8);a=GG(a,b,c2,d,x[k+9],S21,0x21E1CDE6);d=GG(d,a,b,c2,x[k+14],S22,0xC33707D6);c2=GG(c2,d,a,b,x[k+3],S23,0xF4D50D87);b=GG(b,c2,d,a,x[k+8],S24,0x455A14ED);a=GG(a,b,c2,d,x[k+13],S21,0xA9E3E905);d=GG(d,a,b,c2,x[k+2],S22,0xFCEFA3F8);c2=GG(c2,d,a,b,x[k+7],S23,0x676F02D9);b=GG(b,c2,d,a,x[k+12],S24,0x8D2A4C8A);a=HH(a,b,c2,d,x[k+5],S31,0xFFFA3942);d=HH(d,a,b,c2,x[k+8],S32,0x8771F681);c2=HH(c2,d,a,b,x[k+11],S33,0x6D9D6122);b=HH(b,c2,d,a,x[k+14],S34,0xFDE5380C);a=HH(a,b,c2,d,x[k+1],S31,0xA4BEEA44);d=HH(d,a,b,c2,x[k+4],S32,0x4BDECFA9);c2=HH(c2,d,a,b,x[k+7],S33,0xF6BB4B60);b=HH(b,c2,d,a,x[k+10],S34,0xBEBFBC70);a=HH(a,b,c2,d,x[k+13],S31,0x289B7EC6);d=HH(d,a,b,c2,x[k],S32,0xEAA127FA);c2=HH(c2,d,a,b,x[k+3],S33,0xD4EF3085);b=HH(b,c2,d,a,x[k+6],S34,0x04881D05);a=HH(a,b,c2,d,x[k+9],S31,0xD9D4D039);d=HH(d,a,b,c2,x[k+12],S32,0xE6DB99E5);c2=HH(c2,d,a,b,x[k+15],S33,0x1FA27CF8);b=HH(b,c2,d,a,x[k+2],S34,0xC4AC5665);a=II(a,b,c2,d,x[k],S41,0xF4292244);d=II(d,a,b,c2,x[k+7],S42,0x432AFF97);c2=II(c2,d,a,b,x[k+14],S43,0xAB9423A7);b=II(b,c2,d,a,x[k+5],S44,0xFC93A039);a=II(a,b,c2,d,x[k+12],S41,0x655B59C3);d=II(d,a,b,c2,x[k+3],S42,0x8F0CCC92);c2=II(c2,d,a,b,x[k+10],S43,0xFFEFF47D);b=II(b,c2,d,a,x[k+1],S44,0x85845DD1);a=II(a,b,c2,d,x[k+8],S41,0x6FA87E4F);d=II(d,a,b,c2,x[k+15],S42,0xFE2CE6E0);c2=II(c2,d,a,b,x[k+6],S43,0xA3014314);b=II(b,c2,d,a,x[k+13],S44,0x4E0811A1);a=II(a,b,c2,d,x[k+4],S41,0xF7537E82);d=II(d,a,b,c2,x[k+11],S42,0xBD3AF235);c2=II(c2,d,a,b,x[k+2],S43,0x2AD7D2BB);b=II(b,c2,d,a,x[k+9],S44,0xEB86D391);a=AU(a,AA);b=AU(b,BB);c2=AU(c2,CC);d=AU(d,DD);}
  return (WH(a)+WH(b)+WH(c2)+WH(d)).toLowerCase();
}

// ─── ISRC Scoring Engine (ported from qobuz-tidal-eclipse) ───────────────────
function normalizeStr(s) {
  return String(s||'').toLowerCase()
    .replace(/[àáâãäå]/g,'a').replace(/[èéêë]/g,'e').replace(/[ìíîï]/g,'i')
    .replace(/[òóôõö]/g,'o').replace(/[ùúûü]/g,'u').replace(/[ý]/g,'y')
    .replace(/[ñ]/g,'n').replace(/[ç]/g,'c')
    .replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
}
const FEAT_RE_ISRC = /\s*(\(|\[)?\s*(feat\.?|ft\.?|featuring)\s+[^\)\]]*\s*(\)|\])?/gi;
function removeFeat(s) { return String(s||'').replace(FEAT_RE_ISRC,'').trim(); }
function isrcCleanTitle(t) { return t ? removeFeat(t) : 'Unknown'; }
function isrcFormatQuery(q) {
  q = q.replace(/['\u2018\u2019\u0060\u00B4]/g,"'").replace(/[\u201C\u201D\u00AB\u00BB]/g,'"');
  q = removeFeat(q);
  if (/ - /.test(q)) { return q.split(' - ').map(p=>removeFeat(p.trim())).join(' - '); }
  return removeFeat(q);
}
function isrcFindBestMatch(items, query, expectedDuration) {
  let bestItem=null, bestScore=-1;
  const qNorm=normalizeStr(query);
  const hasHyphen=/ - /.test(qNorm);
  const qWords=qNorm.replace(/[^a-z0-9\s]/gi,' ').split(/\s+/).filter(w=>w.length>1);
  let qLeft=qNorm, qRight='';
  if (hasHyphen){const parts=qNorm.split(' - ').map(p=>p.trim());qLeft=parts[0];qRight=parts[1]||'';}
  for(let i=0;i<Math.min(items.length,50);i++){
    const t=items[i];
    const tTitle=normalizeStr(isrcCleanTitle(t.title||''));
    const tArtist=normalizeStr(t.performer?.name||t.artist?.name||t.artists?.[0]?.name||'');
    let score=0;
    const thits=qWords.filter(w=>tTitle.includes(w)).length;
    const ahits=qWords.filter(w=>tArtist.includes(w)).length;
    score+=thits*15+ahits*8;
    const cov=qWords.filter(w=>tTitle.includes(w)||tArtist.includes(w)).length;
    if(cov===qWords.length&&qWords.length>0)score+=50;
    let tm=false,am=false;
    if(hasHyphen){
      if(qLeft&&(tTitle===qLeft||tTitle.includes(qLeft)||qLeft.includes(tTitle)))tm=true;
      if(qRight&&(tTitle===qRight||tTitle.includes(qRight)||qRight.includes(tTitle)))tm=true;
      if(qLeft&&(tArtist===qLeft||tArtist.includes(qLeft)||qLeft.includes(tArtist)))am=true;
      if(qRight&&(tArtist===qRight||tArtist.includes(qRight)||qRight.includes(tArtist)))am=true;
    }else{
      if(tTitle&&thits>0&&(qNorm===tTitle||tTitle.includes(qNorm)||qNorm.includes(tTitle)))tm=true;
      if(tTitle&&tTitle===qNorm)tm=true;
      if(tArtist&&(qNorm===tArtist||tArtist.includes(qNorm)||qNorm.includes(tArtist)))am=true;
    }
    if(tm)score+=35;if(am)score+=25;if(tm&&am)score+=80;
    if(tTitle===qNorm||(hasHyphen&&(tTitle===qLeft||tTitle===qRight)))score+=60;
    if(!hasHyphen&&thits===0&&ahits>0)score-=90;
    if(!hasHyphen&&thits===0&&qWords.length>=2)score-=40;
    if(!hasHyphen&&thits===0&&qWords.length>=1)score=-9999; // FIX: zero title-word hits = hard reject (prevents wrong-track like Embers)
    if(!/\b(cover|karaoke|tribute|instrumental|8-bit)\b/i.test(qNorm)&&
       /\b(cover|karaoke|tribute|instrumental|8-bit)\b/i.test(t.title||''))score-=500;
    if(!/\b(live|remix|version|edit|mix)\b/i.test(qNorm)&&
       /\b(live|remix|version|edit|mix)\b/i.test(t.title||''))score-=50;
    if (expectedDuration && expectedDuration > 10) {
      const tDur = t.duration || 0;
      if (tDur > 10) {
        const diff = Math.abs(tDur - expectedDuration);
        if (diff > 45) score -= 300;
        else if (diff > 20) score -= 80;
      }
    }
    if(score>bestScore){bestScore=score;bestItem=t;}
  }
  return {item:bestItem,score:bestScore};
}

// ─── Native Qobuz Stream ──────────────────────────────────────────────────────
// Calls qobuz.com directly with a signed MD5 request. No proxy needed.
// Falls back to proxy instances in qobuzStream() if this throws.
async function qobuzNativeStream(trackId, formatId, env) {
  const appId     = (env&&env.QOBUZ_APP_ID)     || QOBUZ_APP_ID;
  const userToken = (env&&env.QOBUZ_USER_TOKEN)  || QOBUZ_USER_TOKEN;
  const secret    = (env&&env.QOBUZ_SECRET)      || QOBUZ_SECRET;
  const cacheKey  = 'qnative:' + trackId + ':' + formatId;
  const cached    = await cacheGet(cacheKey);
  if (cached) {
    if (cached.url && cached.url.startsWith('/dz-proxy/') && req) {
      try { const base = new URL(req.url); cached.url = `${base.origin}${cached.url}`; } catch {}
    }
    return cached;
  }
  const ts  = Math.floor(Date.now()/1000);
  const sig = md5('trackgetFileUrlformat_id'+formatId+'intentstreamtrack_id'+trackId+ts+secret);
  const url = 'https://www.qobuz.com/api.json/0.2/track/getFileUrl' +
    '?app_id='+appId+'&user_auth_token='+userToken+
    '&track_id='+trackId+'&format_id='+formatId+
    '&intent=stream&request_ts='+ts+'&request_sig='+sig;
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),7000);
  try {
    const r=await fetch(url,{headers:{'User-Agent':UA},signal:ctrl.signal});
    clearTimeout(timer);
    if(!r.ok){try{await r.arrayBuffer();}catch{}throw new Error('Qobuz native HTTP '+r.status);}
    const data=await r.json();
    if(!data?.url)throw new Error('No URL in native Qobuz response for '+trackId);
    const fmt=formatId===5?'mp3':'flac';
    const qual=formatId===5?'320kbps':formatId===6?'lossless':formatId===7?'hires-96':'hires-192';
    const result={url:data.url,format:fmt,quality:qual,source:'qobuz-native',expiresAt:Math.floor(Date.now()/1000)+1680};
    await cacheSet(cacheKey,result,1680);
    return result;
  } catch(e){clearTimeout(timer);throw e;}
}


async function getWorkingHiFiInstance(instances) {
  const list = (instances && instances.length) ? instances : DEFAULT_HIFI_INSTANCES;
  const inst = list[0];
  const cacheKey = 'hifi:working:' + inst;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const r = await axios.get(`${inst}/search/`, {
      params: { s: 'test', limit: 1 },
      headers: { 'User-Agent': UA },
      timeout: 5000,
    });
    if (r.status === 200 && typeof r.data === 'object' && r.data !== null) {
      await cacheSet(cacheKey, inst, 300);
      return inst;
    }
  } catch {}
  return null;
}


// ─── Qobuz client (via proxy — multi-instance, parallel, cached) ──────────────
// QOBUZ_INSTANCES: tries both proxies in parallel, picks best quality winner.
// qobuzStream:         stream URLs cached 28 min (proxies expire them at 30 min).
// qobuzFindBestTrack:  search results cached 1 h; negative results cached 30 min.

async function qobuzStream(trackId, env, preferredQuality) {
  const cacheKey = 'qstream:' + trackId;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  if (env) {
    try {
      const _ur = await upstashCmd(env, 'GET', cacheKey);
      if (_ur) { const _up = JSON.parse(_ur); cacheSet(cacheKey, _up, 700); return _up; }
    } catch(e) {}
  }

  const fmtQuality = { 27: 'hires-192', 7: 'hires-96', 6: 'lossless', 5: '320kbps' };
  const fmtLabel   = { 27: 'flac', 7: 'flac', 6: 'flac', 5: 'mp3' };
  // Build format order from preferredQuality — preferred first, then fallback highest→lowest
  const _qFmtMap = { 'HIRES_192': 27, 'HIRES_96': 7, 'LOSSLESS': 6, 'HIGH': 5, 'LOW': 5 };
  const _qPrefFmt = _qFmtMap[preferredQuality] || 27; // default: hi-res 192kHz
  const fmtOrder = [_qPrefFmt, ...[27, 7, 6, 5].filter(f => f !== _qPrefFmt)];

  // ── Race native + all proxy combos simultaneously for fastest result ─────
  // Native Qobuz direct (signed MD5) runs in parallel with all proxy fallbacks.
  // We collect all settled results then pick the best quality winner.
  const nativeCombos = fmtOrder.map(fmt => ({ type: 'native', fmt }));
  const proxyCombos  = QOBUZ_INSTANCES.flatMap(inst => fmtOrder.map(fmt => ({ type: 'proxy', inst, fmt })));
  const allCombos    = [...nativeCombos, ...proxyCombos];

  const allResults = await Promise.allSettled(allCombos.map(async combo => {
    if (combo.type === 'native') {
      const native = await qobuzNativeStream(trackId, combo.fmt, env);
      if (native && native.url) return { url: native.url, fmt: combo.fmt, source: 'qobuz-native' };
      throw new Error('no native url');
    } else {
      const r = await qobuzGet(combo.inst + '/stream/' + trackId, { format_id: combo.fmt });
      if (r.data && r.data.url) {
        cacheSet('qinst:' + combo.inst, Date.now(), 600);
        return { url: r.data.url, fmt: combo.fmt, source: 'qobuz-proxy' };
      }
      throw new Error('no proxy url');
    }
  }));

  // Pick highest-quality winner (prefer native over proxy for same format)
  for (const fmt of fmtOrder) {
    const nativeHit = allResults.find(r => r.status === 'fulfilled' && r.value.fmt === fmt && r.value.source === 'qobuz-native');
    const proxyHit  = allResults.find(r => r.status === 'fulfilled' && r.value.fmt === fmt && r.value.source === 'qobuz-proxy');
    const hit = nativeHit || proxyHit;
    if (hit) {
      const result = { url: hit.value.url, format: fmtLabel[fmt], quality: fmtQuality[fmt], source: hit.value.source, expiresAt: Math.floor(Date.now()/1000)+1680 };
      await cacheSet(cacheKey, result, 1680);
      if (env) upstashCmd(env, 'SET', cacheKey, JSON.stringify(result), 'EX', 720).catch(()=>{});
      return result;
    }
  }
  return null;
}


// qobuzFindByIsrc: looks up a Qobuz track by ISRC code.
// ONLY returns a result if the Qobuz item's own .isrc field matches exactly —
// if the proxy doesn't support ISRC search syntax the result is silently discarded.
// Confirmed hits cached 24h; misses cached 30 min.
async function qobuzFindByIsrc(isrc) {
  if (!isrc) return null;
  const normIsrc = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const wantIsrc = normIsrc(isrc);
  if (!wantIsrc) return null;

  const cacheKey = 'qisrc:' + wantIsrc;
  const cached = await cacheGet(cacheKey);
  if (cached === 'MISS') return null;
  if (cached) return cached;

  for (const inst of QOBUZ_INSTANCES) {
    try {
      const r = await qobuzGet(inst + '/search', { q: isrc, limit: 5 }, 8000);
      const items = (r.data && r.data.tracks && r.data.tracks.items) ? r.data.tracks.items : [];
      // STRICT: only accept a result if Qobuz confirms the ISRC matches exactly
      const match = items.find(t => t.isrc && normIsrc(t.isrc) === wantIsrc);
      if (match && match.id) {
        await cacheSet(cacheKey, match, 86400); // confirmed ISRC match — cache 24h
        console.log(`[Qobuz ISRC] HIT ${isrc} -> id=${match.id} "${match.title}"`);
        return match;
      }
    } catch(e) { continue; } // instance down — circuit breaker handles it via qobuzStream
  }
  await cacheSet(cacheKey, 'MISS', 1800); // miss cached 30 min
  return null;
}

async function qobuzFindBestTrack(title, artist, isrc, _env, expectedDuration) {
  // 1. ISRC fast path
  if (isrc) {
    const byIsrc = await qobuzFindByIsrc(isrc);
    if (byIsrc) return byIsrc;
    console.log(`[Qobuz ISRC] no confirmed match for ${isrc} — falling back to title search`);
  }
  if (!title) return null;
  // MusicBrainz ISRC enrichment (can be disabled via cfg.noMusicBrainz)
  if (!isrc && title && artist && !(_env && (await getConfig(_env)).noMusicBrainz)) {
    try {
      const _mbRes = await axios.get(
        `https://musicbrainz.org/ws/2/recording/?query=recording:${encodeURIComponent(title)}+AND+artist:${encodeURIComponent(artist)}&fmt=json&limit=3`,
        { headers: { 'User-Agent': 'EclipseAllInOne/1.0 (eclipse-addon)' }, timeout: 4000 }
      );
      const _mbRec = (_mbRes.data?.recordings || [])[0];
      const _mbIsrc = _mbRec?.isrcs?.[0];
      if (_mbIsrc) {
        console.log(`[MusicBrainz] enriched ISRC for "${title}" -> ${_mbIsrc}`);
        const byMbIsrc = await qobuzFindByIsrc(_mbIsrc);
        if (byMbIsrc) return byMbIsrc;
        isrc = _mbIsrc; // carry ISRC forward for cache key enrichment
      }
    } catch(e) { /* non-fatal */ }
  }
  // TheAudioDB ISRC enrichment fallback (can be disabled via cfg.noTheAudioDB)
  if (!isrc && title && artist && !(_env && (await getConfig(_env)).noTheAudioDB)) {
    try {
      const _tadbRes = await axios.get(
        `https://www.theaudiodb.com/api/v1/json/2/searchtrack.php?s=${encodeURIComponent(artist)}&t=${encodeURIComponent(title)}`,
        { timeout: 4000 }
      );
      const _tadbTrack = (_tadbRes.data?.track || [])[0];
      const _tadbIsrc = _tadbTrack?.strMusicBrainzID;
      if (_tadbIsrc) {
        console.log(`[TheAudioDB] enriched ISRC for "${title}" -> ${_tadbIsrc}`);
        const byTadbIsrc = await qobuzFindByIsrc(_tadbIsrc);
        if (byTadbIsrc) return byTadbIsrc;
      }
    } catch(e) { /* non-fatal */ }
  }
  const cacheKey = 'qmatch:' + title.toLowerCase() + ':' + (artist||'').toLowerCase();
  const cached = await cacheGet(cacheKey);
  if (cached === 'MISS') return null;
  if (cached) return cached;
  if (_env) {
    try {
      const _ur = await upstashCmd(_env, 'GET', cacheKey);
      if (_ur === 'MISS') { cacheSet(cacheKey, 'MISS', 1800); return null; }
      if (_ur) { const _up = JSON.parse(_ur); cacheSet(cacheKey, _up, 3600); return _up; }
    } catch(e) {}
  }

  // Use ISRC scoring engine for accurate matching
  const query = artist ? (artist + ' - ' + title) : isrcFormatQuery(title);
  for (const inst of QOBUZ_INSTANCES) {
    try {
      const r = await qobuzGet(inst + '/search', { q: query, limit: 20 }, 10000);
      const data = r.data || null;
      if (!data) continue;
      const items = (data.tracks && data.tracks.items) ? data.tracks.items : [];
      if (!items.length) continue;
      const match = isrcFindBestMatch(items, query, expectedDuration);
      if (match.item && match.score >= 50) {
        await cacheSet(cacheKey, match.item, 3600);
        if (_env) upstashCmd(_env, 'SET', cacheKey, JSON.stringify(match.item), 'EX', 3600).catch(()=>{});
        return match.item;
      }
    } catch(e) { continue; }
  }
  await cacheSet(cacheKey, 'MISS', 1800);
  if (_env) upstashCmd(_env, 'SET', cacheKey, 'MISS', 'EX', 1800).catch(()=>{});
  return null;
}

// ─── Qobuz Direct Search ─────────────────────────────────────────────────────
async function qobuzSearch(query) {
  if (!query) return { tracks: [], albums: [], artists: [], playlists: [] };
  const cacheKey = `qsearch:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  for (const inst of QOBUZ_INSTANCES) {
    try {
      const r = await axios.get(`${inst}/search`, {
        params: { q: query, limit: 20 },
        headers: { 'User-Agent': UA },
        timeout: 9000,
      });
      const data = r.data || {};

      // ── Tracks ────────────────────────────────────────────────────────────
      const rawTracks = data.tracks?.items || data.tracks || data.items || [];
      // Sort explicit (parental_warning) tracks first — prevents clean/censored versions winning
      rawTracks.sort((a, b) => (!!(b.parental_warning||b.explicit) ? 1 : 0) - (!!(a.parental_warning||a.explicit) ? 1 : 0));
      const tracks = rawTracks.slice(0, 20).map(t => {
        const artistName = t.performer?.name || t.artist?.name || t.artists?.[0]?.name || 'Unknown';
        const cover = t.album?.image?.large || t.album?.cover_url || null;
        return {
          id: `qobuz_${t.id}`,
          title: t.title || 'Unknown',
          artist: artistName,
          album: t.album?.title || '',
          duration: t.duration || undefined,
          artworkURL: cover,
          format: 'flac',
          explicit: !!(t.parental_warning || t.explicit),
          source: 'qobuz',
        };
      });

      // ── Albums ────────────────────────────────────────────────────────────
      const rawAlbums = data.albums?.items || data.albums || [];
      const albums = rawAlbums.slice(0, 8).map(a => ({
        id:         `qobuzalbum_${a.id}`,
        title:      a.title || 'Unknown Album',
        artist:     a.artist?.name || 'Unknown',
        artworkURL: a.image?.small || a.image?.large || null,
        year:       safeYear(a.release_date_original),
        source:     'qobuz',
      }));

      // ── Artists ───────────────────────────────────────────────────────────
      const rawArtists = data.artists?.items || data.artists || [];
      const artists = rawArtists.slice(0, 6).map(a => ({
        id:         `qobuz_artist_${a.id}`,
        name:       a.name || 'Unknown Artist',
        // Qobuz search: artist.image.large  or artist.picture (300x300 jpg path)
        artworkURL: (() => {
          // Priority 1: full URL from image.large / thumbnail / small (most reliable from proxy)
          const fromImage = a.image?.thumbnail || a.image?.small || a.image?.large || null;
          if (fromImage) {
            return fromImage.includes('/images/artists/covers/')
              ? fromImage.replace(/(_org|_\d+)(\.jpg)$/i, '_300$2')
              : fromImage;
          }
          // Priority 2: a.picture is a bare hash → construct static URL
          if (a.picture && a.picture.length > 5 && !a.picture.startsWith('http')) {
            return `https://static.qobuz.com/images/artists/covers/${a.picture}_300.jpg`;
          }
          // Priority 3: a.picture is already a full URL (rare proxy variants)
          if (a.picture && a.picture.startsWith('http')) return a.picture;
          // Priority 4: a.images array (some proxy response shapes)
          if (Array.isArray(a.images) && a.images[0]) return a.images[0];
          return null;
        })(),
        source:     'qobuz',
      }));

      // ── Playlists ─────────────────────────────────────────────────────────
      const rawPlaylists = data.playlists?.items || data.playlists || [];
      const playlists = rawPlaylists.slice(0, 5).map(p => ({
        id:         `qobuzplaylist_${p.id}`,
        title:      p.name || p.title || 'Unknown Playlist',
        artist:     p.owner?.name || 'Qobuz',
        // Qobuz playlist images is an array in search results
        artworkURL: (Array.isArray(p.images) && p.images[0]) || p.image_url || null,
        trackCount: p.tracks_count || undefined,
        source:     'qobuz',
      }));

      // Re-rank tracks using ISRC scoring engine so best match is always first
      if (tracks.length > 1) {
        const scored = tracks.map(t => {
          const qNorm   = normalizeStr(query);
          const tTitle  = normalizeStr(t.title || '');
          const tArtist = normalizeStr(t.artist || '');
          const qWords  = qNorm.replace(/[^a-z0-9\s]/gi,' ').split(/\s+/).filter(w=>w.length>1);
          const hasHyphen = / - /.test(qNorm);
          const thits = qWords.filter(w=>tTitle.includes(w)).length;
          const ahits = qWords.filter(w=>tArtist.includes(w)).length;
          let s = thits*15 + ahits*8;
          const cov = qWords.filter(w=>tTitle.includes(w)||tArtist.includes(w)).length;
          if (cov===qWords.length && qWords.length>0) s+=50;
          if (!hasHyphen && thits>0 && (qNorm===tTitle||tTitle.includes(qNorm)||qNorm.includes(tTitle))) s+=35;
          if (!hasHyphen && tArtist && (qNorm===tArtist||tArtist.includes(qNorm)||qNorm.includes(tArtist))) s+=25;
          if (thits>0 && ahits>0) s+=80;
          if (tTitle===qNorm) s+=60;
          // KEY FIX: penalise heavily when title has ZERO word hits but artist matches
          // This is what caused "embers dead butterflies" to surface wrong track
          if (!hasHyphen && thits===0 && ahits>0) s-=90;
          if (!hasHyphen && thits===0 && qWords.length>=2) s-=40;
          if (!/\b(cover|karaoke|tribute|instrumental|8-bit)\b/i.test(qNorm) &&
              /\b(cover|karaoke|tribute|instrumental|8-bit)\b/i.test(t.title||'')) s-=500;
          if (!/\b(live|remix|version|edit|mix)\b/i.test(qNorm) &&
              /\b(live|remix|version|edit|mix)\b/i.test(t.title||'')) s-=50;
          return { t, s };
        });
        scored.sort((a,b) => b.s - a.s);
        tracks.length = 0;
        scored.forEach(x => tracks.push(x.t));
      }

      const result = { tracks, albums, artists, playlists };
      await cacheSet(cacheKey, result, 300);
      return result;
    } catch (e) { continue; }
  }
  return { tracks: [], albums: [], artists: [], playlists: [] };
}

function artistRelevance(name, query) {
  var n = (name || '').toLowerCase().trim();
  var q = (query || '').toLowerCase().trim();
  if (n === q) return 4;
  if (n.startsWith(q) || q.startsWith(n)) return 3;
  if (n.includes(q) || q.includes(n)) return 2;
  return 0;
}

async function hifiSearch(query, instances) {
  const list = (instances && instances.length) ? instances : DEFAULT_HIFI_INSTANCES;
  const cacheKey = `hifi:search:all:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const HIFI_TIMEOUT = 7000;
  const inst = list[0];

  let data = null, artistData = null;
  try {
    [data, artistData] = await Promise.all([
      Promise.any(list.map(i =>
        axios.get(`${i}/search`, { params: { s: query, limit: 50, offset: 0 }, headers: { 'User-Agent': UA }, timeout: HIFI_TIMEOUT })
          .then(r => { if (r.status === 200 && r.data) return r.data; throw new Error('bad'); })
      )),
      axios.get(`${inst}/search`, { params: { s: query, type: 'ARTISTS', limit: 10 }, headers: { 'User-Agent': UA }, timeout: HIFI_TIMEOUT })
        .then(r => r.data).catch(() => null),
    ]);
  } catch(e) {
    return { tracks: [], albums: [], artists: [] };
  }

  if (!data) return { tracks: [], albums: [], artists: [] };

  try {
    const items = data?.data?.items || data?.items || data?.tracks?.items || data?.data?.tracks?.items || [];
    const instB64 = encodeBase64Url(inst);
    const albumMap = {}, artistMap = {}, artistHits = {}, tracks = [];

    for (const t of items) {
      if (!t?.id) continue;

      for (const a of (t.artists || (t.artist ? [t.artist] : []))) {
        if (!a?.id) continue;
        const arid = String(a.id);
        if (!artistMap[arid]) {
          artistMap[arid] = {
            id: `hifi_artist_${instB64}_${a.id}`,
            name: a.name || 'Unknown',
            artworkURL: a.picture
              ? `https://resources.tidal.com/images/${a.picture.replace(/-/g, '/')}/320x320.jpg`
              : undefined,
            _source: 'hifi',
          };
        }
        artistHits[arid] = (artistHits[arid] || 0) + 1;
      }

      if (t.streamReady === false || t.allowStreaming === false) continue;

      const origId = String(t.id);
      const artworkURL = t.album?.cover
        ? `https://resources.tidal.com/images/${t.album.cover.replace(/-/g, '/')}/1280x1280.jpg`
        : undefined;

      const tArtistName = (() => {
        if (t.artists && t.artists.length) return t.artists.map(a => a.name).join(', ');
        if (t.artist && t.artist.name) return t.artist.name;
        return 'Unknown';
      })();

      const hifiIsrc = t.isrc ? t.isrc.toUpperCase().replace(/[^A-Z0-9]/g, '') : null;

      tracks.push({
        id: `hifi_${instB64}_${origId}`,
        title: t.title || 'Unknown',
        artist: tArtistName,
        album: t.album?.title || '',
        duration: t.duration ? Math.floor(t.duration) : undefined,
        artworkURL,
        isrc: hifiIsrc || undefined,
        format: (t.audioQuality === 'HIGH' || t.audioQuality === 'LOW') ? 'aac' : 'flac',
        _source: 'hifi',
        _inst: inst,
        _instB64: instB64,
        _origId: origId,
      });

      cacheSet(`hifi:track:meta:${instB64}_${origId}`, {
        title: t.title || 'Unknown',
        artist: tArtistName,
        isrc: hifiIsrc,
        duration: t.duration ? Math.floor(t.duration) : undefined,
      }, 3600);

      if (t.album?.id) {
        const aid = String(t.album.id);
        if (!albumMap[aid]) albumMap[aid] = {
          id: `hifi_album_${instB64}_${aid}`,
          title: t.album.title || 'Unknown Album',
          artist: tArtistName,
          artworkURL,
          year: safeYear(t.album.releaseDate || t.album.streamStartDate || t.releaseDate) || undefined,
          _source: 'hifi',
        };
      }
    }

    // Merge dedicated artist-type search results (fixes geo-restricted artists like Drake/Travis Scott)
    const arItems = artistData?.data?.artists?.items || artistData?.data?.items
      || artistData?.artists?.items || artistData?.items || [];
    for (const a of arItems) {
      if (!a?.id || !a?.name) continue;
      const key = String(a.id);
      if (!artistMap[key]) {
        artistMap[key] = {
          id: `hifi_artist_${instB64}_${a.id}`,
          name: a.name,
          artworkURL: a.picture
            ? `https://resources.tidal.com/images/${a.picture.replace(/-/g, '/')}/320x320.jpg`
            : undefined,
          _source: 'hifi',
        };
      }
      artistHits[key] = (artistHits[key] || 0) + 10; // boost dedicated artist results to top
    }

    const artistList = Object.keys(artistMap)
      .sort((a, b) => {
        const ra = artistRelevance(artistMap[a].name, query) * 100 + (artistHits[a] || 0);
        const rb = artistRelevance(artistMap[b].name, query) * 100 + (artistHits[b] || 0);
        return rb - ra;
      })
      .slice(0, 5)
      .map(k => artistMap[k]);

    const result = {
      tracks,
      albums: Object.values(albumMap)
        .sort((a, b) => {
          if (!a.year && !b.year) return 0;
          if (!a.year) return 1;
          if (!b.year) return -1;
          return Number(b.year) - Number(a.year);
        })
        .slice(0, 8),
      artists: artistList,
    };
    await cacheSet(cacheKey, result, 300);
    return result;
  } catch(e) {
    console.warn('[HiFi] search error:', e.message);
    return { tracks: [], albums: [], artists: [] };
  }
}
async function hifiStream(id, extraInstances, preferredQuality) {
  const withoutPrefix = id.slice(5);
  const firstUnderscore = withoutPrefix.indexOf('_');
  const instB64   = withoutPrefix.slice(0, firstUnderscore);
  const origId    = withoutPrefix.slice(firstUnderscore + 1);
  const preferred = decodeBase64Url(instB64);

  // Single instance: always use hifi-api-bffw.onrender.com (the only one configured).
  // User-configured instances are still prepended in case someone overrides via token.
  const allInstances = [...new Set([preferred, ...(extraInstances || []), ...DEFAULT_HIFI_INSTANCES])];
  const instanceOrder = allInstances.slice(0, 3); // cap at 3 to avoid blast

  function parseTrackResponse(data) {
    const payload = data?.data || data;
    if (payload?.manifest) {
      try {
        const decoded = JSON.parse(atob(payload.manifest));
        const url = decoded.urls?.[0];
        if (url) {
          const codec = (decoded.codecs || decoded.mimeType || '').toLowerCase();
          const isFlac = codec.includes('flac') || codec.includes('audio/flac');
          return { url, format: isFlac ? 'flac' : 'aac' };
        }
        // manifest decoded but no url — log the structure
        console.warn('[HiFi stream] manifest decoded but no url, keys:', Object.keys(decoded));
      } catch (e) {
        console.warn('[HiFi stream] manifest decode error:', e.message);
      }
    }
    if (payload?.url) return { url: payload.url, format: 'aac' };
    // Log what we actually got back
    if (payload) console.warn('[HiFi stream] no manifest/url in payload, keys:', Object.keys(payload).slice(0,10).join(','));
    return null;
  }

  // Try quality tiers in preferred order — race ALL instances per tier in parallel.
  // Each tier is tried fully before falling to the next, so LOSSLESS is always
  // attempted before HIGH or LOW (fixes the bug where LOW won the race).
  async function tryInstance(inst, ql) {
    // 3.5s timeout — render.com free tier has cold starts up to 3s on first wake
    try {
      const r = await axios.get(`${inst}/track/`, {
        params: { id: origId, quality: ql },
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        timeout: 2500,
      });
      const parsed = parseTrackResponse(r.data);
      if (parsed) return { ...parsed, quality: ql };
    } catch (e) {
      const status = e.response?.status;
      const msg = e.response?.data?.userMessage || e.response?.data?.error || e.message;
      if (status !== 403 && status !== 404 && status !== 401)
        console.warn(`[HiFi stream] ${inst}/track/ ql=${ql} -> ${status || 'ERR'}: ${msg}`);
    }
    return null;
  }

  // Build quality order: preferred first, then remaining tiers highest→lowest
  const ALL_QUALITIES = ['LOSSLESS', 'HIGH', 'LOW'];
  const pref = preferredQuality && ALL_QUALITIES.includes(preferredQuality) ? preferredQuality : 'LOSSLESS';
  const qualityOrder = [pref, ...ALL_QUALITIES.filter(q => q !== pref)];

  // FIX: Two-phase race strategy to minimize latency:
  // Phase 1 — race preferred quality across ALL instances simultaneously (2s window).
  // Phase 2 — if phase 1 yields nothing, race ALL remaining qualities × ALL instances at once.
  // This caps worst-case at ~4s (was up to 9s with sequential per-tier loops).
  try {
    const winner = await Promise.any(
      instanceOrder.map(inst =>
        tryInstance(inst, qualityOrder[0]).then(r => {
          if (!r) throw new Error('no result');
          return r;
        })
      )
    );
    console.log(`[HiFi stream] phase1 winner quality=${qualityOrder[0]} trackId=${origId}`);
    return winner;
  } catch { /* phase 1 failed — all instances timed out or errored on preferred quality */ }

  // Phase 2: race ALL remaining quality tiers × ALL instances simultaneously
  const phase2Promises = [];
  for (const ql of qualityOrder.slice(1)) {
    for (const inst of instanceOrder) {
      phase2Promises.push(
        tryInstance(inst, ql).then(r => {
          if (!r) throw new Error('no result');
          return r;
        })
      );
    }
  }
  if (phase2Promises.length) {
    try {
      const winner2 = await Promise.any(phase2Promises);
      console.log(`[HiFi stream] phase2 winner trackId=${origId}`);
      return winner2;
    } catch { /* all tiers/instances failed */ }
  }

  // Legacy /stream/ path — single fast attempt (no retry loop, no sleep)
  for (const inst of instanceOrder) {
    try {
      const r = await axios.get(`${inst}/stream/${origId}`, {
        headers: { 'User-Agent': UA },
        timeout: 4000,
      });
      if (r.data?.url) {
        console.log(`[HiFi stream] legacy /stream/ success: ${inst} trackId=${origId}`);
        return { url: r.data.url, format: r.data.format || 'aac', quality: r.data.quality || 'unknown' };
      }
    } catch (e) {
      const _ls = e.response?.status;
      if (_ls !== 403 && _ls !== 404 && _ls !== 401)
        console.warn(`[HiFi stream] legacy ${inst}/stream/${origId} -> ${_ls || 'ERR'}: ${e.message}`);
    }
  }

  console.error(`[HiFi stream] ALL paths failed for trackId=${origId}`);
  return null;
}

async function hifiAlbum(id) {
  const withoutPrefix = id.slice(11);
  const firstUnderscore = withoutPrefix.indexOf('_');
  const instB64 = withoutPrefix.slice(0, firstUnderscore);
  const albumId = withoutPrefix.slice(firstUnderscore + 1);
  const inst = decodeBase64Url(instB64);
  const cacheKey = `hifi:album:${instB64}:${albumId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const r = await axios.get(`${inst}/album/`, {
      params: { id: albumId, limit: 100 },
      headers: { 'User-Agent': UA },
      timeout: 10000,
    });
    const album = r.data?.data || r.data;
    const rawItems = album?.items || [];
    const _mainAlbumArtists = (album?.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED');
    const artistName = _mainAlbumArtists.length
      ? _mainAlbumArtists.map(a => a.name).join(', ')
      : (album?.artist?.name || (album?.artists || []).map(a => a.name).join(', ') || 'Unknown');
    const cover = album?.cover
      ? `https://resources.tidal.com/images/${album.cover.replace(/-/g, '/')}/1280x1280.jpg`
      : undefined;
    const tracks = rawItems
      .map(i => i.item || i)
      .filter(t => t?.id && t.streamReady !== false)
      .map(t => ({
        id: `hifi_${instB64}_${t.id}`,
        title: t.title || 'Unknown',
        artist: ((t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED').length
              ? (t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED')
              : (t.artists?.length ? t.artists : (t.artist ? [t.artist] : []))).map(a => a.name).join(', ') || artistName,
        duration: t.duration ? Math.floor(t.duration) : undefined,
        trackNumber: t.trackNumber,
        artworkURL: cover,
        format: 'flac',
      }));
    // FIX: cache track meta so stream handler applies correct streamOrder priority (Qobuz-first etc.)
    for (const _rawT of rawItems.map(i => i.item || i).filter(t => t?.id)) {
      const _rawArtist = (((_rawT.artists||[]).filter(a=>a.type==='MAIN'||a.type==='FEATURED').length
        ? (_rawT.artists||[]).filter(a=>a.type==='MAIN'||a.type==='FEATURED')
        : (_rawT.artists?.length ? _rawT.artists : (_rawT.artist ? [_rawT.artist] : []))
      ).map(a=>a.name).join(', ')) || artistName;
      cacheSet(`hifi:track:meta:${instB64}_${_rawT.id}`, {
        title: _rawT.title || 'Unknown',
        artist: _rawArtist,
        isrc: _rawT.isrc ? _rawT.isrc.toUpperCase().replace(/[^A-Z0-9]/g,'') : null,
        duration: _rawT.duration ? Math.floor(_rawT.duration) : undefined,
      }, 3600);
    }
    const result = {
      id,
      title: album?.title || 'Unknown Album',
      artist: artistName,
      artworkURL: cover,
      year: safeYear(album?.releaseDate),
      trackCount: tracks.length,
      tracks,
    };
    await cacheSet(cacheKey, result, 3600);
    return result;
  } catch (e) {
    console.warn('[HiFi] album error:', e.message);
    return null;
  }
}


async function scSearch(query, clientId) {
  const cid = await getSCClientId(clientId);
  if (!cid) return { tracks: [], playlists: [] };
  const cacheKey = `sc:search:${cid.slice(0,8)}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const [tracksRes, plRes] = await Promise.allSettled([
      axios.get('https://api-v2.soundcloud.com/search/tracks', {
        params: { q: query, client_id: cid, limit: 20 },
        timeout: 8000,
      }),
      axios.get('https://api-v2.soundcloud.com/search/playlists', {
        params: { q: query, client_id: cid, limit: 5 },
        timeout: 8000,
      }),
    ]);
    const tracks = (tracksRes.status === 'fulfilled' ? tracksRes.value.data?.collection || [] : [])
      .filter(t => {
        // Drop snipped/blocked tracks from search results
        const _p = (t.policy || '').toUpperCase();
        if (_p === 'BLOCK') return false;
        // Only drop SNIP if the track is also very short (< 60s) — a real snip preview.
        // Long tracks (GY!BE, ambient, etc.) may have policy=SNIP but still be full uploads.
        if (_p === 'SNIP' && (t.full_duration || t.duration || 0) < 60000) return false;
        return true;
      })
      .map(t => ({
      id: `sc_${t.id}`,
      title: t.publisher_metadata?.title || t.title,
      artist: t.publisher_metadata?.artist || t.user?.name || t.user?.username || 'Unknown',
      album: '',
      duration: Math.floor((t.full_duration || t.duration || 0) / 1000),
      artworkURL: (t.artwork_url || '').replace('-large', '-t500x500'),
      isrc: t.publisher_metadata?.isrc || undefined,
      format: 'mp3',
      _source: 'sc',
      _origId: String(t.id),
      _streamUrl: t.media?.transcodings?.find(x => x.format?.mime_type?.includes('mpeg'))?.url || null,
    }));
    // Cache individual track transcoding URLs + policy so fallback can detect snips/previews
    for (const t of (tracksRes.status === 'fulfilled' ? tracksRes.value.data?.collection || [] : [])) {
      const turl = t.media?.transcodings?.find(x => x.format?.protocol === 'progressive' && x.format?.mime_type?.includes('mpeg'))?.url
                || t.media?.transcodings?.find(x => x.format?.protocol === 'progressive')?.url
                || t.media?.transcodings?.[0]?.url;
      if (turl) await cacheSet(`sc:transcodings:${t.id}`, turl, 3600);
      // Cache title/artist for fallback lookup when track turns out to be snipped
      if (t.title) {
        const _scMetaVal = { title: t.publisher_metadata?.title || t.title, artist: t.publisher_metadata?.artist || t.user?.name || t.user?.username || '', isrc: t.publisher_metadata?.isrc ? t.publisher_metadata.isrc.toUpperCase().replace(/[^A-Z0-9]/g,'') : null, duration: Math.floor((t.full_duration || t.duration || 0) / 1000) || undefined };
        await cacheSet(`sc:meta:${t.id}`, _scMetaVal, 3600);
        // Also persist to Upstash so stream handler can find it across isolates
        // Upstash persist done in handleSearch (which has c.env access)
      }
      // Cache policy so stream handler can detect snipped/blocked tracks
      if (t.policy || t.monetization_model) {
        await cacheSet(`sc:policy:${t.id}`, {
          policy: t.policy || '',
          monetization: t.monetization_model || '',
          snipped: !!(t.policy && ['SNIP', 'BLOCK'].includes(t.policy.toUpperCase())),
        }, 3600);
      }
    }
    const playlists = (plRes.status === 'fulfilled' ? plRes.value.data?.collection || [] : []).map(p => ({
      id: `sc_pl_${p.id}`,
      title: p.title,
      creator: p.user?.username || 'Unknown',
      artworkURL: (p.artwork_url || '').replace('-large', '-t500x500'),
      trackCount: p.track_count || 0,
      _source: 'sc',
      _origId: String(p.id),
    }));
    const result = { tracks, playlists };
    await cacheSet(cacheKey, result, 300);
    return result;
  } catch (e) {
    console.warn('[SC] search error:', e.message);
    return { tracks: [], playlists: [] };
  }
}



// ── raceNonNull: resolves with first non-null result from any promise (fast parallel fallback) ──
function raceNonNull(promises) {
  return new Promise((resolve) => {
    let pending = promises.length;
    if (!pending) return resolve(null);
    let resolved = false;
    promises.forEach(p =>
      Promise.resolve(p)
        .then(v => { if (v != null && !resolved) { resolved = true; resolve(v); } })
        .catch(() => {})
        .finally(() => { if (--pending === 0 && !resolved) resolve(null); })
    );
  });
}

async function scStream(origId, clientId, oauthToken) {
  const cid = await getSCClientId(clientId);
  // Even without a client_id, try using a cached transcoding URL from search
  const cachedTranscodingUrl = await cacheGet(`sc:transcodings:${origId}`);
  if (!cid && !cachedTranscodingUrl) return null;
  if (!cid && cachedTranscodingUrl) {
    // Can't resolve the transcoding URL without client_id, nothing we can do
    console.warn('[SC] no client_id, cannot resolve transcoding URL for', origId);
    return null;
  }
  try {
    const res = await axios.get(`https://api-v2.soundcloud.com/tracks/${origId}`, {
      params: { client_id: cid },
      headers: oauthToken ? { Authorization: `OAuth ${oauthToken}` } : {},
      timeout: 5000,
    });
    const transcodings = res.data?.media?.transcodings || [];
    // Prefer progressive MP3 > progressive any > HLS MP3 > HLS any > first available
    const transcoding =
      transcodings.find(t => t.format?.protocol === 'progressive' && t.format?.mime_type?.includes('mpeg')) ||
      transcodings.find(t => t.format?.protocol === 'progressive') ||
      transcodings.find(t => t.format?.protocol === 'hls' && t.format?.mime_type?.includes('mpeg')) ||
      transcodings.find(t => t.format?.protocol === 'hls') ||
      transcodings[0];
    if (!transcoding?.url) {
      console.warn(`[SC] no transcodings available for track ${origId}`);
      return null;
    }
    const streamRes = await axios.get(transcoding.url, {
      params: { client_id: cid },
      headers: oauthToken ? { Authorization: `OAuth ${oauthToken}` } : {},
      timeout: 5000,
    });
    const url = streamRes.data?.url;
    if (!url) return null;
    const isHls = transcoding.format?.protocol === 'hls' || url.includes('.m3u8');
    // Detect snipped/preview tracks: SC returns short URLs or policy says SNIP/BLOCK
    const trackData = res.data;
    const policy = (trackData?.policy || '').toUpperCase();
    // With a valid OAuth token the user is authenticated — SUB_HIGH_TIER tracks are accessible
    const isSnipped = !oauthToken && (
      policy === 'SNIP' || policy === 'BLOCK'
      || trackData?.monetization_model === 'SUB_HIGH_TIER'
      || (trackData?.full_duration && trackData?.duration && trackData.full_duration > trackData.duration + 5000)
    );
    // Never serve a snippet — return null so caller gets a 404 or tries HiFi
    if (isSnipped) {
      console.warn(`[SC stream] ${origId} is snipped/sub-only, refusing to serve preview`);
      return null;
    }
    return { url, format: isHls ? 'hls' : 'mp3', quality: '128kbps', _scSnipped: false };
  } catch (e) {
    console.warn('[SC] stream error:', e.message);
    // Fallback: try cached transcoding URL directly
    if (cachedTranscodingUrl) {
      try {
        const fallbackRes = await axios.get(cachedTranscodingUrl, { params: { client_id: cid }, timeout: 6000 });
        const fallbackUrl = fallbackRes.data?.url;
        if (fallbackUrl) return { url: fallbackUrl, format: 'mp3', quality: '128kbps' };
      } catch {}
    }
    return null;
  }
}

// ─── Internet Archive Search (Music) ─────────────────────────────────────────
async function iaSearchMusic(query) {
  const cacheKey = `ia:music:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get('https://archive.org/advancedsearch.php', {
      params: {
        q: `${query} AND mediatype:audio AND -mediatype:collection`,
        fl: 'identifier,title,creator,date,description',
        rows: 10,
        page: 1,
        output: 'json',
        'sort[]': 'downloads desc',
      },
      timeout: 8000,
    });
    const docs = res.data?.response?.docs || [];
    const tracks = docs.map(d => ({
      id: `ia_music_${d.identifier}`,
      title: d.title || d.identifier,
      artist: Array.isArray(d.creator) ? d.creator[0] : (d.creator || 'Unknown'),
      album: '',
      duration: 0,
      artworkURL: `https://archive.org/services/img/${d.identifier}`,
      format: 'mp3',
      _source: 'ia_music',
      _identifier: d.identifier,
    }));
    await cacheSet(cacheKey, tracks, 600);
    return tracks;
  } catch (e) {
    console.warn('[IA Music] search error:', e.message);
    return [];
  }
}

async function iaGetBestAudioFile(identifier) {
  const cacheKey = `ia:files:${identifier}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get(`https://archive.org/metadata/${identifier}`, { timeout: 8000 });
    const files = res.data?.files || [];
    const _audioFiles = files.filter(f => {
      const n = (f.name || '').toLowerCase();
      return (n.endsWith('.mp3') || n.endsWith('.flac') || n.endsWith('.ogg') || n.endsWith('.wav') || n.endsWith('.opus'))
        && f.source !== 'metadata';
    });
    // Score: flac=4, mp3 (320/VBR)=3, mp3 (other)=2, ogg/opus=1, wav=0
    const _score = f => {
      const n = (f.name || '').toLowerCase();
      const bitrate = parseInt(f.bitrate || '0', 10);
      if (n.endsWith('.flac')) return 4;
      if (n.endsWith('.mp3') && (bitrate >= 320 || f.name?.includes('320') || f.name?.includes('VBR'))) return 3;
      if (n.endsWith('.mp3')) return 2;
      if (n.endsWith('.ogg') || n.endsWith('.opus')) return 1;
      return 0;
    };
    _audioFiles.sort((a, b) => _score(b) - _score(a));
    const best = _audioFiles[0];
    if (best) {
      const url = `https://archive.org/download/${identifier}/${encodeURIComponent(best.name)}`;
      await cacheSet(cacheKey, url, 3600);
      return url;
    }
    return null;
  } catch(e) { console.warn('[IA getBestAudioFile]', e.message); return null; }
}

// ─── Internet Archive Audiobooks ──────────────────────────────────────────────
async function iaSearchAudiobooks(query) {
  const cacheKey = `ia:audiobooks:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get('https://archive.org/advancedsearch.php', {
      params: {
        q: `${query} AND (collection:librivoxaudio OR subject:audiobook OR subject:"audio book") AND mediatype:audio`,
        fl: 'identifier,title,creator,date,description,subject',
        rows: 8,
        page: 1,
        output: 'json',
        'sort[]': 'downloads desc',
      },
      timeout: 8000,
    });
    const docs = res.data?.response?.docs || [];
    const albums = docs.map(d => ({
      id: `ia_book_${d.identifier}`,
      title: d.title || d.identifier,
      artist: Array.isArray(d.creator) ? d.creator[0] : (d.creator || 'Unknown Author'),
      artworkURL: `https://archive.org/services/img/${d.identifier}`,
      trackCount: 0,
      year: safeYear(d.date),
      _source: 'ia_book',
      _identifier: d.identifier,
    }));
    await cacheSet(cacheKey, albums, 600);
    return albums;
  } catch (e) {
    console.warn('[IA Audiobooks] search error:', e.message);
    return [];
  }
}

// ─── LibriVox Audiobooks ──────────────────────────────────────────────────────
async function librivoxSearch(query) {
  const cacheKey = `librivox:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    // LibriVox API: title search with caret prefix for broader matches
    const res = await axios.get('https://librivox.org/api/feed/audiobooks', {
      params: { title: `%5E${query}`, format: 'json', extended: 1, limit: 6 },
      timeout: 5000,
    }).catch(async () =>
      axios.get('https://librivox.org/api/feed/audiobooks', {
        params: { title: query, format: 'json', extended: 1, limit: 6 },
        timeout: 5000,
      })
    );
    const books = Array.isArray(res.data?.books) ? res.data.books : [];
    const albums = books.map(b => ({
      id: `lvox_${b.id}`,
      title: b.title || 'Unknown',
      artist: (b.authors || []).map(a => `${a.first_name} ${a.last_name}`).join(', ') || 'Unknown Author',
      artworkURL: b.url_zip_file ? '' : '',
      trackCount: parseInt(b.num_sections) || 0,
      year: safeYear(b.copyright_year),
      _source: 'librivox',
      _bookId: b.id,
      _rssUrl: b.url_rss,
    }));
    await cacheSet(cacheKey, albums, 600);
    return albums;
  } catch (e) {
    console.warn('[LibriVox] search error:', e.message);
    return [];
  }
}

async function librivoxGetChapters(bookId, rssUrl) {
  const cacheKey = `lvox:chapters:${bookId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const feedUrl = rssUrl || `https://librivox.org/rss/${bookId}`;
    const res = await axios.get(feedUrl, { timeout: 8000, responseType: 'text' });
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    let i = 0;
    while ((m = itemRe.exec(res.data)) !== null) {
      const item = m[1];
      const title = (item.match(/<title><!\[CDATA\[([^\]]+)\]\]>/) || item.match(/<title>([^<]+)/))?.[1]?.trim() || `Chapter ${++i}`;
      const url = item.match(/url="([^"]+\.mp3)"/)?.[1] || item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1] || '';
      const duration = item.match(/<itunes:duration>([^<]+)/)?.[1] || '';
      const durSecs = duration.split(':').reduce((acc, t) => acc * 60 + parseInt(t || 0), 0);
      if (url) items.push({ title, url, duration: durSecs });
    }
    await cacheSet(cacheKey, items, 3600);
    return items;
  } catch (e) {
    console.warn('[LibriVox] chapter fetch error:', e.message);
    return [];
  }
}

// ─── Podcast Index ────────────────────────────────────────────────────────────
async function podcastIndexHeaders(key, secret) {
  // Trim keys to prevent whitespace from corrupting the HMAC hash
  key = String(key || '').trim();
  secret = String(secret || '').trim();
  const ts = Math.floor(Date.now() / 1000).toString();
  const msgBuffer = new TextEncoder().encode(key + secret + ts);
  const hashBuffer = await crypto.subtle.digest('SHA-1', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    'X-Auth-Key': key,
    'X-Auth-Date': ts,
    Authorization: hash,
    'User-Agent': 'EclipseUniversalAddon/1.0',
  };
}

async function piSearchEpisodes(query, key, secret) {
  if (!key || !secret) return { playlists: [], albums: [], episodes: [] };
  const cacheKey = `pi:episodes:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    // Run both PI calls in parallel to cut search latency in half
    const _piHdrs = await podcastIndexHeaders(key, secret);
    const [feedsRes, epRes] = await Promise.allSettled([
      axios.get('https://api.podcastindex.org/api/1.0/search/byterm', {
        params: { q: query, max: 10, fulltext: true },
        headers: _piHdrs,
        timeout: 8000,
      }),
      axios.get('https://api.podcastindex.org/api/1.0/episodes/search', {
        params: { q: query, max: 20, fulltext: true },
        headers: _piHdrs,
        timeout: 8000,
      }),
    ]);
    const feeds = feedsRes.status === 'fulfilled' ? (feedsRes.value.data?.feeds || []) : [];
    // Return as playlists (podcast series)
    const playlists = feeds.slice(0, 5).map(f => ({
      id: `pi_feed_${f.id}`,
      title: f.title || 'Unknown Podcast',
      description: f.description || '',
      artworkURL: f.artwork || f.image || '',
      creator: f.author || '',
      trackCount: f.episodeCount || 0,
      _source: 'pi',
      _feedId: f.id,
      _feedUrl: f.url,
    }));
    const _rawEps = epRes.status === 'fulfilled'
      ? (epRes.value.data?.items || epRes.value.data?.episodes || [])
      : [];
    // If episode search returned nothing but we have feeds, pull episodes from top feed
    let _feedEps = [];
    if (_rawEps.length === 0 && feeds.length > 0 && key && secret) {
      try {
        const _topFeed = feeds[0];
        const _fEpHdrs = await podcastIndexHeaders(key, secret);
        const _fEpRes = await axios.get('https://api.podcastindex.org/api/1.0/episodes/byfeedid', {
          params: { id: _topFeed.id, max: 20 },
          headers: _fEpHdrs,
          timeout: 6000,
        });
        _feedEps = (_fEpRes.data?.items || []).map(e => ({ ...e, feedTitle: e.feedTitle || _topFeed.title, image: e.image || e.feedImage || _topFeed.artwork || _topFeed.image }));
      } catch (e2) { /* non-fatal */ }
    }
    // Deduplicate by id before mapping (rawEps take priority over feedEps)
    const _seenPiEpId = new Set(_rawEps.map(e => String(e.id)));
    const _deduped = [..._rawEps, ..._feedEps.filter(e => !_seenPiEpId.has(String(e.id)))];
    const episodes = _deduped.map(e => ({
      id: `pi_ep_${e.id}`,
      title: e.title || 'Unknown Episode',
      artist: e.feedTitle || e.author || 'Unknown Podcast',
      album: e.feedTitle || '',
      duration: e.duration || 0,
      artworkURL: e.image || e.feedImage || '',
      format: 'mp3',
      streamURL: e.enclosureUrl || e.enclosure?.url || '',
      _source: 'pi',
    }));
    // Pre-cache stream URLs so handleStream resolves without re-fetching PI API
    for (const ep of episodes) {
      if (ep.streamURL) cacheSet(`pi:ep:stream:${ep.id}`, ep.streamURL, 3600);
    }
    for (const f of feeds) {
      await cacheSet(`pi:series_info:${f.id}`, {
        title: f.title || 'Unknown Podcast',
        artworkURL: f.artwork || f.image || '',
        creator: f.author || '',
        description: f.description || '',
      }, 3600);
    }
    const albums = feeds.slice(0, 5).map(f => ({
      id: `pi_feed_${f.id}`,
      title: f.title || 'Unknown Podcast',
      artist: f.author || '',
      artworkURL: f.artwork || f.image || '',
      trackCount: f.episodeCount || 0,
      year: 0,
      _source: 'pi',
      _isPodcast: true,
    }));
    const result = { playlists, albums, episodes };
    await cacheSet(cacheKey, result, 600);
    return result;
  } catch (e) {
    console.warn('[PI] search error:', e.message, 'status:', e?.response?.status || 'N/A', 'key_set:', !!(key && secret));
    return { playlists: [], albums: [], episodes: [] };
  }
}

async function piGetEpisodes(feedId, key, secret) {
  if (!key || !secret) return [];
  const cacheKey = `pi:feed:${feedId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const _piHdrs2 = await podcastIndexHeaders(key, secret);
    const res = await axios.get('https://api.podcastindex.org/api/1.0/episodes/byfeedid', {
      params: { id: feedId, max: 50 },
      headers: _piHdrs2,
      timeout: 8000,
    });
    const items = (res.data?.items || []).map(e => ({
      id: `pi_ep_${e.id}`,
      title: e.title || 'Episode',
      artist: e.feedTitle || '',
      duration: e.duration || 0,
      artworkURL: e.image || e.feedImage || '',
      streamURL: e.enclosureUrl || '',
      format: 'mp3',
    }));
    await cacheSet(cacheKey, items, 600);
    return items;
  } catch { return []; }
}

// ─── Taddy GraphQL ────────────────────────────────────────────────────────────
async function taddySearch(query, apiKey, userId) {
  // Trim to prevent whitespace from breaking auth headers
  apiKey = String(apiKey || '').trim();
  userId = String(userId || '').trim();
  if (!apiKey || !userId) return { playlists: [], albums: [], episodes: [] };
  const cacheKey = `taddy:search:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  const gql = `query { search(term: "${query.replace(/[\\'"`\n\r{}[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)}", filterForTypes: [PODCASTSERIES, PODCASTEPISODE], limitPerPage: 8) { searchId podcastSeries { uuid name imageUrl rssUrl episodes(limitPerPage: 5) { uuid name audioUrl duration imageUrl } } podcastEpisodes { uuid name audioUrl duration imageUrl podcastSeries { uuid name imageUrl } } } }`;
  try {
    const res = await axios.post('https://api.taddy.org', { query: gql }, {
      headers: {
        'Content-Type': 'application/json',
        'X-USER-ID': userId,
        'X-API-KEY': apiKey,
      },
      timeout: 5000,
    });
    const data = res.data?.data?.search;
    const playlists = (data?.podcastSeries || []).map(s => ({
      id: `taddy_series_${s.uuid}`,
      title: s.name || 'Unknown',
      description: s.description || '',
      artworkURL: s.imageUrl || '',
      creator: '',
      trackCount: 0,
      _source: 'taddy',
      _uuid: s.uuid,
      _episodes: s.episodes || [],
    }));
    // Build episodes: standalone podcastEpisodes + episodes embedded in each series
    const _seriesEps = (data?.podcastSeries || []).flatMap(s =>
      (s.episodes || []).map(e => ({
        id: `taddy_ep_${e.uuid}`,
        title: e.name || 'Unknown Episode',
        artist: s.name || 'Unknown Podcast',
        album: s.name || '',
        duration: e.duration || 0,
        artworkURL: e.imageUrl || s.imageUrl || '',
        format: 'mp3',
        streamURL: e.audioUrl || '',
        _source: 'taddy',
      }))
    );
    const _directEps = (data?.podcastEpisodes || []).map(e => ({
      id: `taddy_ep_${e.uuid}`,
      title: e.name || 'Unknown Episode',
      artist: e.podcastSeries?.name || 'Unknown Podcast',
      album: e.podcastSeries?.name || '',
      duration: e.duration || 0,
      artworkURL: e.imageUrl || e.podcastSeries?.imageUrl || '',
      format: 'mp3',
      streamURL: e.audioUrl || '',
      _source: 'taddy',
    }));
    // Deduplicate by uuid, prefer directEps (richer metadata)
    const _seenTaddyUuid = new Set(_directEps.map(e => e.id));
    const episodes = [..._directEps, ..._seriesEps.filter(e => !_seenTaddyUuid.has(e.id))];
    // Pre-cache stream URLs for Taddy episodes too
    for (const ep of episodes) {
      if (ep.streamURL) cacheSet(`taddy:ep:stream:${ep.id}`, ep.streamURL, 3600);
    }
    for (const s of (data?.podcastSeries || [])) {
      await cacheSet(`taddy:series_info:${s.uuid}`, {
        title: s.name || 'Unknown Podcast',
        artworkURL: s.imageUrl || '',
        creator: '',
      }, 3600);
    }
    const albums = playlists.map(p => ({
      id: p.id,
      title: p.title,
      artist: p.creator || '',
      artworkURL: p.artworkURL || '',
      trackCount: p.trackCount || 0,
      year: 0,
      _source: 'taddy',
      _isPodcast: true,
    }));
    const result = { playlists, albums, episodes };
    await cacheSet(cacheKey, result, 600);
    return result;
  } catch (e) {
    console.warn('[Taddy] search error:', e.message, 'status:', e?.response?.status || 'N/A', 'key_set:', !!(apiKey && userId));
    return { playlists: [], albums: [], episodes: [] };
  }
}

async function taddyGetEpisodes(seriesUuid, apiKey, userId) {
  apiKey = String(apiKey || '').trim();
  userId = String(userId || '').trim();
  if (!apiKey || !userId) return [];
  const cacheKey = `taddy:series:${seriesUuid}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  const gql = `query {
    getPodcastSeries(uuid: "${seriesUuid}") {
      uuid name imageUrl
      episodes(limitPerPage: 50) {
        uuid name description audioUrl duration imageUrl datePublished
      }
    }
  }`;
  try {
    const res = await axios.post('https://api.taddy.org', { query: gql }, {
      headers: { 'Content-Type': 'application/json', 'X-USER-ID': userId, 'X-API-KEY': apiKey },
      timeout: 8000,
    });
    const series = res.data?.data?.getPodcastSeries;
    const items = (series?.episodes || []).map(e => ({
      id: `taddy_ep_${e.uuid}`,
      title: e.name || 'Episode',
      artist: series?.name || '',
      duration: e.duration || 0,
      artworkURL: e.imageUrl || series?.imageUrl || '',
      streamURL: e.audioUrl || '',
      format: 'mp3',
    }));
    await cacheSet(cacheKey, items, 600);
    return items;
  } catch { return []; }
}

// ─── Apple Podcasts — RSS Feed Parser ─────────────────────────────────────────
async function appleGetFeed(feedUrl, collectionId) {
  const cacheKey = `apple:feed:${collectionId || feedUrl}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get(feedUrl, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      timeout: 10000,
      responseType: 'text',
    });
    const xml = res.data;
    const chanTitle  = (xml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim() || '';
    const chanArtM   = xml.match(/<itunes:image\s+href="([^"]+)"/) || xml.match(/<image>[\s\S]*?<url>([\s\S]*?)<\/url>/);
    const chanArt    = chanArtM ? chanArtM[1].trim() : '';
    const chanAuthor = (xml.match(/<itunes:author>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/itunes:author>/) || [])[1]?.trim() || '';
    const chanDesc   = (xml.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1]?.trim().slice(0, 500) || '';
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    const episodes = [];
    let m, idx = 0;
    while ((m = itemRe.exec(xml)) !== null) {
      const item    = m[1];
      const title   = (item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim() || `Episode ${idx + 1}`;
      const encM    = item.match(/<enclosure[^>]+url="([^"]+)"/) || item.match(/<enclosure[^>]+url='([^']+)'/);
      const audioUrl = encM ? encM[1].trim() : null;
      const durStr  = (item.match(/<itunes:duration>([\s\S]*?)<\/itunes:duration>/) || [])[1]?.trim() || '';
      const durSecs = durStr.includes(':')
        ? durStr.split(':').reduce((acc, t) => acc * 60 + parseInt(t, 10), 0)
        : (parseInt(durStr, 10) || 0);
      const artM  = item.match(/<itunes:image\s+href="([^"]+)"/);
      const epArt = artM ? artM[1].trim() : chanArt;
      const epId  = `apple_ep_rss_${collectionId || 'feed'}_${idx}`;
      if (audioUrl) await cacheSet(`apple:ep:stream:${epId}`, audioUrl, 3600);
      episodes.push({
        id: epId, title,
        artist: chanAuthor || chanTitle, album: chanTitle,
        duration: durSecs, artworkURL: epArt,
        format: audioUrl && audioUrl.includes('.m4a') ? 'aac' : 'mp3',
        streamURL: audioUrl, source: 'apple',
      });
      idx++;
    }
    const result = {
      id: `apple_feed_${collectionId || 'rss'}`,
      title: chanTitle || 'Podcast', artist: chanAuthor,
      artworkURL: chanArt, description: chanDesc,
      trackCount: episodes.length, tracks: episodes,
    };
    await cacheSet(cacheKey, result, 600);
    return result;
  } catch (e) {
    console.warn('[Apple] RSS feed parse error:', e.message);
    return null;
  }
}

// ─── Apple Podcasts Search (iTunes API — completely free, no key) ─────────────
// In-flight dedup map for Apple Podcasts: prevents concurrent identical queries all hitting iTunes
const _appleInflight = new Map();

async function appleSearch(query) {
  const cacheKey = `apple:search:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  // Deduplicate concurrent identical queries — return the same promise to all callers
  if (_appleInflight.has(cacheKey)) return _appleInflight.get(cacheKey);

  const promise = _appleSearchInner(query, cacheKey);
  _appleInflight.set(cacheKey, promise);
  promise.finally(() => _appleInflight.delete(cacheKey));
  return promise;
}

// ─── Apple iTunes podcast search ─────────────────────────────────────────────
// Global circuit-breaker: if Apple 429s us, skip it for 60s to avoid spam.
// This prevents Cloudflare's shared IP from getting hammered after a rate-limit hit.
const _appleCB = { trippedUntil: 0, consecutive429s: 0, consecutive403s: 0 };
function _appleCircuitOpen() {
  if (Date.now() < _appleCB.trippedUntil) return true;
  if (_appleCB.consecutive429s >= 2) {
    _appleCB.trippedUntil = Date.now() + 300000; // 5 min cooldown for repeated 429s
    _appleCB.consecutive429s = 0;
    console.warn('[Apple] circuit breaker OPEN (429) — skipping Apple for 5 min');
    return true;
  }
  if (_appleCB.consecutive403s >= 1) {
    _appleCB.trippedUntil = Date.now() + 120000; // 2 min cooldown for 403 CF IP block
    _appleCB.consecutive403s = 0;
    console.warn('[Apple] circuit breaker OPEN (403 CF block) — skipping Apple for 2 min');
    return true;
  }
  return false;
}
function _appleRecordSuccess() { _appleCB.consecutive429s = 0; _appleCB.consecutive403s = 0; }
function _appleRecord429()     { _appleCB.consecutive429s++; }
function _appleRecord403()     { _appleCB.consecutive403s++; }

// Rotate UA strings so each retry looks like a different client
const _APPLE_UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

async function _appleSearchInner(query, cacheKey) {
  // If circuit breaker is open, skip Apple entirely and return empty
  if (_appleCircuitOpen()) {
    console.warn('[Apple] circuit breaker open — skipping iTunes for query:', query);
    return { playlists: [], albums: [], episodes: [], artists: [] };
  }

  try {
    // Staggered jitter: 100-600ms to spread burst requests from Cloudflare's shared IP
    await new Promise(r => setTimeout(r, 100 + Math.floor(Math.random() * 500)));

    const itunesResult = await (async () => {
      // Try up to 3 times with different UAs and increasing backoff
      const delays = [0, 1500, 3000];
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          if (_appleCircuitOpen()) return null; // circuit tripped mid-retry, abort
          await new Promise(r => setTimeout(r, delays[attempt] + Math.floor(Math.random() * 500)));
        }
        try {
          const ua = _APPLE_UAS[attempt % _APPLE_UAS.length];
          const r = await axios.get('https://itunes.apple.com/search', {
            params: { term: query, media: 'podcast', entity: 'podcastEpisode', limit: 20, explicit: 'Yes' },
            headers: {
              'User-Agent': ua,
            },
            timeout: 10000,
          });
          _appleRecordSuccess();
          return r.data || null;
        } catch (e) {
          if (e?.response?.status === 429) {
            _appleRecord429();
            console.warn(`[Apple] rate-limited (429) on attempt ${attempt + 1}/3 — query: ${query}`);
            if (attempt === 2) {
              console.warn('[Apple] all 3 attempts 429d — returning empty, circuit may trip');
              return null;
            }
            // continue to next attempt with longer delay
          } else if (e?.response?.status === 403) {
            // CF Worker datacenter IP blocked by Apple — don't retry, trip the circuit
            _appleRecord403();
            console.warn('[Apple] 403 blocked (CF IP) — tripping circuit, skipping Apple search');
            return null;
          } else {
            console.warn('[Apple] search error:', e.message, 'status:', e?.response?.status);
            return null; // non-429 errors don't retry
          }
        }
      }
      return null;
    })();

    if (!itunesResult) return { playlists: [], albums: [], episodes: [], artists: [] };

    const rawEps = (itunesResult?.results || []).filter(ep => ep.kind === 'podcast-episode' && ep.episodeUrl);

    // Build episode tracks
    const episodes = rawEps.map(ep => {
      const epId = `apple_ep_${ep.trackId}`;
      cacheSet(`apple:ep:stream:${epId}`, ep.episodeUrl, 3600).catch(() => {});
      if (ep.feedUrl && ep.collectionId) cacheSet(`apple:feed_url:${ep.collectionId}`, ep.feedUrl, 86400).catch(() => {});
      const art = (ep.artworkUrl600 || ep.artworkUrl160 || '').replace(/\/\d+x\d+(bb|cc)\./, '/600x600bb.');
      return {
        id: epId,
        title: String(ep.trackName || 'Unknown Episode').replace(/\s+/g, ' ').trim(),
        artist: String(ep.collectionName || ep.artistName || 'Unknown Podcast').replace(/\s+/g, ' ').trim(),
        album: String(ep.collectionName || '').replace(/\s+/g, ' ').trim(),
        duration: ep.trackTimeMillis ? Math.floor(ep.trackTimeMillis / 1000) : null,
        artworkURL: art || null,
        streamURL: ep.episodeUrl,
        format: (() => { const u = (ep.episodeUrl || '').toLowerCase().split('?')[0]; if (u.endsWith('.m4a') || u.includes('/m4a/')) return 'm4a'; if (u.endsWith('.aac')) return 'aac'; if (u.endsWith('.ogg') || u.endsWith('.opus')) return 'ogg'; return 'mp3'; })(),
        source: 'apple',
      };
    });

    // Build albums (podcast shows) from episode collectionIds
    const albumMap = new Map();
    const artistMap = new Map();
    rawEps.forEach(ep => {
      const cid   = ep.collectionId ? String(ep.collectionId) : null;
      const cname = String(ep.collectionName || ep.artistName || '').replace(/\s+/g, ' ').trim();
      const aname = String(ep.artistName || ep.collectionName || '').replace(/\s+/g, ' ').trim();
      const art   = (ep.artworkUrl600 || ep.artworkUrl160 || '').replace(/\/\d+x\d+(bb|cc)\./, '/600x600bb.');
      if (cid && cname && !albumMap.has(cid)) {
        albumMap.set(cid, {
          id: `apple_feed_${cid}`, title: cname, artist: aname, artworkURL: art || null,
          trackCount: null, year: ep.releaseDate ? String(new Date(ep.releaseDate).getFullYear()) : null,
          source: 'apple', _isPodcast: true,
        });
      }
      const akey = aname.toLowerCase();
      if (aname && !artistMap.has(akey)) {
        let aId;
        try { aId = `itartist_${btoa(unescape(encodeURIComponent(aname)))}`; } catch { aId = `itartist_${aname.replace(/[^a-z0-9]/gi,'_')}`; }
        artistMap.set(akey, { id: aId, name: aname, artworkURL: art || null, genres: [], source: 'apple' });
      }
    });

    // Build playlists from albums
    const playlists = Array.from(albumMap.values()).map(a => ({
      id: a.id, title: a.title, creator: a.artist, artworkURL: a.artworkURL,
      trackCount: a.trackCount, description: '', source: 'apple',
      _feedUrl: null,
    }));

    const albums  = Array.from(albumMap.values());
    const artists = Array.from(artistMap.values());

    const result = { playlists, albums, episodes, artists };
    await cacheSet(cacheKey, result, 600);
    return result;
  } catch (e) {
    console.warn('[Apple] search error:', e.message);
    return { playlists: [], albums: [], episodes: [], artists: [] };
  }
}

async function dzGw(method, params, arl, sid, apiToken) {
  const res = await fetch(
    `https://www.deezer.com/ajax/gw-light.php?method=${method}&input=3&api_version=1.0&api_token=${encodeURIComponent(apiToken || 'null')}`,
    {
      method: 'POST',
      headers: {
        'Cookie': `arl=${arl}; sid=${sid || ''}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.deezer.com',
        'Referer': 'https://www.deezer.com/',
      },
      body: JSON.stringify(params),
    }
  );
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _raw: text.slice(0, 500) }; }
}

// ── dzPing — get SID cookie ───────────────────────────────────────────────────
async function dzPing(arl) {
  const res = await fetch(
    'https://www.deezer.com/ajax/gw-light.php?method=deezer.ping&input=3&api_version=1.0&api_token=null',
    {
      method: 'POST',
      headers: {
        'Cookie': `arl=${arl}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Origin': 'https://www.deezer.com',
        'Referer': 'https://www.deezer.com/',
      },
      body: JSON.stringify({}),
    }
  );
  const setCookie = res.headers.get('set-cookie') || '';
  const sidMatch  = setCookie.match(/sid=([^;]+)/);
  return sidMatch ? sidMatch[1] : '';
}

// ── Blowfish key derivation (per-track) ──────────────────────────────────────
function dzGetBlowfishKey(trackId) {
  const SECRET = 'g4el58wc0zvf9na1';
  const h = dzMd5Sync(trackId);
  let key = '';
  for (let i = 0; i < 16; i++) {
    key += String.fromCharCode(h.charCodeAt(i) ^ h.charCodeAt(i + 16) ^ SECRET.charCodeAt(i));
  }
  return key;
}

// ── Pure-JS synchronous MD5 ───────────────────────────────────────────────────
function dzMd5Sync(str) {
  function safeAdd(x,y){const l=(x&0xffff)+(y&0xffff);const m=(x>>16)+(y>>16)+(l>>16);return(m<<16)|(l&0xffff);}
  function rol(n,c){return(n<<c)|(n>>>(32-c));}
  function cmn(q,a,b,x,s,t){return safeAdd(rol(safeAdd(safeAdd(a,q),safeAdd(x,t)),s),b);}
  function ff(a,b,c,d,x,s,t){return cmn((b&c)|(~b&d),a,b,x,s,t);}
  function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&~d),a,b,x,s,t);}
  function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
  function ii(a,b,c,d,x,s,t){return cmn(c^(b|~d),a,b,x,s,t);}
  const bytes=new TextEncoder().encode(str);
  const len8=bytes.length;
  const len32=Math.ceil((len8+9)/64)*16;
  const M=new Int32Array(len32);
  for(let i=0;i<len8;i++)M[i>>2]|=bytes[i]<<((i%4)*8);
  M[len8>>2]|=0x80<<((len8%4)*8);
  M[len32-2]=len8*8;
  let a=1732584193,b=-271733879,c=-1732584194,d=271733878;
  for(let i=0;i<len32;i+=16){
    const[A,B,C,D]=[a,b,c,d];
    a=ff(a,b,c,d,M[i+0],7,-680876936);d=ff(d,a,b,c,M[i+1],12,-389564586);c=ff(c,d,a,b,M[i+2],17,606105819);b=ff(b,c,d,a,M[i+3],22,-1044525330);
    a=ff(a,b,c,d,M[i+4],7,-176418897);d=ff(d,a,b,c,M[i+5],12,1200080426);c=ff(c,d,a,b,M[i+6],17,-1473231341);b=ff(b,c,d,a,M[i+7],22,-45705983);
    a=ff(a,b,c,d,M[i+8],7,1770035416);d=ff(d,a,b,c,M[i+9],12,-1958414417);c=ff(c,d,a,b,M[i+10],17,-42063);b=ff(b,c,d,a,M[i+11],22,-1990404162);
    a=ff(a,b,c,d,M[i+12],7,1804603682);d=ff(d,a,b,c,M[i+13],12,-40341101);c=ff(c,d,a,b,M[i+14],17,-1502002290);b=ff(b,c,d,a,M[i+15],22,1236535329);
    a=gg(a,b,c,d,M[i+1],5,-165796510);d=gg(d,a,b,c,M[i+6],9,-1069501632);c=gg(c,d,a,b,M[i+11],14,643717713);b=gg(b,c,d,a,M[i+0],20,-373897302);
    a=gg(a,b,c,d,M[i+5],5,-701558691);d=gg(d,a,b,c,M[i+10],9,38016083);c=gg(c,d,a,b,M[i+15],14,-660478335);b=gg(b,c,d,a,M[i+4],20,-405537848);
    a=gg(a,b,c,d,M[i+9],5,568446438);d=gg(d,a,b,c,M[i+14],9,-1019803690);c=gg(c,d,a,b,M[i+3],14,-187363961);b=gg(b,c,d,a,M[i+8],20,1163531501);
    a=gg(a,b,c,d,M[i+13],5,-1444681467);d=gg(d,a,b,c,M[i+2],9,-51403784);c=gg(c,d,a,b,M[i+7],14,1735328473);b=gg(b,c,d,a,M[i+12],20,-1926607734);
    a=hh(a,b,c,d,M[i+5],4,-378558);d=hh(d,a,b,c,M[i+8],11,-2022574463);c=hh(c,d,a,b,M[i+11],16,1839030562);b=hh(b,c,d,a,M[i+14],23,-35309556);
    a=hh(a,b,c,d,M[i+1],4,-1530992060);d=hh(d,a,b,c,M[i+4],11,1272893353);c=hh(c,d,a,b,M[i+7],16,-155497632);b=hh(b,c,d,a,M[i+10],23,-1094730640);
    a=hh(a,b,c,d,M[i+13],4,681279174);d=hh(d,a,b,c,M[i+0],11,-358537222);c=hh(c,d,a,b,M[i+3],16,-722521979);b=hh(b,c,d,a,M[i+6],23,76029189);
    a=hh(a,b,c,d,M[i+9],4,-640364487);d=hh(d,a,b,c,M[i+12],11,-421815835);c=hh(c,d,a,b,M[i+15],16,530742520);b=hh(b,c,d,a,M[i+2],23,-995338651);
    a=ii(a,b,c,d,M[i+0],6,-198630844);d=ii(d,a,b,c,M[i+7],10,1126891415);c=ii(c,d,a,b,M[i+14],15,-1416354905);b=ii(b,c,d,a,M[i+5],21,-57434055);
    a=ii(a,b,c,d,M[i+12],6,1700485571);d=ii(d,a,b,c,M[i+3],10,-1894986606);c=ii(c,d,a,b,M[i+10],15,-1051523);b=ii(b,c,d,a,M[i+1],21,-2054922799);
    a=ii(a,b,c,d,M[i+8],6,1873313359);d=ii(d,a,b,c,M[i+15],10,-30611744);c=ii(c,d,a,b,M[i+6],15,-1560198380);b=ii(b,c,d,a,M[i+13],21,1309151649);
    a=ii(a,b,c,d,M[i+4],6,-145523070);d=ii(d,a,b,c,M[i+11],10,-1120210379);c=ii(c,d,a,b,M[i+2],15,718787259);b=ii(b,c,d,a,M[i+9],21,-343485551);
    a=safeAdd(a,A);b=safeAdd(b,B);c=safeAdd(c,C);d=safeAdd(d,D);
  }
  return [a,b,c,d].map(n=>{let h='';for(let i=0;i<4;i++)h+=('0'+((n>>(i*8))&0xff).toString(16)).slice(-2);return h;}).join('');
}

// ── Pure-JS async MD5 (for buildCDNUrl) ──────────────────────────────────────
async function dzMd5(str) { return dzMd5Sync(str); }

// ── Build Deezer CDN URL from track fields (AES-ECB via CBC+zeroIV) ──────────
async function dzBuildCDNUrl(md5Origin, mediaVersion, trackId, quality) {
  const SEP   = '\xa4';
  const step1 = [md5Origin, quality, trackId, mediaVersion].join(SEP);
  const md5Hex = await dzMd5(step1);
  const step2  = md5Hex + SEP + step1 + SEP;
  const padded = step2.padEnd(Math.ceil(step2.length / 16) * 16, '\0');
  const rawKey = new TextEncoder().encode('jo6aey6haid2Teih');
  const aesKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, ['encrypt']);
  const blocks = [];
  const paddedBytes = new TextEncoder().encode(padded);
  for (let i = 0; i < paddedBytes.length; i += 16) {
    const block  = paddedBytes.slice(i, i + 16);
    const zeroIV = new Uint8Array(16);
    const enc    = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIV }, aesKey, block);
    blocks.push(new Uint8Array(enc).slice(0, 16));
  }
  const hexResult = blocks.map(b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')).join('');
  return `https://e-cdns-proxy-${md5Origin[0]}.dzcdn.net/mobile/1/${hexResult}`;
}

// ── Blowfish P-array and S-boxes (standard Blowfish constants) ───────────────
const DZ_BF_P = [0x243f6a88,0x85a308d3,0x13198a2e,0x03707344,0xa4093822,0x299f31d0,0x082efa98,0xec4e6c89,0x452821e6,0x38d01377,0xbe5466cf,0x34e90c6c,0xc0ac29b7,0xc97c50dd,0x3f84d5b5,0xb5470917,0x9216d5d9,0x8979fb1b];
const DZ_BF_S0 = [
  0xd1310ba6, 0x98dfb5ac, 0x2ffd72db, 0xd01adfb7, 0xb8e1afed, 0x6a267e96, 0xba7c9045, 0xf12c7f99,
  0x24a19947, 0xb3916cf7, 0x0801f2e2, 0x858efc16, 0x636920d8, 0x71574e69, 0xa458fea3, 0xf4933d7e,
  0x0d95748f, 0x728eb658, 0x718bcd58, 0x82154aee, 0x7b54a41d, 0xc25a59b5, 0x9c30d539, 0x2af26013,
  0xc5d1b023, 0x286085f0, 0xca417918, 0xb8db38ef, 0x8e79dcb0, 0x603a180e, 0x6c9e0e8b, 0xb01e8a3e,
  0xd71577c1, 0xbd314b27, 0x78af2fda, 0x55605c60, 0xe65525f3, 0xaa55ab94, 0x57489862, 0x63e81440,
  0x55ca396a, 0x2aab10b6, 0xb4cc5c34, 0x1141e8ce, 0xa15486af, 0x7c72e993, 0xb3ee1411, 0x636fbc2a,
  0x2ba9c55d, 0x741831f6, 0xce5c3e16, 0x9b87931e, 0xafd6ba33, 0x6c24cf5c, 0x7a325381, 0x28958677,
  0x3b8f4898, 0x6b4bb9af, 0xc4bfe81b, 0x66282193, 0x61d809cc, 0xfb21a991, 0x487cac60, 0x5dec8032,
  0xef845d5d, 0xe98575b1, 0xdc262302, 0xeb651b88, 0x23893e81, 0xd396acc5, 0x0f6d6ff3, 0x83f44239,
  0x2e0b4482, 0xa4842004, 0x69c8f04a, 0x9e1f9b5e, 0x21c66842, 0xf6e96c9a, 0x670c9c61, 0xabd388f0,
  0x6a51a0d2, 0xd8542f68, 0x960fa728, 0xab5133a3, 0x6eef0b6c, 0x137a3be4, 0xba3bf050, 0x7efb2a98,
  0xa1f1651d, 0x39af0176, 0x66ca593e, 0x82430e88, 0x8cee8619, 0x456f9fb4, 0x7d84a5c3, 0x3b8b5ebe,
  0xe06f75d8, 0x85c12073, 0x401a449f, 0x56c16aa6, 0x4ed3aa62, 0x363f7706, 0x1bfedf72, 0x429b023d,
  0x37d0d724, 0xd00a1248, 0xdb0fead3, 0x49f1c09b, 0x075372c9, 0x80991b7b, 0x25d479d8, 0xf6e8def7,
  0xe3fe501a, 0xb6794c3b, 0x976ce0bd, 0x04c006ba, 0xc1a94fb6, 0x409f60c4, 0x5e5c9ec2, 0x196a2463,
  0x68fb6faf, 0x3e6c53b5, 0x1339b2eb, 0x3b52ec6f, 0x6dfc511f, 0x9b30952c, 0xcc814544, 0xaf5ebd09,
  0xbee3d004, 0xde334afd, 0x660f2807, 0x192e4bb3, 0xc0cba857, 0x45c8740f, 0xd20b5f39, 0xb9d3fbdb,
  0x5579c0bd, 0x1a60320a, 0xd6a100c6, 0x402c7279, 0x679f25fe, 0xfb1fa3cc, 0x8ea5e9f8, 0xdb3222f8,
  0x3c7516df, 0xfd616b15, 0x2f501ec8, 0xad0552ab, 0x323db5fa, 0xfd238760, 0x53317b48, 0x3e00df82,
  0x9e5c57bb, 0xca6f8ca0, 0x1a87562e, 0xdf1769db, 0xd542a8f6, 0x287effc3, 0xac6732c6, 0x8c4f5573,
  0x695b27b0, 0xbbca58c8, 0xe1ffa35d, 0xb8f011a0, 0x10fa3d98, 0xfd2183b8, 0x4afcb56c, 0x2dd1d35b,
  0x9a53e479, 0xb6f84565, 0xd28e49bc, 0x4bfb9790, 0xe1ddf2da, 0xa4cb7e33, 0x62fb1341, 0xcee4c6e8,
  0xef20cada, 0x36774c01, 0xd07e9efe, 0x2bf11fb4, 0x95dbda4d, 0xae909198, 0xeaad8e71, 0x6b93d5a0,
  0xd08ed1d0, 0xafc725e0, 0x8e3c5b2f, 0x8e7594b7, 0x8ff6e2fb, 0xf2122b64, 0x8888b812, 0x900df01c,
  0x4fad5ea0, 0x688fc31c, 0xd1cff191, 0xb3a8c1ad, 0x2f2f2218, 0xbe0e1777, 0xea752dfe, 0x8b021fa1,
  0xe5a0cc0f, 0xb56f74e8, 0x18acf3d6, 0xce89e299, 0xb4a84fe0, 0xfd13e0b7, 0x7cc43b81, 0xd2ada8d9,
  0x165fa266, 0x80957705, 0x93cc7314, 0x211a1477, 0xe6ad2065, 0x77b5fa86, 0xc75442f5, 0xfb9d35cf,
  0xebcdaf0c, 0x7b3e89a0, 0xd6411bd3, 0xae1e7e49, 0x00250e2d, 0x2071b35e, 0x226800bb, 0x57b8e0af,
  0x2464369b, 0xf009b91e, 0x5563911d, 0x59dfa6aa, 0x78c14389, 0xd95a537f, 0x207d5ba2, 0x02e5b9c5,
  0x83260376, 0x6295cfa9, 0x11c81968, 0x4e734a41, 0xb3472dca, 0x7b14a94a, 0x1b510052, 0x9a532915,
  0xd60f573f, 0xbc9bc6e4, 0x2b60a476, 0x81e67400, 0x08ba6fb5, 0x571be91f, 0xf296ec6b, 0x2a0dd915,
  0xb6636521, 0xe7b9f9b6, 0xff34052e, 0xc5855664, 0x53b02d5d, 0xa99f8fa1, 0x08ba4799, 0x6e85076a
];
const DZ_BF_S1 = [
  0x4b7a70e9, 0xb5b32944, 0xdb75092e, 0xc4192623, 0xad6ea6b0, 0x49a7df7d, 0x9cee60b8, 0x8fedb266,
  0xecaa8c71, 0x699a17ff, 0x5664526c, 0xc2b19ee1, 0x193602a5, 0x75094c29, 0xa0591340, 0xe4183a3e,
  0x3f54989a, 0x5b429d65, 0x6b8fe4d6, 0x99f73fd6, 0xa1d29c07, 0xefe830f5, 0x4d2d38e6, 0xf0255dc1,
  0x4cdd2086, 0x8470eb26, 0x6382e9c6, 0x021ecc5e, 0x09686b3f, 0x3ebaefc9, 0x3c971814, 0x6b6a70a1,
  0x687f3584, 0x52a0e286, 0xb79c5305, 0xaa500737, 0x3e07841c, 0x7fdeae5c, 0x8e7d44ec, 0x5716f2b8,
  0xb03ada37, 0xf0500c0d, 0xf01c1f04, 0x0200b3ff, 0xae0cf51a, 0x3cb574b2, 0x25837a58, 0xdc0921bd,
  0xd19113f9, 0x7ca92ff6, 0x94324773, 0x22f54701, 0x3ae5e581, 0x37c2dadc, 0xc8b57634, 0x9af3dda7,
  0xa9446146, 0x0fd0030e, 0xecc8c73e, 0xa4751e41, 0xe238cd99, 0x3bea0e2f, 0x3280bba1, 0x183eb331,
  0x4e548b38, 0x4f6db908, 0x6f420d03, 0xf60a04bf, 0x2cb81290, 0x24977c79, 0x5679b072, 0xbcaf89af,
  0xde9a771f, 0xd9930810, 0xb38bae12, 0xdccf3f2e, 0x5512721f, 0x2e6b7124, 0x501adde6, 0x9f84cd87,
  0x7a584718, 0x7408da17, 0xbc9f9abc, 0xe94b7d8c, 0xec7aec3a, 0xdb851dfa, 0x63094366, 0xc464c3d2,
  0xef1c1847, 0x3215d908, 0xdd433b37, 0x24c2ba16, 0x12a14d43, 0x2a65c451, 0x50940002, 0x133ae4dd,
  0x71dff89e, 0x10314e55, 0x81ac77d6, 0x5f11199b, 0x043556f1, 0xd7a3c76b, 0x3c11183b, 0x5924a509,
  0xf28fe6ed, 0x97f1fbfa, 0x9ebabf2c, 0x1e153c6e, 0x86e34570, 0xeae96fb1, 0x860e5e0a, 0x5a3e2ab3,
  0x771fe71c, 0x4e3d06fa, 0x2965dcb9, 0x99e71d0f, 0x803e89d6, 0x5266c825, 0x2e4cc978, 0x9c10b36a,
  0xc6150eba, 0x94e2ea78, 0xa5fc3c53, 0x1e0a2df4, 0xf2f74ea7, 0x361d2b3d, 0x1939260f, 0x19c27960,
  0x5223a708, 0xf71312b6, 0xebadfe6e, 0xeac31f66, 0xe3bc4595, 0xa67bc883, 0xb17f37d1, 0x018cff28,
  0xc332ddef, 0xbe6c5aa5, 0x65582185, 0x68ab9802, 0xeecea50f, 0xdb2f953b, 0x2aef7dad, 0x5b6e2f84,
  0x1521b628, 0x29076170, 0xecdd4775, 0x619f1510, 0x13cca830, 0xeb61bd96, 0x0334fe1e, 0xaa0363cf,
  0xb5735c90, 0x4c70a239, 0xd59e9e0b, 0xcbaade14, 0xeecc86bc, 0x60622ca7, 0x9cab5cab, 0xb2f3846e,
  0x648b1eaf, 0x19bdf0ca, 0xa02369b9, 0x655abb50, 0x40685a32, 0x3c2ab4b3, 0x319ee9d5, 0xc021b8f7,
  0x9b540b19, 0x875fa099, 0x95f7997e, 0x623d7da8, 0xf837889a, 0x97e32d77, 0x11ed935f, 0x16681281,
  0x0e358829, 0xc7e61fd6, 0x96dedfa1, 0x7858ba99, 0x57f584a5, 0x1b227263, 0x9b83c3ff, 0x1ac24696,
  0xcdb30aeb, 0x532e3054, 0x8fd948e4, 0x6dbc3128, 0x58ebf2ef, 0x34c6ffea, 0xfe28ed61, 0xee7c3c73,
  0x5d4a14d9, 0xe864b7e3, 0x42105d14, 0x203e13e0, 0x45eee2b6, 0xa3aaabea, 0xdb6c4f15, 0xfacb4fd0,
  0xc742f442, 0xef6abbb5, 0x654f3b1d, 0x41cd2105, 0xd81e799e, 0x86854dc7, 0xe44b476a, 0x3d816250,
  0xcf62a1f2, 0x5b8d2646, 0xfc8883a0, 0xc1c7b6a3, 0x7f1524c3, 0x69cb7492, 0x47848a0b, 0x5692b285,
  0x095bbf00, 0xad19489d, 0x1462b174, 0x23820e00, 0x58428d2a, 0x0c55f5ea, 0x1dadf43e, 0x233f7061,
  0x3372f092, 0x8d937e41, 0xd65fecf1, 0x6c223bdb, 0x7cde3759, 0xcbee7460, 0x4085f2a7, 0xce77326e,
  0xa6078084, 0x19f8509e, 0xe8efd855, 0x61d99735, 0xa969a7aa, 0xc50c06c2, 0x5a04abfc, 0x800bcadc,
  0x9e447a2e, 0xc3453484, 0xfdd56705, 0x0e1e9ec9, 0xdb73dbd3, 0x105588cd, 0x675fda79, 0xe3674340,
  0xc5c43465, 0x713e38d8, 0x3d28f89e, 0xf16dff20, 0x153e21e7, 0x8fb03d4a, 0xe6e39f2b, 0xdb83adf7
];
const DZ_BF_S2 = [
  0xe93d5a68, 0x948140f7, 0xf64c261c, 0x94692934, 0x411520f7, 0x7602d4f7, 0xbcf46b2e, 0xd4a20068,
  0xd4082471, 0x3320f46a, 0x43b7d4b7, 0x500061af, 0x1e39f62e, 0x97244546, 0x14214f74, 0xbf8b8840,
  0x4d95fc1d, 0x96b591af, 0x70f4ddd3, 0x66a02f45, 0xbfbc09ec, 0x03bd9785, 0x7fac6dd0, 0x31cb8504,
  0x96eb27b3, 0x55fd3941, 0xda2547e6, 0xabca0a9a, 0x28507825, 0x530429f4, 0x0a2c86da, 0xe9b66dfb,
  0x68dc1462, 0xd7486900, 0x680ec0a4, 0x27a18dee, 0x4f3ffea2, 0xe887ad8c, 0xb58ce006, 0x7af4d6b6,
  0xaace1e7c, 0xd3375fec, 0xce78a399, 0x406b2a42, 0x20fe9e35, 0xd9f385b9, 0xee39d7ab, 0x3b124e8b,
  0x1dc9faf7, 0x4b6d1856, 0x26a36631, 0xeae397b2, 0x3a6efa74, 0xdd5b4332, 0x6841e7f7, 0xca7820fb,
  0xfb0af54e, 0xd8feb397, 0x454056ac, 0xba489527, 0x55533a3a, 0x20838d87, 0xfe6ba9b7, 0xd096954b,
  0x55a867bc, 0xa1159a58, 0xcca92963, 0x99e1db33, 0xa62a4a56, 0x3f3125f9, 0x5ef47e1c, 0x9029317c,
  0xfdf8e802, 0x04272f70, 0x80bb155c, 0x05282ce3, 0x95c11548, 0xe4c66d22, 0x48c1133f, 0xc70f86dc,
  0x07f9c9ee, 0x41041f0f, 0x404779a4, 0x5d886e17, 0x325f51eb, 0xd59bc0d1, 0xf2bcc18f, 0x41113564,
  0x257b7834, 0x602a9c60, 0xdff8e8a3, 0x1f636c1b, 0x0e12b4c2, 0x02e1329e, 0xaf664fd1, 0xcad18115,
  0x6b2395e0, 0x333e92e1, 0x3b240b62, 0xeebeb922, 0x85b2a20e, 0xe6ba0d99, 0xde720c8c, 0x2da2f728,
  0xd0127845, 0x95b794fd, 0x647d0862, 0xe7ccf5f0, 0x5449a36f, 0x877d48fa, 0xc39dfd27, 0xf33e8d1e,
  0x0a476341, 0x992eff74, 0x3a6f6eab, 0xf4f8fd37, 0xa812dc60, 0xa1ebddf8, 0x991be14c, 0xdb6e6b0d,
  0xc67b5510, 0x6d672c37, 0x2765d43b, 0xdcd0e804, 0xf1290dc7, 0xcc00ffa3, 0xb5390f92, 0x690fed0b,
  0x667b9ffb, 0xcedb7d9c, 0xa091cf0b, 0xd9155ea3, 0xbb132f88, 0x515bad24, 0x7b9479bf, 0x763bd6eb,
  0x37392eb3, 0xcc115979, 0x8026e297, 0xf42e312d, 0x6842ada7, 0xc66a2b3b, 0x12754ccc, 0x782ef11c,
  0x6a124237, 0xb79251e7, 0x06a1bbe6, 0x4bfb6350, 0x1a6b1018, 0x11caedfa, 0x3d25bdd8, 0xe2e1c3c9,
  0x44421659, 0x0a121386, 0xd90cec6e, 0xd5abea2a, 0x64af674e, 0xda86a85f, 0xbebfe988, 0x64e4c3fe,
  0x9dbc8057, 0xf0f7c086, 0x60787bf8, 0x6003604d, 0xd1fd8346, 0xf6381fb0, 0x7745ae04, 0xd736fccc,
  0x83426b33, 0xf01eab71, 0xb0804187, 0x3c005e5f, 0x77a057be, 0xbde8ae24, 0x55464299, 0xbf582e61,
  0x4e58f48f, 0xf2ddfda2, 0xf474ef38, 0x8789bdc2, 0x5366f9c3, 0xc8b38e74, 0xb475f255, 0x46fcd9b9,
  0x7aeb2661, 0x8b1ddf84, 0x846a0e79, 0x915f95e2, 0x466e598e, 0x20b45770, 0x8cd55591, 0xc902de4c,
  0xb90bace1, 0xbb8205d0, 0x11a86248, 0x7574a99e, 0xb77f19b6, 0xe0a9dc09, 0x662d09a1, 0xc4324633,
  0xe85a1f02, 0x09f0be8c, 0x4a99a025, 0x1d6efe10, 0x1ab93d1d, 0x0ba5a4df, 0xa186f20f, 0x2868f169,
  0xdcb7da83, 0x573906fe, 0xa1e2ce9b, 0x4fcd7f52, 0x50115e01, 0xa70683fa, 0xa002b5c4, 0x0de6d027,
  0x9af88c27, 0x773f8641, 0xc3604c06, 0x61a806b5, 0xf0177a28, 0xc0f586e0, 0x006058aa, 0x30dc7d62,
  0x11e69ed7, 0x2338ea63, 0x53c2dd94, 0xc2c21634, 0xbbcbee56, 0x90bcb6de, 0xebfc7da1, 0xce591d76,
  0x6f05e409, 0x4b7c0188, 0x39720a3d, 0x7c927c24, 0x86e3725f, 0x724d9db9, 0x1ac15bb4, 0xd39eb8fc,
  0xed545578, 0x08fca5b5, 0xd83d7cd3, 0x4dad0fc4, 0x1e50ef5e, 0xb161e6f8, 0xa28514d9, 0x6c51133c,
  0x6fd5c7e7, 0x56e14ec4, 0x362abfce, 0xddc6c837, 0xd79a3234, 0x92638212, 0x670efa8e, 0x406000e0
];
const DZ_BF_S3 = [
  0x3a39ce37, 0xd3faf5cf, 0xabc27737, 0x5ac52d1b, 0x5cb0679e, 0x4fa33742, 0xd3822740, 0x99bc9bbe,
  0xd5118e9d, 0xbf0f7315, 0xd62d1c7e, 0xc700c47b, 0xb78c1b6b, 0x21a19045, 0xb26eb1be, 0x6a366eb4,
  0x5748ab2f, 0xbc946e79, 0xc6a376d2, 0x6549c2c8, 0x530ff8ee, 0x468dde7d, 0xd5730a1d, 0x4cd04dc6,
  0x2939bbdb, 0xa9ba4650, 0xac9526e8, 0xbe5ee304, 0xa1fad5f0, 0x6a2d519a, 0x63ef8ce2, 0x9a86ee22,
  0xc089c2b8, 0x43242ef6, 0xa51e03aa, 0x9cf2d0a4, 0x83c061ba, 0x9be96a4d, 0x8fe51550, 0xba645bd6,
  0x2826a2f9, 0xa73a3ae1, 0x4ba99586, 0xef5562e9, 0xc72fefd3, 0xf752f7da, 0x3f046f69, 0x77fa0a59,
  0x80e4a915, 0x87b08601, 0x9b09e6ad, 0x3b3ee593, 0xe990fd5a, 0x9e34d797, 0x2cf0b7d9, 0x022b8b51,
  0x96d5ac3a, 0x017da67d, 0xd1cf3ed6, 0x7c7d2d28, 0x1f9f25cf, 0xadf2b89b, 0x5ad6b472, 0x5a88f54c,
  0xe029ac71, 0xe019a5e6, 0x47b0acfd, 0xed93fa9b, 0xe8d3c48d, 0x283b57cc, 0xf8d56629, 0x79132e28,
  0x785f0191, 0xed756055, 0xf7960e44, 0xe3d35e8c, 0x15056dd4, 0x88f46dba, 0x03a16125, 0x0564f0bd,
  0xc3eb9e15, 0x3c9057a2, 0x97271aec, 0xa93a072a, 0x1b3f6d9b, 0x1e6321f5, 0xf59c66fb, 0x26dcf319,
  0x7533d928, 0xb155fdf5, 0x03563482, 0x8aba3cbb, 0x28517711, 0xc20ad9f8, 0xabcc5167, 0xccad925f,
  0x4de81751, 0x3830dc8e, 0x379d5862, 0x9320f991, 0xea7a90c2, 0xfb3e7bce, 0x5121ce64, 0x774fbe32,
  0xa8b6e37e, 0xc3293d46, 0x48de5369, 0x6413e680, 0xa2ae0810, 0xdd6db224, 0x69852dfd, 0x09072166,
  0xb39a460a, 0x6445c0dd, 0x586cdecf, 0x1c20c8ae, 0x5bbef7dd, 0x1b588d40, 0xccd2017f, 0x6bb4e3bb,
  0xdda26a7e, 0x3a59ff45, 0x3e350a44, 0xbcb4cdd5, 0x72eacea8, 0xfa6484bb, 0x8d6612ae, 0xbf3c6f47,
  0xd29be463, 0x542f5d9e, 0xaec2771b, 0xf64e6370, 0x740e0d8d, 0xe75b1357, 0xf8721671, 0xaf537d5d,
  0x4040cb08, 0x4eb4e2cc, 0x34d2466a, 0x0115af84, 0xe1b00428, 0x95983a1d, 0x06b89fb4, 0xce6ea048,
  0x6f3f3b82, 0x3520ab82, 0x011a1d4b, 0x277227f8, 0x611560b1, 0xe7933fdc, 0xbb3a792b, 0x344525bd,
  0xa08839e1, 0x51ce794b, 0x2f32c9b7, 0xa01fbac9, 0xe01cc87e, 0xbcc7d1f6, 0xcf0111c3, 0xa1e8aac7,
  0x1a908749, 0xd44fbd9a, 0xd0dadecb, 0xd50ada38, 0x0339c32a, 0xc6913667, 0x8df9317c, 0xe0b12b4f,
  0xf79e59b7, 0x43f5bb3a, 0xf2d519ff, 0x27d9459c, 0xbf97222c, 0x15e6fc2a, 0x0f91fc71, 0x9b941525,
  0xfae59361, 0xceb69ceb, 0xc2a86459, 0x12baa8d1, 0xb6c1075e, 0xe3056a0c, 0x10d25065, 0xcb03a442,
  0xe0ec6e0e, 0x1698db3b, 0x4c98a0be, 0x3278e964, 0x9f1f9532, 0xe0d392df, 0xd3a0342b, 0x8971f21e,
  0x1b0a7441, 0x4ba3348c, 0xc5be7120, 0xc37632d8, 0xdf359f8d, 0x9b992f2e, 0xe60b6f47, 0x0fe3f11d,
  0xe54cda54, 0x1edad891, 0xce6279cf, 0xcd3e7e6f, 0x1618b166, 0xfd2c1d05, 0x848fd2c5, 0xf6fb2299,
  0xf523f357, 0xa6327623, 0x93a83531, 0x56cccd02, 0xacf08162, 0x5a75ebb5, 0x6e163697, 0x88d273cc,
  0xde966292, 0x81b949d0, 0x4c50901b, 0x71c65614, 0xe6c6c7bd, 0x327a140a, 0x45e1d006, 0xc3f27b9a,
  0xc9aa53fd, 0x62a80f00, 0xbb25bfe2, 0x35bdd2f6, 0x71126905, 0xb2040222, 0xb6cbcf7c, 0xcd769c2b,
  0x53113ec0, 0x1640e3d3, 0x38abbd60, 0x2547adf0, 0xba38209c, 0xf746ce76, 0x77afa1c5, 0x20756060,
  0x85cbfe4e, 0x8ae88dd8, 0x7aaaf9b0, 0x4cf9aa7e, 0x1948c25c, 0x02fb8a8c, 0x01c36ae4, 0xd6ebe1f9,
  0x90d4f869, 0xa65cdea0, 0x3f09252d, 0xc208e69f, 0xb74e6132, 0xce77e25b, 0x578fdfe3, 0x3ac372e6
];

// ── Blowfish encrypt/decrypt/F primitives ─────────────────────────────────────
function dzBfEncrypt(l, r, P, S) {
  l = l >>> 0; r = r >>> 0;
  for (let i = 0; i < 16; i++) {
    l = (l ^ P[i]) >>> 0;
    r = (r ^ dzBfF(l, S)) >>> 0;
    [l, r] = [r, l];
  }
  [l, r] = [r, l];
  r = (r ^ P[16]) >>> 0;
  l = (l ^ P[17]) >>> 0;
  return [l >>> 0, r >>> 0];
}
function dzBfDecrypt(l, r, P, S) {
  l = l >>> 0; r = r >>> 0;
  for (let i = 17; i > 1; i--) {
    l = (l ^ P[i]) >>> 0;
    r = (r ^ dzBfF(l, S)) >>> 0;
    [l, r] = [r, l];
  }
  [l, r] = [r, l];
  r = (r ^ P[1]) >>> 0;
  l = (l ^ P[0]) >>> 0;
  return [l >>> 0, r >>> 0];
}
function dzBfF(x, S) {
  const a=(x>>>24)&0xff, b=(x>>>16)&0xff, c=(x>>>8)&0xff, d=x&0xff;
  return (((S[0][a]+S[1][b])>>>0)^S[2][c])+S[3][d]>>>0;
}

// ── BF key expansion cache — expanded keys are reused across requests ────────
const _DZ_BF_EXPANDED = new Map();

// ── Expand BF key SYNCHRONOUSLY (no yields) — ~0.3ms on V8, safe for CF ────
// Yields were added to stay under a 10ms CPU budget, but they add 50-200ms of
// latency before the first audio byte. Expansion is fast enough without them.
function dzBfExpandKeySync(keyStr) {
  const cached = _DZ_BF_EXPANDED.get(keyStr);
  if (cached) return cached;
  const keyBytes = new Uint8Array(keyStr.length);
  for (let i = 0; i < keyStr.length; i++) keyBytes[i] = keyStr.charCodeAt(i);
  const P = DZ_BF_P.slice();
  const S = [DZ_BF_S0.slice(), DZ_BF_S1.slice(), DZ_BF_S2.slice(), DZ_BF_S3.slice()];
  for (let i = 0; i < 18; i++) {
    let word = 0;
    for (let j = 0; j < 4; j++) word = ((word << 8) | keyBytes[(i * 4 + j) % keyBytes.length]) >>> 0;
    P[i] = (P[i] ^ word) >>> 0;
  }
  let l = 0, r = 0;
  for (let i = 0; i < 18; i += 2) { [l, r] = dzBfEncrypt(l, r, P, S); P[i] = l; P[i+1] = r; }
  for (let b = 0; b < 4; b++) {
    for (let i = 0; i < 256; i += 2) {
      [l, r] = dzBfEncrypt(l, r, P, S); S[b][i] = l; S[b][i+1] = r;
    }
  }
  const result = { P, S };
  _DZ_BF_EXPANDED.set(keyStr, result);
  if (_DZ_BF_EXPANDED.size > 500) { _DZ_BF_EXPANDED.delete(_DZ_BF_EXPANDED.keys().next().value); }
  return result;
}
async function dzBfExpandKey(keyStr) { return dzBfExpandKeySync(keyStr); }

// ── Fast BF-CBC decrypt using pre-expanded {P,S} — IV=[0,1,2,3,4,5,6,7] ─────
function dzBfDecryptBlockFast(data, { P, S }) {
  const out = new Uint8Array(data.length);
  let prevL = 0x00010203 >>> 0, prevR = 0x04050607 >>> 0;
  for (let i = 0; i < data.length; i += 8) {
    let cl = ((data[i]<<24)|(data[i+1]<<16)|(data[i+2]<<8)|data[i+3]) >>> 0;
    let cr = ((data[i+4]<<24)|(data[i+5]<<16)|(data[i+6]<<8)|data[i+7]) >>> 0;
    const origL = cl, origR = cr;
    [cl, cr] = dzBfDecrypt(cl, cr, P, S);
    cl = (cl ^ prevL) >>> 0; cr = (cr ^ prevR) >>> 0;
    prevL = origL; prevR = origR;
    out[i]=(cl>>>24)&0xff; out[i+1]=(cl>>>16)&0xff; out[i+2]=(cl>>>8)&0xff; out[i+3]=cl&0xff;
    out[i+4]=(cr>>>24)&0xff; out[i+5]=(cr>>>16)&0xff; out[i+6]=(cr>>>8)&0xff; out[i+7]=cr&0xff;
  }
  return out;
}


// ── Deezer session cache (in-memory, keyed by first 16 chars of ARL) ──────────
const _dzSessionCache = new Map();
function _dzSessionGet(arlKey) {
  const v = _dzSessionCache.get(arlKey);
  if (!v) return null;
  if (v.exp && v.exp < Date.now()) { _dzSessionCache.delete(arlKey); return null; }
  return v.data;
}
function _dzSessionSet(arlKey, data) {
  _dzSessionCache.set(arlKey, { data, exp: Date.now() + 55 * 60 * 1000 });
}

// ── Deezer stream-URL cache (in-memory, keyed by numeric trackId) ─────────────
const _dzStreamCache = new Map();
function _dzStreamGet(trackId) {
  const v = _dzStreamCache.get(String(trackId));
  if (!v) return null;
  if (v.exp && v.exp < Date.now()) { _dzStreamCache.delete(String(trackId)); return null; }
  return v.data;
}
function _dzStreamSet(trackId, data) {
  const ttl = data?.expiresAt ? Math.max(60, Math.floor(data.expiresAt - Date.now() / 1000)) : 1500;
  _dzStreamCache.set(String(trackId), { data, exp: Date.now() + Math.min(ttl, 1500) * 1000 });
}

// ── Get premium stream info from Deezer private API ──────────────────────────
// Returns { url, cipher, blowfishKey, quality, expiresAt } or null
async function dzGetPremiumStreamInfo(trackId, arl, env) {
  try {
    const arlKey = arl.slice(0, 16);
    let session  = _dzSessionGet(arlKey);
    let sid, apiToken, licenseToken, userId;

    if (session) {
      ({ sid, apiToken, licenseToken, userId } = session);
    } else {
      sid          = await dzPing(arl);
      const userRaw = await dzGw('deezer.getUserData', {}, arl, sid, 'null');
      apiToken     = userRaw?.results?.checkForm || 'null';
      licenseToken = userRaw?.results?.USER?.OPTIONS?.license_token || null;
      userId       = userRaw?.results?.USER?.USER_ID || 0;
      if (userId && userId !== 0) {
        _dzSessionSet(arlKey, { sid, apiToken, licenseToken, userId });
      }
    }

    if (!userId || userId === 0) { console.warn('[deezer] ARL invalid or not logged in'); return null; }

    // Check Upstash cache first (shared across all CF isolates)
    const redisCacheKey = `dz:stream:${trackId}`;
    try {
      const cached = await upstashCmd(env, 'GET', redisCacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed?.url) return { ...parsed, expandedBf: null };
      }
    } catch {}

    const [listRaw, singleRaw] = await Promise.all([
      dzGw('song.getListData', { sng_ids: [String(trackId)] }, arl, sid, apiToken),
      dzGw('song.getData', { SNG_ID: String(trackId) }, arl, sid, apiToken),
    ]);
    let song = listRaw?.results?.data?.[0];
    if (!song?.TRACK_TOKEN || !song?.MD5_ORIGIN) {
      const fromSingle = singleRaw?.results;
      if (fromSingle?.MD5_ORIGIN) song = fromSingle;
    }
    if (!song?.MD5_ORIGIN) return null;

    const { MD5_ORIGIN, MEDIA_VERSION, SNG_ID, TRACK_TOKEN } = song;
    const trackIsrc = song.ISRC ? String(song.ISRC).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
    const blowfishKey = dzGetBlowfishKey(String(SNG_ID || trackId));
    let streamUrl = null, streamCipher = 'BF_CBC_STRIPE', quality = '320kbps';

    // Try media.deezer.com first (best quality, cipher info included)
    if (TRACK_TOKEN && licenseToken) {
      try {
        const mediaRes = await fetch('https://media.deezer.com/v1/get_url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
            'Cookie': `arl=${arl}; sid=${sid || ''}`,
            'Origin': 'https://www.deezer.com',
            'Referer': 'https://www.deezer.com/',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          body: JSON.stringify({
            license_token: licenseToken,
            media: [
              { type: 'FULL', formats: [{ cipher: 'BF_CBC_STRIPE', format: 'FLAC'    }] },
              { type: 'FULL', formats: [{ cipher: 'BF_CBC_STRIPE', format: 'MP3_320' }] },
              { type: 'FULL', formats: [{ cipher: 'NONE',          format: 'MP3_320' }] },
              { type: 'FULL', formats: [{ cipher: 'NONE',          format: 'FLAC'    }] },
              { type: 'FULL', formats: [{ cipher: 'BF_CBC_STRIPE', format: 'MP3_128' }] },
              { type: 'FULL', formats: [{ cipher: 'NONE',          format: 'MP3_128' }] },
            ],
            track_tokens: [TRACK_TOKEN],
          }),
        });
        const mediaData  = await mediaRes.json();
        const mediaItems = mediaData?.data?.[0]?.media || [];
        for (const item of mediaItems) {
          const s = item?.sources?.[0]?.url;
          if (s) {
            streamUrl    = s;
            streamCipher = item?.cipher?.type || 'BF_CBC_STRIPE';
            const fmt    = item.format || 'MP3_320';
            quality      = fmt.includes('FLAC') ? 'flac' : fmt.includes('128') ? '128kbps' : '320kbps';
            break;
          }
        }
      } catch (e) { console.warn('[deezer] media.deezer.com error:', e.message); }
    }

    // CDN URL reconstruction fallback (320 first — most reliable, then FLAC, then 128)
    if (!streamUrl && MD5_ORIGIN && MEDIA_VERSION) {
      const sngId = String(SNG_ID || trackId);
      try {
        streamUrl    = await dzBuildCDNUrl(MD5_ORIGIN, MEDIA_VERSION, sngId, '3');
        streamCipher = 'BF_CBC_STRIPE';
        quality      = '320kbps';
      } catch (e2) {
        console.warn('[deezer] CDN 320 fallback failed:', e2.message);
        try {
          streamUrl    = await dzBuildCDNUrl(MD5_ORIGIN, MEDIA_VERSION, sngId, '9');
          streamCipher = 'BF_CBC_STRIPE';
          quality      = 'flac';
        } catch (e3) {
          try {
            streamUrl    = await dzBuildCDNUrl(MD5_ORIGIN, MEDIA_VERSION, sngId, '1');
            streamCipher = 'BF_CBC_STRIPE';
            quality      = '128kbps';
          } catch (e4) { console.error('[deezer] All CDN fallbacks failed:', e4.message); }
        }
      }
    }

    if (!streamUrl) { console.warn('[deezer] No stream URL for track', trackId); return null; }

    // Pre-expand BF key immediately so /dz-proxy hits the expansion cache instantly
    if (streamCipher === 'BF_CBC_STRIPE' && blowfishKey) dzBfExpandKeySync(blowfishKey);

    // Cache in Upstash (4min TTL)
    try {
      await upstashCmd(env, 'SET', redisCacheKey, JSON.stringify({ url: streamUrl, cipher: streamCipher, blowfishKey, quality, isrc: trackIsrc }), 'EX', 240);
    } catch {}

    const expiresAt = Date.now() + 240_000;
    return { url: streamUrl, cipher: streamCipher, blowfishKey, quality, expiresAt, isrc: trackIsrc };
  } catch (e) {
    console.error('[deezer] getPremiumStreamInfo fatal:', e.message);
    return null;
  }
}

// ── deezerSearch — public Deezer API (no ARL needed) ─────────────────────────
async function deezerSearch(query) {
  if (!query) return { tracks: [], albums: [], artists: [], playlists: [] };
  const cacheKey = `dz:search:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const [trackRes, albumRes, artistRes, playlistRes] = await Promise.allSettled([
      axios.get(`${DEEZER_API}/search`,          { params: { q: query, limit: 25, output: 'json' }, headers: { 'User-Agent': UA }, timeout: 8000 }),
      axios.get(`${DEEZER_API}/search/album`,    { params: { q: query, limit: 8  }, headers: { 'User-Agent': UA }, timeout: 8000 }),
      axios.get(`${DEEZER_API}/search/artist`,   { params: { q: query, limit: 6  }, headers: { 'User-Agent': UA }, timeout: 8000 }),
      axios.get(`${DEEZER_API}/search/playlist`, { params: { q: query, limit: 4  }, headers: { 'User-Agent': UA }, timeout: 8000 }),
    ]);
    const rawTracks    = trackRes.status    === 'fulfilled' ? (trackRes.value.data?.data    || []) : [];
    // Sort Deezer explicit tracks first to prefer unfiltered versions
    rawTracks.sort((a, b) => (b.explicit_lyrics || 0) - (a.explicit_lyrics || 0));
    const rawAlbums    = albumRes.status    === 'fulfilled' ? (albumRes.value.data?.data    || []) : [];
    const rawArtists   = artistRes.status   === 'fulfilled' ? (artistRes.value.data?.data   || []) : [];
    const rawPlaylists = playlistRes.status === 'fulfilled' ? (playlistRes.value.data?.data || []) : [];
    const tracks = rawTracks.slice(0, 25).map(t => ({
      id: `deezer:${t.id}`, title: t.title || 'Unknown', artist: t.artist?.name || 'Unknown',
      album: t.album?.title || '', duration: t.duration || undefined,
      artworkURL: t.album?.cover_xl || t.album?.cover_big || t.album?.cover || null,
      format: 'mp3', source: 'deezer',
      isrc: t.isrc ? String(t.isrc).toUpperCase().replace(/[^A-Z0-9]/g, '') : null,
    }));
    const albums = rawAlbums.slice(0, 8).map(a => ({
      id: `deezer:album:${a.id}`, title: a.title || 'Unknown Album', artist: a.artist?.name || 'Unknown',
      artworkURL: a.cover_xl || a.cover_big || a.cover || null, year: safeYear(a.release_date), source: 'deezer',
    }));
    const artists = rawArtists.slice(0, 6).map(a => ({
      id: `deezer:artist:${a.id}`, name: a.name || 'Unknown Artist',
      artworkURL: a.picture_xl || a.picture_big || a.picture || null, source: 'deezer',
    }));
    const playlists = rawPlaylists.slice(0, 4).map(p => ({
      id: `deezer:playlist:${p.id}`, title: p.title || 'Unknown Playlist',
      artist: p.user?.name || 'Deezer',
      artworkURL: p.picture_xl || p.picture_big || p.picture || null,
      trackCount: p.nb_tracks || undefined, source: 'deezer',
    }));
    // Album-track fallback:
    // Deezer's /search endpoint sometimes misses tracks that exist on indexed albums
    // (common for regional/independent artists like Gulfateh Khan).
    // Strategy:
    //   1. Always fetch tracks from the top 3 matching albums in parallel.
    //   2. Score each album track against the query words.
    //   3. Any album track whose title shares ≥1 query word with the track portion
    //      of the query AND isn't already in rawTracks (deduped by Deezer ID) is
    //      appended — this way "First Love" surfaces even when /search returns
    //      other tracks (e.g. covers) but not the specific one.
    let finalTracks = [...tracks];
    if (rawAlbums.length > 0) {
      try {
        const seenDzIds = new Set(rawTracks.map(t => String(t.id)));
        const albumTrackFetches = rawAlbums.slice(0, 3).map(a =>
          axios.get(`${DEEZER_API}/album/${a.id}/tracks`, {
            params: { limit: 50 }, headers: { 'User-Agent': UA }, timeout: 4000
          })
            .then(r => (r.data?.data || []).map(t => ({
              ...t,
              _albumArtist: a.artist?.name || '',
              _albumTitle: a.title || '',
              _albumCover: a.cover_xl || a.cover_big || a.cover || null,
            })))
            .catch(() => [])
        );
        const albumTrackResults = await Promise.all(albumTrackFetches);

        // Extract the "track" portion of query — if it contains an artist name
        // (e.g. "first love gulfateh khan") strip the artist words so we match
        // only on the track title words.
        const qFull = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        const qWords = qFull.split(' ').filter(w => w.length > 2);

        const albumMatches = [];
        for (const tList of albumTrackResults) {
          for (const t of tList) {
            if (seenDzIds.has(String(t.id))) continue; // already in rawTracks
            const tNorm = (t.title || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
            if (!tNorm) continue;
            const tWords = tNorm.split(' ').filter(w => w.length > 1);
            // Score: how many query words hit the track title
            const hits = qWords.filter(w => tNorm.includes(w)).length;
            if (hits === 0) continue;
            // Prefer tracks where the title itself contains a query word
            // (not just the artist name from the album metadata)
            const titleHits = qWords.filter(w => tWords.some(tw => tw.includes(w) || w.includes(tw))).length;
            albumMatches.push({
              score: titleHits * 10 + hits,
              track: {
                id: `deezer:${t.id}`,
                title: t.title || 'Unknown',
                artist: t._albumArtist || t.artist?.name || 'Unknown',
                album: t._albumTitle || '',
                duration: t.duration || undefined,
                artworkURL: t._albumCover,
                format: 'mp3',
                source: 'deezer',
                // Carry ISRC so cross-source ISRC dedup fires — prevents same song
                // from appearing as both a HiFi result AND a Deezer album-fallback result.
                isrc: t.isrc ? String(t.isrc).toUpperCase().replace(/[^A-Z0-9]/g, '') : null,
              },
            });
            seenDzIds.add(String(t.id));
          }
        }
        // Sort best matches first, then prepend to finalTracks when rawTracks was
        // empty (pure fallback) or append when rawTracks already had results.
        albumMatches.sort((a, b) => b.score - a.score);
        const albumTrackList = albumMatches.map(m => m.track).slice(0, 10);
        if (finalTracks.length === 0) {
          finalTracks = albumTrackList; // pure fallback — album tracks are primary
        } else {
          finalTracks = [...finalTracks, ...albumTrackList]; // supplement existing results
        }
        finalTracks = finalTracks.slice(0, 25);
        if (albumTrackList.length > 0) {
          console.log(`[Deezer album-track fallback] +${albumTrackList.length} tracks for "${query}"`);
        }
      } catch(e) { console.warn('[Deezer album-track fallback]', e.message); }
    }
    // ── Deezer-internal dedup: same song can appear as both single & album version ──
    // ISRC-first, then title+artist+duration-bucket (±5s) as fallback.
    {
      const _dzSeenIsrc = new Set();
      const _dzSeenTa   = new Set();
      finalTracks = finalTracks.filter(t => {
        if (t.isrc) {
          const n = String(t.isrc).toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (_dzSeenIsrc.has(n)) return false;
          _dzSeenIsrc.add(n);
          return true;
        }
        const _dt = (t.title  || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
        const _da = (t.artist || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^(the|a|an)/, '').slice(0, 40);
        const _dd = t.duration && t.duration > 5 ? '|d' + (Math.round(t.duration / 5) * 5) : '';
        if (!_dt || !_da) return true;
        const _dk = _dt + '|' + _da + _dd;
        if (_dzSeenTa.has(_dk)) return false;
        _dzSeenTa.add(_dk);
        return true;
      });
    }
    const result = { tracks: finalTracks, albums, artists, playlists };
    await cacheSet(cacheKey, result, 300);
    return result;
  } catch (e) {
    console.warn('Deezer search error:', e.message);
    return { tracks: [], albums: [], artists: [], playlists: [] };
  }
}

// ── deezerFindByIsrc — exact ISRC lookup via Deezer public API ──────────────
async function deezerFindByIsrc(isrc) {
  if (!isrc) return null;
  const normIsrc = String(isrc).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normIsrc) return null;
  const cacheKey = `dzisrc:${normIsrc}`;
  const cached = await cacheGet(cacheKey);
  if (cached === 'MISS') return null;
  if (cached) return cached;
  try {
    const r = await axios.get(`${DEEZER_API}/search/track`, {
      params: { q: `isrc:${normIsrc}`, limit: 5 },
      headers: { 'User-Agent': UA },
      timeout: 6000,
    });
    const items = r.data?.data || [];
    const match = items.find(t =>
      t.isrc && String(t.isrc).toUpperCase().replace(/[^A-Z0-9]/g, '') === normIsrc
    );
    if (match) {
      const result = {
        id: `deezer:${match.id}`,
        numericId: String(match.id),
        title: match.title || 'Unknown',
        artist: match.artist?.name || 'Unknown',
        album: match.album?.title || '',
        duration: match.duration ?? undefined,
        artworkURL: match.album?.cover_xl || match.album?.cover_big || null,
        isrc: normIsrc,
        source: 'deezer',
      };
      await cacheSet(cacheKey, result, 86400);
      console.log(`[Deezer ISRC] HIT ${normIsrc} -> id=${match.id} "${match.title}"`);
      return result;
    }
    await cacheSet(cacheKey, 'MISS', 1800);
    console.log(`[Deezer ISRC] no confirmed match for ${normIsrc}`);
    return null;
  } catch (e) {
    console.warn('[Deezer ISRC] lookup error:', e.message);
    return null;
  }
}

// ── deezerStream — ARL-based, with BF_CBC_STRIPE proxy or direct NONE URL ────
async function deezerStream(trackId, env, req, expectedIsrc = null) {
  const arl = env?.deezerArl || env?.DEEZER_ARL || null;
  if (!arl) { console.warn('[deezer] No DEEZER_ARL configured'); return null; }

  const numericId = decodeURIComponent(String(trackId || '')).replace(/^deezer(?::|%3A)/i, '');
  const cacheKey  = `dz:stream:result:${numericId}`;
  const cached    = await cacheGet(cacheKey);
  if (cached) {
    // ISRC validation on cache hit — bust cache if ISRC mismatch
    if (expectedIsrc) {
      const wantIsrc   = String(expectedIsrc).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const cachedIsrc = cached.isrc ? String(cached.isrc).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
      if (cachedIsrc && cachedIsrc !== wantIsrc) {
        console.warn(`[Deezer stream] ISRC mismatch in cache for ${numericId}: got ${cachedIsrc}, expected ${wantIsrc} — busting cache`);
        // fall through to re-fetch
      } else {
        return cached;
      }
    } else {
      return cached;
    }
  }

  try {
    const info = await dzGetPremiumStreamInfo(numericId, arl, env);
    if (!info?.url) return null;

    // ISRC validation on fresh fetch — reject if Deezer track ISRC doesn't match
    if (expectedIsrc && info.isrc) {
      const wantIsrc = String(expectedIsrc).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const gotIsrc  = String(info.isrc).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (gotIsrc && gotIsrc !== wantIsrc) {
        console.warn(`[Deezer stream] ISRC mismatch: track ${numericId} has ${gotIsrc}, expected ${wantIsrc} — rejecting`);
        return null;
      }
    }

    let result;
    if (info.cipher === 'NONE') {
      // No decryption needed — return direct URL
      result = {
        url:     info.url,
        format:  info.quality === 'flac' ? 'flac' : 'mp3',
        quality: info.quality,
        source:  'deezer',
        isrc:    info.isrc || null,
      };
    } else {
      // BF_CBC_STRIPE — must go through /dz-proxy route for decryption
      const cdnB64  = btoa(info.url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const bfParam = encodeURIComponent(info.blowfishKey);
      const origin = req ? (() => { try { return new URL(req.url).origin; } catch { return ''; } })() : '';
      const relPath = `/dz-proxy/${numericId}?cdn=${cdnB64}&k=${bfParam}`;
      result = {
        url:     origin ? `${origin}${relPath}` : relPath,
        format:  info.quality === 'flac' ? 'flac' : 'mp3',
        quality: info.quality,
        source:  'deezer',
        isrc:    info.isrc || null,
      };
      // Store stream info in memory cache so /dz-proxy can re-use it
      _dzStreamSet(numericId, info);
    }

    const ttl = info.expiresAt ? Math.max(60, Math.floor((info.expiresAt - Date.now()) / 1000) - 30) : 200;
    await cacheSet(cacheKey, result, ttl);
    return result;
  } catch (e) {
    console.warn('Deezer stream error:', e.message);
    return null;
  }
}

async function deezerAlbum(albumId) {
  const cacheKey = `dz:album:${albumId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const [metaRes, tracksRes] = await Promise.allSettled([
      axios.get(`${DEEZER_API}/album/${albumId}`, { headers: { 'User-Agent': UA }, timeout: 8000 }),
      axios.get(`${DEEZER_API}/album/${albumId}/tracks`, { params: { limit: 100 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
    ]);
    const meta      = metaRes.status === 'fulfilled' ? (metaRes.value.data || {}) : {};
    const rawTracks = tracksRes.status === 'fulfilled' ? (tracksRes.value.data?.data || []) : [];
    const artworkURL = meta.cover_xl || meta.cover_big || meta.cover || null;
    const artistName = meta.artist?.name || 'Unknown';
    const tracks = rawTracks.map((t, i) => ({
      id: `deezer:${t.id}`, title: t.title || 'Unknown',
      artist: t.artist?.name || artistName, album: meta.title || '',
      duration: t.duration || undefined, artworkURL, format: 'mp3', source: 'deezer',
      trackNumber: t.track_position || (i + 1),
    }));
    const result = {
      id: `deezer:album:${albumId}`, title: meta.title || 'Unknown Album',
      artist: artistName, artworkURL, year: safeYear(meta.release_date), tracks,
    };
    await cacheSet(cacheKey, result, 3600);
    return result;
  } catch (e) { console.warn('Deezer album error:', e.message); return null; }
}

async function deezerArtist(artistId) {
  const cacheKey = `dz:artist:${artistId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const [infoRes, topRes] = await Promise.allSettled([
      axios.get(`${DEEZER_API}/artist/${artistId}`, { headers: { 'User-Agent': UA }, timeout: 8000 }),
      axios.get(`${DEEZER_API}/artist/${artistId}/top`, { params: { limit: 20 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
    ]);
    const info      = infoRes.status === 'fulfilled' ? (infoRes.value.data || {}) : {};
    const rawTop    = topRes.status === 'fulfilled' ? (topRes.value.data?.data || []) : [];
    const artworkURL = info.picture_xl || info.picture_big || info.picture || null;
    const artistName = info.name || 'Unknown Artist';
    // FIX: paginate Deezer albums — fetch up to 300 across 3 pages so all albums/EPs/singles appear
    let allRawAlbums = [];
    const _albumPageSize = 100;
    for (let _page = 0; _page < 3; _page++) {
      try {
        const aRes = await axios.get(`${DEEZER_API}/artist/${artistId}/albums`, {
          params: { limit: _albumPageSize, index: _page * _albumPageSize },
          headers: { 'User-Agent': UA }, timeout: 8000,
        });
        const pageData = aRes.data?.data || [];
        if (!pageData.length) break;
        allRawAlbums = allRawAlbums.concat(pageData);
        const total = aRes.data?.total || 0;
        if (allRawAlbums.length >= total || pageData.length < _albumPageSize) break;
      } catch(e) { console.warn('[Deezer artist albums page]', e.message); break; }
    }
    const topTracks = rawTop.map(t => ({
      id: `deezer:${t.id}`, title: t.title || 'Unknown', artist: artistName,
      album: t.album?.title || '', duration: t.duration || undefined,
      artworkURL: t.album?.cover_xl || t.album?.cover_big || artworkURL, format: 'mp3', source: 'deezer',
    }));
    const albums = allRawAlbums.map(a => ({
      id: `deezer:album:${a.id}`, title: a.title || 'Unknown Album', artist: artistName,
      artworkURL: a.cover_xl || a.cover_big || a.cover || null, year: safeYear(a.release_date), source: 'deezer',
    }));
    const result = { id: `deezer:artist:${artistId}`, name: artistName, artworkURL, topTracks, albums };
    await cacheSet(cacheKey, result, 3600);
    return result;
  } catch (e) { console.warn('Deezer artist error:', e.message); return null; }
}

async function deezerPlaylist(playlistId) {
  const cacheKey = `dz:playlist:${playlistId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const metaRes = await axios.get(`${DEEZER_API}/playlist/${playlistId}`, { headers: { 'User-Agent': UA }, timeout: 8000 });
    const meta    = metaRes.data || {};
    if (!meta.id) return null;
    const embeddedTracks = meta.tracks?.data || [];
    const totalTracks    = meta.tracks?.total || embeddedTracks.length;
    let allRawTracks     = embeddedTracks;
    if (totalTracks > embeddedTracks.length) {
      try {
        const tracksRes = await axios.get(`${DEEZER_API}/playlist/${playlistId}/tracks`, {
          params: { limit: 100, index: 0 }, headers: { 'User-Agent': UA }, timeout: 8000,
        });
        const fetched = tracksRes.data?.data || [];
        if (fetched.length > embeddedTracks.length) allRawTracks = fetched;
      } catch {}
    }
    const mapTrack = t => ({
      id: `deezer:${t.id}`, title: t.title || t.title_short || 'Unknown',
      artist: t.artist?.name || 'Unknown', album: t.album?.title || meta.title || '',
      duration: t.duration || undefined,
      artworkURL: t.album?.cover_xl || t.album?.cover_big || meta.picture_xl || meta.picture_big || null,
      isrc: t.isrc || undefined, format: 'mp3', source: 'deezer',
    });
    const tracks = allRawTracks.map(mapTrack);
    const result = {
      id: `deezer:playlist:${playlistId}`, type: 'playlist',
      title: meta.title || 'Unknown Playlist', artist: meta.creator?.name || 'Deezer',
      artworkURL: meta.picture_xl || meta.picture_big || null, trackCount: totalTracks, tracks,
    };
    await cacheSet(cacheKey, result, 3600);
    return result;
  } catch (e) { console.warn('Deezer playlist error:', e.message); return null; }
}




// ─── YouTube Music (ported from standalone youtube addon) ─────────────────────
// ─── YouTube Music — Eclipse Addon (Cloudflare Workers) ─────────────────────
// author: ricky | version: 1.4.8

function generateToken() {
  const arr = new Uint8Array(14);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}
function isValidToken(t) { return typeof t === 'string' && /^[a-f0-9]{28}$/.test(t); }
function parseTokenPath(p) {
  const m = p.match(new RegExp("^/u/([a-f0-9]{28})(/.*)?$"));
  return m ? { token: m[1], rest: m[2] || '/' } : null;
}
function lastSegment(rest) { return rest.split('/').filter(Boolean).pop() || ''; }


// ─── Radio Browser ────────────────────────────────────────────────────────────
const RADIO_BROWSER_HOSTS = [
  'https://de1.api.radio-browser.info',
  'https://fr1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
];

async function getRadioBrowserHost() {
  const cached = await cacheGet('radio:host');
  if (cached) return cached;
  for (const h of RADIO_BROWSER_HOSTS) {
    try {
      await axios.get(`${h}/json/stats`, { timeout: 2000 });
      await cacheSet('radio:host', h, 300);
      return h;
    } catch {}
  }
  return RADIO_BROWSER_HOSTS[0];
}

async function radioSearch(query) {
  const cacheKey = `radio:search:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  const host = await getRadioBrowserHost();
  try {
    const res = await axios.get(`${host}/json/stations/search`, {
      params: { name: query, limit: 10, hidebroken: true, order: 'votes', reverse: true },
      headers: { 'User-Agent': 'EclipseUniversalAddon/1.0' },
      timeout: 5000,
    });
    const stations = (res.data || []).map(s => ({
      id: `radio_${s.stationuuid}`,
      title: s.name || 'Unknown Station',
      artist: `${s.country || ''} ${s.tags ? '· ' + s.tags.split(',').slice(0,2).join(', ') : ''}`.trim(),
      album: 'Live Radio',
      duration: 0,
      artworkURL: s.favicon || '',
      format: s.codec?.toLowerCase() || 'mp3',
      streamURL: s.url_resolved || s.url,
      _source: 'radio',
      _stationuuid: s.stationuuid,
    }));
    // Also search by tag (genre)
    const tagRes = await axios.get(`${host}/json/stations/bytag/${encodeURIComponent(query)}`, {
      params: { limit: 5, hidebroken: true, order: 'votes', reverse: true },
      headers: { 'User-Agent': 'EclipseUniversalAddon/1.0' },
      timeout: 5000,
    }).catch(() => ({ data: [] }));
    const tagStations = (tagRes.data || []).map(s => ({
      id: `radio_${s.stationuuid}`,
      title: s.name || 'Unknown Station',
      artist: `${s.country || ''} ${s.tags ? '· ' + s.tags.split(',').slice(0,2).join(', ') : ''}`.trim(),
      album: 'Live Radio',
      duration: 0,
      artworkURL: s.favicon || '',
      format: s.codec?.toLowerCase() || 'mp3',
      streamURL: s.url_resolved || s.url,
      _source: 'radio',
      _stationuuid: s.stationuuid,
    }));
    const combined = [...stations, ...tagStations].reduce((acc, s) => {
      if (!acc.find(x => x._stationuuid === s._stationuuid)) acc.push(s);
      return acc;
    }, []).slice(0, 12);
    await cacheSet(cacheKey, combined, 300);
    return combined;
  } catch (e) {
    console.warn('[Radio] search error:', e.message);
    return [];
  }
}



// ─── Routes ──────────────────────────────────────────────────────────────────

// ── Deezer BF_CBC_STRIPE decryption proxy ─────────────────────────────────────
// Called when deezerStream() returns a /dz-proxy URL (cipher=BF_CBC_STRIPE).
// Fetches the encrypted CDN audio and streams it back with Blowfish decryption.
// Range requests are fully supported so seeking works correctly on all clients.
async function handleDzProxy(c) {
  const _rlResDz = await applyRateLimit(c, 'dzProxy');
  if (_rlResDz) return _rlResDz;
  const _dzCfg = getConfig(c);
  const arl = _dzCfg.deezerArl || c.env?.DEEZER_ARL;
  if (!arl) return c.json({ error: 'No DEEZER_ARL configured' }, 403);

  const trackId  = c.req.param('id');
  const reqUrl   = new URL(c.req.url);
  const cdnB64   = reqUrl.searchParams.get('cdn');
  const bfKey    = reqUrl.searchParams.get('k');

  let cdnUrl, cipher, quality;
  if (cdnB64) {
    cdnUrl  = atob(cdnB64.replace(/-/g, '+').replace(/_/g, '/'));
    cipher  = bfKey ? 'BF_CBC_STRIPE' : 'NONE';
    quality = cdnUrl.includes('FLAC') ? 'flac' : 'mp3';
  } else {
    let cached = _dzStreamGet(trackId);
    if (!cached) cached = await dzGetPremiumStreamInfo(trackId, arl, c.env);
    if (!cached?.url) return c.json({ error: 'Track not found' }, 404);
    cdnUrl  = cached.url;
    cipher  = cached.cipher;
    quality = cached.quality;
  }

  const rangeHeader = c.req.header('Range');
  const cdnHeaders  = {
    'User-Agent':      'Mozilla/5.0',
    'Accept':          '*/*',
    'Accept-Encoding': 'identity',
    'Origin':          'https://www.deezer.com',
    'Referer':         'https://www.deezer.com/',
  };
  if (rangeHeader) cdnHeaders['Range'] = rangeHeader;

  if (c.req.method === 'HEAD') {
    const headRes = await fetch(cdnUrl, { method: 'HEAD', headers: cdnHeaders });
    const h = { 'Content-Type': quality === 'flac' ? 'audio/flac' : 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
    const cl = headRes.headers.get('Content-Length');
    const cr = headRes.headers.get('Content-Range');
    if (cl) h['Content-Length'] = cl;
    if (cr) h['Content-Range']  = cr;
    return new Response(null, { status: headRes.ok ? 200 : headRes.status, headers: h });
  }

  // NONE cipher — pipe directly
  if (cipher !== 'BF_CBC_STRIPE' || !bfKey) {
    const cdnRes = await fetch(cdnUrl, { headers: cdnHeaders });
    if (!cdnRes.ok && cdnRes.status !== 206) return new Response('CDN error: ' + cdnRes.status, { status: 502 });
    const respH = {
      'Content-Type':  quality === 'flac' ? 'audio/flac' : 'audio/mpeg',
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
    };
    const cl = cdnRes.headers.get('Content-Length');
    const cr = cdnRes.headers.get('Content-Range');
    if (cl) respH['Content-Length'] = cl;
    if (cr) respH['Content-Range']  = cr;
    return new Response(cdnRes.body, { status: cdnRes.status, headers: respH });
  }

  // BF_CBC_STRIPE — align to 2048-byte chunk boundary, stream-decrypt
  const rangeM       = rangeHeader?.match(/bytes=(\d+)(?:-(\d+))?/);
  const clientStart  = rangeM ? parseInt(rangeM[1], 10) : 0;
  const clientEnd    = rangeM && rangeM[2] ? parseInt(rangeM[2], 10) : null;
  const alignedStart = Math.floor(clientStart / 2048) * 2048;
  const alignOffset  = clientStart - alignedStart;
  const chunkStart   = alignedStart / 2048;

  const alignedEnd = clientEnd !== null ? Math.ceil((clientEnd + 1) / 2048) * 2048 - 1 : null;

  let alignedRes = await fetch(cdnUrl, { headers: { ...cdnHeaders,
    Range: alignedEnd !== null ? `bytes=${alignedStart}-${alignedEnd}` : `bytes=${alignedStart}-`,
  }});
  if (!alignedRes.ok && alignedRes.status !== 206) return new Response('CDN error: ' + alignedRes.status, { status: 502 });

  const expandedBf = dzBfExpandKeySync(bfKey); // sync — ~0ms after first call
  let chunkIndex   = chunkStart;
  let leftover     = new Uint8Array(0);
  let skipped      = 0;

  const { readable, writable } = new TransformStream({
    transform(chunk, controller) {
      const buf = new Uint8Array(leftover.length + chunk.length);
      buf.set(leftover); buf.set(chunk, leftover.length);
      let pos = 0;
      while (pos + 2048 <= buf.length) {
        const block     = buf.subarray(pos, pos + 2048);
        const decrypted = chunkIndex % 3 === 0
          ? dzBfDecryptBlockFast(block, expandedBf)
          : new Uint8Array(block);
        chunkIndex++; pos += 2048;
        if (skipped < alignOffset) {
          const need = alignOffset - skipped;
          if (need >= decrypted.length) { skipped += decrypted.length; continue; }
          controller.enqueue(decrypted.subarray(need)); skipped = alignOffset;
        } else { controller.enqueue(decrypted); }
      }
      leftover = buf.slice(pos);
    },
    flush(controller) {
      if (leftover.length > 0) {
        const out = skipped < alignOffset ? leftover.subarray(alignOffset - skipped) : leftover;
        if (out.length > 0) controller.enqueue(out);
      }
    },
  });

  alignedRes.body.pipeTo(writable).catch(() => {});
  const respHeaders = {
    'Content-Type':  quality === 'flac' ? 'audio/flac' : 'audio/mpeg',
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
  };
  const cl2 = alignedRes.headers.get('Content-Length');
  const cr2  = alignedRes.headers.get('Content-Range');
  if (cl2) respHeaders['Content-Length'] = cl2;
  if (cr2) respHeaders['Content-Range']  = cr2;
  return new Response(readable, { status: alignedRes.status, headers: respHeaders });
}


// ═══════════════════════════════════════════════════════════════════════════

// ── SomaFM — free, no-key internet radio ──────────────────────────────────────
async function somaFmSearch(query) {
  const cacheKey = `somafm:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await axios.get('https://api.somafm.com/channels.json', {
      headers: { 'User-Agent': 'EclipseUniversalAddon/1.0' },
      timeout: 5000,
    });
    const channels = res.data?.channels || [];
    const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    const scored = channels.map(ch => {
      const name  = (ch.title || '').toLowerCase();
      const genre = (ch.genre || '').toLowerCase();
      const desc  = (ch.description || '').toLowerCase();
      let score = 1;
      if (name === q)            score = 500;
      else if (name.includes(q)) score = 300;
      else if (genre.includes(q)) score = 200;
      else if (desc.includes(q)) score = 100;
      return { ch, score };
    }).sort((a, b) => b.score - a.score).slice(0, 15);

    const stations = scored.map(({ ch }) => {
      const stream =
        ch.playlists?.find(p => p.format === 'mp3' && p.quality === 'highest')?.url ||
        ch.playlists?.find(p => p.format === 'aac')?.url ||
        ch.playlists?.[0]?.url || null;
      if (!stream) return null;
      return {
        id: `somafm:${ch.id}`,
        title: ch.title || 'SomaFM Station',
        artist: ch.genre || 'SomaFM',
        album: 'Live Radio \u00b7 SomaFM',
        duration: 0,
        artworkURL: ch.xlimage || ch.image || null,
        format: stream.includes('.m3u') ? 'hls' : 'mp3',
        streamURL: stream,
        source: 'somafm',
      };
    }).filter(Boolean);

    await cacheSet(cacheKey, stations, 300);
    return stations;
  } catch (e) {
    console.warn('SomaFM search error:', e.message);
    return [];
  }
}

//
//
//   // Manifest (with and without token)
//   function buildManifest(token) { ... }
//   app.get('/manifest.json', ...);
//   app.get('/:token/manifest.json', ...);
//
// ═══════════════════════════════════════════════════════════════════════════

// ── Manifest routes ─────────────────────────────────────────────────────────
// Eclipse uses contentType in the manifest to decide which player UI to show.
// One manifest can only have one contentType, so we expose three manifest routes:
//   /{token}/manifest.json           → music player  (main addon)
//   /{token}/podcast/manifest.json   → podcast player
//   /{token}/audiobook/manifest.json → audiobook player
// All three routes hit the exact same search/stream/catalog endpoints.

function buildManifest(token, type) {
  const prefix = `com.eclipse.universal${token ? '.' + token.slice(0, 8) : ''}`;
  // Parse token to get custom addon name if set
  const cfg = token ? parseToken(token) : {};
  const customName = (cfg.addon_name && cfg.addon_name.trim()) ? cfg.addon_name.trim() : null;

  if (type === 'podcast') {
    return {
      id: prefix + '.podcast',
      name: customName ? customName + ' — Podcasts' : 'Podcasts',
      version: '1.4.1',
      description: 'Podcast episodes and series from Podcast Index, Taddy, and Apple Podcasts',
      icon: 'https://www.jermelpresident.com/wp-content/uploads/2020/10/ApplePodcastHP.jpg',
      resources: ['search', 'stream', 'catalog'],
      types: ['track', 'album', 'artist', 'playlist'],
      contentType: 'podcast',
    };
  }

  if (type === 'audiobook') {
    return {
      id: prefix + '.audiobook',
      name: customName ? customName + ' — Audiobooks' : 'Audiobooks',
      version: '1.4.0',
      description: 'Public domain audiobooks from LibriVox and Internet Archive',
      icon: 'https://play-lh.googleusercontent.com/-x0uIYaNWONIRefvL7u4pi75rh4fi5441J0EelEpoOaGRZbAPdhRqKxBu-cvvCV5dw',
      resources: ['search', 'stream', 'catalog'],
      types: ['track', 'album', 'artist', 'playlist'],
      contentType: 'audiobook',
    };
  }

  if (type === 'radio') {
    return {
      id: prefix + '.radio',
      name: customName ? customName + ' — Radio' : 'Radio',
      version: '1.4.0',
      description: 'Live internet radio from Radio Browser (250 k+ stations) and SomaFM',
      icon: 'https://img.freepik.com/premium-vector/radio-icon-vector-logo-template_917138-1337.jpg',
      resources: ['search', 'stream', 'catalog'],
      types: ['track', 'album', 'artist', 'playlist'],
      contentType: 'music',
    };
  }

  // Default: music
  return {
    id: prefix,
    name: customName || 'All In Eclipse',
    version: '1.4.0',
    description: 'All-in-one: HiFi music, SoundCloud, Internet Archive, Podcasts, Audiobooks, and Live Radio',
    icon: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTueIUOQATc6lrir4FpwhFl9P656MBFPkvOV03N5P3zlA&s=10',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist', 'playlist'],
    contentType: 'music',
  };
}

// ── Main manifest (music player) ─────────────────────────────────────────────

app.get('/:config/stats', async (c) => {
  return c.json({
    uptime: Math.floor(process.uptime?.() || 0),
    stats: _stats,
    instances: {
      qobuz: QOBUZ_INSTANCES,
      hifi_defaults: DEFAULT_HIFI_INSTANCES,
      keepalive_targets: KEEPALIVE_TARGETS,
    },
  });
});


// ── Deezer BF proxy routes (must be before /:token/* wildcards)
app.get('/dz-proxy/:id',      handleDzProxy);
app.get('/:token/dz-proxy/:id', handleDzProxy);

app.get('/manifest.json', c => c.json(buildManifest(null, 'music')));
app.get('/:token/manifest.json', c => c.json(buildManifest(c.req.param('token'), 'music')));

// ── Podcast sub-manifest → podcast player UI ─────────────────────────────────
// Install URL: https://your-addon.vercel.app/{token}/podcast/manifest.json
app.get('/podcast/manifest.json', c => c.json(buildManifest(null, 'podcast')));
app.get('/:token/podcast/manifest.json', c => c.json(buildManifest(c.req.param('token'), 'podcast')));

// ── Audiobook sub-manifest → audiobook player UI ─────────────────────────────
// Install URL: https://your-addon.vercel.app/{token}/audiobook/manifest.json
app.get('/audiobook/manifest.json', c => c.json(buildManifest(null, 'audiobook')));
app.get('/:token/audiobook/manifest.json', c => c.json(buildManifest(c.req.param('token'), 'audiobook')));

// ── Radio sub-manifest → music player UI (Radio Browser + SomaFM only) ────────
// Install URL: https://your-addon.vercel.app/{token}/radio/manifest.json
app.get('/radio/manifest.json', c => c.json(buildManifest(null, 'radio')));
app.get('/:token/radio/manifest.json', c => c.json(buildManifest(c.req.param('token'), 'radio')));

// Search (with and without token)


// ─── Stats tracking ──────────────────────────────────────────────────────────
const _stats = { hits: {}, misses: {}, errors: {} };
function statHit(src)   { _stats.hits[src]   = (_stats.hits[src]   || 0) + 1; }
function statMiss(src)  { _stats.misses[src]  = (_stats.misses[src]  || 0) + 1; }
function statErr(src)   { _stats.errors[src]  = (_stats.errors[src]  || 0) + 1; }


// ─── Qobuz Instance Retry Helper ─────────────────────────────────────────────
// Retries each instance up to 3 times before moving on.
// Permanent errors (403/404/401) are not retried.
async function qobuzGet(url, params, timeout = 7000) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await axios.get(url, { params, headers: { 'User-Agent': UA }, timeout });
      return r;
    } catch(e) {
      const status = e.response?.status;
      if (status === 403 || status === 404 || status === 401) throw e; // permanent, don't retry
      if (attempt < MAX_RETRIES) {
        await new Promise(res => setTimeout(res, 500));
        continue;
      }
      throw e; // gave up after MAX_RETRIES
    }
  }
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────
// Dual-layer sliding window: always-on in-memory (no Upstash required) +
// optional Upstash Redis for distributed deployments.
//
// Per-IP limits by route type:
//   stream   → 40 req / 60 s   (normal playback = ~1 req per track)
//   search   → 25 req / 60 s   (fast typists do ~1 req/keystroke burst)
//   catalog  → 20 req / 60 s   (album/artist/playlist browse)
//   resolve  → 20 req / 60 s
//   dzProxy  → 30 req / 60 s   (each track = 1 req, similar to stream)
//   manifest → 8  req / 60 s   (addon install only)
//   global   → 80 req / 60 s   (health, stats, instances, etc.)

const _rlWindows = new Map(); // "ip:type" -> { count, windowStart }

const RL_CFG = {
  stream:   { window: 60_000, max: 120 },
  search:   { window: 60_000, max: 100 },  // raised: 25 was too low, blocked legitimate podcast searches
  catalog:  { window: 60_000, max: 80  },
  resolve:  { window: 60_000, max: 60  },
  dzProxy:  { window: 60_000, max: 60  },
  manifest: { window: 60_000, max: 60  },  // raised: 8 was too low, blocked manifest installs
  global:   { window: 60_000, max: 200 },
};

// CF Workers: setInterval is not allowed in global scope.
// Instead we do lazy pruning: every ~100 checkRateLimit calls we sweep expired windows.
let _rlPruneCounter = 0;
function _rlMaybePrune() {
  if (++_rlPruneCounter < 100) return;
  _rlPruneCounter = 0;
  const now = Date.now();
  for (const [key, entry] of _rlWindows) {
    const type = key.split(':').pop();
    const cfg  = RL_CFG[type] || RL_CFG.global;
    if (now - entry.windowStart > cfg.window * 2) _rlWindows.delete(key);
  }
}

/**
 * checkRateLimit(env, ip, type)
 * Returns { allowed: boolean, headers: object }
 * Always enforces in-memory limits. If Upstash is configured it also
 * runs a supplementary distributed check (used as secondary firewall).
 */
async function checkRateLimit(env, ip, type = 'global') {
  const cfg = RL_CFG[type] || RL_CFG.global;
  const key = `${ip}:${type}`;
  const now = Date.now();

  // ── In-memory sliding window (always active) ────────────────────────────
  let entry = _rlWindows.get(key);
  if (!entry || now - entry.windowStart > cfg.window) {
    entry = { count: 0, windowStart: now };
  }
  entry.count++;
  _rlWindows.set(key, entry);
  _rlMaybePrune();

  const remaining  = Math.max(0, cfg.max - entry.count);
  const resetEpoch = Math.ceil((entry.windowStart + cfg.window) / 1000);
  const retryAfter = Math.ceil((entry.windowStart + cfg.window - now) / 1000);

  const headers = {
    'X-RateLimit-Limit':     String(cfg.max),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset':     String(resetEpoch),
  };

  if (entry.count > cfg.max) {
    headers['Retry-After'] = String(Math.max(1, retryAfter));
    return { allowed: false, headers };
  }

  // ── Optional Upstash secondary check (distributed deployments) ──────────
  if (env?.UPSTASH_REDIS_REST_URL && env?.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const bucket = Math.floor(now / cfg.window);
      const rKey   = `rl:${type}:${ip}:${bucket}`;
      const count  = await upstashCmd(env, 'INCR', rKey);
      if (count === 1) upstashCmd(env, 'EXPIRE', rKey, Math.ceil(cfg.window / 1000) + 10).catch(() => {});
      if (count > cfg.max) {
        headers['X-RateLimit-Remaining'] = '0';
        headers['Retry-After'] = String(Math.ceil((cfg.window - (now % cfg.window)) / 1000));
        return { allowed: false, headers };
      }
    } catch (_) { /* non-fatal — fall through to in-memory result */ }
  }

  return { allowed: true, headers };
}

/** Convenience: extract best-effort client IP from a Hono context */
function getClientIp(c) {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'unknown'
  );
}

/** Apply rate limit to a Hono handler context. Returns 429 response or null. */
async function applyRateLimit(c, type) {
  const ip = getClientIp(c);
  const rl = await checkRateLimit(c.env, ip, type);
  for (const [k, v] of Object.entries(rl.headers)) c.header(k, v);
  if (!rl.allowed) {
    return c.json(
      { error: 'Too Many Requests', retryAfter: Number(rl.headers['Retry-After'] || 5) },
      429,
    );
  }
  return null; // allowed
}

async function handleSearch(c) {
  const _rlRes = await applyRateLimit(c, 'search');
  if (_rlRes) return _rlRes;
  const query = c.req.query('q') || '';
  if (!query || query.trim().length < 2) return c.json({ tracks: [], albums: [], artists: [], playlists: [] });
  const cfg = getConfig(c);
  const cacheKey = `search:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const TOTAL_MS = 7000;
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve(null), ms))
    ]);
  }

  // Fire all sources — source flags gate whether results are used, not whether calls fire
  const [
    hifiRes, scRes, iaMusicRes,
    piRes, taddyRes, appleRes,
    lvoxRes, iaBookRes, radioRes,
    qobuzRes, deezerRes,
  ] = await Promise.all([
    withTimeout(hifiSearch(query, cfg.hifiInstances),            7000),
    withTimeout(scSearch(query, cfg.scClientId),                 7000),
    withTimeout(iaSearchMusic(query),                            4000),
    cfg.noPodcast   ? Promise.resolve(null) : withTimeout(piSearchEpisodes(query, cfg.piKey, cfg.piSecret), TOTAL_MS),
    cfg.noPodcast   ? Promise.resolve(null) : withTimeout(taddySearch(query, cfg.taddyKey, cfg.taddyUid),  TOTAL_MS),
    // Apple Podcasts: free iTunes API — no keys needed. Always runs unless user explicitly disables podcasts.
    cfg.noPodcast   ? Promise.resolve(null) : withTimeout(appleSearch(query),                              TOTAL_MS),
    cfg.noAudiobook ? Promise.resolve(null) : cfg.noLibrivox ? Promise.resolve(null) : withTimeout(librivoxSearch(query),                           TOTAL_MS),
    cfg.noAudiobook ? Promise.resolve(null) : withTimeout(iaSearchAudiobooks(query),                       TOTAL_MS),
    cfg.noRadio     ? Promise.resolve(null) : cfg.noRadio ? Promise.resolve(null) : withTimeout(radioSearch(query),                              4000),
    withTimeout(qobuzSearch(query),                              7000),
    (cfg.noDeezer && !cfg.searchOrder.includes('deezer')) ? Promise.resolve(null) : withTimeout(deezerSearch(query), 7000),
  ]);

  const scResult    = scRes    || {};
  const scRaw       = Array.isArray(scResult) ? scResult : (scResult.tracks    || []);
  // Persist sc:meta to Upstash now that we have c.env (parallel, non-blocking)
  // MSET: write all 20 sc:meta in ONE Upstash command instead of 20
  const _msetArgs = [];
  for (const _t of scRaw) {
    if (_t._origId && _t.title) {
      const _mv = { title: _t.title, artist: _t.artist || '', isrc: _t.isrc || null };
      cacheSet(`sc:meta:${_t._origId}`, _mv, 3600);
      _msetArgs.push(`sc:meta:${_t._origId}`, JSON.stringify(_mv));
    }
  }
  if (_msetArgs.length) upstashCmd(c.env, 'MSET', ..._msetArgs).catch(()=>{});
  const _scInOrder   = cfg.searchOrder.includes('sc');
  const sc          = (cfg.noSc && !_scInOrder) ? [] : scRaw;
  const scPlaylists = (cfg.noSc && !_scInOrder) ? [] : (Array.isArray(scResult) ? [] : (scResult.playlists || []));
  const iaMusicRaw  = iaMusicRes || [];
  const iaMusic     = cfg.noIa   ? [] : iaMusicRaw;

  const piResult    = piRes    || { playlists: [], episodes: [], albums: [] };
  const taddyResult = taddyRes || { playlists: [], episodes: [], albums: [] };
  const appleResult = appleRes || { playlists: [], episodes: [], albums: [] };
  const lvox        = (cfg.noAudiobook ? [] : lvoxRes)    || [];
  const iaBooks     = (cfg.noAudiobook ? [] : iaBookRes)  || [];
  const radio       = (cfg.noRadio     ? [] : radioRes)   || [];
  const piAlbums    = piResult.albums    || [];
  const taddyAlbums = taddyResult.albums || [];
  const appleAlbums = appleResult.albums || [];

  // Qobuz search results
  const qobuzResult    = qobuzRes || { tracks: [], albums: [], artists: [], playlists: [] };
  const qobuzTracks    = cfg.noQobuz ? [] : (qobuzResult.tracks    || []);
  const qobuzAlbums    = cfg.noQobuz ? [] : (qobuzResult.albums    || []);
  const qobuzArtists   = cfg.noQobuz ? [] : (qobuzResult.artists   || []);
  const qobuzPlaylists = cfg.noQobuz ? [] : (qobuzResult.playlists || []);

  // Merge podcast episodes: PI first, then Taddy (dedupe by title)
  const episodeTitles = new Set();
  const allEpisodes = [];
  if (!cfg.noPodcast) {
    for (const ep of [...(piResult.episodes || []), ...(taddyResult.episodes || []), ...(appleResult.episodes || [])]) {
      const key = ep.title?.toLowerCase().slice(0, 40);
      if (!episodeTitles.has(key)) { episodeTitles.add(key); allEpisodes.push(ep); }
    }
  }

  // Merge podcast series: PI first, then Taddy
  const seriesTitles = new Set();
  const _deezerInOrder = cfg.searchOrder.includes('deezer');
  const deezerPlaylists = (cfg.noDeezer && !_deezerInOrder) ? [] : (deezerRes?.playlists || []);
  const allSeries = [];
  {
    const _podLists = cfg.noPodcast ? [] : [
      ...(piResult.playlists   || []),
      ...(taddyResult.playlists || []),
      ...(appleResult.playlists || []),
    ];
    for (const s of [...scPlaylists, ...deezerPlaylists, ..._podLists]) {
      const key = s.title?.toLowerCase().slice(0, 40);
      if (!seriesTitles.has(key)) { seriesTitles.add(key); allSeries.push(s); }
    }
  }

  // Merge audiobook albums: LibriVox first, then IA
  const bookTitles = new Set();
  const allBooks = [];
  if (!cfg.noAudiobook) {
    for (const b of [...lvox, ...iaBooks]) {
      const key = b.title?.toLowerCase().slice(0, 40);
      if (!bookTitles.has(key)) { bookTitles.add(key); allBooks.push(b); }
    }
  }

  // Normalize HiFi result (now returns object)
  const hifiResult     = (cfg.noHifi ? {} : hifiRes) || {};
  const hifiTrackList  = Array.isArray(hifiResult) ? hifiResult : (hifiResult.tracks  || []);
  const hifiAlbumList  = Array.isArray(hifiResult) ? []         : (hifiResult.albums  || []);
  const hifiArtistList = Array.isArray(hifiResult) ? []         : (hifiResult.artists || []);

  // Re-encode instB64 for tracks that came back with raw inst
  const hifiTracksNorm = hifiTrackList.map(t => {
    const base = (t.id && t.id.startsWith('hifi_'))
      ? t
      : { ...t, id: `hifi_${encodeBase64Url(t._inst || '')}_${t._origId || t.id}` };
    // Normalize ISRC so _canonKey dedup works cross-source
    if (base.isrc) base.isrc = String(base.isrc).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return base;
  });

  // Dedupe podcast albums
  const podcastAlbumSet = new Set();
  const podcastAlbums = [];
  for (const a of [...piAlbums, ...taddyAlbums, ...appleAlbums]) {
    if (!podcastAlbumSet.has(a.id)) { podcastAlbumSet.add(a.id); podcastAlbums.push(a); }
  }

  // Smart query-type detection
  const qLow = query.toLowerCase();
  const isPodcastQuery = /podcast|episode|rogan|lex fridman|serial|npr|radiolab|conan|armchair|smartless|call her daddy|pardon my take|crime junkie|huberman|theo von|apple podcast/i.test(qLow)
    || (allEpisodes.length > 0 && hifiTrackList.length === 0);
  const isRadioQuery    = /^(radio|internet radio|live radio|fm radio|somafm|soma fm|bbc radio|rnz radio)$/i.test(qLow.trim());
  const isAudiobookQuery = /audiobook|librivox|sherlock|austen|dickens|tolkien|public domain/i.test(qLow);

  // Build ordered music track pool respecting user-selected search priority.
  // searchOrder contains ONLY the sources the user wants — treat it as the allow-list.
  // The no_ flags are for completely disabling a source; if a source appears in searchOrder
  // it means the user explicitly wants it, so honour that over the no_ flag.
  const defaultMusicOrder = ['hifi', 'qobuz', 'deezer', 'sc', 'ia'];
  const effectiveMusicOrder = cfg.searchOrder.length > 0
    ? cfg.searchOrder.filter(k => defaultMusicOrder.includes(k))
    : defaultMusicOrder.filter(k => {
        if (k === 'hifi'   && cfg.noHifi)   return false;
        if (k === 'qobuz'  && cfg.noQobuz)  return false;
        if (k === 'sc'     && cfg.noSc     && !cfg.searchOrder.includes('sc'))     return false;
        if (k === 'ia'     && cfg.noIa)     return false;
        if (k === 'deezer' && cfg.noDeezer && !cfg.searchOrder.includes('deezer')) return false;
        return true;
      });

  // Source results — a source is included if it appears in effectiveMusicOrder.
  // effectiveMusicOrder is built from searchOrder (user's explicit pick) or defaults minus disabled.
  const deezerTracks = (deezerRes?.tracks || []).map(t => ({
    ...t, id: t.id, title: t.title, artist: t.artist, album: t.album || '',
    artworkURL: t.artworkURL, duration: t.duration, format: t.format || 'mp3',
    // Explicitly preserve isrc so _canonKey can use the ISRC-based dedup path
    // (without this the spread may not carry isrc through to the interleave)
    isrc: t.isrc ? String(t.isrc).toUpperCase().replace(/[^A-Z0-9]/g, '') : null,
  }));
  // Cache deezer track metadata so stream handler can cross-source fallback without query params
  for (const dt of deezerTracks) {
    const rawId = String(dt.id).replace(/^deezer:/, '');
    cacheSet(`dz:track:meta:${rawId}`, { title: dt.title, artist: dt.artist, isrc: dt.isrc ? dt.isrc.toUpperCase().replace(/[^A-Z0-9]/g,'') : null }, 3600);
  }
  // Score tracks by artist-name relevance to the query so that
  // e.g. searching "drake" floats Drake tracks above Nick Drake tracks,
  // while still allowing song-title matches to appear further down.
  const _scoreTrack = (t, q) => {
    if (!q) return 0;
    const aName = (typeof t.artist === 'string' ? t.artist : (t.artist?.name || '')).toLowerCase();
    const qLow = q.toLowerCase().trim();
    if (aName === qLow) return 3;           // exact artist match
    if (aName.startsWith(qLow)) return 2;   // artist starts with query
    if (aName.includes(qLow)) return 1;     // artist contains query
    return 0;                               // title/other match
  };
  const _sortByRelevance = (tracks, q) =>
    [...tracks].sort((a, b) => _scoreTrack(b, q) - _scoreTrack(a, q));
  const _q = query || '';
  const musicSourceMap = {
    hifi:   effectiveMusicOrder.includes('hifi')   ? _sortByRelevance(hifiTracksNorm, _q) : [],
    qobuz:  effectiveMusicOrder.includes('qobuz')  ? _sortByRelevance(qobuzTracks, _q)    : [],
    sc:     effectiveMusicOrder.includes('sc')     ? _sortByRelevance(sc, _q)             : [],
    ia:     effectiveMusicOrder.includes('ia')     ? _sortByRelevance(iaMusic, _q)        : [],
    deezer: effectiveMusicOrder.includes('deezer') ? _sortByRelevance(deezerTracks, _q)   : [],
  };
  const musicAlbumMap = {
    hifi:   effectiveMusicOrder.includes('hifi')   ? hifiAlbumList       : [],
    qobuz:  effectiveMusicOrder.includes('qobuz')  ? qobuzAlbums         : [],
    sc:     [],
    ia:     [],
    deezer: effectiveMusicOrder.includes('deezer') ? (deezerRes?.albums || []) : [],
  };

  // ── Canonical dedup ─────────────────────────────────────────────────────────
  // Dedup rules (in order of strictness):
  //   1. ISRC match (exact, cross-source) → always dedup, higher priority wins
  //   2. title + SAME artist + duration bucket (±3 s) → dedup same recording
  //      "First Love" by Gulfateh Khan ≠ "First Love" by BTS — different artist,
  //      so both are kept even though the title matches.
  //   3. No ISRC + same title + different/missing artist → NOT deduped.
  //      This is the key fix: generic title collisions across sources are allowed
  //      through so niche artists don't get swallowed by popular same-title tracks.
  const _normStr = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
  // Normalize artist: strip featured artists, "the/a/an" prefix, whitespace
  const _normArtist = raw => {
    const base = String(raw || '').split(/[,&]|\s+(?:feat|ft|with|x)/i)[0];
    const n = _normStr(base);
    return n.replace(/^(the|a|an)/, '').replace(/^0+/, '').trim() || n;
  };

  // _canonKey returns ALL keys that should be marked/checked for this item.
  // Returns an array: [primaryKey, ...secondaryKeys]
  // primaryKey  = isrc: key (if ISRC present) or ta:+dur key
  // secondaryKeys = ta:+nodur key (always), so a duration-missing copy can match
  const _canonKeys = item => {
    const t = _normStr(item.title || '');
    const a = _normArtist(item.artist || '');
    const dur = (item.duration && item.duration > 5) ? item.duration : 0;
    const db  = dur ? '|d' + (Math.round(dur / 5) * 5) : '';
    const taBase = (t && a) ? ('ta:' + t + '|' + a) : null;
    const taFull = taBase ? (taBase + db) : null;
    const keys = [];
    if (item.isrc) {
      const ik = 'isrc:' + item.isrc.toUpperCase().replace(/[^A-Z0-9]/g, '');
      keys.push(ik);
    }
    if (taFull && taFull !== taBase) keys.push(taFull); // with-duration key
    if (taBase) keys.push(taBase);                       // no-duration key (always added as fallback)
    return keys; // first key is "primary"; all must be checked AND marked
  };

  // Backwards-compat single key for _canonAlbKey (albums don't need multi-key)
  const _canonKey = item => {
    const keys = _canonKeys(item);
    return keys.length ? keys[0] : null;
  };

  const _canonAlbKey = item => {
    const t = _normStr(item.title  || '');
    const a = _normArtist(item.artist || '');
    // year-agnostic: same album missing year on one source still deduped
    const y = item.year ? String(item.year).slice(0, 4) : '';
    const base = 'alb:' + t + '|' + a;
    return y ? base + '|' + y : base;
  };

  // ── Priority-first dedup interleave ────────────────────────────────────────
  // Strategy: drain ALL items from source[0] first (highest priority), marking
  // their ISRC/title+artist+duration keys as seen, THEN source[1], etc.
  // This guarantees the first source in searchOrder wins on duplicates — a Deezer
  // track is NEVER shown if HiFi/Qobuz already has the same song.
  // Duration tolerance: ±3 seconds (strict — avoids deduping edit vs album cuts).
  const interleave = (sourceLists) => {
    // Round-robin with priority dedup:
    // Same position across all sources interleaved, but higher-priority sources
    // pre-claim their ISRC/title+artist keys so lower sources skip exact duplicates.
    // This ensures: (a) all sources contribute unique tracks to results,
    // (b) when the same song exists on multiple sources, the highest-priority version wins.
    const result = [], seenIds = new Set(), seenKeys = new Set();
    // Pre-register keys from all sources in priority order so dedup is priority-aware
    const allItems = [];
    const maxLen = Math.max(0, ...sourceLists.map(l => l.length));
    for (let i = 0; i < maxLen; i++) {
      for (const list of sourceLists) {
        if (i >= list.length) continue;
        const item = list[i];
        if (!item) continue;
        const _rawIk = item.id;
        const ik = _rawIk
          ? String(_rawIk).toLowerCase()
              .replace(/^(deezer|tidal|qobuz|sc|hifi):(?!album:|artist:|playlist:)/i, '')
              .trim()
          : _rawIk;
        if (ik && seenIds.has(ik)) continue;
        const cks = _canonKeys(item);
        const isDupe = cks.some(k => seenKeys.has(k));
        if (isDupe) continue;
        if (ik) seenIds.add(ik);
        for (const k of cks) seenKeys.add(k);
        result.push(item);
      }
    }
    return result;
  };

  const interleaveAlbums = (sourceLists) => {
    // Round-robin with priority dedup (same logic as interleave)
    const result = [], seenIds = new Set(), seenKeys = new Set();
    const maxLen = Math.max(0, ...sourceLists.map(l => l.length));
    for (let i = 0; i < maxLen; i++) {
      for (const list of sourceLists) {
        if (i >= list.length) continue;
        const item = list[i];
        if (!item) continue;
        const ik = item.id;
        if (ik && seenIds.has(ik)) continue;
        // Check both year-keyed and year-agnostic keys so same album deduped regardless
        const t = _normStr(item.title || '');
        const a = _normArtist(item.artist || '');
        const y = item.year ? String(item.year).slice(0, 4) : '';
        const keyBase = 'alb:' + t + '|' + a;
        const keyFull = y ? keyBase + '|' + y : keyBase;
        if (seenKeys.has(keyBase) || seenKeys.has(keyFull)) continue;
        if (ik) seenIds.add(ik);
        seenKeys.add(keyBase);
        if (keyFull !== keyBase) seenKeys.add(keyFull);
        result.push(item);
      }
    }
    return result;
  };

  const orderedTrackLists = effectiveMusicOrder.map(k => musicSourceMap[k] || []);
  const orderedAlbumLists = effectiveMusicOrder.map(k => musicAlbumMap[k] || []);
  let orderedMusicTracks = interleave(orderedTrackLists);
  const orderedMusicAlbums = interleaveAlbums(orderedAlbumLists);

  // ── Blocked ISRC filter ─────────────────────────────────────────────────────
  if (cfg.blockedIsrcs && cfg.blockedIsrcs.length) {
    const _blockedSet = new Set(cfg.blockedIsrcs);
    orderedMusicTracks = orderedMusicTracks.filter(t => {
      if (!t.isrc) return true;
      const norm = String(t.isrc).toUpperCase().replace(/[^A-Z0-9]/g, '');
      return !_blockedSet.has(norm);
    });
  }

  // Merge qobuz playlists into the playlists (allSeries) pool — dedupe by title
  for (const p of qobuzPlaylists) {
    const key = p.title?.toLowerCase().slice(0, 40);
    if (!seriesTitles.has(key)) { seriesTitles.add(key); allSeries.push(p); }
  }

  const _seenArtistNames = new Set();
  const _dedupeArtists = list => list.filter(a => {
    const k = _normStr(a.name || '');
    if (!k) return true;
    if (_seenArtistNames.has(k)) return false;
    _seenArtistNames.add(k); return true;
  });
  const _seenAlbumKeys = new Set();
  const _dedupeAlbums = list => list.filter(a => {
    const _at = _normStr(a.title  || '');
    const _aa = _normArtist(a.artist || '');
    const _ay = a.year ? String(a.year).slice(0, 4) : '';
    if (!_at || !_aa) return true;
    const k    = _at + '|' + _aa + (_ay ? '|' + _ay : '');
    const kNoY = _at + '|' + _aa;
    if (_seenAlbumKeys.has(k) || _seenAlbumKeys.has(kNoY)) return false;
    _seenAlbumKeys.add(k);
    _seenAlbumKeys.add(kNoY);
    return true;
  });

  let allTracks, allAlbums, allArtists;
  if (isPodcastQuery) {
    allTracks  = [...allEpisodes, ...orderedMusicTracks, ...radio];
    allAlbums  = [...podcastAlbums, ...allBooks, ...orderedMusicAlbums];
    allArtists = effectiveMusicOrder.flatMap(k => ({ hifi: hifiArtistList, qobuz: qobuzArtists, deezer: deezerRes?.artists || [], sc: [], ia: [] })[k] || []);
  } else if (isRadioQuery) {
    allTracks  = [...orderedMusicTracks, ...radio, ...allEpisodes];
    allAlbums  = [...orderedMusicAlbums, ...allBooks, ...podcastAlbums];
    allArtists = effectiveMusicOrder.flatMap(k => ({ hifi: hifiArtistList, qobuz: qobuzArtists, deezer: deezerRes?.artists || [], sc: [], ia: [] })[k] || []);
  } else if (isAudiobookQuery) {
    allTracks  = [...orderedMusicTracks, ...allEpisodes, ...radio];
    allAlbums  = [...allBooks, ...orderedMusicAlbums, ...podcastAlbums];
    allArtists = [...qobuzArtists];
  } else {
    allTracks  = [...orderedMusicTracks, ...radio, ...allEpisodes];
    allAlbums  = [...orderedMusicAlbums, ...allBooks, ...podcastAlbums];
    allArtists = effectiveMusicOrder.flatMap(k => ({ hifi: hifiArtistList, qobuz: qobuzArtists, deezer: deezerRes?.artists || [], sc: [], ia: [] })[k] || []);
  }

  allArtists = _dedupeArtists(allArtists);
  allAlbums  = _dedupeAlbums(allAlbums);

  // noExplicit filter: remove explicit tracks when enabled (default: OFF = explicit allowed)
  if (cfg.noExplicit) {
    allTracks = allTracks.filter(t => !t.explicit);
  }

  const result = {
    tracks:    allTracks.slice(0, 60),
    albums:    allAlbums.slice(0, 16),
    artists:   allArtists.slice(0, 10),
    playlists: allSeries.slice(0, 20),
  };

  await cacheSet(cacheKey, result, 180);
  return c.json(result);
}

app.get('/search', handleSearch);
app.get('/:token/search', handleSearch);

// ─── Podcast-only search (/podcast/search) ───────────────────────────────────
async function handlePodcastSearch(c) {
  const query = (c.req.query('q') || '').replace(/\s+/g, ' ').trim();
  if (!query || query.length < 2) return c.json({ tracks: [], albums: [], artists: [], playlists: [] });
  const cfg = getConfig(c);
  const cacheKey = `search:podcast:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const hasPi = !!(cfg.piKey && cfg.piSecret);

  // Run all three in parallel. PI is the primary source when keys are set.
  const [piData, taddyData, itunesData] = await Promise.allSettled([
    hasPi ? piSearchEpisodes(query, cfg.piKey, cfg.piSecret) : Promise.resolve(null),
    taddySearch(query, cfg.taddyKey, cfg.taddyUid),
    appleSearch(query),
  ]);

  const piResult     = piData.status    === 'fulfilled' ? piData.value    : null;
  const taddyResult  = taddyData.status === 'fulfilled' ? taddyData.value : null;
  const itunesResult = itunesData.status === 'fulfilled' ? itunesData.value : null;

  // Log source hit counts so you can confirm PI is working
  console.log(`[podcast/search] query="${query}" PI=${hasPi ? (piResult?.episodes?.length??0)+'ep '+(piResult?.playlists?.length??0)+'feeds' : 'disabled (no pi_key/pi_secret in token)'} Taddy=${taddyResult?.episodes?.length??0}ep Apple=${itunesResult?.episodes?.length??0}ep token=${(c.req.param('token')||'none').slice(0,12)}`);

  // ── PI results ────────────────────────────────────────────────────────────
  const piFeeds    = piResult?.playlists || piResult?.albums || [];
  const piEpisodes = piResult?.episodes || [];
  // Pre-cache PI episode stream URLs so /stream/:id resolves without re-fetching PI API
  for (const ep of piEpisodes) {
    if (ep?.id && ep?.streamURL) cacheSet(`pi:ep:stream:${ep.id}`, ep.streamURL, 3600);
  }

  // ── Taddy results ─────────────────────────────────────────────────────────
  const taddyEpisodes  = taddyResult?.episodes  || [];
  const taddyPlaylists = taddyResult?.playlists || [];

  // ── iTunes/Apple results ──────────────────────────────────────────────────
  const itunesEpisodes  = itunesResult?.episodes  || [];
  const itunesAlbums    = itunesResult?.albums    || [];
  const itunesArtists   = itunesResult?.artists   || [];
  const itunesPlaylists = itunesResult?.playlists || [];

  // ── Tracks: PI first when keys set (most reliable), then Apple, then Taddy ──
  // When PI keys are present, PI episodes go first so results appear even if Apple 429s.
  // When no PI keys, Apple episodes go first (original behaviour).
  const episodeOrder = hasPi
    ? [...piEpisodes, ...itunesEpisodes, ...taddyEpisodes]
    : [...itunesEpisodes, ...piEpisodes, ...taddyEpisodes];

  const allTracks = [];
  const seenTrackTitle = new Set();
  for (const ep of episodeOrder) {
    if (!ep || !ep.streamURL) continue;
    const key = (ep.title || '').toLowerCase().slice(0, 40);
    if (!seenTrackTitle.has(key)) { seenTrackTitle.add(key); allTracks.push(ep); }
  }

  // ── Albums: PI feeds first when keys set, then Apple, then Taddy ─────────
  const allAlbums = [];
  const seenAlbumId = new Set();

  // PI feed albums
  const piFeedAlbums = piFeeds.map(f => ({
    id: f.id || ('pi_feed_' + String(f._feedId || f.feedId || '')),
    title: String(f.title || '').trim(),
    artist: String(f.artist || f.author || f.creator || f.ownerName || '').trim(),
    artworkURL: f.artworkURL || f.image || f.artwork || f.artworkUrl || null,
    trackCount: f.trackCount || f.episodeCount || null,
    year: f.year || (f.newestItemPublishTime ? String(new Date(f.newestItemPublishTime * 1000).getFullYear()) : null),
    source: 'pi',
    _isPodcast: true,
    _feedId: f._feedId || f.feedId || null,
    _feedUrl: f._feedUrl || f.url || null,
  }));

  // Album merge order: PI first when keys set
  const albumOrder = hasPi
    ? [...piFeedAlbums, ...itunesAlbums]
    : [...itunesAlbums, ...piFeedAlbums];

  for (const a of albumOrder) {
    if (a.id && !seenAlbumId.has(a.id)) { seenAlbumId.add(a.id); allAlbums.push(a); }
  }
  // Taddy playlists as albums
  for (const p of taddyPlaylists) {
    const a = { id: p.id, title: p.title, artist: p.creator || '', artworkURL: p.artworkURL || null, trackCount: p.trackCount || null, year: null, source: 'taddy', _isPodcast: true };
    if (a.id && !seenAlbumId.has(a.id)) { seenAlbumId.add(a.id); allAlbums.push(a); }
  }

  // ── Artists: PI authors first when keys set, then iTunes ─────────────────
  const allArtists = [];
  const seenArtistName = new Set();

  // PI feed authors
  for (const f of piFeeds) {
    const name = String(f.author || f.ownerName || '').replace(/\s+/g, ' ').trim();
    const key = name.toLowerCase();
    if (!key || seenArtistName.has(key)) continue;
    seenArtistName.add(key);
    let aId; try { aId = `pi_author_${btoa(unescape(encodeURIComponent(name)))}`; } catch { aId = `pi_author_${name.replace(/[^a-z0-9]/gi,'_')}`; }
    allArtists.push({ id: aId, name, artworkURL: f.image || f.artwork || null, genres: f.categories ? Object.values(f.categories).slice(0, 2) : [], source: 'pi' });
  }
  // iTunes artists
  for (const a of itunesArtists) {
    const key = (a.name || '').toLowerCase();
    if (key && !seenArtistName.has(key)) { seenArtistName.add(key); allArtists.push(a); }
  }

  // ── Playlists: PI rss feeds first when keys set, then Apple, then Taddy ──
  const allPlaylists = [];
  const seenPlaylistId = new Set();

  // PI feeds as playlists
  for (const f of piFeeds) {
    const _fUrl = f._feedUrl || f.url || null;
    let feedId = (f.id && String(f.id).startsWith('rss_')) ? f.id : null;
    if (!feedId && _fUrl) {
      try { feedId = 'rss_' + btoa(unescape(encodeURIComponent(_fUrl))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); } catch { continue; }
    } else if (!feedId) {
      feedId = f.id || null;
    }
    if (!feedId) continue;
    if (seenPlaylistId.has(feedId)) continue;
    seenPlaylistId.add(feedId);
    if (_fUrl) cacheSet(`rss_feed_url:${feedId}`, _fUrl, 86400).catch(() => {});
    allPlaylists.push({ id: feedId, title: String(f.title || '').trim(), creator: String(f.artist || f.author || f.creator || f.ownerName || '').trim(), artworkURL: f.artworkURL || f.image || f.artwork || null, trackCount: f.trackCount || f.episodeCount || null, description: String(f.description || '').slice(0, 200), source: 'pi' });
  }

  // Apple + Taddy playlists after PI
  for (const p of [...itunesPlaylists, ...taddyPlaylists]) {
    if (p.id && !seenPlaylistId.has(p.id)) { seenPlaylistId.add(p.id); allPlaylists.push(p); }
  }

  const result = {
    tracks:    allTracks.slice(0, 30),
    albums:    allAlbums.slice(0, 15),
    artists:   allArtists.slice(0, 6),
    playlists: allPlaylists.slice(0, 8),
  };
  await cacheSet(cacheKey, result, 180);
  return c.json(result);
}

async function handleAudiobookSearch(c) {
  const query = c.req.query('q') || '';
  if (!query) return c.json({ tracks: [], albums: [], artists: [], playlists: [] });
  const cfg = getConfig(c);
  const cacheKey = `search:audiobook:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const [lvoxAlbums, iaBookAlbums] = await Promise.allSettled([
    librivoxSearch(query),
    iaSearchAudiobooks(query),
  ]);

  const get = r => (r.status === 'fulfilled' ? r.value : null) || [];

  const lvox    = get(lvoxAlbums);
  const iaBooks = get(iaBookAlbums);

  // Merge audiobook albums (dedupe by title)
  const bookTitles = new Set();
  const allBooks = [];
  for (const b of [...lvox, ...iaBooks]) {
    const key = b.title?.toLowerCase().slice(0, 40);
    if (!bookTitles.has(key)) { bookTitles.add(key); allBooks.push(b); }
  }

  // Build flat track list from book albums so Eclipse shows them as playable items
  const bookTracks = allBooks.map(b => ({
    id:         b.id,
    title:      b.title,
    artist:     b.artist || b.creator || 'Unknown Author',
    album:      b.title,
    duration:   b.duration || null,
    artworkURL: b.artworkURL || null,
  }));

  // Build artist entries from unique authors
  const authorSeen = new Set();
  const bookAuthors = [];
  for (const b of allBooks) {
    const name = b.artist || b.creator || 'Unknown Author';
    if (!authorSeen.has(name)) {
      authorSeen.add(name);
      bookAuthors.push({
        id:         `author:${encodeURIComponent(name)}`,
        name,
        artworkURL: b.artworkURL || null,
        source:     b.source || 'librivox',
      });
    }
  }

  // Build playlist entries from source collections
  const bookPlaylists = [
    lvox.length > 0 ? {
      id: 'audiobook:collection:librivox',
      title: 'LibriVox — Free Public Domain Audiobooks',
      creator: 'LibriVox',
      trackCount: lvox.length,
      artworkURL: null,
      source: 'librivox',
    } : null,
    iaBooks.length > 0 ? {
      id: 'audiobook:collection:ia',
      title: 'Internet Archive Audiobooks',
      creator: 'Internet Archive',
      trackCount: iaBooks.length,
      artworkURL: null,
      source: 'iabook',
    } : null,
  ].filter(Boolean);

  const result = {
    tracks:    bookTracks.slice(0, 20),
    albums:    allBooks.slice(0, 20),
    artists:   bookAuthors.slice(0, 10),
    playlists: bookPlaylists,
  };
  await cacheSet(cacheKey, result, 180);
  return c.json(result);
}

// ─── Sub-routes for podcast manifest base URL ────────────────────────────────
app.get('/podcast/search',              handlePodcastSearch);
app.get('/:token/podcast/search',       handlePodcastSearch);

// ─── Podcast catalog routes (Eclipse calls /catalog/{type}/{id}.json?search=q) ─
async function handlePodcastCatalog(c) {
  const query = c.req.query('search') || c.req.query('q') || '';
  if (!query || query.trim().length < 1) {
    return c.json({ tracks: [], albums: [], playlists: [] });
  }
  const cfg = getConfig(c);
  const catalogId = c.req.param('id') || '';
  const cacheKey = `catalog:podcast:${catalogId}:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const [podcastData, taddyData, appleData] = await Promise.allSettled([
    piSearchEpisodes(query, cfg.piKey, cfg.piSecret),
    taddySearch(query, cfg.taddyKey, cfg.taddyUid),
    appleSearch(query),
  ]);

  const get = r => (r.status === 'fulfilled' ? r.value : null) || {};
  const piResult    = get(podcastData);
  const taddyResult = get(taddyData);
  const appleResult = get(appleData);

  // Merge episodes (dedupe by title)
  const episodeTitles = new Set();
  const allEpisodes = [];
  for (const ep of [...(piResult.episodes||[]), ...(taddyResult.episodes||[]), ...(appleResult.episodes||[])]) {
    const key = ep.title?.toLowerCase().slice(0, 40);
    if (!episodeTitles.has(key)) { episodeTitles.add(key); allEpisodes.push(ep); }
  }
  // Merge series/playlists (dedupe by title)
  const seriesTitles = new Set();
  const allSeries = [];
  for (const s of [...(piResult.playlists||[]), ...(taddyResult.playlists||[]), ...(appleResult.playlists||[])]) {
    const key = s.title?.toLowerCase().slice(0, 40);
    if (!seriesTitles.has(key)) { seriesTitles.add(key); allSeries.push(s); }
  }
  // Merge podcast show albums (dedupe by id)
  const podcastAlbumSet = new Set();
  const podcastAlbums = [];
  for (const a of [...(piResult.albums||[]), ...(taddyResult.albums||[]), ...(appleResult.albums||[])]) {
    if (!podcastAlbumSet.has(a.id)) { podcastAlbumSet.add(a.id); podcastAlbums.push(a); }
  }

  let result;
  if (catalogId === 'podcast-episodes') {
    result = { tracks: allEpisodes.slice(0, 40), albums: [], artists: [], playlists: [] };
  } else if (catalogId === 'podcast-series') {
    result = { tracks: [], albums: [], artists: [], playlists: allSeries.slice(0, 20) };
  } else if (catalogId === 'podcast-albums') {
    result = { tracks: [], albums: podcastAlbums.slice(0, 12), artists: [], playlists: [] };
  } else {
    result = {
      tracks:    allEpisodes.slice(0, 40),
      albums:    podcastAlbums.slice(0, 12),
      playlists: allSeries.slice(0, 20),
    };
  }
  await cacheSet(cacheKey, result, 180);
  return c.json(result);
}

app.get('/podcast/catalog/:type/:id',           handlePodcastCatalog);
app.get('/:token/podcast/catalog/:type/:id',    handlePodcastCatalog);
app.get('/podcast/stream/:id',          handleStream);
app.get('/:token/podcast/stream/:id',   handleStream);
app.get('/podcast/album/:id',           handleAlbumWithHifi);
app.get('/:token/podcast/album/:id',    handleAlbumWithHifi);
app.get('/podcast/playlist/:id',        handlePlaylist);
app.get('/:token/podcast/playlist/:id', handlePlaylist);
app.get('/podcast/artist/:id',          handleArtist);
app.get('/:token/podcast/artist/:id',   handleArtist);

// ─── Sub-routes for audiobook manifest base URL ──────────────────────────────
app.get('/audiobook/search',               handleAudiobookSearch);
app.get('/:token/audiobook/search',        handleAudiobookSearch);
app.get('/audiobook/stream/:id',           handleStream);
app.get('/:token/audiobook/stream/:id',    handleStream);
app.get('/audiobook/album/:id',            handleAlbumWithHifi);
app.get('/:token/audiobook/album/:id',     handleAlbumWithHifi);
app.get('/audiobook/playlist/:id',         handlePlaylist);
app.get('/:token/audiobook/playlist/:id',  handlePlaylist);
app.get('/audiobook/artist/:id',           handleArtist);
app.get('/:token/audiobook/artist/:id',    handleArtist);


// ─── Radio-only search handler (Radio Browser + SomaFM) ──────────────────────
async function handleRadioSearch(c) {
  const _rlResRs = await applyRateLimit(c, 'search');
  if (_rlResRs) return _rlResRs;
  const query = c.req.query('q') || '';
  if (!query) return c.json({ tracks: [], albums: [], artists: [], playlists: [] });
  const cacheKey = `search:radio:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);

  const [rbRes, somaRes] = await Promise.allSettled([
    radioSearch(query),
    somaFmSearch(query),
  ]);
  const rb   = rbRes.status   === 'fulfilled' ? (rbRes.value   || []) : [];
  const soma = somaRes.status === 'fulfilled' ? (somaRes.value || []) : [];

  // Merge & dedupe by title
  const seen = new Set();
  const combined = [];
  for (const s of [...rb, ...soma]) {
    const key = (s.title || '').toLowerCase().slice(0, 40);
    if (!seen.has(key)) { seen.add(key); combined.push(s); }
  }

  // Build artist entries from unique genres/tags
  const genreMap = new Map();
  for (const s of combined) {
    const tags = (s.artist || '').split(',').map(t => t.trim()).filter(Boolean);
    for (const tag of tags.slice(0, 2)) {
      if (tag && !genreMap.has(tag)) {
        genreMap.set(tag, {
          id:         `radiogenre:${encodeURIComponent(tag)}`,
          name:       tag,
          artworkURL: s.artworkURL || null,
          source:     s.source || 'radio',
        });
      }
    }
  }
  const radioArtists = [...genreMap.values()].slice(0, 10);

  // Build album entries — one per source (Radio Browser / SomaFM)
  const radioAlbums = [
    rb.length > 0 ? {
      id:         'radio:source:radiobrowser',
      title:      'Radio Browser',
      artist:     'Radio Browser',
      artworkURL: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/radio-browser.png',
      trackCount: rb.length,
      year:       0,
      source:     'radio',
    } : null,
    soma.length > 0 ? {
      id:         'radio:source:somafm',
      title:      'SomaFM',
      artist:     'SomaFM',
      artworkURL: 'https://somafm.com/img3/facebook-logo.png',
      trackCount: soma.length,
      year:       0,
      source:     'somafm',
    } : null,
  ].filter(Boolean);

  // Build playlist entries from popular genre buckets
  const GENRE_BUCKETS = ['jazz', 'classical', 'rock', 'pop', 'electronic', 'ambient', 'news', 'talk', 'hip-hop', 'country'];
  const radioPlaylists = GENRE_BUCKETS.map(g => {
    const matches = combined.filter(s => (s.artist || '').toLowerCase().includes(g));
    if (!matches.length) return null;
    return {
      id:         `radioplaylist:${g}`,
      title:      g.charAt(0).toUpperCase() + g.slice(1) + ' Radio',
      creator:    'Radio Browser',
      trackCount: matches.length,
      artworkURL: matches[0]?.artworkURL || null,
      source:     'radio',
    };
  }).filter(Boolean).slice(0, 8);

  const result = {
    tracks:    combined.slice(0, 30),
    albums:    radioAlbums,
    artists:   radioArtists,
    playlists: radioPlaylists,
  };
  await cacheSet(cacheKey, result, 180);
  return c.json(result);
}

// ─── Sub-routes for radio manifest base URL ───────────────────────────────────
app.get('/radio/search',              handleRadioSearch);
app.get('/:token/radio/search',       handleRadioSearch);
app.get('/radio/album/:id',           handleAlbumWithHifi);
app.get('/:token/radio/album/:id',    handleAlbumWithHifi);
app.get('/radio/playlist/:id',        handlePlaylist);
app.get('/:token/radio/playlist/:id', handlePlaylist);
app.get('/radio/artist/:id',          handleArtist);
app.get('/:token/radio/artist/:id',   handleArtist);
app.get('/radio/stream/:id',          handleStream);
app.get('/:token/radio/stream/:id',   handleStream);

// Lightweight resolve for playlist import — HiFi only, skips podcast/radio/IA overhead
// Use this endpoint for per-track lookups during CSV/link playlist imports
async function handleResolve(c) {
  const _rlResRv = await applyRateLimit(c, 'resolve');
  if (_rlResRv) return _rlResRv;
  const query = c.req.query('q') || '';
  if (!query) return c.json({ tracks: [] });
  const cfg = getConfig(c);
  const cacheKey = `resolve:${c.req.param('token') || 'noop'}:${query}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return c.json(cached);
  try {
    // HiFi first — fastest and highest quality
    const hifiResult = await hifiSearch(query, cfg.hifiInstances);
    let tracks = (Array.isArray(hifiResult) ? hifiResult : (hifiResult.tracks || [])).slice(0, 5);
    // SC fallback only if HiFi came back empty
    if (!tracks.length) {
      const scResult = await scSearch(query, cfg.scClientId);
      tracks = (Array.isArray(scResult) ? scResult : (scResult.tracks || [])).slice(0, 5);
    }
    const result = { tracks };
    await cacheSet(cacheKey, result, 300);
    return c.json(result);
  } catch (e) {
    console.warn('[resolve] error:', e.message);
    return c.json({ tracks: [] });
  }
}

app.get('/resolve', handleResolve);
app.get('/:token/resolve', handleResolve);

// Stream resolution
async function handleStream(c) {
  const _rlRes = await applyRateLimit(c, 'stream');
  if (_rlRes) return _rlRes;
  const id = c.req.param('id');
  const cfg = getConfig(c);

  if (id.startsWith('hifi_album_')) {
    const data = await hifiAlbum(id);
    if (data) return c.json(data);
    return c.json({ error: 'HiFi album not found' });
  }

  if (id.startsWith('hifi_')) {
    // Check stream URL cache first — makes repeat plays instant
    const streamCacheKey = `stream:url:${id}`;
    const cachedStream = await cacheGet(streamCacheKey);
    if (cachedStream) return c.json(cachedStream);

    const trackKey = id.slice(5); // strip 'hifi_' -> instB64_origId
    const _hifiStreamOrder = cfg.streamOrder && cfg.streamOrder.length ? cfg.streamOrder : [];
    const _hifiHIdx2 = _hifiStreamOrder.indexOf('hifi');
    const _hifiQIdx2 = _hifiStreamOrder.indexOf('qobuz');
    // If streamOrder is set and hifi is NOT in it (e.g. deezer-only), skip hifi entirely
    const _hifiSkipSelf = _hifiStreamOrder.length > 0 && _hifiHIdx2 === -1;
    // Skip qobuz-first if hifi is skipped, OR hifi ranks higher than qobuz
    const _skipQobuz = _hifiSkipSelf || (_hifiQIdx2 !== -1 && _hifiHIdx2 !== -1 && _hifiHIdx2 < _hifiQIdx2);
    let qMeta = await cacheGet(`hifi:track:meta:${trackKey}`);
    // FIX: if meta not cached yet, do a live HiFi track info fetch to populate it
    if (!_hifiSkipSelf && !qMeta && !_skipQobuz) {
      try {
        const _tkParts = trackKey.split('_');
        const _tkInstB64 = _tkParts[0];
        const _tkOrigId = _tkParts.slice(1).join('_');
        const _tkInst = decodeBase64Url(_tkInstB64);
        // FIX: 2s timeout (was 5s) — don't block Qobuz lookup waiting for slow Tidal instances
        const _tkRes = await axios.get(`${_tkInst}/track/`, {
          params: { id: _tkOrigId }, headers: { 'User-Agent': UA }, timeout: 2000,
        });
        const _tkD = _tkRes.data?.data || _tkRes.data || {};
        const _tkT = _tkD.item || _tkD;
        if (_tkT?.title) {
          const _tkArtists = ((_tkT.artists||[]).filter(a=>a.type==='MAIN'||a.type==='FEATURED').length
            ? (_tkT.artists||[]).filter(a=>a.type==='MAIN'||a.type==='FEATURED')
            : (_tkT.artists||[])).map(a=>a.name).join(', ');
          qMeta = {
            title: _tkT.title,
            artist: _tkArtists || '',
            isrc: _tkT.isrc ? _tkT.isrc.toUpperCase().replace(/[^A-Z0-9]/g,'') : null,
            duration: _tkT.duration ? Math.floor(_tkT.duration) : undefined,
          };
          cacheSet(`hifi:track:meta:${trackKey}`, qMeta, 3600);
        }
      } catch(e) { /* non-fatal — will fall through to native HiFi */ }
    }
    if (!_hifiSkipSelf && !_skipQobuz && (qMeta?.title || qMeta?.isrc)) {
      try {
        const qTrack = await qobuzFindBestTrack(qMeta.title, qMeta.artist, qMeta.isrc || null, c.env, qMeta.duration);
        if (qTrack && qTrack.id) {
          // ISRC cross-check: if we matched by title+artist, verify the Qobuz result's ISRC
          // matches what we expected — prevents wrong-track substitution (e.g. "Remember My Name").
          const _normIsrcStr = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          const _qIsrcOk = !qMeta.isrc          // no expected ISRC — accept any result
            || !qTrack.isrc                      // Qobuz didn't return ISRC — accept
            || _normIsrcStr(qTrack.isrc) === _normIsrcStr(qMeta.isrc); // ISRCs match
          if (!_qIsrcOk) {
            console.warn(`[Qobuz] ISRC mismatch: wanted ${qMeta.isrc}, Qobuz returned ${qTrack.isrc} for "${qMeta.title}" — skipping, falling through to HiFi`);
          } else {
            const qStream = await qobuzStream(qTrack.id, c.env, cfg.preferredQuality);
            if (qStream) {
              const matchInfo = qMeta.isrc ? `ISRC:${qMeta.isrc}` : `"${qMeta.title}" by "${qMeta.artist}"`;
              console.log(`[Qobuz] HIT ${matchInfo} -> id=${qTrack.id} quality=${qStream.quality}`);
              await cacheSet(streamCacheKey, qStream, 280);
              return c.json(qStream);
            }
          }
        }
        console.log(`[Qobuz] no match for "${qMeta.title}" by "${qMeta.artist}"${qMeta.isrc ? ` (ISRC:${qMeta.isrc})` : ''} — falling back to HiFi`);
      } catch(e) {
        console.warn('[Qobuz] error:', e.message);
      }
    }
    // ── HiFi direct stream (skipped if hifi not in streamOrder) ─────────────
    if (!_hifiSkipSelf) {
      const data = await hifiStream(id, cfg.hifiInstances, cfg.preferredQuality);
      if (data) {
        await cacheSet(streamCacheKey, data, 280);
        return c.json(data);
      }
    }

    // HiFi failed or skipped — walk full streamOrder fallback chain
    const meta = await cacheGet(`hifi:track:meta:${trackKey}`);
    if (meta?.title && meta?.artist) {
      const _fbOrder = (_hifiStreamOrder.length
        ? _hifiStreamOrder.filter(s => s !== 'hifi')
        : ['qobuz', 'hifi', 'deezer', 'sc', 'ia'] // default: Qobuz→Tidal→Deezer→SC→IA
      );
      console.log(`[stream fallback] HiFi failed for "${meta.title}", trying parallel: ${_fbOrder.join(',')}`);
      // FIX: run ALL fallback sources in parallel (Promise.any) — cuts latency from ~7s to ~2s
      const _hifiFbAttempts = [];

      if (_fbOrder.includes('qobuz') && !cfg.noQobuz && _skipQobuz) {
        _hifiFbAttempts.push((async () => {
          const qTrack = await qobuzFindBestTrack(meta.title, meta.artist, meta.isrc || null, c.env, meta.duration);
          if (!qTrack?.id) throw new Error('no qobuz track');
          const _qd = (meta.duration && qTrack.duration) ? Math.abs(meta.duration - qTrack.duration) : 0;
          if (_qd > 20) throw new Error(`qobuz dur mismatch ${_qd}s`);
          const qs = await qobuzStream(qTrack.id, c.env, cfg.preferredQuality);
          if (!qs) throw new Error('qobuz stream failed');
          console.log(`[fb-qobuz] HIT "${meta.title}" -> ${qTrack.id}`);
          return { ...qs, fallback: 'qobuz' };
        })());
      }

      if (_fbOrder.includes('deezer') && !cfg.noDeezer) {
        _hifiFbAttempts.push((async () => {
          const dRes = await deezerSearch(`${meta.artist} ${meta.title}`);
          for (const dt of (dRes?.tracks || []).slice(0, 5)) {
            const _dd = (meta.duration && dt.duration) ? Math.abs(meta.duration - dt.duration) : 0;
            if (_dd > 20) continue;
            const ds = await deezerStream(String(dt.id).replace(/^deezer:/i,''), c.env, c.req);
            if (ds) { console.log(`[fb-deezer] HIT "${meta.title}"`); return { ...ds, fallback: 'deezer' }; }
          }
          throw new Error('no deezer match');
        })());
      }

      if (_fbOrder.includes('sc') && !cfg.noSc) {
        _hifiFbAttempts.push((async () => {
          const cid = await getSCClientId(cfg.scClientId);
          if (!cid) throw new Error('no sc client_id');
          const scRes = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
            params: { q: `${meta.artist} ${meta.title}`, client_id: cid, limit: 8 },
            headers: cfg.scOAuthToken ? { Authorization: `OAuth ${cfg.scOAuthToken}` } : {},
            timeout: 5000,
          });
          const scTracks = scRes.data?.collection || [];
          for (const st of scTracks) {
            const _sd = (meta.duration && st.full_duration)
              ? Math.abs(meta.duration - st.full_duration / 1000) : 0;
            if (_sd > 20) continue;
            const scr = await scStream(String(st.id), cid, cfg.scOAuthToken);
            if (!scr || scr._scSnipped) continue;
            console.log(`[fb-sc] HIT "${st.title}" by "${st.user?.username}"`);
            const { _scSnipped, ...clean } = scr;
            return { ...clean, fallback: 'sc' };
          }
          throw new Error('no sc match');
        })());
      }

      if (_hifiFbAttempts.length) {
        try {
          const _hWinner = await Promise.any(_hifiFbAttempts);
          console.log(`[HiFi fallback winner] ${_hWinner.fallback} for "${meta.title}"`);
          await cacheSet(streamCacheKey, _hWinner, 280);
          return c.json(_hWinner);
        } catch(e) {
          console.warn(`[HiFi fallback] all sources failed for "${meta.title}"`);
        }
      }
    }
    return c.json({ error: 'Stream not found — all fallbacks exhausted' });
  }

  if (id.startsWith('sc_')) {
    const origId = id.slice(3);
    const scStreamCacheKey = `stream:url:${id}`;
    const cachedScStream = await cacheGet(scStreamCacheKey);
    if (cachedScStream) return c.json(cachedScStream);

    // If streamOrder is set and sc is NOT in it (e.g. deezer-only), skip sc entirely
    const _scSelfOrder = cfg.streamOrder && cfg.streamOrder.length ? cfg.streamOrder : [];
    const _scSkipSelf = _scSelfOrder.length > 0 && !_scSelfOrder.includes('sc');

    // Respect streamOrder — if user put qobuz/hifi before sc, try those first
    let scMeta0 = await cacheGet(`sc:meta:${origId}`);
    if (!scMeta0) {
      try {
        const _raw = await upstashCmd(c.env, 'GET', `sc:meta:${origId}`);
        if (_raw) { scMeta0 = JSON.parse(_raw); await cacheSet(`sc:meta:${origId}`, scMeta0, 3600); }
      } catch(e) {}
    }
    const _scStreamOrder = cfg.streamOrder && cfg.streamOrder.length ? cfg.streamOrder : [];
    const _scIdx = _scStreamOrder.indexOf('sc');
    const _qIdx  = _scStreamOrder.indexOf('qobuz');
    const _hIdx  = _scStreamOrder.indexOf('hifi');

    // Try Qobuz before SC if qobuz is ranked higher (lower index) than sc
    // FIX: ISRC-gate — only upgrade SC tracks that have a confirmed ISRC.
    // Without ISRC, qobuzFindBestTrack does fuzzy title/artist search which matches wrong tracks
    // on SC-exclusive / indie content. If no ISRC, always play natively on SC.
    if (!_scSkipSelf && scMeta0?.title && scMeta0?.isrc && _qIdx !== -1 && (_scIdx === -1 || _qIdx < _scIdx) && !cfg.noQobuz) {
      try {
        const qTrack = await qobuzFindBestTrack(scMeta0.title, scMeta0.artist, scMeta0.isrc, c.env, scMeta0.duration);
        if (qTrack?.id) {
          const _qDurDiff = (scMeta0.duration && qTrack.duration)
            ? Math.abs(scMeta0.duration - qTrack.duration) : 0;
          // FIX: tighter 5s guard (was 15s) — prevents wrong-track substitution on close matches
          if (_qDurDiff > 5) {
            console.log(`[SC→Qobuz] dur mismatch ${_qDurDiff}s — playing SC natively`);
          } else {
            const qStream = await qobuzStream(qTrack.id, c.env, cfg.preferredQuality);
            if (qStream) {
              console.log(`[SC→Qobuz priority] ISRC:${scMeta0.isrc} → qobuz:${qTrack.id}`);
              await cacheSet(scStreamCacheKey, qStream, 280);
              return c.json(qStream);
            }
          }
        }
      } catch(e) { console.warn('[SC→Qobuz priority]', e.message); }
    }

    // Try HiFi/Tidal before SC if hifi is ranked higher than sc — also ISRC-gated
    if (!_scSkipSelf && scMeta0?.title && scMeta0?.isrc && _hIdx !== -1 && (_scIdx === -1 || _hIdx < _scIdx) && !cfg.noHifi) {
      try {
        const hifiRes = await hifiSearch(`${scMeta0.artist} ${scMeta0.title}`, cfg.hifiInstances);
        const hifiTracks = Array.isArray(hifiRes) ? hifiRes : (hifiRes?.tracks || []);
        for (const ht of hifiTracks.slice(0, 3)) {
          const _hDurDiff = (scMeta0.duration && ht.duration)
            ? Math.abs(scMeta0.duration - ht.duration) : 0;
          if (_hDurDiff > 5) { console.log(`[SC→HiFi] dur mismatch ${_hDurDiff}s — skip`); continue; }
          const hs = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
          if (hs) {
            console.log(`[SC→HiFi priority] ISRC:${scMeta0.isrc} → ${ht.id}`);
            await cacheSet(scStreamCacheKey, hs, 280);
            return c.json(hs);
          }
        }
      } catch(e) { console.warn('[SC→HiFi priority]', e.message); }
    }

    // Skip primary scStream if sc not in streamOrder
    if (!_scSkipSelf) {
      const data = await scStream(origId, cfg.scClientId, cfg.scOAuthToken);
      if (data) {
        const { _scSnipped, ...cleanData } = data;
        await cacheSet(scStreamCacheKey, cleanData, 280);
        return c.json(cleanData);
      }
    }
    // SC failed or skipped — try fallback sources
    let scMeta = scMeta0; // reuse already-fetched meta (includes Upstash lookup)
    if (!scMeta) {
      try {
        const _raw2 = await upstashCmd(c.env, 'GET', `sc:meta:${origId}`);
        if (_raw2) scMeta = JSON.parse(_raw2);
      } catch(e) {}
    }
    // If still no meta, try a live SC track lookup (first-time play before search persisted)
    if (!scMeta?.title) {
      try {
        const cid2 = await getSCClientId(cfg.scClientId);
        if (cid2) {
          const _liveRes = await axios.get(`https://api-v2.soundcloud.com/tracks/${origId}`, {
            params: { client_id: cid2 }, timeout: 5000,
          });
          const _lt = _liveRes.data;
          if (_lt?.title) {
            scMeta = {
              title: _lt.publisher_metadata?.title || _lt.title,
              artist: _lt.publisher_metadata?.artist || _lt.user?.name || _lt.user?.username || '',
              isrc: _lt.publisher_metadata?.isrc || null,
              duration: _lt.duration ? Math.floor(_lt.duration / 1000) : undefined, // FIX: was missing, caused fallback dur checks to always use 0
            };
            cacheSet(`sc:meta:${origId}`, scMeta, 3600);
            upstashCmd(c.env, 'SET', `sc:meta:${origId}`, JSON.stringify(scMeta), 'EX', 86400).catch(()=>{});
          }
        }
      } catch(e) { console.warn('[SC meta live lookup]', e.message); }
    }
    if (scMeta?.title && scMeta?.artist) {
      // Walk streamOrder — only try sources the user has enabled
      const _fbOrder = cfg.streamOrder && cfg.streamOrder.length
        ? cfg.streamOrder.filter(s => s !== 'sc') // SC already failed, skip it
        : []; // no streamOrder set = user didn't restrict streams, use defaults below
      const _tryQobuz = _fbOrder.length ? _fbOrder.includes('qobuz') : !cfg.noQobuz;
      const _tryHifi  = _fbOrder.length ? _fbOrder.includes('hifi')  : !cfg.noHifi;
      const _tryDeezer= _fbOrder.length ? _fbOrder.includes('deezer'): !cfg.noDeezer;
      // Sort fallback sources by streamOrder position
      const _fbSources = [];
      if (_fbOrder.length) {
        for (const s of _fbOrder) {
          if (s === 'qobuz' && _tryQobuz) _fbSources.push('qobuz');
          if (s === 'hifi'  && _tryHifi)  _fbSources.push('hifi');
          if (s === 'deezer'&& _tryDeezer)_fbSources.push('deezer');
        }
      } else {
        if (_tryQobuz) _fbSources.push('qobuz');
        if (_tryHifi)  _fbSources.push('hifi');
        if (_tryDeezer)_fbSources.push('deezer');
        // FIX: if all three flags were false (misconfigured cfg), force a default order so fallback always runs
        if (!_fbSources.length) { _fbSources.push('qobuz', 'hifi', 'deezer'); }
      }
      console.log(`[SC fallback] ${origId} snipped — trying [${_fbSources.join(',')}] in parallel for ${scMeta.title}`);
      // FIX 3: run all fallback sources in parallel with Promise.any() — cuts latency from ~7s to ~2s
      const _scDurSec = scMeta.duration; // already in seconds (divided by 1000 at cache time)
      const _scFbAttempts = [];

      if (_fbSources.includes('qobuz')) {
        _scFbAttempts.push((async () => {
          const qTrack = await qobuzFindBestTrack(scMeta.title, scMeta.artist, scMeta.isrc || null, c.env, _scDurSec);
          if (!qTrack?.id) throw new Error('no qobuz track');
          const _sqd = (_scDurSec && qTrack.duration) ? Math.abs(_scDurSec - qTrack.duration) : 0;
          if (_sqd > 15) throw new Error(`qobuz dur mismatch ${_sqd}s`);
          const qs = await qobuzStream(qTrack.id, c.env, cfg.preferredQuality);
          if (!qs) throw new Error('qobuz stream failed');
          console.log(`[SC→Qobuz] ${scMeta.isrc || scMeta.title} → ${qTrack.id}`);
          statHit('qobuz');
          return { ...qs, fallback: 'qobuz' };
        })());
      }

      if (_fbSources.includes('hifi')) {
        _scFbAttempts.push((async () => {
          const hRes = await hifiSearch(`${scMeta.artist} ${scMeta.title}`, cfg.hifiInstances);
          const hTracks = Array.isArray(hRes) ? hRes : (hRes?.tracks || []);
          for (const ht of hTracks.slice(0, 5)) {
            if (_scDurSec && ht.duration) {
              const _hd = Math.abs(_scDurSec - ht.duration);
              if (_hd > 15) { console.log(`[SC→HiFi] dur mismatch ${_hd}s — skip ${ht.id}`); continue; }
            }
            const hs = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
            if (hs) { console.log(`[SC→HiFi] ${scMeta.title} → ${ht.id}`); return { ...hs, fallback: 'hifi' }; }
          }
          throw new Error('no hifi match');
        })());
      }

      if (_fbSources.includes('deezer')) {
        _scFbAttempts.push((async () => {
          const dzRes = await deezerSearch(`${scMeta.artist} ${scMeta.title}`);
          const dzTracks = dzRes?.tracks || [];
          for (const _dzt of dzTracks.slice(0, 5)) {
            // Deezer duration is in seconds
            if (_scDurSec && _dzt.duration) {
              const _dzd = Math.abs(_scDurSec - _dzt.duration);
              if (_dzd > 15) { console.log(`[SC→Deezer] dur mismatch ${_dzd}s — skip`); continue; }
            }
            const _dzNumId = String(_dzt.id).replace(/^deezer:/i, '');
            const ds = await deezerStream(_dzNumId, c.env, c.req);
            if (ds) { console.log(`[SC→Deezer] ${scMeta.title} → ${_dzNumId}`); statHit('deezer'); return { ...ds, fallback: 'deezer' }; }
          }
          throw new Error('no deezer match');
        })());
      }

      if (_scFbAttempts.length) {
        try {
          const _winner = await Promise.any(_scFbAttempts);
          console.log(`[SC fallback winner] ${_winner.fallback} for ${scMeta.title}`);
          return c.json(_winner);
        } catch(e) {
          console.warn(`[SC fallback] all sources failed for ${scMeta.title}`);
        }
      }
    }
    return c.json({ error: 'SoundCloud stream not found or restricted' });
  }

  if (id.startsWith('ia_music_')) {
    const identifier = id.slice(9);
    const url = await iaGetBestAudioFile(identifier);
    if (url) return c.json({ url, format: 'mp3', quality: 'variable' });
    return c.json({ error: 'IA stream not found' });
  }

  if (id.startsWith('ia_book_')) {
    const identifier = id.slice(8);
    const url = await iaGetBestAudioFile(identifier);
    if (url) return c.json({ url, format: 'mp3', quality: 'variable' });
    return c.json({ error: 'IA audiobook stream not found' });
  }

  if (id.startsWith('qobuz_')) {
    const qobuzId = id.slice(6);
    const sCacheKey = `stream:url:${id}`;
    const cachedQStream = await cacheGet(sCacheKey);
    if (cachedQStream) return c.json(cachedQStream);
    // If streamOrder is set and qobuz is NOT in it (e.g. deezer-only), skip qobuz entirely
    const _qSelfOrder = cfg.streamOrder && cfg.streamOrder.length ? cfg.streamOrder : [];
    const _qSkipSelf = _qSelfOrder.length > 0 && !_qSelfOrder.includes('qobuz');
    if (!_qSkipSelf) {
      try {
        const result = await qobuzStream(qobuzId, c.env, cfg.preferredQuality);
        if (result) {
          await cacheSet(sCacheKey, result, 280);
          return c.json(result);
        }
      } catch(e) { console.warn('[qobuz direct stream]', e.message); }
    }
    // Qobuz failed or skipped — try fallback sources in parallel
    const _qMeta = await cacheGet(`qobuz:track:meta:${qobuzId}`);
    if (_qMeta?.title) {
      const _qFbOrder = (cfg.streamOrder?.length
        ? cfg.streamOrder.filter(s => s !== 'qobuz')
        : ['hifi', 'deezer', 'sc']
      );
      console.log(`[qobuz fallback] "${_qMeta.title}" trying parallel: ${_qFbOrder.join(',')}`);
      const _qFbAttempts = [];

      if (_qFbOrder.includes('hifi') && !cfg.noHifi) {
        _qFbAttempts.push((async () => {
          const _hRes = await hifiSearch(`${_qMeta.artist} ${_qMeta.title}`, cfg.hifiInstances);
          const _hTracks = Array.isArray(_hRes) ? _hRes : (_hRes?.tracks || []);
          for (const _ht of _hTracks.slice(0, 5)) {
            const _hd = (_qMeta.duration && _ht.duration) ? Math.abs(_qMeta.duration - _ht.duration) : 0;
            if (_hd > 20) continue;
            const _hs = await hifiStream(_ht.id, cfg.hifiInstances, cfg.preferredQuality);
            if (_hs) { console.log(`[qobuz fb-hifi] HIT "${_qMeta.title}"`); return { ..._hs, fallback: 'hifi' }; }
          }
          throw new Error('no hifi match');
        })());
      }

      if (_qFbOrder.includes('deezer') && !cfg.noDeezer) {
        _qFbAttempts.push((async () => {
          const _dRes = await deezerSearch(`${_qMeta.artist} ${_qMeta.title}`);
          for (const _dt of (_dRes?.tracks || []).slice(0, 5)) {
            const _dd = (_qMeta.duration && _dt.duration) ? Math.abs(_qMeta.duration - _dt.duration) : 0;
            if (_dd > 20) continue;
            const _ds = await deezerStream(String(_dt.id).replace(/^deezer:/i,''), c.env, c.req);
            if (_ds) { console.log(`[qobuz fb-deezer] HIT "${_qMeta.title}"`); return { ..._ds, fallback: 'deezer' }; }
          }
          throw new Error('no deezer match');
        })());
      }

      if (_qFbOrder.includes('sc') && !cfg.noSc) {
        _qFbAttempts.push((async () => {
          const _cid = await getSCClientId(cfg.scClientId);
          if (!_cid) throw new Error('no sc client_id');
          const _scR = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
            params: { q: `${_qMeta.artist} ${_qMeta.title}`, client_id: _cid, limit: 8 },
            headers: cfg.scOAuthToken ? { Authorization: `OAuth ${cfg.scOAuthToken}` } : {},
            timeout: 5000,
          });
          for (const _st of (_scR.data?.collection || [])) {
            const _sd = (_qMeta.duration && _st.full_duration)
              ? Math.abs(_qMeta.duration - _st.full_duration / 1000) : 0;
            if (_sd > 20) continue;
            const _ss = await scStream(String(_st.id), _cid, cfg.scOAuthToken);
            if (_ss && !_ss._scSnipped) {
              console.log(`[qobuz fb-sc] HIT "${_st.title}"`);
              const { _scSnipped, ...clean } = _ss;
              return { ...clean, fallback: 'sc' };
            }
          }
          throw new Error('no sc match');
        })());
      }

      if (_qFbAttempts.length) {
        try {
          const _qWinner = await Promise.any(_qFbAttempts);
          console.log(`[Qobuz fallback winner] ${_qWinner.fallback} for "${_qMeta.title}"`);
          await cacheSet(sCacheKey, _qWinner, 280);
          return c.json(_qWinner);
        } catch(e) {
          console.warn(`[Qobuz fallback] all sources failed for "${_qMeta.title}"`);
        }
      }
    }
    return c.json({ error: 'Stream not found — all fallbacks exhausted' });
  }

  if (id.startsWith('radio_')) {
    // Radio stream URLs are stored directly in search results as streamURL
    // If we get here, try to find from cache
    return c.json({ error: 'Radio stream: use streamURL from search result' });
  }

  // ── Podcast Index episode stream ──────────────────────────────────────────
  if (id.startsWith('pi_ep_')) {
    const piCached = await cacheGet(`pi:ep:stream:${id}`);
    if (piCached) return c.json({ url: piCached, format: detectFormat(piCached), quality: 'variable' });
    const epId = id.replace('pi_ep_', '');
    const cfg2 = getConfig(c);
    if (cfg2.piKey && cfg2.piSecret) {
      try {
        const _h = await podcastIndexHeaders(cfg2.piKey, cfg2.piSecret);
        const lu = await axios.get('https://api.podcastindex.org/api/1.0/episodes/byid', {
          params: { id: epId },
          headers: _h,
          timeout: 8000,
        });
        const ep = lu.data?.episode;
        const url = ep?.enclosureUrl || ep?.enclosure?.url;
        if (url) {
          await cacheSet(`pi:ep:stream:${id}`, url, 3600);
          return c.json({ url, format: detectFormat(url), quality: 'variable' });
        }
      } catch (e) { console.warn('[PI stream]', e.message); }
    }
    return c.json({ error: 'Podcast Index episode stream not found: ' + id });
  }

  // ── Taddy episode stream ────────────────────────────────────────────────────
  if (id.startsWith('taddy_ep_')) {
    const tCached = await cacheGet(`taddy:ep:stream:${id}`);
    if (tCached) return c.json({ url: tCached, format: detectFormat(tCached), quality: 'variable' });
    const epUuid = id.replace('taddy_ep_', '');
    const cfg3 = getConfig(c);
    if (cfg3.taddyKey && cfg3.taddyUid) {
      try {
        const gql = `query { getPodcastEpisode(uuid: "${epUuid}") { uuid name audioUrl duration imageUrl podcastSeries { uuid name imageUrl } } }`;
        const r = await axios.post('https://api.taddy.org', { query: gql }, {
          headers: {
            'Content-Type': 'application/json',
            'X-USER-ID': String(cfg3.taddyUid),
            'X-API-KEY': cfg3.taddyKey,
            'User-Agent': 'EclipseAllInOne/1.0',
          },
          timeout: 10000,
        });
        const ep = r.data?.data?.getPodcastEpisode;
        if (ep?.audioUrl) {
          await cacheSet(`taddy:ep:stream:${id}`, ep.audioUrl, 3600);
          return c.json({ url: ep.audioUrl, format: detectFormat(ep.audioUrl), quality: 'variable' });
        }
      } catch (e) { console.warn('[Taddy stream]', e.message); }
    }
    return c.json({ error: 'Taddy episode stream not found: ' + id });
  }

  // ── Apple Podcast episode stream ────────────────────────────────────────────
  if (id.startsWith('apple_ep_')) {
    const cachedUrl = await cacheGet(`apple:ep:stream:${id}`);
    if (cachedUrl) {
      return c.json({ url: cachedUrl, format: cachedUrl.includes('.m4a') ? 'aac' : 'mp3', quality: 'variable' });
    }
    const trackId = id.startsWith('apple_ep_rss_') ? null : id.slice('apple_ep_'.length);
    if (trackId && /^[0-9]+$/.test(trackId)) {
      try {
        const lu = await axios.get('https://itunes.apple.com/lookup', {
          params: { id: trackId, media: 'podcast', entity: 'podcastEpisode', limit: 1 },
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          timeout: 5000,
        });
        const ep = (lu.data?.results || []).find(r => r.kind === 'podcast-episode' || r.wrapperType === 'track');
        const url = ep?.episodeUrl;
        if (url) {
          await cacheSet(`apple:ep:stream:${id}`, url, 3600);
          return c.json({ url, format: 'mp3', quality: 'variable' });
        }
      } catch (e) {
        console.warn('[Apple] episode stream lookup error:', e.message);
      }
    }
    return c.json({ error: 'Apple Podcast episode stream URL not found' });
  }

  if (id.startsWith('lvox_')) {
    return c.json({ error: 'LibriVox: use /album/{id} and browse chapters' });
  }

  // ── Deezer stream (early return — BEFORE social fallback) ──────────────────
  if (id.startsWith('deezer:') || id.toLowerCase().startsWith('deezer%3a')) {
    const dzId = decodeURIComponent(id).replace(/^deezer(?::|%3A)/i, '');

    // Respect streamOrder — try qobuz/hifi before deezer if ranked higher
    const _dzStreamOrder = cfg.streamOrder && cfg.streamOrder.length ? cfg.streamOrder : [];
    const _dzIdx  = _dzStreamOrder.indexOf('deezer');
    const _dzQIdx = _dzStreamOrder.indexOf('qobuz');
    const _dzHIdx = _dzStreamOrder.indexOf('hifi');
    const dzIsrc0 = c.req.query('isrc') ? String(c.req.query('isrc')).trim().toUpperCase() : null;
    const dzTitle = c.req.query('title')  ? decodeURIComponent(c.req.query('title')).trim()  : '';
    const dzArtist= c.req.query('artist') ? decodeURIComponent(c.req.query('artist')).trim() : '';

    // Load cached track metadata so we can cross-source even without query params
    const _dzCachedMeta = await cacheGet(`dz:track:meta:${dzId}`);
    const dzTitle2  = dzTitle  || _dzCachedMeta?.title  || '';
    const dzArtist2 = dzArtist || _dzCachedMeta?.artist || '';
    const dzIsrc    = dzIsrc0  || _dzCachedMeta?.isrc   || null;

    // FIX: when streamOrder is set and non-empty, treat any source NOT in it as disabled.
    // e.g. streamOrder=['deezer'] → qobuz/hifi/sc are all implicitly excluded,
    // even if cfg.noQobuz etc. aren't explicitly true.
    const _dzHasExplicitOrder = _dzStreamOrder.length > 0;
    const _dzEffNoQobuz = _dzHasExplicitOrder ? !_dzStreamOrder.includes('qobuz') : (cfg.noQobuz || false);
    const _dzEffNoHifi  = _dzHasExplicitOrder ? !_dzStreamOrder.includes('hifi')  : (cfg.noHifi  || false);
    const _dzEffNoSc    = _dzHasExplicitOrder ? !_dzStreamOrder.includes('sc')    : (cfg.noSc    || false);

    // If deezer is NOT in streamOrder, skip deezerStream() entirely and cross-source immediately
    const dzSkipDeezer = _dzIdx === -1 && _dzStreamOrder.length > 0; // skip when streamOrder is set and deezer not in it

    // Stream order respected: if qobuz or hifi ranks BEFORE deezer in streamOrder,
    // try them first using ISRC/title lookup before falling back to native Deezer.
    // dzSkipDeezer is true only when streamOrder explicitly excludes deezer entirely.
    const _dzQFirst = !_dzEffNoQobuz && _dzQIdx !== -1 && _dzIdx !== -1 && _dzQIdx < _dzIdx;
    const _dzHFirst = !_dzEffNoHifi  && _dzHIdx !== -1 && _dzIdx !== -1 && _dzHIdx < _dzIdx;

    if (_dzQFirst && (dzIsrc || dzTitle2)) {
      try {
        const qTrack = dzIsrc
          ? await qobuzFindByIsrc(dzIsrc)
          : await qobuzFindBestTrack(dzTitle2, dzArtist2, null, c.env, _dzCachedMeta?.duration);
        if (qTrack?.id) {
          const qStream = await qobuzStream(qTrack.id, c.env, cfg.preferredQuality);
          if (qStream) {
            console.log(`[Deezer→Qobuz priority] ${dzIsrc || dzTitle2}`);
            return c.json({ ...qStream, fallbackSource: 'qobuz' });
          }
        }
      } catch(e) { console.warn('[Deezer→Qobuz priority]', e.message); }
    }

    if (_dzHFirst && (dzIsrc || dzTitle2)) {
      try {
        const _hRes2 = await hifiSearch(`${dzArtist2} ${dzTitle2}`, cfg.hifiInstances);
        const _htList2 = Array.isArray(_hRes2) ? _hRes2 : (_hRes2?.tracks || []);
        for (const ht of _htList2.slice(0, 3)) {
          const _htIsrc2 = ht.isrc ? String(ht.isrc).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
          if (dzIsrc && _htIsrc2 && _htIsrc2 !== dzIsrc) continue;
          const hs = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
          if (hs) {
            console.log(`[Deezer→HiFi priority] ${dzIsrc || dzTitle2}`);
            return c.json({ ...hs, fallbackSource: 'hifi' });
          }
        }
      } catch(e) { console.warn('[Deezer→HiFi priority]', e.message); }
    }

    if (dzSkipDeezer) {
      // Deezer excluded from streamOrder — go straight to other sources
      if (!_dzEffNoQobuz && dzTitle2) {
        try {
          const qTrack = dzIsrc ? await qobuzFindByIsrc(dzIsrc) : await qobuzFindBestTrack(dzTitle2, dzArtist2, dzIsrc, c.env);
          if (qTrack?.id) { const qStream = await qobuzStream(qTrack.id, c.env, cfg.preferredQuality); if (qStream) { console.log(`[Deezer→Qobuz skip] ${dzTitle2}`); return c.json(qStream); } }
        } catch(e) { console.warn('[Deezer→Qobuz skip]', e.message); }
      }
      if (!_dzEffNoHifi && dzTitle2) {
        try {
          const hifiRes = await hifiSearch(`${dzArtist2} ${dzTitle2}`, cfg.hifiInstances);
          for (const ht of (Array.isArray(hifiRes) ? hifiRes : (hifiRes?.tracks || [])).slice(0, 3)) {
            const hs = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
            if (hs) { console.log(`[Deezer→HiFi skip] ${dzTitle2}`); return c.json(hs); }
          }
        } catch(e) { console.warn('[Deezer→HiFi skip]', e.message); }
      }
      if (!_dzEffNoSc && dzTitle2) {
        try {
          const cid = await getSCClientId(cfg.scClientId);
          if (cid) {
            const scRes = await axios.get('https://api-v2.soundcloud.com/search/tracks', { params: { q: `${dzArtist2} ${dzTitle2}`, client_id: cid, limit: 5 }, timeout: 5000 });
            const scTrack = (scRes.data?.collection || []).find(t => t.streamable);
            if (scTrack) { const r = await scStream(String(scTrack.id), cid, cfg.scOAuthToken); if (r) { console.log(`[Deezer→SC skip] ${dzTitle2}`); return c.json({ ...r, fallback: 'sc' }); } }
          }
        } catch(e) { console.warn('[Deezer→SC skip]', e.message); }
      }
      return c.json({ error: 'Deezer stream not found' }, 404);
    }

    // Deezer IS in streamOrder (or no explicit order) — try it directly first
    if (!dzSkipDeezer) {
      // ISRC fast path: if we have an ISRC, confirm the correct Deezer track ID first
      // Race ISRC correction lookup against direct stream in parallel.
      // If ISRC resolves to a DIFFERENT id, prefer that — otherwise use direct result.
      if (dzIsrc) {
        const [isrcResult, directResult] = await Promise.allSettled([
          deezerFindByIsrc(dzIsrc).catch(() => null),
          deezerStream(dzId, c.env, c.req, dzIsrc || null).catch(() => null),
        ]);
        const byIsrc = isrcResult.status === 'fulfilled' ? isrcResult.value : null;
        const direct = directResult.status === 'fulfilled' ? directResult.value : null;
        // If ISRC pointed to a different (corrected) track ID, stream that instead
        if (byIsrc?.numericId && byIsrc.numericId !== dzId) {
          try {
            const isrcStream = await deezerStream(byIsrc.numericId, c.env, c.req, dzIsrc);
            if (isrcStream) {
              console.log(`[Deezer] ISRC-confirmed stream ${dzIsrc} -> id=${byIsrc.numericId} (URL had id=${dzId})`);
              return c.json(isrcStream);
            }
          } catch (e) { console.warn('[Deezer ISRC fast path]', e.message); }
        }
        if (direct) return c.json(direct);
      } else {
        const s = await deezerStream(dzId, c.env, c.req, null);
        if (s) return c.json(s);
      }
      console.log(`[Deezer direct] stream failed for ${dzId} — falling back to upgrade sources`);
      // Deezer failed — walk full streamOrder for best available source
      const _dzFbOrder = cfg.streamOrder && cfg.streamOrder.length
        ? cfg.streamOrder.filter(x => x !== 'deezer')
        : ['qobuz', 'hifi', 'sc'];
      // Hard-stop: if streamOrder was explicit and only had deezer, don't bleed into other sources
      if (cfg.streamOrder && cfg.streamOrder.length > 0 && _dzFbOrder.length === 0) {
        return c.json({ error: 'Deezer stream not found' }, 404);
      }
      for (const _fbSrc of _dzFbOrder) {
        if (_fbSrc === 'qobuz' && !_dzEffNoQobuz) {
          try {
            const qTrack = dzIsrc
              ? await qobuzFindByIsrc(dzIsrc)
              : (dzTitle2 ? await qobuzFindBestTrack(dzTitle2, dzArtist2, null, c.env) : null);
            if (qTrack?.id) {
              const qStream = await qobuzStream(qTrack.id, c.env, cfg.preferredQuality);
              if (qStream) { console.log(`[Deezer→Qobuz fallback] ${dzIsrc || dzTitle2}`); return c.json({ ...qStream, fallback: 'qobuz' }); }
            }
          } catch(e) { console.warn('[Deezer→Qobuz fallback]', e.message); }
        }
        if (_fbSrc === 'hifi' && !_dzEffNoHifi && dzTitle2) {
          try {
            const hifiRes = await hifiSearch(`${dzArtist2} ${dzTitle2}`, cfg.hifiInstances);
            const hifiTracks = Array.isArray(hifiRes) ? hifiRes : (hifiRes?.tracks || []);
            for (const ht of hifiTracks.slice(0, 3)) {
              const hs = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
              if (hs) { console.log(`[Deezer→HiFi fallback] ${dzTitle2}`); return c.json({ ...hs, fallback: 'hifi' }); }
            }
          } catch(e) { console.warn('[Deezer→HiFi fallback]', e.message); }
        }
        if (_fbSrc === 'sc' && !cfg.noSc && dzTitle2) {
          try {
            const cid = await getSCClientId(cfg.scClientId);
            if (cid) {
              const scRes = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
                params: { q: `${dzArtist2} ${dzTitle2}`, client_id: cid, limit: 5 }, timeout: 5000,
              });
              const scTrack = (scRes.data?.collection || []).find(t => t.streamable);
              if (scTrack) {
                const _dzScResult2 = await scStream(String(scTrack.id), cid, cfg.scOAuthToken);
                if (_dzScResult2) { console.log(`[Deezer→SC fallback] ${dzTitle2}`); return c.json({ ..._dzScResult2, fallback: 'sc' }); }
              }
            }
          } catch(e) { console.warn('[Deezer→SC fallback]', e.message); }
        }
      }
    }

    return c.json({ error: 'Deezer stream not found' }, 404);
  }

  // ── Social/Community Tab & Cross-Addon Track Fallback ───────────────────────
  // Tracks from Social/Community tab or other addons (Apple Music, Tidal, Deezer,
  // Spotify, etc.) arrive with foreign ID prefixes this addon doesn't own.
  // Eclipse passes ?title=&artist= query params alongside the foreign ID —
  // we use those to search our own sources for the best match.
  //
  // Strategy:
  //   0. Extract search query: prefer ?title+artist params, fall back to raw ID.
  //   1. Bare numeric ID → try HiFi directly (likely a Tidal track ID).
  //   2. HiFi search using title+artist — best quality.
  //   3. SC search using title+artist — broad availability.
  //   4. Last resort: HiFi search using raw ID string.
  {
    const rawId = id;
    const decodedId = (() => { try { return decodeURIComponent(rawId); } catch (e) { return rawId; } })();

    // Eclipse passes title/artist as query params for cross-addon tracks
    const qTitle  = c.req.query('title')  ? decodeURIComponent(c.req.query('title')).trim()  : '';
    const qArtist = c.req.query('artist') ? decodeURIComponent(c.req.query('artist')).trim() : '';
    const searchQuery = (qTitle && qArtist)
      ? `${qArtist} ${qTitle}`
      : (qTitle || qArtist || decodedId);

    const qIsrc = c.req.query('isrc') ? String(c.req.query('isrc')).trim().toUpperCase() : '';
    console.log(`[Social fallback] id="${decodedId}" title="${qTitle}" artist="${qArtist}" isrc="${qIsrc}" → query="${searchQuery}"`);

    // 0. ISRC fast path — try Qobuz exact match before any search
    if (qIsrc && !cfg.noQobuz) {
      try {
        const qTrack = await qobuzFindByIsrc(qIsrc);
        if (qTrack?.id) {
          const qStream = await qobuzStream(qTrack.id, c.env, cfg.preferredQuality);
          if (qStream) { console.log(`[Social→Qobuz ISRC] ${qIsrc} → ${qTrack.id}`); statHit('qobuz'); return c.json({ ...qStream, fallback: 'qobuz_isrc' }); }
        }
      } catch(e) { console.warn('[Social→Qobuz ISRC]', e.message); }
    }

    const cid = await getSCClientId(cfg.scClientId);
    const _socialInstances = (cfg.hifiInstances && cfg.hifiInstances.length) ? cfg.hifiInstances : DEFAULT_HIFI_INSTANCES;

    // 1. Bare numeric ID → try HiFi directly as a Tidal track ID
    if (/^\d+$/.test(decodedId)) {
      let hifiDirectResult = null;
      for (const _inst of _socialInstances) {
        const instB64 = encodeBase64Url(_inst);
        const syntheticHifiId = `hifi_${instB64}_${decodedId}`;
        hifiDirectResult = await hifiStream(syntheticHifiId, cfg.hifiInstances, cfg.preferredQuality);
        if (hifiDirectResult) break;
      }
      if (hifiDirectResult) {
        console.log(`[Social fallback] HiFi direct stream success for numeric ID ${decodedId}`);
        return c.json({ ...hifiDirectResult, fallback: 'social_hifi_direct' });
      }
    }

    // 2. HiFi search using title+artist (or raw ID as fallback query)
    if (searchQuery.length > 1) {
      try {
        console.log(`[Social fallback] HiFi search: "${searchQuery}"`);
        const hifiSearchResult = await hifiSearch(searchQuery, cfg.hifiInstances);
        const hifiTracks = Array.isArray(hifiSearchResult) ? hifiSearchResult : (hifiSearchResult?.tracks || []);
        for (const ht of hifiTracks.slice(0, 5)) {
          const hifiStreamResult = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
          if (hifiStreamResult) {
            console.log(`[Social fallback] HiFi matched: "${ht.title}" by "${ht.artist}"`);
            return c.json({ ...hifiStreamResult, fallback: 'social_hifi_search' });
          }
        }
      } catch (e) {
        console.warn('[Social fallback] HiFi search failed:', e.message);
      }

      // 3. SoundCloud search using title+artist
      if (cid) {
        try {
          console.log(`[Social fallback] SC search: "${searchQuery}"`);
          const scSearchRes = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
            params: { q: searchQuery, client_id: cid, limit: 5 },
            timeout: 8000,
          });
          const candidates = scSearchRes.data?.collection || [];
          const streamAttempts = await Promise.all(
            candidates.map(t => scStream(String(t.id), cid).then(r => ({ r, t })).catch(() => ({ r: null, t })))
          );
          for (const { r, t } of streamAttempts) {
            if (r && !r._scSnipped) {
              console.log(`[Social fallback] SC matched: "${t.title}" by "${t.user?.username}"`);
              const { _scSnipped, ...clean } = r;
              return c.json({ ...clean, fallback: 'social_sc' });
            }
          }
        } catch (e) {
          console.warn('[Social fallback] SC search failed:', e.message);
        }
      }

      // 4. Last resort: if no title/artist params, try HiFi with raw ID as query
      if (!qTitle && !qArtist) {
        try {
          console.log(`[Social fallback] last resort HiFi for raw id: "${decodedId}"`);
          const hifiSearchResult2 = await hifiSearch(decodedId, cfg.hifiInstances);
          const hifiTracks2 = Array.isArray(hifiSearchResult2) ? hifiSearchResult2 : (hifiSearchResult2?.tracks || []);
          for (const ht of hifiTracks2.slice(0, 3)) {
            const hifiStreamResult = await hifiStream(ht.id, cfg.hifiInstances, cfg.preferredQuality);
            if (hifiStreamResult) {
              console.log(`[Social fallback] last resort HiFi matched: "${ht.title}"`);
              return c.json({ ...hifiStreamResult, fallback: 'social_hifi_lastresort' });
            }
          }
        } catch (e) {
          console.warn('[Social fallback] last resort HiFi failed:', e.message);
        }
      }
    }
  }

  // ── Deezer stream ───────────────────────────────────────────────────────
    c.json({ error: 'Unknown stream ID — could not resolve via any source' }, 404);
}

app.get('/stream/:id', handleStream);
app.get('/:token/stream/:id', handleStream);

// Album detail (audiobooks)
async function handleAlbum(c) {
  const _rlResAlb = await applyRateLimit(c, 'catalog');
  if (_rlResAlb) return _rlResAlb;
  const id = c.req.param('id');

  if (id.startsWith('lvox_')) {
    const bookId = id.slice(5);
    const cacheKey = `album:lvox:${bookId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    // Look up book info
    try {
      const infoRes = await axios.get('https://librivox.org/api/feed/audiobooks', {
        params: { id: bookId, format: 'json', extended: 1 },
        timeout: 5000,
      });
      const book = infoRes.data?.books?.[0] || {};
      const rssUrl = book.url_rss || `https://librivox.org/rss/${bookId}`;
      const author = (book.authors || []).map(a => `${a.first_name} ${a.last_name}`).join(', ') || 'Unknown Author';
      const chapters = await librivoxGetChapters(bookId, rssUrl);
      const albumData = {
        id,
        title: book.title || `LibriVox Book ${bookId}`,
        artist: author,
        artworkURL: '',
        year: safeYear(book.copyright_year),
        description: book.description || '',
        trackCount: chapters.length,
        tracks: chapters.map((c, i) => ({
          id: `lvox_ch_${bookId}_${i}`,
          title: c.title,
          artist: author,
          duration: c.duration,
          streamURL: c.url,
          format: 'mp3',
        })),
      };
      await cacheSet(cacheKey, albumData, 3600);
      return c.json(albumData);
    } catch (e) {
      return c.json({ error: 'LibriVox album fetch failed' });
    }
  }

  if (id.startsWith('ia_book_')) {
    const identifier = id.slice(8);
    const cacheKey = `album:ia_book:${identifier}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    try {
      const meta = await axios.get(`https://archive.org/metadata/${identifier}`, { timeout: 6000 });
      const m = meta.data?.metadata || {};
      const files = (meta.data?.files || [])
        .filter(f => ['mp3','ogg','flac'].some(ext => f.name?.toLowerCase().endsWith(`.${ext}`)) && f.source !== 'metadata')
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const albumData = {
        id,
        title: Array.isArray(m.title) ? m.title[0] : (m.title || identifier),
        artist: Array.isArray(m.creator) ? m.creator[0] : (m.creator || 'Unknown'),
        artworkURL: `https://archive.org/services/img/${identifier}`,
        year: safeYear(m.date),
        description: Array.isArray(m.description) ? m.description[0] : (m.description || ''),
        trackCount: files.length,
        tracks: files.map((f, i) => ({
          id: `ia_book_file_${identifier}_${i}`,
          title: f.title || f.name?.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') || `Track ${i + 1}`,
          artist: Array.isArray(m.creator) ? m.creator[0] : (m.creator || 'Unknown'),
          duration: f.length ? parseInt(f.length) : 0,
          streamURL: `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`,
          format: f.name?.split('.').pop()?.toLowerCase() || 'mp3',
        })),
      };
      await cacheSet(cacheKey, albumData, 3600);
      return c.json(albumData);
    } catch {
      return c.json({ error: 'IA audiobook album fetch failed' });
    }
  }

  // ── Deezer album/artist/playlist ────────────────────────────────────────
  if (id.startsWith('deezer:album:')) {
    const data = await deezerAlbum(id.replace('deezer:album:', ''));
    if (data) return c.json(data);
    return c.json({ error: 'Deezer album not found' }, 404);
  }
  if (id.startsWith('deezer:artist:')) {
    const data = await deezerArtist(id.replace('deezer:artist:', ''));
    if (data) return c.json(data);
    return c.json({ error: 'Deezer artist not found' }, 404);
  }
  if (id.startsWith('deezer:playlist:')) {
    const data = await deezerPlaylist(id.replace('deezer:playlist:', ''));
    if (data) return c.json(data);
    return c.json({ error: 'Deezer playlist not found' }, 404);
  }
  if (id.startsWith('deezer:')) {
    // bare deezer track id — return single-track album shell
    const trackId = id.replace('deezer:', '');
    const data = await deezerAlbum(trackId).catch(() => null);
    if (data) return c.json(data);
    return c.json({ error: 'Deezer item not found' }, 404);
  }
    c.json({ error: 'Album not found' }, 404);
}

async function handleAlbumWithHifi(c) {
  const _rlResAwh = await applyRateLimit(c, 'catalog');
  if (_rlResAwh) return _rlResAwh;
  const id = c.req.param('id');
  const cfg = getConfig(c);

  // ── HiFi album ──────────────────────────────────────────────────────────
  if (id.startsWith('hifi_album_')) {
    const data = await hifiAlbum(id);
    if (data) return c.json(data);
    return c.json({ error: 'HiFi album not found' });
  }

  if (id.startsWith('qobuzalbum_')) {
    const qobuzAlbumId = id.slice(11);
    const aCacheKey = `qobuz:album:${qobuzAlbumId}`;
    const cachedAlbum = await cacheGet(aCacheKey);
    if (cachedAlbum) return c.json(cachedAlbum);
    for (const inst of QOBUZ_INSTANCES) {
      try {
        // qobuz-api1: GET /album/:album_id  (path param)
        // Qobuz returns album object directly: { id, title, artist:{name}, image:{large}, release_date_original, tracks:{items:[...]} }
        const r = await axios.get(`${inst}/album/${qobuzAlbumId}`, {
          headers: { 'User-Agent': UA },
          timeout: 9000,
        });
        const album = r.data || {};
        if (!album?.id) continue;
        const cover      = album.image?.large || null;
        const artistName = album.artist?.name || 'Unknown';
        const rawTracks  = album.tracks?.items || [];
        const tracks = rawTracks.map((t, i) => ({
          id:          `qobuz_${t.id}`,
          title:       t.title || `Track ${i + 1}`,
          artist:      t.performer?.name || t.performers?.split(',')?.[0]?.trim() || artistName,
          album:       album.title || '',
          duration:    t.duration  || undefined,
          artworkURL:  cover,
          format:      'flac',
          source:      'qobuz',
          trackNumber: t.track_number || (i + 1),
        }));
        const result = {
          id,
          title:      album.title || 'Unknown Album',
          artist:     artistName,
          artworkURL: cover,
          year:       safeYear(album.release_date_original),
          trackCount: tracks.length,
          tracks,
        };
        await cacheSet(aCacheKey, result, 600);
        return c.json(result);
      } catch(e) { continue; }
    }
    return c.json({ error: 'Qobuz album not found' });
  }

  // ── Podcast Index feed album ─────────────────────────────────────────────
  if (id.startsWith('pi_feed_')) {
    const feedId   = id.slice(8);
    const cacheKey = `album:pi_feed:${feedId}`;
    const cached   = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    const [feedRes, epRes] = await Promise.allSettled([
      cfg.piKey && cfg.piSecret
        ? podcastIndexHeaders(cfg.piKey, cfg.piSecret).then(h => axios.get('https://api.podcastindex.org/api/1.0/podcasts/byfeedid', {
            params: { id: feedId },
            headers: h,
            timeout: 8000,
          }))
        : Promise.resolve(null),
      cfg.piKey && cfg.piSecret
        ? podcastIndexHeaders(cfg.piKey, cfg.piSecret).then(h => axios.get('https://api.podcastindex.org/api/1.0/episodes/byfeedid', {
            params: { id: feedId, max: 200, fulltext: true },
            headers: h,
            timeout: 10000,
          }))
        : Promise.resolve(null),
    ]);

    const feed = feedRes.status === 'fulfilled' && feedRes.value
      ? (feedRes.value.data?.feed || {})
      : {};
    const episodes = epRes.status === 'fulfilled' && epRes.value
      ? (epRes.value.data?.items || [])
      : [];

    // Fallback: use cached series info if feed API call failed
    if (!feed.title) {
      const cached_info = await cacheGet(`pi:series_info:${feedId}`);
      if (cached_info) { feed.title = cached_info.title; feed.image = cached_info.artworkURL; feed.author = cached_info.creator; }
    }

    const tracks = episodes.map(ep => ({
      id: `pi_ep_${ep.id}`,
      title: ep.title || 'Episode',
      artist: ep.feedAuthor || ep.feedTitle || feed.title || '',
      album:  ep.feedTitle  || feed.title  || '',
      duration:   typeof ep.duration === 'number' ? ep.duration : null,
      artworkURL: ep.image || ep.feedImage || feed.image || feed.artwork || null,
      streamURL:  ep.enclosureUrl || null,
      format: 'mp3',
    }));

    const albumData = {
      id,
      title:       feed.title       || 'Podcast',
      artist:      feed.author      || feed.ownerName || '',
      artworkURL:  feed.image       || feed.artwork   || null,
      year:        feed.newestItemPublishTime ? safeYear(new Date(feed.newestItemPublishTime * 1000).getFullYear()) : 0,
      description: (feed.description || '').slice(0, 500),
      trackCount:  tracks.length,
      tracks,
    };
    await cacheSet(cacheKey, albumData, 600);
    return c.json(albumData);
  }

  // ── Taddy series album ───────────────────────────────────────────────────
  if (id.startsWith('taddy_series_')) {
    const uuid     = id.slice(13);
    const cacheKey = `album:taddy_series:${uuid}`;
    const cached   = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    if (!cfg.taddyKey || !cfg.taddyUid) {
      return c.json({ error: 'No Taddy credentials configured.' });
    }

    let pod = {};
    try {
      const gql = `query {
        getPodcastSeries(uuid: "${uuid}") {
          uuid name description imageUrl authorName
          episodes(limitPerPage: 200) {
            uuid name audioUrl duration imageUrl
          }
        }
      }`;
      const r = await axios.post('https://api.taddy.org', { query: gql }, {
        headers: {
          'Content-Type': 'application/json',
          'X-USER-ID': cfg.taddyUid,
          'X-API-KEY': cfg.taddyKey,
        },
        timeout: 10000,
      });
      pod = r.data?.data?.getPodcastSeries || {};
    } catch (e) {
      console.warn('[Taddy] album fetch error:', e.message);
    }

    // Fallback: use cached series info if Taddy call failed
    if (!pod.name) {
      const cached_info = await cacheGet(`taddy:series_info:${uuid}`);
      if (cached_info) { pod.name = cached_info.title; pod.imageUrl = cached_info.artworkURL; }
    }

    const tracks = (pod.episodes || []).map(ep => ({
      id: `taddy_ep_${ep.uuid}`,
      title:      ep.name    || 'Episode',
      artist:     pod.authorName || pod.name || '',
      album:      pod.name   || '',
      duration:   ep.duration || null,
      artworkURL: ep.imageUrl || pod.imageUrl || null,
      streamURL:  ep.audioUrl || null,
      format: 'mp3',
    }));

    const albumData = {
      id,
      title:       pod.name        || 'Podcast',
      artist:      pod.authorName  || '',
      artworkURL:  pod.imageUrl    || null,
      year:        0,
      description: (pod.description || '').slice(0, 500),
      trackCount:  tracks.length,
      tracks,
    };
    await cacheSet(cacheKey, albumData, 600);
    return c.json(albumData);
  }


  // ── Apple Podcast feed album ──────────────────────────────────────────────
  if (id.startsWith('apple_feed_')) {
    const collectionId = id.slice('apple_feed_'.length);
    const cacheKey = `album:apple_feed:${collectionId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    let feedUrl = await cacheGet(`apple:feed_url:${collectionId}`);
    if (!feedUrl) {
      try {
        const lu = await axios.get('https://itunes.apple.com/lookup', {
          params: { id: collectionId, media: 'podcast', entity: 'podcast' },
          timeout: 5000,
        });
        feedUrl = lu.data?.results?.[0]?.feedUrl || null;
        if (feedUrl) await cacheSet(`apple:feed_url:${collectionId}`, feedUrl, 86400);
      } catch (e) { console.warn('[Apple] album feedUrl lookup error:', e.message); }
    }
    if (feedUrl) {
      const feedData = await appleGetFeed(feedUrl, collectionId);
      if (feedData) { await cacheSet(cacheKey, feedData, 600); return c.json(feedData); }
    }
    try {
      const lu = await axios.get('https://itunes.apple.com/lookup', {
        params: { id: collectionId, media: 'podcast', entity: 'podcastEpisode', limit: 200 },
        timeout: 10000,
      });
      const results = lu.data?.results || [];
      const show = results.find(r => r.kind === 'podcast' || r.wrapperType === 'collection' || r.collectionType === 'Podcast');
      const eps  = results.filter(r => r.kind === 'podcast-episode');
      const tracks = eps.map((r, i) => {
        const epId = `apple_ep_${r.trackId}`;
        if (r.episodeUrl) cacheSet(`apple:ep:stream:${epId}`, r.episodeUrl, 3600);
        return {
          id: epId, title: r.trackName || `Episode ${i + 1}`,
          artist: r.artistName || show?.collectionName || '',
          album: r.collectionName || show?.collectionName || '',
          duration: r.trackTimeMillis ? Math.floor(r.trackTimeMillis / 1000) : 0,
          artworkURL: (r.artworkUrl600 || r.artworkUrl100 || show?.artworkUrl600 || '').replace('100x100', '600x600'),
          format: 'mp3', streamURL: r.episodeUrl || null, source: 'apple',
        };
      });
      const albumData = {
        id, title: show?.collectionName || 'Apple Podcast',
        artist: show?.artistName || '',
        artworkURL: (show?.artworkUrl600 || '').replace('100x100', '600x600'),
        year: 0, description: show?.description || '',
        trackCount: tracks.length, tracks,
      };
      await cacheSet(cacheKey, albumData, 600);
      return c.json(albumData);
    } catch (e) { console.warn('[Apple] album fallback lookup error:', e.message); }
    return c.json({ error: 'Apple Podcast feed not found' });
  }

  // ── Social/Cross-Addon Album Fallback ───────────────────────────────────────
  // Album IDs from other addons (Apple Music, Tidal, Deezer, Spotify, etc.)
  // won't match any known prefix. Eclipse passes ?title=&artist= params.
  // Use those to search HiFi for the best matching album.
  {
    const qTitle  = c.req.query('title')  ? decodeURIComponent(c.req.query('title')).trim()  : '';
    const qArtist = c.req.query('artist') ? decodeURIComponent(c.req.query('artist')).trim() : '';
    const decodedAlbumId = (() => { try { return decodeURIComponent(id); } catch (e) { return id; } })();
    const searchQuery = (qTitle && qArtist)
      ? `${qArtist} ${qTitle}`
      : (qTitle || qArtist || '');

    if (searchQuery.length > 1) {
      console.log(`[Album social fallback] id="${decodedAlbumId}" query="${searchQuery}" — searching HiFi`);
      try {
        const hifiResult = await hifiSearch(searchQuery, cfg.hifiInstances);
        const albums = Array.isArray(hifiResult) ? [] : (hifiResult?.albums || []);
        if (albums.length) {
          const albumData = await hifiAlbum(albums[0].id);
          if (albumData) {
            console.log(`[Album social fallback] HiFi album matched: "${albumData.title}"`);
            return c.json(albumData);
          }
        }
        // No album objects — build a synthetic album from track results
        const tracks = Array.isArray(hifiResult) ? hifiResult : (hifiResult?.tracks || []);
        if (tracks.length) {
          console.log(`[Album social fallback] building synthetic album from tracks for "${searchQuery}"`);
          const syntheticAlbum = {
            id,
            title: qTitle || tracks[0]?.album || searchQuery,
            artist: qArtist || tracks[0]?.artist || '',
            artworkURL: tracks[0]?.artworkURL || null,
            trackCount: tracks.length,
            tracks: tracks.slice(0, 50),
          };
          return c.json(syntheticAlbum);
        }
      } catch (e) {
        console.warn('[Album social fallback] HiFi search error:', e.message);
      }
    }
  }

  // ── Radio Browser source album ────────────────────────────────────────────
  if (id === 'radio:source:radiobrowser') {
    const cacheKey = 'radio:album:radiobrowser';
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    const stations = await radioSearch('station') || [];
    const result = {
      id, title: 'Radio Browser', artist: 'Radio Browser',
      artworkURL: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/radio-browser.png',
      trackCount: stations.length, tracks: stations,
    };
    await cacheSet(cacheKey, result, 300);
    return c.json(result);
  }

  // ── SomaFM source album ──────────────────────────────────────────────────
  if (id === 'radio:source:somafm') {
    const cacheKey = 'radio:album:somafm';
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    let allStations = [];
    try {
      const res = await axios.get('https://api.somafm.com/channels.json', {
        headers: { 'User-Agent': 'EclipseUniversalAddon/1.0' }, timeout: 5000,
      });
      allStations = (res.data?.channels || []).map(ch => {
        const stream =
          ch.playlists?.find(p => p.format === 'mp3' && p.quality === 'highest')?.url ||
          ch.playlists?.find(p => p.format === 'aac')?.url ||
          ch.playlists?.[0]?.url || null;
        if (!stream) return null;
        return {
          id: `somafm:${ch.id}`, title: ch.title || 'SomaFM Station',
          artist: ch.genre || 'SomaFM', album: 'Live Radio · SomaFM', duration: 0,
          artworkURL: ch.xlimage || ch.image || null,
          format: stream.includes('.m3u') ? 'hls' : 'mp3', streamURL: stream, source: 'somafm',
        };
      }).filter(Boolean);
    } catch (e) { console.warn('[SomaFM] album fetch error:', e.message); }
    const result = {
      id, title: 'SomaFM', artist: 'SomaFM',
      artworkURL: 'https://somafm.com/img3/facebook-logo.png',
      trackCount: allStations.length, tracks: allStations,
    };
    await cacheSet(cacheKey, result, 300);
    return c.json(result);
  }

  return handleAlbum(c);
}
app.get('/album/:id', handleAlbumWithHifi);
app.get('/:token/album/:id', handleAlbumWithHifi);

// ─── Artist detail ────────────────────────────────────────────────────────────
async function handleArtist(c) {
  const _rlResArt = await applyRateLimit(c, 'catalog');
  if (_rlResArt) return _rlResArt;
  const id = c.req.param('id');
  const cfg = getConfig(c);

  if (id.startsWith('hifi_artist_')) {
    const withoutPrefix = id.slice(12);
    const firstUnderscore = withoutPrefix.indexOf('_');
    const instB64  = withoutPrefix.slice(0, firstUnderscore);
    const artistId = withoutPrefix.slice(firstUnderscore + 1);
    const inst     = decodeBase64Url(instB64);
    const cacheKey = `hifi:artist:${instB64}:${artistId}`;
    const cached   = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    try {
      const coverUrl = (uuid, size = 1280) => uuid
        ? `https://resources.tidal.com/images/${String(uuid).replace(/-/g, '/')}/${size}x${size}.jpg`
        : undefined;

      // Fire ALL endpoints in parallel across multiple param variations
      // Covers all known HiFi API v2.x instance response shapes
      // FIX: 3s timeouts (was 8s) — Promise.allSettled waits for ALL; slow instances
      // were blocking the entire artist page for up to 8 seconds.
      const [infoRes, discRes, albumsRes, topTracksRes, albumsRes2, discRes2, albAlbumsRes, albEpsRes, albCompRes] = await Promise.allSettled([
        axios.get(`${inst}/artist/`, { params: { id: artistId }, headers: { 'User-Agent': UA }, timeout: 3000 }),
        axios.get(`${inst}/artist/`, { params: { f: artistId, skip_tracks: false }, headers: { 'User-Agent': UA }, timeout: 3000 }),
        axios.get(`${inst}/artist/albums/`, { params: { id: artistId, limit: 100, offset: 0 }, headers: { 'User-Agent': UA }, timeout: 3000 }),
        axios.get(`${inst}/artist/toptracks/`, { params: { id: artistId, limit: 30 }, headers: { 'User-Agent': UA }, timeout: 3000 }),
        axios.get(`${inst}/artist/albums/`, { params: { artistId, limit: 100 }, headers: { 'User-Agent': UA }, timeout: 3000 }),
        axios.get(`${inst}/artist/discography/`, { params: { id: artistId, limit: 50 }, headers: { 'User-Agent': UA }, timeout: 3000 }),
        axios.get(`${inst}/artist/albums/`, { params: { id: artistId, filter: 'ALBUMS',       limit: 100 }, headers: { 'User-Agent': UA }, timeout: 3000 }),
        axios.get(`${inst}/artist/albums/`, { params: { id: artistId, filter: 'EPSSINGLES',   limit: 100 }, headers: { 'User-Agent': UA }, timeout: 3000 }),
        axios.get(`${inst}/artist/albums/`, { params: { id: artistId, filter: 'COMPILATIONS', limit: 100 }, headers: { 'User-Agent': UA }, timeout: 3000 }),
      ]);

      // ── Artist info ──────────────────────────────────────────────────────────
      let artistInfo = {};
      if (infoRes.status === 'fulfilled') {
        const d = infoRes.value.data?.data || infoRes.value.data || {};
        if      (d.artist?.id)   artistInfo = d.artist;
        else if (d.id && d.name) artistInfo = d;
      }
      // Fallback: discography response often embeds artist info too
      if (!artistInfo.name && discRes.status === 'fulfilled') {
        const dd = discRes.value.data?.data || discRes.value.data || {};
        if      (dd.artist?.id)   artistInfo = dd.artist;
        else if (dd.id && dd.name) artistInfo = dd;
      }

      // ── Albums — merge all sources, dedupe by album id ───────────────────────
      const albumMap = {};
      const albumTitleSeen = new Set(); // FIX: dedup albums by title+year to catch int/string id mismatches
      const addAlbums = (arr) => {
        for (const a of (Array.isArray(arr) ? arr : [])) {
          if (!a?.id) continue;
          const _ak = String(a.id);
          if (albumMap[_ak]) continue;
          const _rd = a.releaseDate || a.release_date || a.streamStartDate || a.stream_start_date || a.year || '';
          const _aNorm = `${(a.title||'').toLowerCase().replace(/[^a-z0-9]/g,'')}:${_rd.slice(0,4)}`;
          if (_aNorm.length > 1 && albumTitleSeen.has(_aNorm)) continue;
          if (_aNorm.length > 1) albumTitleSeen.add(_aNorm);
          albumMap[_ak] = a;
        }
      };
      // Helper to extract array from any known response shape
      const extractList = (res, keys = ['items', 'tracks', 'albums']) => {
        if (res.status !== 'fulfilled' || !res.value) return [];
        const d = res.value.data?.data || res.value.data || {};
        for (const k of keys) {
          if (Array.isArray(d[k])) return d[k];
          if (Array.isArray(d[k]?.items)) return d[k].items;
        }
        if (Array.isArray(d)) return d;
        return [];
      };
      if (discRes.status === 'fulfilled') {
        const dd = discRes.value.data?.data || discRes.value.data || {};
        addAlbums(Array.isArray(dd.albums) ? dd.albums : (dd.albums?.items || []));
      }
      if (discRes2.status === 'fulfilled') {
        const dd2 = discRes2.value.data?.data || discRes2.value.data || {};
        addAlbums(Array.isArray(dd2.albums) ? dd2.albums : (dd2.albums?.items || []));
        addAlbums(Array.isArray(dd2.items) ? dd2.items : []);
      }
      for (const aRes of [albumsRes, albumsRes2, albAlbumsRes, albEpsRes, albCompRes]) {
        if (aRes.status === 'fulfilled') {
          const ad = aRes.value.data?.data || aRes.value.data;
          addAlbums(Array.isArray(ad) ? ad : (ad?.items || []));
        }
      }
      // FIX: fetch page 2 of HiFi albums for artists with large catalogs
      if (Object.keys(albumMap).length >= 100) {
        try {
          const albumsPage2 = await axios.get(`${inst}/artist/albums/`, {
            params: { id: artistId, limit: 100, offset: 100 },
            headers: { 'User-Agent': UA }, timeout: 5000
          });
          const ap2 = albumsPage2.data?.data || albumsPage2.data;
          addAlbums(Array.isArray(ap2) ? ap2 : (ap2?.items || []));
        } catch(e) { /* page 2 optional */ }
      }
      // Also extract albums from info response (some instances nest them there)
      if (infoRes.status === 'fulfilled') {
        const id2 = infoRes.value.data?.data || infoRes.value.data || {};
        addAlbums(Array.isArray(id2.albums) ? id2.albums : (id2.albums?.items || []));
      }

      // ── Tracks — merge discography + toptracks ───────────────────────────────
      const trackMap = {};
      const trackTitleArtistSeen = new Set(); // FIX: secondary dedup by title+artist
      const addTracks = (arr) => {
        for (const t of (Array.isArray(arr) ? arr : [])) {
          if (!t?.id) continue;
          const _tk = String(t.id);
          if (trackMap[_tk]) continue;
          const _tNorm = `${(t.title||'').toLowerCase().replace(/[^a-z0-9]/g,'')}:${((t.artists||[]).map(a=>a.name).join('').toLowerCase().replace(/[^a-z0-9]/g,''))}`;
          if (trackTitleArtistSeen.has(_tNorm)) continue;
          trackTitleArtistSeen.add(_tNorm);
          trackMap[_tk] = t;
        }
      };
      if (discRes.status === 'fulfilled') {
        const dd = discRes.value.data?.data || discRes.value.data || {};
        addTracks(Array.isArray(dd.tracks) ? dd.tracks : (dd.tracks?.items || []));
      }
      if (discRes2.status === 'fulfilled') {
        const dd2 = discRes2.value.data?.data || discRes2.value.data || {};
        addTracks(Array.isArray(dd2.tracks) ? dd2.tracks : (dd2.tracks?.items || []));
      }
      if (topTracksRes.status === 'fulfilled') {
        const td = topTracksRes.value.data?.data || topTracksRes.value.data || {};
        addTracks(td.items || td.tracks || (Array.isArray(td) ? td : []));
      }

      // ── Search fallback if both album sources came back empty ─────────────────
      if (!Object.keys(albumMap).length && artistInfo.name) {
        try {
          const sData = await axios.get(`${inst}/search/`, { params: { s: artistInfo.name, limit: 30 }, headers: { 'User-Agent': UA }, timeout: 8000 });
          const sItems = sData.data?.data?.items || sData.data?.items || [];
          const wantName = artistInfo.name.toLowerCase();
          for (const t of sItems) {
            if (!t?.album?.id) continue;
            const tArtist = ((t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED').length ? (t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED') : (t.artists || [])).map(a => a.name).join(', ').toLowerCase();
            if (!tArtist.includes(wantName) && !wantName.includes(tArtist)) continue;
            const alId = String(t.album.id);
            if (!albumMap[alId]) albumMap[alId] = {
              id: t.album.id, title: t.album.title, cover: t.album.cover,
              // FIX: t.album.releaseDate is often null on track objects; fall back to
              // streamStartDate (ISO string) or track-level releaseDate
              releaseDate: t.album.releaseDate || t.album.release_date || t.album.streamStartDate || t.album.stream_start_date || t.album.year || t.releaseDate || null,
              source: 'hifi',
            };
            if (!trackMap[String(t.id)] && t.streamReady !== false) trackMap[String(t.id)] = t;
          }
        } catch (e6) { console.log('[HiFi] search fallback failed:', e6.message); }
      }

      const artistName = artistInfo.name || 'Unknown Artist';
      const artworkURL = artistInfo.picture ? coverUrl(artistInfo.picture, 480) : undefined;

      // FIX: Build topTracks from dedicated toptracks endpoint first (popularity-ranked),
      // fall back to trackMap (discography) only if toptracks endpoint returned nothing.
      const buildTopTracksArr = (rawArr) => rawArr
        .filter(t => t?.id && t.streamReady !== false)
        .map(t => ({
          id:         `hifi_${instB64}_${t.id}`,
          title:      t.title || 'Unknown',
          artist:     ((t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED').length
              ? (t.artists || []).filter(a => a.type === 'MAIN' || a.type === 'FEATURED')
              : (t.artists?.length ? t.artists : (t.artist ? [t.artist] : []))).map(a => a.name).join(', ') || artistName,
          album:      t.album?.title || '',
          duration:   t.duration ? Math.floor(t.duration) : undefined,
          artworkURL: t.album?.cover ? coverUrl(t.album.cover, 320) : artworkURL,
          format:     'flac',
        }));

      // Prefer dedicated /artist/toptracks/ order (popularity-ranked by Tidal)
      // FIX: unwrap {item: trackObj} wrapper that the HiFi proxy returns (same as hifiAlbum)
      // and handle all known response shapes across proxy versions
      const unwrapTracks = (arr) => (Array.isArray(arr) ? arr : []).map(i => i.item || i);
      let topTracksRawArr = [];
      if (topTracksRes.status === 'fulfilled') {
        const td = topTracksRes.value.data?.data || topTracksRes.value.data || {};
        // Try all known response shapes, unwrapping {item: track} wrappers in each
        topTracksRawArr = unwrapTracks(
          td.items || td.tracks?.items || td.topTracks?.items ||
          td.tracks || (Array.isArray(td) ? td : [])
        ).filter(t => t?.id);
      }
      // If toptracks endpoint failed or returned nothing, try a second path-param style URL
      if (!topTracksRawArr.length) {
        try {
          const ttRes2 = await axios.get(`${inst}/artist/${artistId}/toptracks`, {
            params: { limit: 20 }, headers: { 'User-Agent': UA }, timeout: 4000,
          });
          const td2 = ttRes2.data?.data || ttRes2.data || {};
          topTracksRawArr = unwrapTracks(
            td2.items || td2.tracks?.items || td2.tracks || (Array.isArray(td2) ? td2 : [])
          ).filter(t => t?.id);
        } catch (_tte) { /* path-param toptracks not supported on this instance */ }
      }
      // Final fallback: discography tracks, sorted by popularity
      if (!topTracksRawArr.length) {
        topTracksRawArr = Object.values(trackMap)
          .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
      }
      const topTracks = buildTopTracksArr(topTracksRawArr).slice(0, 20);

      const albums = Object.values(albumMap)
        // FIX: sort by numeric year descending; null/0 years go to the end
        .sort((a, b) => {
          const ya = safeYear(a.releaseDate || a.release_date || a.streamStartDate || a.stream_start_date);
          const yb = safeYear(b.releaseDate || b.release_date || b.streamStartDate || b.stream_start_date);
          if (!ya && !yb) return 0;
          if (!ya) return 1;  // a has no year → push to end
          if (!yb) return -1; // b has no year → push to end
          return yb - ya;     // newest first
        })
        .slice(0, 200)
        .map(a => ({
          id:         `hifi_album_${instB64}_${a.id}`,
          title:      a.title || 'Unknown Album',
          artist:     artistName,
          artworkURL: a.cover ? coverUrl(a.cover, 320) : undefined,
          year:       safeYear(a.releaseDate || a.release_date || a.streamStartDate || a.stream_start_date || a.year) || undefined,
          source:     'hifi',
        }));

      // FIX: cache track meta for ALL tracks so stream handler can apply correct streamOrder priority
      for (const [_atid, _atv] of Object.entries(trackMap)) {
        if (_atv.streamReady === false) continue;
        const _atArtist = (((_atv.artists||[]).filter(a=>a.type==='MAIN'||a.type==='FEATURED').length
          ? (_atv.artists||[]).filter(a=>a.type==='MAIN'||a.type==='FEATURED')
          : (_atv.artists?.length ? _atv.artists : (_atv.artist ? [_atv.artist] : []))
        ).map(a=>a.name).join(', ')) || artistName;
        cacheSet(`hifi:track:meta:${instB64}_${_atid}`, {
          title: _atv.title || 'Unknown',
          artist: _atArtist,
          isrc: _atv.isrc ? _atv.isrc.toUpperCase().replace(/[^A-Z0-9]/g,'') : null,
          duration: _atv.duration ? Math.floor(_atv.duration) : undefined,
        }, 3600);
      }
      const result = { id, name: artistName, artworkURL, topTracks, albums };
      await cacheSet(cacheKey, result, 3600);
      return c.json(result);
    } catch (e) {
      console.warn('[HiFi] artist error:', e.message);
      return c.json({ error: 'Artist fetch failed: ' + e.message });
    }
  }

  if (id.startsWith('sc_artist_')) {
    const artistName = decodeURIComponent(id.slice(10));
    const cid = await getSCClientId(cfg.scClientId);
    if (!cid) return c.json({ error: 'SC client ID unavailable' });
    try {
      const r = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
        params: { q: artistName, client_id: cid, limit: 20 }, timeout: 8000,
      });
      const topTracks = (r.data?.collection || []).map(t => ({
        id:        `sc_${t.id}`,
        title:     t.title || 'Unknown',
        artist:    t.user?.username || 'Unknown',
        duration:  Math.floor((t.duration || 0) / 1000),
        artworkURL: (t.artwork_url || '').replace('-large', '-t500x500'),
        format: 'mp3',
        _origId: String(t.id),
      }));
      return c.json({ id, name: artistName, topTracks, albums: [] });
    } catch (e) {
      return c.json({ error: 'SC artist fetch failed' });
    }
  }

  // ── Podcast show as artist (pi_feed_, taddy_series_, apple_feed_) ─────────
  if (id.startsWith('pi_feed_') || id.startsWith('taddy_series_') || id.startsWith('apple_feed_')) {
    const cacheKey = `artist:podcast:${id}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    let episodes = [];
    let info = { title: 'Podcast', artworkURL: null, creator: '' };

    if (id.startsWith('pi_feed_')) {
      const feedId = id.slice(8);
      episodes = await piGetEpisodes(feedId, cfg.piKey, cfg.piSecret) || [];
      const si = await cacheGet(`pi:series_info:${feedId}`);
      if (si) info = si;
      else if (!cfg.piKey) {
        // try to get info from PI without auth
        try {
          const _piH6 = await podcastIndexHeaders(cfg.piKey, cfg.piSecret);
          const infoRes = await axios.get('https://api.podcastindex.org/api/1.0/podcasts/byfeedid', {
            params: { id: feedId }, headers: _piH6, timeout: 5000,
          });
          const f = infoRes.data?.feed;
          if (f) info = { title: f.title, artworkURL: f.artwork || f.image, creator: f.author };
        } catch {}
      }
    } else if (id.startsWith('taddy_series_')) {
      const uuid = id.slice(13);
      episodes = await taddyGetEpisodes(uuid, cfg.taddyKey, cfg.taddyUid) || [];
      const si = await cacheGet(`taddy:series_info:${uuid}`);
      if (si) info = { title: si.title, artworkURL: si.artworkURL, creator: si.creator || '' };
      else if (episodes[0]) info = { title: episodes[0].artist || 'Podcast', artworkURL: episodes[0].artworkURL, creator: '' };
    } else if (id.startsWith('apple_feed_')) {
      const collectionId = id.slice('apple_feed_'.length);
      let feedUrl = await cacheGet(`apple:feed_url:${collectionId}`);
      if (!feedUrl) {
        try {
          const lu = await axios.get('https://itunes.apple.com/lookup', {
            params: { id: collectionId, media: 'podcast', entity: 'podcast' }, timeout: 5000,
          });
          feedUrl = lu.data?.results?.[0]?.feedUrl || null;
          if (feedUrl) await cacheSet(`apple:feed_url:${collectionId}`, feedUrl, 86400);
        } catch {}
      }
      if (feedUrl) {
        const feedData = await appleGetFeed(feedUrl, collectionId);
        if (feedData) {
          episodes = feedData.tracks || [];
          info = { title: feedData.title, artworkURL: feedData.artworkURL, creator: feedData.artist };
        }
      }
    }

    const result = {
      id,
      name:       info.title || 'Podcast',
      artworkURL: info.artworkURL || null,
      topTracks:  episodes.slice(0, 20),
      albums:     episodes.length ? [{
        id, title: info.title || 'Podcast', artist: info.creator || '',
        artworkURL: info.artworkURL || null, trackCount: episodes.length, source: 'pi',
      }] : [],
    };
    await cacheSet(cacheKey, result, 3600);
    return c.json(result);
  }

  // ── Audiobook author as artist ────────────────────────────────────────────
  if (id.startsWith('author:')) {
    const authorName = decodeURIComponent(id.slice(7));
    const cacheKey = `artist:author:${id}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    const [lvoxRes, iaRes] = await Promise.allSettled([
      librivoxSearch(authorName),
      iaSearchAudiobooks(authorName),
    ]);
    const lvox = lvoxRes.status === 'fulfilled' ? (lvoxRes.value || []) : [];
    const ia   = iaRes.status   === 'fulfilled' ? (iaRes.value   || []) : [];
    const seen = new Set();
    const allBooks = [];
    for (const b of [...lvox, ...ia]) {
      const key = b.title?.toLowerCase().slice(0, 40);
      if (!seen.has(key)) { seen.add(key); allBooks.push(b); }
    }

    const result = {
      id,
      name:       authorName,
      artworkURL: allBooks[0]?.artworkURL || null,
      topTracks:  allBooks.slice(0, 20).map(b => ({
        id: b.id, title: b.title, artist: authorName, album: b.title,
        duration: b.duration || null, artworkURL: b.artworkURL || null, format: 'mp3', source: b.source,
      })),
      albums: allBooks.slice(0, 20).map(b => ({
        id: b.id, title: b.title, artist: authorName,
        artworkURL: b.artworkURL || null, year: b.year || 0, source: b.source,
      })),
    };
    await cacheSet(cacheKey, result, 3600);
    return c.json(result);
  }

  // ── Radio genre as artist ─────────────────────────────────────────────────
  if (id.startsWith('radiogenre:')) {
    const genre = decodeURIComponent(id.slice(11));
    const cacheKey = `artist:radiogenre:${genre}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    const [rbRes, somaRes] = await Promise.allSettled([
      radioSearch(genre),
      somaFmSearch(genre),
    ]);
    const rb   = rbRes.status   === 'fulfilled' ? (rbRes.value   || []) : [];
    const soma = somaRes.status === 'fulfilled' ? (somaRes.value || []) : [];
    const seen = new Set();
    const stations = [];
    for (const s of [...rb, ...soma]) {
      const key = (s.title || '').toLowerCase().slice(0, 40);
      if (!seen.has(key)) { seen.add(key); stations.push(s); }
    }

    const result = {
      id,
      name:       genre.charAt(0).toUpperCase() + genre.slice(1) + ' Radio',
      artworkURL: stations[0]?.artworkURL || null,
      topTracks:  stations.slice(0, 20),
      albums:     [],
    };
    await cacheSet(cacheKey, result, 300);
    return c.json(result);
  }

  if (id.startsWith('qobuz_artist_')) {
    const qobuzArtistId = id.slice(13);
    const arCacheKey = `qobuz:artist:${qobuzArtistId}`;
    const cachedAr = await cacheGet(arCacheKey);
    if (cachedAr) return c.json(cachedAr);
    for (const inst of QOBUZ_INSTANCES) {
      try {
        // The proxy /artist/:id only returns basic info — no albums, no tracks.
        // Fetch artist info + 4 parallel search queries to cover all release types.
        const arRes = await axios.get(`${inst}/artist/${qobuzArtistId}`, {
          params: { limit: 10 }, // artist proxy: just need basic info; albums come from search
          headers: { 'User-Agent': UA },
          timeout: 8000,
        });
        const arData = arRes.data || {};
        if (!arData?.id && !arData?.name) continue;
        const artistName = arData.name || '';
        // Artist cover: prefer image fields (full URL), fallback to picture hash → CDN URL
        // Use thumbnail/small for artist cover — large can be 1500x1500+ causing overflow in Eclipse
        let cover = arData.image?.small || arData.image?.large || null;
        if (!cover && arData.image?.large) {
          // Downscale large URL: replace any _org or _NNN suffix with _300
          cover = arData.image.large.replace(/(_org|_\d+)(\.jpg)$/i, '_300$2');
          if (cover === arData.image.large) cover = arData.image.large; // no suffix to replace, use as-is
        }
        if (!cover && arData.picture && typeof arData.picture === 'string' && arData.picture.length > 5) {
          // picture is a bare hash → build 300px CDN URL
          cover = `https://static.qobuz.com/images/artists/covers/${arData.picture}_300.jpg`;
        }
        if (!cover && arData.images && arData.images.length) cover = arData.images[0];

        // Run search queries in parallel: general, EP/Single, compilation, live
        // to maximise album type coverage since proxy has no dedicated albums endpoint
        const [s1, s2, s3, s4] = await Promise.allSettled([
          axios.get(`${inst}/search`, { params: { q: artistName, limit: 50 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
          axios.get(`${inst}/search`, { params: { q: `${artistName} EP`, limit: 20 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
          axios.get(`${inst}/search`, { params: { q: `${artistName} compilation`, limit: 20 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
          axios.get(`${inst}/search`, { params: { q: `${artistName} live`, limit: 20 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
        ]);

        // Collect tracks + albums from all search results, filter to this artist
        const albumMap = {};
        const albumTitleYearSeen = new Set(); // dedup by title+year across parallel search results
        const topTracks = [];
        const seenTrackIds = new Set(); // FIX: dedup tracks across all parallel search results
        const wantId = String(arData.id);
        const wantNameLow = artistName.toLowerCase();

        const isThisArtist = (a) => {
          if (!a) return false;
          const aId = String(a.artist?.id || a.artists?.[0]?.id || '');
          if (aId && aId === wantId) return true;
          const aName = (a.artist?.name || a.artists?.[0]?.name || a.performer?.name || '').toLowerCase();
          // Exact match only - "drake" must not match "nick drake" or "drake bell"
          return aName === wantNameLow;
        };

        for (const res of [s1, s2, s3, s4]) {
          if (res.status !== 'fulfilled') continue;
          const data = res.value.data || {};

          // Albums
          const rawAlbums = data.albums?.items || data.albums || [];
          for (const a of rawAlbums) {
            if (!a?.id) continue;
            const key = String(a.id);
            if (albumMap[key]) continue;
            // Accept if artist id matches OR artist name matches
            const aArtistId = String(a.artist?.id || '');
            const aArtistName = (a.artist?.name || '').toLowerCase();
            if (aArtistId !== wantId && aArtistName !== wantNameLow) continue;
            const _tyKey = (a.title || '').toLowerCase().replace(/[^a-z0-9]/g,'') + ':' + String((a.release_date_original || '').slice(0,4));
            if (_tyKey.length > 1 && albumTitleYearSeen.has(_tyKey)) continue;
            if (_tyKey.length > 1) albumTitleYearSeen.add(_tyKey);
            albumMap[key] = a;
          }

          // Tracks — collect from all searches, dedup by track id, hard cap at 20 total
          if (topTracks.length < 10) {
            const rawTracks = data.tracks?.items || data.tracks || [];
            for (const t of rawTracks) {
              if (topTracks.length >= 10) break;
              if (!isThisArtist(t)) continue;
              const _tkey = String(t.id);
              if (seenTrackIds.has(_tkey)) continue;
              seenTrackIds.add(_tkey);
              topTracks.push({
                id:         `qobuz_${t.id}`,
                title:      t.title || 'Unknown',
                artist:     t.performer?.name || t.artist?.name || artistName,
                album:      t.album?.title || '',
                duration:   t.duration || undefined,
                artworkURL: t.album?.image?.small || t.album?.image?.large || (t.album?.image?.large ? t.album.image.large.replace(/(_org|_\d+)(\.jpg)$/i,'_300$2') : null) || null,
                format:     'flac',
                source:     'qobuz',
              });
            }
          }
        }

        const albums = Object.values(albumMap)
          // FIX: numeric year sort descending, nulls/0s at end (consistent with hifi)
          .sort((a, b) => {
            const ya = safeYear(a.release_date_original);
            const yb = safeYear(b.release_date_original);
            if (!ya && !yb) return 0;
            if (!ya) return 1;
            if (!yb) return -1;
            return yb - ya;
          })
          .slice(0, 20) // 20 albums max — Eclipse renders albums in a grid; too many causes layout overflow
          .map(a => ({
            id:         `qobuzalbum_${a.id}`,
            title:      a.title || 'Unknown Album',
            artist:     artistName,
            artworkURL: a.image?.small || a.image?.large || a.image?.mega || (a.image?.large ? a.image.large.replace(/(_org|_\d+)(\.jpg)$/i,'_300$2') : null) || null,
            trackCount: a.tracks_count || undefined,
            year:       safeYear(a.release_date_original),
            source:     'qobuz',
          }));

        const result = { id, name: artistName || 'Unknown Artist', artworkURL: cover, topTracks, albums };
        await cacheSet(arCacheKey, result, 600);
        return c.json(result);
      } catch(e) { continue; }
    }
    return c.json({ error: 'Qobuz artist not found' });
  }

    if (id.startsWith('deezer:artist:')) {
    const data = await deezerArtist(id.replace('deezer:artist:', ''));
    if (data) return c.json(data);
    return c.json({ error: 'Deezer artist not found' }, 404);
  }
    return c.json({ error: 'Artist not found' });
}
app.get('/artist/:id', handleArtist);
app.get('/:token/artist/:id', handleArtist);

// Playlist detail (podcast series)
async function handlePlaylist(c) {
  const _rlResPl = await applyRateLimit(c, 'catalog');
  if (_rlResPl) return _rlResPl;
  const id = c.req.param('id');
  const cfg = getConfig(c);

  // SoundCloud playlist
  if (id.startsWith('sc_pl_')) {
    const origId = id.slice(6);
    const cid = await getSCClientId(cfg.scClientId);
    if (!cid) return c.json({ error: 'SC client ID unavailable' });
    const cacheKey = `sc:playlist:${origId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    try {
      const r = await axios.get(`https://api-v2.soundcloud.com/playlists/${origId}`, {
        params: { client_id: cid },
        timeout: 10000,
      });
      const pl = r.data;
      const tracks = (pl.tracks || []).map(t => ({
        id: `sc_${t.id}`,
        title: t.title || 'Unknown',
        artist: t.publisher_metadata?.artist || t.user?.name || t.user?.username || 'Unknown',
        duration: Math.floor((t.duration || 0) / 1000),
        artworkURL: (t.artwork_url || '').replace('-large', '-t500x500'),
        format: 'mp3',
        _source: 'sc',
        _origId: String(t.id),
      }));
      const result = {
        id,
        title: pl.title || 'SoundCloud Playlist',
        creator: pl.user?.username || 'Unknown',
        artworkURL: (pl.artwork_url || '').replace('-large', '-t500x500'),
        trackCount: tracks.length,
        tracks,
      };
      await cacheSet(cacheKey, result, 600);
      return c.json(result);
    } catch (e) {
      return c.json({ error: 'SC playlist fetch failed: ' + e.message });
    }
  }

  if (id.startsWith('pi_feed_')) {
    const feedId = id.slice(8);
    const cacheKey = `playlist:pi_feed:${feedId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    const episodes = await piGetEpisodes(feedId, cfg.piKey, cfg.piSecret);
    // Get series info from cache; re-fetch from PI if cache has expired
    let seriesInfo = await cacheGet(`pi:series_info:${feedId}`);
    if (!seriesInfo && cfg.piKey && cfg.piSecret) {
      try {
        const _piH7 = await podcastIndexHeaders(cfg.piKey, cfg.piSecret);
        const infoRes = await axios.get('https://api.podcastindex.org/api/1.0/podcasts/byfeedid', {
          params: { id: feedId },
          headers: _piH7,
          timeout: 5000,
        });
        const f = infoRes.data?.feed;
        if (f) {
          seriesInfo = {
            title: f.title || 'Podcast',
            artworkURL: f.artwork || f.image || '',
            creator: f.author || '',
            description: f.description || '',
          };
          await cacheSet(`pi:series_info:${feedId}`, seriesInfo, 3600);
        }
      } catch {}
    }
    if (!seriesInfo) seriesInfo = { title: 'Podcast', artworkURL: '', creator: '', description: '' };
    const playlistData = {
      id,
      title: seriesInfo.title,
      description: seriesInfo.description || '',
      artworkURL: seriesInfo.artworkURL || '',
      creator: seriesInfo.creator || '',
      tracks: episodes,
    };
    await cacheSet(cacheKey, playlistData, 600);
    return c.json(playlistData);
  }

  if (id.startsWith('taddy_series_')) {
    const uuid = id.slice(13);
    const cacheKey = `playlist:taddy:${uuid}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    const [episodes, seriesInfo] = await Promise.all([
      taddyGetEpisodes(uuid, cfg.taddyKey, cfg.taddyUid),
      cacheGet(`taddy:series_info:${uuid}`),
    ]);
    const info = seriesInfo
      || (episodes && episodes[0]
        ? { title: episodes[0].artist || 'Podcast', artworkURL: episodes[0].artworkURL || '', creator: episodes[0].artist || '' }
        : { title: 'Podcast', artworkURL: '', creator: '' });
    const playlistData = {
      id,
      title: info.title || 'Podcast',
      description: '',
      artworkURL: info.artworkURL || '',
      creator: info.creator || '',
      tracks: episodes || [],
    };
    await cacheSet(cacheKey, playlistData, 600);
    return c.json(playlistData);
  }


  // ── Apple Podcast feed playlist ───────────────────────────────────────────
  if (id.startsWith('apple_feed_')) {
    const collectionId = id.slice('apple_feed_'.length);
    const cacheKey = `playlist:apple_feed:${collectionId}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);
    let feedUrl = await cacheGet(`apple:feed_url:${collectionId}`);
    if (!feedUrl) {
      try {
        const lu = await axios.get('https://itunes.apple.com/lookup', {
          params: { id: collectionId, media: 'podcast', entity: 'podcast' },
          timeout: 5000,
        });
        feedUrl = lu.data?.results?.[0]?.feedUrl || null;
        if (feedUrl) await cacheSet(`apple:feed_url:${collectionId}`, feedUrl, 86400);
      } catch (e) { console.warn('[Apple] playlist feedUrl lookup error:', e.message); }
    }
    if (feedUrl) {
      const feedData = await appleGetFeed(feedUrl, collectionId);
      if (feedData) {
        const playlistData = {
          id, title: feedData.title, description: feedData.description || '',
          artworkURL: feedData.artworkURL || '', creator: feedData.artist || '',
          tracks: feedData.tracks,
        };
        await cacheSet(cacheKey, playlistData, 600);
        return c.json(playlistData);
      }
    }
    return c.json({ error: 'Apple Podcast feed not found — no RSS feed URL available' });
  }

  // ── Radio genre playlist ────────────────────────────────────────────────
  if (id.startsWith('radioplaylist:')) {
    const genre = decodeURIComponent(id.slice(14));
    const cacheKey = `radioplaylist:${genre}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    const [rbRes, somaRes] = await Promise.allSettled([
      radioSearch(genre),
      somaFmSearch(genre),
    ]);
    const rb   = rbRes.status   === 'fulfilled' ? (rbRes.value   || []) : [];
    const soma = somaRes.status === 'fulfilled' ? (somaRes.value || []) : [];
    const seen = new Set();
    const tracks = [];
    for (const s of [...rb, ...soma]) {
      const key = (s.title || '').toLowerCase().slice(0, 40);
      if (!seen.has(key)) { seen.add(key); tracks.push(s); }
    }
    const result = {
      id,
      title:      genre.charAt(0).toUpperCase() + genre.slice(1) + ' Radio',
      creator:    'Radio Browser',
      artworkURL: tracks[0]?.artworkURL || null,
      trackCount: tracks.length,
      tracks:     tracks.slice(0, 30),
    };
    await cacheSet(cacheKey, result, 300);
    return c.json(result);
  }

  // ── Audiobook collection playlist ─────────────────────────────────────────
  if (id === 'audiobook:collection:librivox' || id === 'audiobook:collection:ia') {
    const isLvox = id === 'audiobook:collection:librivox';
    const cacheKey = id;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json(cached);

    const books = isLvox
      ? (await librivoxSearch('popular') || [])
      : (await iaSearchAudiobooks('audiobook') || []);

    const tracks = books.map(b => ({
      id: b.id, title: b.title, artist: b.artist || b.creator || 'Unknown Author',
      album: b.title, duration: b.duration || null, artworkURL: b.artworkURL || null,
      format: 'mp3', source: b.source,
    }));
    const result = {
      id,
      title:      isLvox ? 'LibriVox — Free Public Domain Audiobooks' : 'Internet Archive Audiobooks',
      creator:    isLvox ? 'LibriVox' : 'Internet Archive',
      artworkURL: null,
      trackCount: tracks.length,
      tracks,
    };
    await cacheSet(cacheKey, result, 600);
    return c.json(result);
  }

  if (id.startsWith('qobuzplaylist_')) {
    const qobuzPlaylistId = id.slice(14);
    const plCacheKey = `qobuz:playlist:${qobuzPlaylistId}`;
    const cachedPl = await cacheGet(plCacheKey);
    if (cachedPl) return c.json(cachedPl);
    for (const inst of QOBUZ_INSTANCES) {
      try {
        // The proxy /playlist/:id returns metadata but tracks is always empty.
        // Strategy: get playlist metadata, then use name/genres to search for tracks.
        const r = await axios.get(`${inst}/playlist/${qobuzPlaylistId}`, {
          headers: { 'User-Agent': UA },
          timeout: 9000,
        });
        const pl = r.data || {};
        if (!pl?.id) continue;

        const cover = (Array.isArray(pl.images300) && pl.images300[0])
          || (Array.isArray(pl.image_rectangle) && pl.image_rectangle[0])
          || (Array.isArray(pl.images) && pl.images[0])
          || null;
        const plName = pl.name || pl.title || '';
        const genre = pl.genres?.[0]?.name || '';

        // Build search queries from playlist name keywords + genre
        // Strip common filler words to get better search terms
        const nameWords = plName.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 3).slice(0, 4);
        const searchQ1 = nameWords.slice(0, 3).join(' ') || genre || 'music';
        const searchQ2 = genre || nameWords.slice(0, 2).join(' ') || 'popular';

        const [sr1, sr2] = await Promise.allSettled([
          axios.get(`${inst}/search`, { params: { q: searchQ1, limit: 30 }, headers: { 'User-Agent': UA }, timeout: 8000 }),
          searchQ2 !== searchQ1
            ? axios.get(`${inst}/search`, { params: { q: searchQ2, limit: 20 }, headers: { 'User-Agent': UA }, timeout: 8000 })
            : Promise.resolve(null),
        ]);

        const trackMap = {};
        for (const res of [sr1, sr2]) {
          if (res.status !== 'fulfilled' || !res.value) continue;
          const data = res.value.data || {};
          const rawTracks = data.tracks?.items || data.tracks || [];
          for (const t of rawTracks) {
            if (!t?.id || trackMap[t.id]) continue;
            trackMap[t.id] = {
              id:         `qobuz_${t.id}`,
              title:      t.title || 'Unknown',
              artist:     t.performer?.name || t.album?.artist?.name || 'Unknown',
              album:      t.album?.title || '',
              duration:   t.duration || undefined,
              artworkURL: t.album?.image?.large || t.album?.image?.small || cover,
              format:     'flac',
              source:     'qobuz',
            };
          }
        }

        const tracks = Object.values(trackMap).slice(0, 50);
        const result = {
          id,
          title:      plName || 'Unknown Playlist',
          artist:     pl.owner?.name || 'Qobuz',
          artworkURL: cover,
          trackCount: pl.tracks_count || tracks.length,
          tracks,
        };
        await cacheSet(plCacheKey, result, 600);
        return c.json(result);
      } catch(e) { continue; }
    }
    return c.json({ error: 'Qobuz playlist not found' });
  }

  if (id.startsWith('deezer:playlist:')) {
    const data = await deezerPlaylist(id.replace('deezer:playlist:', ''));
    if (data) return c.json(data);
    return c.json({ error: 'Deezer playlist not found' }, 404);
  }
      c.json({ error: 'Playlist not found' }, 404);
}

app.get('/playlist/:id', handlePlaylist);
app.get('/:token/playlist/:id', handlePlaylist);


// ─── HiFi Instance Health Check ──────────────────────────────────────────────
app.get('/instances', async (c) => {
  const list = DEFAULT_HIFI_INSTANCES;
  const results = await Promise.allSettled(list.map(async inst => {
    const start = Date.now();
    try {
      const r = await axios.get(`${inst}/search/`, {
        params: { s: 'test', limit: 1 },
        headers: { 'User-Agent': UA },
        timeout: 5000,
      });
      const ok = r.status === 200 && typeof r.data === 'object' && r.data !== null;
      return { inst, online: ok, latency: Date.now() - start };
    } catch (e) {
      return { inst, online: false, latency: Date.now() - start, error: e.message };
    }
  }));
  const instances = results.map(r => r.status === 'fulfilled' ? r.value : { inst: '?', online: false });
  return c.json({
    instances,
    checked: instances.length,
    online: instances.filter(i => i.online).length,
  });
});

// Health check
app.get('/health', async (c) => {
  const hifiInst = await getWorkingHiFiInstance([]);
  const scId = await getSCClientId(null);
  return c.json({
    status: 'ok',
    cache: null ? 'redis' : 'memory',
    hifi_instance: hifiInst || 'none found',
    sc_client_id: scId ? scId.slice(0, 8) + '...' : 'not discovered',
    timestamp: new Date().toISOString(),
  });
});

// ─── Config / Generator Page ─────────────────────────────────────────────────

function buildConfigPage(baseUrl, env) {
  var S = [];
  function w(s) { S.push(s); }

  w('<!DOCTYPE html>');
  w('<html lang="en">');
  w('<head>');
  w('<meta charset="UTF-8">');
  w('<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">');
  w('<title>All In Eclipse — Setup</title>');
  w('<link rel="preconnect" href="https://fonts.googleapis.com">');
  w('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
  w('<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">');
  w('<style>');
  w('*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}');
  w(':root{');
  w('  --glass-bg:rgba(255,255,255,.04);');
  w('  --glass-bg-hover:rgba(255,255,255,.06);');
  w('  --glass-bg-active:rgba(255,255,255,.08);');
  w('  --glass-border:rgba(255,255,255,.09);');
  w('  --glass-border-h:rgba(255,255,255,.16);');
  w('  --glass-blur:blur(24px);');
  w('  --text:#f0f0f5;');
  w('  --muted:#9a9ab0;');
  w('  --faint:#5a5a70;');
  w('  --accent:#6ee7b7;');
  w('  --accent-dim:rgba(110,231,183,.12);');
  w('  --accent-bdr:rgba(110,231,183,.3);');
  w('  --warn:#fbbf24;');
  w('  --err:#f87171;');
  w('  --r-sm:8px;--r:12px;--r-lg:16px;--r-xl:22px;');
  w('  --t:200ms cubic-bezier(.16,1,.3,1);');
  w('}');
  w('html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;-webkit-tap-highlight-color:transparent}');
  w('body{font-family:"Inter",system-ui,-apple-system,sans-serif;background:#0a0a0c;color:var(--text);min-height:100dvh;line-height:1.5;font-size:14px;overflow-x:hidden;position:relative}');
  w('body::before{content:"";position:fixed;inset:0;background:radial-gradient(ellipse 900px 500px at 15% 0%,rgba(110,231,183,.08),transparent 60%),radial-gradient(ellipse 700px 500px at 85% 15%,rgba(96,165,250,.06),transparent 60%),radial-gradient(ellipse 800px 600px at 50% 100%,rgba(192,132,252,.05),transparent 60%);pointer-events:none;z-index:0}');
  w('.app{position:relative;z-index:1;max-width:720px;margin:0 auto;padding:20px 16px 100px}');
  w('@media(max-width:640px){.app{padding:12px 12px 90px}}');
  w('.glass{background:var(--glass-bg);backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur);border:1px solid var(--glass-border);border-radius:var(--r-lg);position:relative;overflow:hidden}');
  w('.glass::before{content:"";position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,255,255,.03) 0%,transparent 50%,rgba(255,255,255,.01) 100%);pointer-events:none}');
  w('.hero{position:relative;overflow:hidden;margin-bottom:16px;min-height:calc(100dvh - 100px);display:flex;flex-direction:column;border-radius:var(--r-xl)}');
  w('@media(max-width:640px){.hero{min-height:calc(100dvh - 80px);border-radius:var(--r)}}');
  w('.hero-bg{position:absolute;inset:0;background:radial-gradient(ellipse 800px 500px at 50% 0%,rgba(110,231,183,.15),transparent 70%),radial-gradient(ellipse 600px 400px at 20% 80%,rgba(96,165,250,.1),transparent 70%),radial-gradient(ellipse 500px 300px at 80% 60%,rgba(192,132,252,.08),transparent 70%);pointer-events:none}');
  w('.hero-bg::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,.04) 0%,rgba(255,255,255,.01) 50%,transparent 100%)}');
  w('.hero-content{position:relative;z-index:1;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 40px 60px;text-align:center}');
  w('@media(max-width:640px){.hero-content{padding:60px 24px 50px}}');
  w('.hero-badge{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;background:var(--accent-dim);border:1px solid var(--accent-bdr);border-radius:99px;font-size:.75rem;font-weight:600;color:var(--accent);margin-bottom:28px;letter-spacing:.02em;animation:fadeInDown .6s ease}');
  w('@keyframes fadeInDown{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}');
  w('.hero-badge-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent);animation:pulse 2s ease-in-out infinite}');
  w('@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}');
  w('.hero h1{font-size:4.5rem;font-weight:900;letter-spacing:-.05em;margin-bottom:24px;background:linear-gradient(180deg,#fff 0%,#e0e0ea 40%,#a0a0b0 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;line-height:1;max-width:700px;animation:fadeInUp .8s ease}');
  w('@media(max-width:640px){.hero h1{font-size:3rem;margin-bottom:20px;letter-spacing:-.04em}}');
  w('.hero-subtitle{font-size:1.5rem;font-weight:600;color:var(--text);margin-bottom:20px;letter-spacing:-.02em;animation:fadeInUp .8s ease .1s both}');
  w('@media(max-width:640px){.hero-subtitle{font-size:1.2rem}}');
  w('.hero p{font-size:1.1rem;color:var(--muted);max-width:520px;margin:0 auto 40px;line-height:1.6;animation:fadeInUp .8s ease .2s both}');
  w('@media(max-width:640px){.hero p{font-size:1rem;margin-bottom:32px}}');
  w('.hero-cta{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;width:100%;max-width:480px;animation:fadeInUp .8s ease .3s both}');
  w('.hero-cta .btn{flex:1;min-width:180px}');
  w('@media(max-width:640px){.hero-cta{flex-direction:column;align-items:stretch;max-width:100%}.hero-cta .btn{min-width:auto}}');
  w('@keyframes fadeInUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}');
  w('.btn{padding:14px 24px;border-radius:var(--r);font-size:.9rem;font-weight:600;font-family:inherit;cursor:pointer;transition:all var(--t);border:none;outline:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap;min-height:48px;-webkit-tap-highlight-color:transparent;position:relative;overflow:hidden}');
  w('.btn-primary{background:linear-gradient(135deg,var(--accent),#86efac);color:#000;box-shadow:0 4px 20px rgba(110,231,183,.25),inset 0 1px 0 rgba(255,255,255,.3)}');
  w('.btn-primary:hover{box-shadow:0 6px 28px rgba(110,231,183,.4),inset 0 1px 0 rgba(255,255,255,.3);transform:translateY(-1px)}');
  w('.btn-primary:active{transform:none}');
  w('.btn-primary:disabled{background:var(--glass-bg-active);color:var(--faint);box-shadow:none;cursor:not-allowed;transform:none}');
  w('.btn-ghost{background:var(--glass-bg);backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur);color:var(--muted);border:1px solid var(--glass-border)}');
  w('.btn-ghost:hover{border-color:var(--glass-border-h);color:var(--text);background:var(--glass-bg-hover)}');
  w('.steps-bar{display:flex;align-items:center;gap:4px;padding:10px;margin-bottom:12px;display:none}');
  w('.step-item{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;position:relative;cursor:pointer;-webkit-tap-highlight-color:transparent;padding:4px 0;transition:opacity var(--t)}');
  w('.step-item:hover{opacity:.85}');
  w('.step-item:not(:last-child)::after{content:"";position:absolute;top:12px;left:calc(50% + 14px);right:calc(-50% + 14px);height:2px;background:var(--glass-border);transition:background var(--t)}');
  w('.step-item.done:not(:last-child)::after{background:var(--accent)}');
  w('.step-num{width:24px;height:24px;border-radius:50%;background:var(--glass-bg-active);border:1.5px solid var(--glass-border);display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:700;color:var(--faint);transition:all var(--t)}');
  w('.step-item.active .step-num{background:var(--accent-dim);border-color:var(--accent-bdr);color:var(--accent);box-shadow:0 0 0 3px rgba(110,231,183,.08)}');
  w('.step-item.done .step-num{background:var(--accent);border-color:var(--accent);color:#000}');
  w('.step-label{font-size:.58rem;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.05em;transition:color var(--t)}');
  w('.step-item.active .step-label{color:var(--text)}');
  w('.step-item.done .step-label{color:var(--muted)}');
  w('.panel{padding:18px;margin-bottom:10px;display:none;animation:fadeIn .3s ease}');
  w('.panel.active{display:block}');
  w('@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}');
  w('.panel-head{display:flex;align-items:center;gap:10px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--glass-border)}');
  w('.panel-title{font-size:.95rem;font-weight:700;letter-spacing:-.01em;line-height:1.3}');
  w('.panel-desc{font-size:.74rem;color:var(--muted);margin-top:3px;line-height:1.45}');
  w('.field{margin-bottom:10px}');
  w('.field-label{display:block;font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:6px}');
  w('.field-input{width:100%;background:rgba(0,0,0,.25);border:1px solid var(--glass-border);border-radius:var(--r-sm);color:var(--text);padding:11px 13px;font-size:.875rem;font-family:inherit;transition:border-color var(--t),box-shadow var(--t);outline:none;-webkit-appearance:none}');
  w('.field-input:focus{border-color:var(--accent-bdr);box-shadow:0 0 0 3px var(--accent-dim)}');
  w('.field-input::placeholder{color:var(--faint)}');
  w('.field-hint{font-size:.68rem;color:var(--faint);margin-top:5px;line-height:1.55}');
  w('.field-hint a{color:var(--accent);text-decoration:none}.field-hint a:hover{text-decoration:underline}');
  w('.field-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}');
  w('@media(max-width:480px){.field-row{grid-template-columns:1fr}}');
  w('.section{margin-bottom:16px}');
  w('.section:last-child{margin-bottom:0}');
  w('.section-title{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}');
  w('.section-title .opt{font-weight:500;color:var(--faint);text-transform:none;letter-spacing:0;font-size:.64rem}');
  w('.content-grid{display:grid;grid-template-columns:1fr;gap:6px}');
  w('.content-card{display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--r);cursor:pointer;transition:all var(--t);user-select:none;-webkit-tap-highlight-color:transparent;min-height:56px;backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur)}');
  w('.content-card:hover{border-color:var(--glass-border-h);background:var(--glass-bg-hover)}');
  w('.content-card.on{background:var(--accent-dim);border-color:var(--accent-bdr);box-shadow:0 0 0 1px var(--accent-bdr),inset 0 1px 0 rgba(255,255,255,.05)}');
  w('.content-check{width:20px;height:20px;border-radius:50%;background:var(--glass-bg-active);border:1.5px solid var(--glass-border);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:transparent;transition:all var(--t)}');
  w('.content-card.on .content-check{background:var(--accent);border-color:var(--accent);color:#000;box-shadow:0 0 8px rgba(110,231,183,.4)}');
  w('.content-meta{flex:1;min-width:0}');
  w('.content-name{font-size:.88rem;font-weight:600;color:var(--text);margin-bottom:2px}');
  w('.content-card.on .content-name{color:var(--accent)}');
  w('.content-desc{font-size:.7rem;color:var(--muted)}');
  w('.svc-card{background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.13);border-radius:var(--r);margin-bottom:8px;overflow:hidden;transition:border-color var(--t),background var(--t);backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur)}');
  w('.svc-card:hover{background:rgba(255,255,255,.075);border-color:rgba(255,255,255,.18)}');
  w('.svc-card.connected{border-color:var(--accent-bdr);background:var(--accent-dim)}');
  w('.svc-head{display:flex;align-items:center;gap:10px;padding:14px 16px;cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none;min-height:60px}');
  w('.svc-info{flex:1;min-width:0}');
  w('.svc-name-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:3px}');
  w('.svc-name{font-size:.9rem;font-weight:700;color:var(--text);letter-spacing:-.01em}');
  w('.svc-opt{font-size:.6rem;font-weight:700;padding:2px 7px;border-radius:99px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.13);color:rgba(255,255,255,.4);letter-spacing:.04em;text-transform:uppercase;flex-shrink:0}');
  w('.svc-desc{font-size:.7rem;color:var(--muted);line-height:1.4}');
  w('.svc-status{font-size:.65rem;font-weight:600;padding:4px 10px;border-radius:99px;flex-shrink:0;white-space:nowrap}');
  w('.svc-status.on{background:var(--accent-dim);border:1px solid var(--accent-bdr);color:var(--accent)}');
  w('.svc-status.off{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.45)}');
  w('.svc-chevron{color:var(--faint);transition:transform var(--t);flex-shrink:0}');
  w('.svc-card.open .svc-chevron{transform:rotate(180deg)}');
  w('.svc-body{display:none;padding:0 16px 16px;border-top:1px solid var(--glass-border)}');
  w('.svc-card.open .svc-body{display:block}');
  w('.svc-body .field:first-child{margin-top:14px}');
  w('.adv-toggle{display:flex;align-items:center;gap:6px;background:none;border:none;color:var(--faint);font-size:.7rem;font-weight:600;cursor:pointer;padding:6px 0;margin-top:6px;font-family:inherit;-webkit-tap-highlight-color:transparent;transition:color var(--t)}');
  w('.adv-toggle:hover{color:var(--muted)}');
  w('.adv-toggle svg{transition:transform var(--t)}');
  w('.adv-toggle.open svg{transform:rotate(180deg)}');
  w('.adv-box{display:none;margin-top:8px}');
  w('.adv-box.open{display:block}');
  w('.mode-toggle{display:grid;grid-template-columns:1fr 1fr;gap:6px;background:rgba(0,0,0,.2);border:1px solid var(--glass-border);border-radius:var(--r);padding:4px;margin-bottom:14px}');
  w('.mode-btn{padding:12px 14px;background:transparent;border:none;border-radius:var(--r-sm);color:var(--muted);font-size:.82rem;font-weight:600;font-family:inherit;cursor:pointer;transition:all var(--t);display:flex;flex-direction:column;align-items:center;gap:4px;-webkit-tap-highlight-color:transparent;min-height:56px;position:relative}');
  w('.mode-btn:hover{color:var(--text)}');
  w('.mode-btn.on{background:var(--accent-dim);color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent-bdr),0 0 12px rgba(110,231,183,.08)}');
  w('.mode-btn-sub{font-size:.64rem;color:var(--faint);font-weight:400}');
  w('.mode-btn.on .mode-btn-sub{color:var(--accent);opacity:.7}');
  w('.mode-btn-soon{position:absolute;top:6px;right:6px;font-size:.52rem;font-weight:700;color:var(--faint);background:var(--glass-bg-active);padding:1px 5px;border-radius:99px;border:1px solid var(--glass-border);letter-spacing:.03em}');
  w('.quality-pills{display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;padding:4px;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;background:rgba(0,0,0,.2);border:1px solid var(--glass-border);border-radius:var(--r)}');
  w('.quality-pills::-webkit-scrollbar{display:none}');
  w('.quality-pill{flex:0 0 auto;min-width:110px;padding:14px 16px;background:transparent;border:1px solid transparent;border-radius:var(--r-sm);cursor:pointer;transition:all var(--t);display:flex;flex-direction:column;align-items:center;gap:4px;scroll-snap-align:start;-webkit-tap-highlight-color:transparent;font-family:inherit}');
  w('.quality-pill:hover{background:var(--glass-bg-hover);border-color:var(--glass-border)}');
  w('.quality-pill.on{background:var(--accent-dim);border-color:var(--accent-bdr);box-shadow:0 0 0 1px var(--accent-bdr),0 0 16px rgba(110,231,183,.1)}');
  w('.quality-pill-name{font-size:.82rem;font-weight:700;color:var(--muted);transition:color var(--t);letter-spacing:-.01em}');
  w('.quality-pill.on .quality-pill-name{color:var(--accent)}');
  w('.quality-pill-desc{font-size:.64rem;color:var(--faint);font-weight:400;transition:color var(--t)}');
  w('.quality-pill.on .quality-pill-desc{color:var(--accent);opacity:.7}');
  w('.quality-current{margin-top:12px;padding:12px 16px;background:var(--accent-dim);border:1px solid var(--accent-bdr);border-radius:var(--r-sm);display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}');
  w('.quality-current-label{font-size:.68rem;color:var(--muted);font-weight:500}');
  w('.quality-current-value{font-size:.82rem;color:var(--accent);font-weight:700;letter-spacing:-.01em}');
  w('.preset-grid{display:grid;grid-template-columns:1fr;gap:6px;margin-bottom:12px}');
  w('.preset-card{padding:14px;background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--r);cursor:pointer;transition:all var(--t);user-select:none;position:relative;-webkit-tap-highlight-color:transparent;min-height:72px;backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur)}');
  w('.preset-card:hover{border-color:var(--glass-border-h);background:var(--glass-bg-hover)}');
  w('.preset-card.on{background:var(--accent-dim);border-color:var(--accent-bdr);box-shadow:0 0 0 1px var(--accent-bdr),inset 0 1px 0 rgba(255,255,255,.05)}');
  w('.preset-check{position:absolute;top:12px;right:12px;width:20px;height:20px;border-radius:50%;background:var(--glass-bg-active);border:1.5px solid var(--glass-border);display:flex;align-items:center;justify-content:center;color:transparent;transition:all var(--t)}');
  w('.preset-card.on .preset-check{background:var(--accent);border-color:var(--accent);color:#000;box-shadow:0 0 8px rgba(110,231,183,.4)}');
  w('.preset-name{font-size:.88rem;font-weight:700;color:var(--text);margin-bottom:4px;padding-right:28px}');
  w('.preset-card.on .preset-name{color:var(--accent)}');
  w('.preset-desc{font-size:.72rem;color:var(--muted);line-height:1.45}');
  w('.drag-list{display:flex;flex-direction:column;gap:5px}');
  w('.drag-item{display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--r-sm);transition:all var(--t);user-select:none;position:relative;-webkit-tap-highlight-color:transparent;min-height:52px;backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur)}');
  w('.drag-item:hover{border-color:var(--glass-border-h);background:var(--glass-bg-hover)}');
  w('.drag-item.inactive{opacity:.45}');
  w('.drag-item.dragging{opacity:.35;border-color:var(--accent-bdr)}');
  w('.drag-item.drag-over{border-color:var(--accent);transform:scale(1.01);box-shadow:0 0 0 2px var(--accent-dim)}');
  w('.drag-item[draggable="true"]{cursor:grab}');
  w('.drag-item[draggable="true"]:active{cursor:grabbing}');
  w('.drag-handle{color:var(--faint);flex-shrink:0;cursor:grab;padding:3px;touch-action:none}');
  w('.drag-handle:active{cursor:grabbing}');
  w('.drag-rank{width:24px;height:24px;background:var(--accent-dim);border:1px solid var(--accent-bdr);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.68rem;font-weight:700;color:var(--accent);flex-shrink:0}');
  w('.drag-body{flex:1;min-width:0}');
  w('.drag-name{font-size:.82rem;font-weight:600}');
  w('.drag-sub{font-size:.66rem;color:var(--muted);margin-top:1px}');
  w('.drag-toggle{width:40px;height:24px;background:var(--accent);border-radius:12px;position:relative;transition:background var(--t);flex-shrink:0;cursor:pointer;border:none;padding:0;-webkit-tap-highlight-color:transparent;box-shadow:inset 0 1px 0 rgba(255,255,255,.2)}');
  w('.drag-toggle::after{content:"";position:absolute;width:18px;height:18px;background:#fff;border-radius:50%;top:3px;left:19px;transition:transform var(--t);box-shadow:0 1px 3px rgba(0,0,0,.3)}');
  w('.drag-toggle.off{background:var(--glass-bg-active);border:1px solid var(--glass-border);box-shadow:none}');
  w('.drag-toggle.off::after{left:3px}');
  w('.drag-arrows{display:flex;flex-direction:column;gap:2px;flex-shrink:0}');
  w('.arrow-btn{width:28px;height:22px;background:var(--glass-bg-active);border:1px solid var(--glass-border);border-radius:4px;color:var(--muted);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all var(--t);padding:0;-webkit-tap-highlight-color:transparent}');
  w('.arrow-btn:hover{background:var(--accent-dim);border-color:var(--accent-bdr);color:var(--accent)}');
  w('.arrow-btn:active{transform:scale(.95)}');
  w('.arrow-btn:disabled{opacity:.3;cursor:not-allowed}');
  w('.summary-grid{display:grid;grid-template-columns:1fr;gap:8px;margin-bottom:14px}');
  w('.sum-card{background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--r);padding:14px 16px;backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur);position:relative;overflow:hidden}');
  w('.sum-card::before{content:"";position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,255,255,.02) 0%,transparent 50%);pointer-events:none}');
  w('.sum-label{font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--faint);margin-bottom:8px;display:block}');
  w('.sum-value{font-size:.88rem;font-weight:600;color:var(--text);line-height:1.45;word-break:break-word}');
  w('.sum-value.accent{color:var(--accent);text-shadow:0 0 20px rgba(110,231,183,.2)}');
  w('.sum-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--glass-border)}');
  w('.sum-row:last-child{border-bottom:none}');
  w('.sum-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px rgba(110,231,183,.4);flex-shrink:0}');
  w('.sum-dot.off{background:var(--faint);box-shadow:none}');
  w('.sum-source-name{font-size:.82rem;font-weight:600;color:var(--text);flex:1}');
  w('.sum-source-name.off{color:var(--faint);font-weight:500}');
  w('.url-card{background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--r);padding:12px;margin-bottom:8px;backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur)}');
  w('.url-label{font-size:.7rem;font-weight:600;color:var(--muted);margin-bottom:8px}');
  w('.url-row{display:flex;gap:8px;align-items:stretch}');
  w('.url-box{flex:1;background:rgba(0,0,0,.3);border:1px solid var(--glass-border);border-radius:var(--r-sm);padding:10px 12px;font-family:"JetBrains Mono",monospace;font-size:.68rem;color:var(--accent);word-break:break-all;line-height:1.5;min-height:42px;display:flex;align-items:center}');
  w('.copy-btn{background:var(--glass-bg);border:1px solid var(--glass-border);color:var(--text);padding:0 14px;border-radius:var(--r-sm);cursor:pointer;font-size:.74rem;font-weight:600;font-family:inherit;transition:all var(--t);flex-shrink:0;display:flex;align-items:center;gap:6px;-webkit-tap-highlight-color:transparent;min-height:42px;backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur)}');
  w('.copy-btn:hover{border-color:var(--accent-bdr);color:var(--accent)}');
  w('.copy-btn:active{transform:scale(.95)}');
  w('.copy-btn.copied{background:var(--accent-dim);border-color:var(--accent-bdr);color:var(--accent)}');
  w('.install-steps{display:flex;flex-direction:column;gap:12px;margin-top:14px}');
  w('.i-step{display:flex;gap:10px;align-items:flex-start}');
  w('.i-num{width:26px;height:26px;border-radius:50%;background:var(--accent-dim);border:1px solid var(--accent-bdr);color:var(--accent);font-size:.76rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}');
  w('.i-body{font-size:.8rem;color:var(--muted);line-height:1.55}');
  w('.i-body strong{color:var(--text)}');
  w('.nav-row{display:flex;gap:8px;margin-top:18px;padding-top:16px;border-top:1px solid var(--glass-border)}');
  w('.nav-row .btn{flex:1}');
  w('@media(max-width:640px){.nav-row{flex-direction:column-reverse}}');
  w('.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(8px);background:rgba(20,20,24,.95);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid var(--glass-border);border-radius:99px;padding:10px 18px;font-size:.8rem;font-weight:600;color:var(--text);display:flex;align-items:center;gap:8px;opacity:0;transition:all .3s cubic-bezier(.16,1,.3,1);pointer-events:none;z-index:1000;white-space:nowrap}');
  w('.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}');
  w('.toast-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px var(--accent);flex-shrink:0}');
  w('.isrc-toggle-row{display:flex;flex-direction:column;gap:8px}');
  w('.isrc-toggle-item{display:flex;align-items:flex-start;gap:12px;padding:10px 12px;background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--r-sm);transition:border-color var(--t),background var(--t)}');
  w('.isrc-toggle-item .itlabel{flex:1;min-width:0}');
  w('.isrc-toggle-item .itname{font-size:.8rem;font-weight:600;color:var(--text);margin-bottom:2px}');
  w('.isrc-toggle-item .itdesc{font-size:.7rem;color:var(--muted);line-height:1.4}');
  w('.isrc-toggle-item .itwarn{font-size:.7rem;color:var(--warn);margin-top:3px;display:none}');
  w('.isrc-toggle-btn{flex-shrink:0;width:36px;height:20px;border-radius:99px;border:1px solid var(--glass-border);background:var(--glass-bg-active);cursor:pointer;position:relative;transition:background var(--t),border-color var(--t);margin-top:1px}');
  w('.isrc-toggle-btn::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--muted);transition:transform var(--t),background var(--t)}');
  w('.isrc-toggle-btn.on{background:var(--accent-dim);border-color:var(--accent-bdr)}');
  w('.isrc-toggle-btn.on::after{transform:translateX(16px);background:var(--accent)}');
  w('.tip{background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--r-sm);padding:10px 13px;font-size:.74rem;color:var(--muted);line-height:1.65;margin-bottom:12px}');
  w('.tip b{color:var(--text)}');
  w('.tip a{color:var(--accent);text-decoration:none}.tip a:hover{text-decoration:underline}');
  w('.tip.warn{border-color:rgba(251,191,36,.18);background:rgba(251,191,36,.05)}');
  w('.tip.warn b{color:var(--warn)}');
  w('code.inline{font-family:"JetBrains Mono","SF Mono",ui-monospace,monospace;font-size:.72rem;color:var(--accent);background:rgba(110,231,183,.08);padding:1px 5px;border-radius:3px}');
  w('.status{padding:10px 14px;border-radius:var(--r-sm);font-size:.78rem;margin-top:10px;display:none;line-height:1.5}');
  w('.s-ok{background:rgba(110,231,183,.07);border:1px solid rgba(110,231,183,.18);color:var(--accent)}');
  w('.s-err{background:rgba(248,113,113,.07);border:1px solid rgba(248,113,113,.18);color:var(--err)}');
  w('.outbox{display:none;margin-top:16px}');
  w('.blk-area{width:100%;background:rgba(0,0,0,.25);border:1px solid var(--glass-border);border-radius:var(--r-sm);color:var(--text);padding:10px 12px;font-size:.8rem;font-family:"JetBrains Mono",monospace;resize:vertical;min-height:70px;outline:none;transition:border-color var(--t)}');
  w('.blk-area:focus{border-color:var(--accent-bdr);box-shadow:0 0 0 3px var(--accent-dim)}');
  w('.shint{font-size:.68rem;color:var(--faint);margin-top:8px;line-height:1.65}');
  w('#hifiInstList .inst-row{display:flex;align-items:center;gap:8px;font-size:.72rem;padding:7px 10px;background:rgba(0,0,0,.25);border:1px solid var(--glass-border);border-radius:8px;margin-bottom:5px}');
  w('footer{text-align:center;font-size:.65rem;color:var(--faint);padding:20px 0 10px;line-height:1.7}');
  w('</style>');
  w('</head>');
  w('<body>');
  w('<div class="app">');

  // ── HERO
  w('<div class="hero glass" id="heroSection">');
  w('<div class="hero-bg"></div>');
  w('<div class="hero-content">');
  w('<div class="hero-badge"><div class="hero-badge-dot"></div>Eclipse Universal Addon</div>');
  w('<h1>All In Eclipse</h1>');
  w('<div class="hero-subtitle">One addon. Every source.</div>');
  w('<p>Stream from Qobuz, Tidal, Deezer, SoundCloud and more &mdash; all in one place. Set up in under a minute.</p>');
  w('<div class="hero-cta">');
  w('<button class="btn btn-primary" onclick="startSetup()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>Get Started</button>');
  w('<button class="btn btn-ghost" onclick="openRefresh()">I have an existing URL</button>');
  w('</div>');
  w('</div>');
  w('<div style="position:relative;z-index:1;padding:14px 20px;border-top:1px solid var(--glass-border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">');
  w('<div style="font-size:.7rem;color:var(--faint)">Qobuz &middot; Tidal &middot; Deezer &middot; SoundCloud &middot; Internet Archive &middot; Podcasts &middot; Radio</div>');
  var displayBase = baseUrl || 'your-addon-url';
  w('<div style="font-size:.65rem;color:var(--faint)">Deployed at <code style="font-family:monospace;color:var(--accent);font-size:.65rem">' + displayBase + '</code></div>');
  w('</div>');
  w('</div>'); // end hero

  // ── STEPS BAR
  w('<div class="steps-bar glass" id="stepsBar">');
  w('<div class="step-item active" data-step="1" onclick="handleStepClick(1)"><div class="step-num">1</div><div class="step-label">Content</div></div>');
  w('<div class="step-item" data-step="2" onclick="handleStepClick(2)"><div class="step-num">2</div><div class="step-label">Credentials</div></div>');
  w('<div class="step-item" data-step="3" onclick="handleStepClick(3)"><div class="step-num">3</div><div class="step-label">Sources</div></div>');
  w('<div class="step-item" data-step="4" onclick="handleStepClick(4)"><div class="step-num">4</div><div class="step-label">Quality</div></div>');
  w('<div class="step-item" data-step="5" onclick="handleStepClick(5)"><div class="step-num">5</div><div class="step-label">Install</div></div>');
  w('</div>');

  // ── PANEL 1: Content Types
  w('<div class="panel glass" data-panel="1">');
  w('<div class="panel-head"><div><div class="panel-title">What do you want to stream?</div><div class="panel-desc">Music is always included. Choose extra content types below.</div></div></div>');
  w('<div class="content-grid">');
  w('<div class="content-card" data-type="podcast" onclick="toggleContent(this,\'podcast\')">');
  w('<div class="content-check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>');
  w('<div class="content-meta"><div class="content-name">Podcasts</div><div class="content-desc">Podcast Index &middot; Taddy &middot; Apple Podcasts</div></div>');
  w('</div>');
  w('<div class="content-card" data-type="audiobook" onclick="toggleContent(this,\'audiobook\')">');
  w('<div class="content-check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>');
  w('<div class="content-meta"><div class="content-name">Audiobooks</div><div class="content-desc">LibriVox &middot; Internet Archive</div></div>');
  w('</div>');
  w('<div class="content-card" data-type="radio" onclick="toggleContent(this,\'radio\')">');
  w('<div class="content-check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>');
  w('<div class="content-meta"><div class="content-name">Radio</div><div class="content-desc">Radio Browser &middot; Live streams worldwide</div></div>');
  w('</div>');
  w('<div class="content-card" data-type="explicit" onclick="toggleContent(this,\'explicit\')"><div class="content-check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><div class="content-meta"><div class="content-name">🔞 Explicit Tracks</div><div class="content-desc">Allow unfiltered tracks &middot; default ON</div></div></div>');
  w('</div>');
  w('<div class="nav-row"><div></div><button class="btn btn-primary" onclick="goToStep(2)">Next <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button></div>');
  w('</div>');

  // ── PANEL 2: Credentials
  w('<div class="panel glass" data-panel="2">');
  w('<div class="panel-head"><div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><div class="panel-title">Connect your accounts</div><span style="font-size:.6rem;font-weight:700;padding:2px 8px;border-radius:99px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.13);color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.05em;flex-shrink:0">Optional</span></div><div class="panel-desc">Skip this step entirely — every service is pre-configured and works out of the box. Add your own credentials only if you want to use your personal account or higher quality streams.</div></div></div>');

  w('<div class="tip"><b>All services are pre-configured.</b> Qobuz, Tidal, Deezer, and SoundCloud work without entering anything. Podcast Index and Taddy are only needed if you enabled Podcasts in the previous step.</div>');

  // Podcast Index + Taddy (shown at top when podcast selected)
  w('<div id="podcastCredsSection" style="display:none">');
  w('<div class="svc-card" data-svc="pi">');
  w('<div class="svc-head" onclick="this.closest(\'.svc-card\').classList.toggle(\'open\')">');
  w('<div class="svc-info"><div class="svc-name-row"><span class="svc-name">Podcast Index</span><span class="svc-opt">Optional</span></div><div class="svc-desc">Podcast search, feed lookup and episode metadata</div></div>');
  w('<div class="svc-status off" id="status-pi">Not connected</div>');
  w('<svg class="svc-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>');
  w('</div>');
  w('<div class="svc-body">');
  w('<div class="field-row"><div class="field"><label class="field-label">API Key</label><input type="text" id="piKey" class="field-input" placeholder="Podcast Index API Key"></div><div class="field"><label class="field-label">API Secret</label><input type="password" id="piSecret" class="field-input" placeholder="Secret"></div></div>');
  w('<div class="field-hint">Free at <a href="https://podcastindex.org/developer" target="_blank" rel="noopener">podcastindex.org/developer</a></div>');
  w('</div></div>');
  w('<div class="svc-card" data-svc="taddy">');
  w('<div class="svc-head" onclick="this.closest(\'.svc-card\').classList.toggle(\'open\')">');
  w('<div class="svc-info"><div class="svc-name-row"><span class="svc-name">Taddy</span><span class="svc-opt">Optional</span></div><div class="svc-desc">Additional podcast metadata and discovery</div></div>');
  w('<div class="svc-status off" id="status-taddy">Not connected</div>');
  w('<svg class="svc-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>');
  w('</div>');
  w('<div class="svc-body">');
  w('<div class="field-row"><div class="field"><label class="field-label">API Key</label><input type="text" id="taddyKey" class="field-input" placeholder="Taddy API Key"></div><div class="field"><label class="field-label">User ID</label><input type="text" id="taddyUid" class="field-input" placeholder="Taddy User ID"></div></div>');
  w('</div></div>');
  w('</div>'); // end podcastCredsSection

  // Qobuz
  w('<div class="svc-card" data-svc="qobuz">');
  w('<div class="svc-head" onclick="this.closest(\'.svc-card\').classList.toggle(\'open\')">');
  w('<div class="svc-info"><div class="svc-name-row"><span class="svc-name">Qobuz</span><span class="svc-opt">Optional</span></div><div class="svc-desc">Hi-Res FLAC up to 24-bit / 192kHz &mdash; pre-configured</div></div>');
  w('<div class="svc-status off" id="status-qobuz">Not connected</div>');
  w('<svg class="svc-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>');
  w('</div>');
  w('<div class="svc-body">');
  w('<div class="field"><label class="field-label">User Auth Token</label><input type="password" id="qobuzUserToken" class="field-input" placeholder="Your Qobuz user_auth_token"><div class="field-hint">Only needed to access <b>your personal Qobuz library</b>. The shared pool works without this.</div></div>');
  w('<button class="adv-toggle" data-adv="qobuz" onclick="toggleAdv(this)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg> Advanced (App ID &amp; Secret)</button>');
  w('<div class="adv-box" data-adv-box="qobuz">');
  w('<div class="field-row"><div class="field"><label class="field-label">App ID</label><input type="text" id="qobuzAppId" class="field-input" placeholder="App ID"></div><div class="field"><label class="field-label">App Secret</label><input type="password" id="qobuzSecret" class="field-input" placeholder="Secret"></div></div>');
  w('<div class="field-hint">Leave blank to use the built-in app credentials.</div>');
  w('</div></div></div>');

  // Tidal HiFi
  w('<div class="svc-card" data-svc="tidal">');
  w('<div class="svc-head" onclick="this.closest(\'.svc-card\').classList.toggle(\'open\')">');
  w('<div class="svc-info"><div class="svc-name-row"><span class="svc-name">Tidal HiFi</span><span class="svc-opt">Optional</span></div><div class="svc-desc">AAC 320 kbps via proxy &mdash; pre-configured</div></div>');
  w('<div class="svc-status off" id="status-tidal">Using public pool</div>');
  w('<svg class="svc-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>');
  w('</div>');
  w('<div class="svc-body">');
  w('<div class="field"><label class="field-label">HiFi Instance URL(s)</label><input type="text" id="hifiInst" class="field-input" placeholder="https://hifi.example.com,https://hifi2.example.com"><div class="field-hint">Comma-separated. Leave blank to use auto-discovered public instances.</div></div>');
  w('<div id="hifiInstList" style="margin-top:10px"></div>');
  w('</div></div>');

  // Deezer
  w('<div class="svc-card" data-svc="deezer">');
  w('<div class="svc-head" onclick="this.closest(\'.svc-card\').classList.toggle(\'open\')">');
  w('<div class="svc-info"><div class="svc-name-row"><span class="svc-name">Deezer</span><span class="svc-opt">Optional</span></div><div class="svc-desc">FLAC or MP3 320 kbps &mdash; needs your ARL cookie to play</div></div>');
  w('<div class="svc-status off" id="status-deezer">Not connected</div>');
  w('<svg class="svc-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>');
  w('</div>');
  w('<div class="svc-body">');
  w('<div class="field"><label class="field-label">ARL Cookie</label><input type="password" id="deezerArl" class="field-input" placeholder="Your Deezer ARL cookie"><div class="field-hint">Deezer tracks appear in search without this, but <b>won\'t play until you add your ARL</b>.<br>Open deezer.com &rarr; DevTools &rarr; Application &rarr; Cookies &rarr; copy the <code class="inline">arl</code> value.</div></div>');
  w('</div></div>');

  // SoundCloud
  w('<div class="svc-card" data-svc="sc">');
  w('<div class="svc-head" onclick="this.closest(\'.svc-card\').classList.toggle(\'open\')">');
  w('<div class="svc-info"><div class="svc-name-row"><span class="svc-name">SoundCloud</span><span class="svc-opt">Optional</span></div><div class="svc-desc">MP3 up to 320 kbps &mdash; pre-configured, auto-discovered</div></div>');
  w('<div class="svc-status off" id="status-sc">Auto-discovered</div>');
  w('<svg class="svc-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>');
  w('</div>');
  w('<div class="svc-body">');
  w('<div class="field"><label class="field-label">Client ID <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--faint)">(optional)</span></label><input type="text" id="scId" class="field-input" placeholder="SoundCloud Client ID"><div class="field-hint">Only set this if auto-discovery stops working.</div></div>');
  w('<button class="adv-toggle" data-adv="sc" onclick="toggleAdv(this)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg> OAuth Token</button>');
  w('<div class="adv-box" data-adv-box="sc"><div class="field"><label class="field-label">OAuth Token</label><input type="password" id="scOauth" class="field-input" placeholder="OAuth token for higher quality"></div></div>');
  w('</div></div>');

  w('<div class="nav-row"><button class="btn btn-ghost" onclick="goToStep(1)">Back</button><button class="btn btn-primary" onclick="goToStep(3)">Next <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button></div>');
  w('</div>'); // end panel 2

  // ── PANEL 3: Sources & Order
  w('<div class="panel glass" data-panel="3">');
  w('<div class="panel-head"><div><div class="panel-title">Source priority &amp; order</div><div class="panel-desc">Choose a preset or drag to customize. Toggle sources on/off individually.</div></div></div>');
  w('<div class="section"><div class="section-title">Quick presets</div>');
  w('<div class="preset-grid" id="presetGrid">');
  w('<div class="preset-card on" data-preset="full" onclick="applyPreset(this)"><div class="preset-check"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><div class="preset-name">Everything</div><div class="preset-desc">All sources enabled &mdash; maximum coverage</div></div>');
  w('<div class="preset-card" data-preset="recommended" onclick="applyPreset(this)"><div class="preset-check"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><div class="preset-name">Recommended</div><div class="preset-desc">Tidal search, all streams &mdash; balanced quality &amp; catalog</div></div>');
  w('<div class="preset-card" data-preset="bigger" onclick="applyPreset(this)"><div class="preset-check"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><div class="preset-name">Bigger catalog</div><div class="preset-desc">Deezer + SoundCloud search for more tracks</div></div>');
  w('<div class="preset-card" data-preset="custom" onclick="applyPreset(this)"><div class="preset-check"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div><div class="preset-name">Custom</div><div class="preset-desc">Configure manually below</div></div>');
  w('</div></div>');
  w('<div class="section"><div class="section-title">Search order <span class="opt">drag or use arrows to reorder</span></div><div class="drag-list" id="searchDragList"></div><div class="shint">The first enabled source is searched first.</div></div>');
  w('<div class="section"><div class="section-title">Stream order <span class="opt">drag or use arrows to reorder</span></div><div class="drag-list" id="streamDragList"></div><div class="shint">Falls back automatically if a source fails.</div></div>');
  w('<div class="section"><div class="section-title">ISRC enrichment <span class="opt">optional</span></div>');
  w('<div class="isrc-toggle-row" id="isrcTogglesRow">');
  w('<div class="isrc-toggle-item on" id="itm-musicbrainz"><button class="isrc-toggle-btn on" id="btn-musicbrainz" onclick="toggleIsrcSource(\'musicbrainz\')" aria-label="Toggle MusicBrainz"></button><div class="itlabel"><div class="itname">MusicBrainz</div><div class="itdesc">Free, open music encyclopedia. Best ISRC coverage.</div><div class="itwarn">Disabling may reduce match accuracy.</div></div></div>');
  w('<div class="isrc-toggle-item on" id="itm-theaudiodb"><button class="isrc-toggle-btn on" id="btn-theaudiodb" onclick="toggleIsrcSource(\'theaudiodb\')" aria-label="Toggle TheAudioDB"></button><div class="itlabel"><div class="itname">TheAudioDB</div><div class="itdesc">Adds artwork and metadata enrichment.</div><div class="itwarn">Disabling reduces metadata quality.</div></div></div>');
  w('<div class="isrc-toggle-item on" id="itm-deezer_isrc"><button class="isrc-toggle-btn on" id="btn-deezer_isrc" onclick="toggleIsrcSource(\'deezer_isrc\')" aria-label="Toggle Deezer ISRC"></button><div class="itlabel"><div class="itname">Deezer ISRC</div><div class="itdesc">Fast ISRC lookup via Deezer public API.</div><div class="itwarn">Disabling may reduce stream hit rate.</div></div></div>');
  w('<div class="isrc-toggle-item on" id="itm-qobuz_isrc"><button class="isrc-toggle-btn on" id="btn-qobuz_isrc" onclick="toggleIsrcSource(\'qobuz_isrc\')" aria-label="Toggle Qobuz ISRC"></button><div class="itlabel"><div class="itname">Qobuz ISRC</div><div class="itdesc">Qobuz ISRC resolution (requires Qobuz credentials).</div><div class="itwarn">Requires Qobuz credentials to be useful.</div></div></div>');
  w('</div></div>');
  w('<div class="section"><div class="section-title">Blocked ISRCs <span class="opt">optional</span></div>');
  w('<textarea class="blk-area" id="blockedIsrcs" placeholder="One ISRC per line&#10;e.g. USUM71900000"></textarea>');
  w('<div class="field-hint">These ISRCs will never be streamed.</div></div>');
  w('<div class="nav-row"><button class="btn btn-ghost" onclick="goToStep(2)">Back</button><button class="btn btn-primary" onclick="goToStep(4)">Next <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button></div>');
  w('</div>'); // end panel 3

  // ── PANEL 4: Quality
  w('<div class="panel glass" data-panel="4">');
  w('<div class="panel-head"><div><div class="panel-title">Audio quality</div><div class="panel-desc">Sets the preferred streaming quality for Qobuz.</div></div></div>');
  w('<div class="quality-pills" id="qualityPills">');
  w('<button class="quality-pill" data-q="HIGH" onclick="setQuality(this)"><span class="quality-pill-name">High</span><span class="quality-pill-desc">320 kbps MP3</span></button>');
  w('<button class="quality-pill" data-q="LOSSLESS" onclick="setQuality(this)"><span class="quality-pill-name">Lossless</span><span class="quality-pill-desc">CD 44.1 kHz</span></button>');
  w('<button class="quality-pill" data-q="HIRES_96" onclick="setQuality(this)"><span class="quality-pill-name">Hi-Res 96</span><span class="quality-pill-desc">24-bit / 96 kHz</span></button>');
  w('<button class="quality-pill" data-q="HIRES_192" onclick="setQuality(this)"><span class="quality-pill-name">Hi-Res 192</span><span class="quality-pill-desc">24-bit / 192 kHz</span></button>');
  w('<button class="quality-pill on" data-q="AUTO" onclick="setQuality(this)"><span class="quality-pill-name">Auto</span><span class="quality-pill-desc">Best available</span></button>');
  w('</div>');
  w('<div class="quality-current"><span class="quality-current-label">Selected quality</span><span class="quality-current-value" id="qualityCurrentValue">Auto &mdash; Best available</span></div>');
  w('<div class="field-hint" style="margin-top:10px">Only applies to Qobuz. Other sources use their native quality.</div>');
  w('<div class="nav-row"><button class="btn btn-ghost" onclick="goToStep(3)">Back</button><button class="btn btn-primary" onclick="goToStep(5)">Generate &amp; Install <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg></button></div>');
  w('</div>'); // end panel 4

  // ── PANEL 5: Generate & Install
  w('<div class="panel glass" data-panel="5">');
  w('<div class="panel-head"><div><div class="panel-title">Your addon URLs</div><div class="panel-desc">Copy these into Eclipse to install your addon.</div></div></div>');
  w('<div class="summary-grid" id="summaryGrid"></div>');
  w('<div class="field-group" style="margin-bottom:14px">');
  w('<label class="field-label" style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:6px">Addon Name <span style="font-weight:400;text-transform:none;opacity:.5">(optional)</span></label>');
  w('<input type="text" id="addonNameInput" placeholder="My Eclipse Addon" maxlength="40" style="width:100%;background:var(--glass-bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:13px;padding:10px 12px;outline:none;margin-bottom:6px" />');
  w('<div style="font-size:11px;color:var(--muted);opacity:.6">Shown in Eclipse\'s connections list. Leave blank to use the default name.</div>');
  w('</div>');
  w('<div id="genStatus" class="status"></div>');
  w('<button class="btn btn-primary" id="genBtn" style="width:100%;margin-bottom:12px" onclick="generateUrls()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Generate My Addon URLs</button>');
  w('<div class="outbox" id="outbox"></div>');
  w('<div class="section" style="margin-top:22px"><div class="section-title">How to install in Eclipse</div>');
  w('<div class="install-steps">');
  w('<div class="i-step"><div class="i-num">1</div><div class="i-body">Open Eclipse &rarr; <strong>Settings</strong> &rarr; <strong>Connections</strong></div></div>');
  w('<div class="i-step"><div class="i-num">2</div><div class="i-body">Tap <strong>Add Connection</strong> &rarr; <strong>Addon</strong></div></div>');
  w('<div class="i-step"><div class="i-num">3</div><div class="i-body">Paste a manifest URL from above and tap <strong>Install</strong>. Install each type separately.</div></div>');
  w('</div></div>');
  w('<div class="nav-row"><button class="btn btn-ghost" onclick="goToStep(4)">Back</button><button class="btn btn-ghost" onclick="goToWelcome()">Start over</button></div>');
  w('</div>'); // end panel 5

  // ── PANEL refresh
  w('<div class="panel glass" data-panel="refresh">');
  w('<div class="panel-head"><div><div class="panel-title">Refresh existing URL</div><div class="panel-desc">Paste your current manifest URL to get a fresh token.</div></div></div>');
  w('<div class="field"><label class="field-label">Current manifest URL</label><input type="text" id="existingUrl" class="field-input" placeholder="https://your-addon.vercel.app/abc123.../manifest.json"></div>');
  w('<div id="refStatus" class="status"></div>');
  w('<button class="btn btn-primary" style="width:100%;margin-top:14px" onclick="doRefresh()">Refresh URL</button>');
  w('<div id="refBox" style="display:none;margin-top:14px">');
  w('<div class="url-card"><div class="url-label">Refreshed URL</div><div class="url-row"><div class="url-box" id="urlRef"></div><button class="copy-btn" onclick="copyText(document.getElementById(\'urlRef\').textContent,this)">Copy</button></div></div>');
  w('</div>');
  w('<div class="nav-row"><button class="btn btn-ghost" onclick="closeRefresh()">Back</button></div>');
  w('</div>');

  w('<footer>Credentials are encoded in your URL only &mdash; never stored server-side<br>All In Eclipse &middot; Qobuz &middot; Tidal &middot; Deezer &middot; SoundCloud &middot; Internet Archive &middot; Podcasts &middot; Radio</footer>');
  w('</div>'); // end .app

  w('<div class="toast" id="toast"><span class="toast-dot"></span><span id="toastMsg">Copied</span></div>');

  w('<script>');
  w('var BASE_URL=' + JSON.stringify(baseUrl || '') + ';');
  w('var SOURCES={qobuz:{name:"Qobuz",sub:"Hi-Res FLAC"},hifi:{name:"Tidal HiFi",sub:"AAC 320"},deezer:{name:"Deezer",sub:"FLAC / MP3"},sc:{name:"SoundCloud",sub:"MP3 320"},ia:{name:"Internet Archive",sub:"Various"}};');
  w('var QOBUZ_TIER_LABELS={HIGH:"High \u2014 320 kbps MP3",LOSSLESS:"Lossless \u2014 CD 44.1 kHz FLAC",HIRES_96:"Hi-Res 96 \u2014 24-bit / 96 kHz",HIRES_192:"Hi-Res 192 \u2014 24-bit / 192 kHz",AUTO:"Auto \u2014 Best available"};');
  w('var PRESETS={');
  w('  full:{search:[{s:"hifi",on:true},{s:"qobuz",on:true},{s:"deezer",on:true},{s:"sc",on:true},{s:"ia",on:true}],stream:[{s:"qobuz",on:true},{s:"hifi",on:true},{s:"deezer",on:true},{s:"sc",on:true},{s:"ia",on:true}]},');
  w('  recommended:{search:[{s:"hifi",on:true},{s:"qobuz",on:false},{s:"deezer",on:false},{s:"sc",on:false},{s:"ia",on:false}],stream:[{s:"qobuz",on:true},{s:"hifi",on:true},{s:"deezer",on:true},{s:"sc",on:true}]},');
  w('  bigger:{search:[{s:"deezer",on:true},{s:"sc",on:true},{s:"qobuz",on:false},{s:"hifi",on:false},{s:"ia",on:false}],stream:[{s:"qobuz",on:true},{s:"hifi",on:true},{s:"deezer",on:true},{s:"sc",on:true},{s:"ia",on:true}]},');
  w('  custom:{search:[{s:"qobuz",on:false},{s:"hifi",on:false},{s:"deezer",on:false},{s:"sc",on:false},{s:"ia",on:false}],stream:[{s:"qobuz",on:false},{s:"hifi",on:false},{s:"deezer",on:false},{s:"sc",on:false},{s:"ia",on:false}]}');
  w('};');
  w('var state={step:1,content:{podcast:false,audiobook:false,radio:false,explicit:true},qualityMode:"general",qobuzQuality:"AUTO",preset:"full",searchOrder:JSON.parse(JSON.stringify(PRESETS.full.search)),streamOrder:JSON.parse(JSON.stringify(PRESETS.full.stream)),started:false};');
  w('var isrcToggles={musicbrainz:true,theaudiodb:true,deezer_isrc:true,qobuz_isrc:true};');

  w('function startSetup(){state.started=true;document.getElementById("heroSection").style.display="none";document.getElementById("stepsBar").style.display="flex";goToStep(1)}');
  w('function goToWelcome(){state.started=false;state.step=1;document.querySelectorAll(".panel").forEach(function(p){p.classList.remove("active")});document.getElementById("heroSection").style.display="flex";document.getElementById("stepsBar").style.display="none";document.querySelectorAll(".step-item").forEach(function(s){s.classList.remove("active","done")});document.querySelector("[data-step=\'1\']").classList.add("active");window.scrollTo({top:0,behavior:"smooth"})}');
  w('function handleStepClick(n){if(!state.started||n>state.step+1)return;goToStep(n)}');
  w('function goToStep(n){state.step=n;document.querySelectorAll(".panel").forEach(function(p){p.classList.remove("active")});var t=document.querySelector("[data-panel=\'"+n+"\']");if(t)t.classList.add("active");document.querySelectorAll(".step-item").forEach(function(s){var sn=+s.dataset.step;s.classList.remove("active","done");if(sn<n)s.classList.add("done");else if(sn===n)s.classList.add("active")});if(n===3)renderDragLists();if(n===4)renderQualityStep();if(n===5)renderSummary();window.scrollTo({top:0,behavior:"smooth"})}');
  w('function openRefresh(){document.querySelectorAll(".panel").forEach(function(p){p.classList.remove("active")});document.querySelector("[data-panel=\'refresh\']").classList.add("active");document.getElementById("heroSection").style.display="none";document.getElementById("stepsBar").style.display="none"}');
  w('function closeRefresh(){if(state.started){goToStep(state.step);document.getElementById("stepsBar").style.display="flex"}else{goToWelcome()}}');
  w('function toggleContent(el,type){state.content[type]=!state.content[type];el.classList.toggle("on",state.content[type]);if(type==="podcast"){var sec=document.getElementById("podcastCredsSection");if(sec)sec.style.display=state.content[type]?"block":"none"}}');
  w('function toggleAdv(btn){var key=btn.dataset.adv;var box=document.querySelector("[data-adv-box=\'"+key+"\']");btn.classList.toggle("open");if(box)box.classList.toggle("open")}');

  w('var STATUS_FIELDS={qobuz:["qobuzUserToken","qobuzSecret","qobuzAppId"],deezer:["deezerArl"],tidal:["hifiInst"],sc:["scId"]};');
  w('var STATUS_DEFAULT={qobuz:"Not connected",deezer:"Not connected",tidal:"Using public pool",sc:"Auto-discovered"};');
  w('function updateStatuses(){Object.keys(STATUS_FIELDS).forEach(function(svc){var hasValue=STATUS_FIELDS[svc].some(function(id){var el=document.getElementById(id);return el&&el.value.trim()});var statusEl=document.getElementById("status-"+svc);var card=document.querySelector("[data-svc=\'"+svc+"\']");if(hasValue){if(statusEl){statusEl.textContent="Connected";statusEl.className="svc-status on"}if(card)card.classList.add("connected")}else{if(statusEl){statusEl.textContent=STATUS_DEFAULT[svc];statusEl.className="svc-status off"}if(card)card.classList.remove("connected")}})}');
  w('document.querySelectorAll(".field-input").forEach(function(i){i.addEventListener("input",updateStatuses)});');

  w('function setQualityMode(mode){if(mode==="perstream")return;state.qualityMode=mode;document.querySelectorAll("#qualityModeToggle .mode-btn").forEach(function(b){b.classList.toggle("on",b.dataset.mode===mode)});document.getElementById("generalQualitySection").style.display=mode==="general"?"block":"none";document.getElementById("perStreamQualitySection").style.display=mode==="perstream"?"block":"none"}');
  w('function setQuality(pill){document.querySelectorAll("#qualityPills .quality-pill").forEach(function(p){p.classList.remove("on")});pill.classList.add("on");state.qobuzQuality=pill.dataset.q;document.getElementById("qualityCurrentValue").textContent=QOBUZ_TIER_LABELS[state.qobuzQuality]}');
  w('function renderQualityStep(){document.getElementById("generalQualitySection").style.display=state.qualityMode==="general"?"block":"none";document.getElementById("perStreamQualitySection").style.display=state.qualityMode==="perstream"?"block":"none";document.querySelectorAll("#qualityModeToggle .mode-btn").forEach(function(b){b.classList.toggle("on",b.dataset.mode===state.qualityMode)});document.querySelectorAll("#qualityPills .quality-pill").forEach(function(p){p.classList.toggle("on",p.dataset.q===state.qobuzQuality)});document.getElementById("qualityCurrentValue").textContent=QOBUZ_TIER_LABELS[state.qobuzQuality]||"Auto \u2014 Best available"}');

  w('function applyPreset(card){var preset=card.dataset.preset;document.querySelectorAll(".preset-card").forEach(function(c){c.classList.remove("on")});card.classList.add("on");state.preset=preset;state.searchOrder=JSON.parse(JSON.stringify(PRESETS[preset].search));state.streamOrder=JSON.parse(JSON.stringify(PRESETS[preset].stream));renderDragLists();toast("Applied preset")}');

  w('function buildDragItem(src,isOn,rank,listId){var item=document.createElement("div");item.className="drag-item"+(isOn?"":" inactive");item.draggable=true;item.dataset.source=src;item.dataset.on=isOn?"1":"0";item.dataset.list=listId;item.innerHTML=\'<svg class="drag-handle" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg><div class="drag-rank">\'+(isOn?rank:"\u2014")+\'</div><div class="drag-body"><div class="drag-name">\'+SOURCES[src].name+\'</div><div class="drag-sub">\'+SOURCES[src].sub+\'</div></div><button class="drag-toggle\'+(isOn?"":" off")+\'" type="button" aria-label="Toggle"></button><div class="drag-arrows"><button class="arrow-btn" aria-label="Move up" data-dir="-1"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg></button><button class="arrow-btn" aria-label="Move down" data-dir="1"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></button></div>\';item.querySelector(".drag-toggle").addEventListener("click",function(e){e.stopPropagation();var on=item.dataset.on==="1";item.dataset.on=on?"0":"1";var newOn=item.dataset.on==="1";item.classList.toggle("inactive",!newOn);item.querySelector(".drag-toggle").classList.toggle("off",!newOn);var order=listId==="searchDragList"?state.searchOrder:state.streamOrder;var idx=order.findIndex(function(x){return x.s===src});if(idx>-1)order[idx].on=newOn;state.preset="custom";document.querySelectorAll(".preset-card").forEach(function(c){c.classList.toggle("on",c.dataset.preset==="custom")});renderDragLists()});setupDragEvents(item,listId);return item}');

  w('document.addEventListener("click",function(e){var btn=e.target.closest(".arrow-btn[data-dir]");if(!btn)return;var item=btn.closest(".drag-item");var listId=item&&item.dataset.list;var dir=btn.dataset.dir;if(listId&&dir)moveItem(btn,listId,dir);});');
  w('function renderDragLists(){["searchDragList","streamDragList"].forEach(function(listId){var order=listId==="searchDragList"?state.searchOrder:state.streamOrder;var list=document.getElementById(listId);if(!list)return;list.innerHTML="";var rank=1;order.forEach(function(item){list.appendChild(buildDragItem(item.s,item.on,item.on?rank++:0,listId))})})}');

  w('function moveItem(btn,listId,dir){var item=btn.closest(".drag-item");var src=item.dataset.source;var order=listId==="searchDragList"?state.searchOrder:state.streamOrder;var idx=order.findIndex(function(x){return x.s===src});var newIdx=idx+parseInt(dir);if(newIdx<0||newIdx>=order.length)return;var tmp=order[idx];order[idx]=order[newIdx];order[newIdx]=tmp;state.preset="custom";document.querySelectorAll(".preset-card").forEach(function(c){c.classList.toggle("on",c.dataset.preset==="custom")});renderDragLists()}');

  w('function setupDragEvents(item,listId){item.addEventListener("dragstart",function(e){item.classList.add("dragging");e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain",item.dataset.source)});item.addEventListener("dragend",function(){item.classList.remove("dragging");document.querySelectorAll(".drag-item").forEach(function(i){i.classList.remove("drag-over")})});item.addEventListener("dragover",function(e){e.preventDefault();e.dataTransfer.dropEffect="move";item.classList.add("drag-over")});item.addEventListener("dragleave",function(){item.classList.remove("drag-over")});item.addEventListener("drop",function(e){e.preventDefault();item.classList.remove("drag-over");var fromSrc=e.dataTransfer.getData("text/plain");var toSrc=item.dataset.source;if(fromSrc===toSrc)return;var order=listId==="searchDragList"?state.searchOrder:state.streamOrder;var fromIdx=order.findIndex(function(x){return x.s===fromSrc});var toIdx=order.findIndex(function(x){return x.s===toSrc});if(fromIdx<0||toIdx<0)return;var tmp=order[fromIdx];order[fromIdx]=order[toIdx];order[toIdx]=tmp;renderDragLists()})}');

  w('function toggleIsrcSource(key){isrcToggles[key]=!isrcToggles[key];var btn=document.getElementById("btn-"+key);var itm=document.getElementById("itm-"+key);var on=isrcToggles[key];if(btn){on?btn.classList.add("on"):btn.classList.remove("on")}if(itm){itm.classList.toggle("on",on)}var warn=itm?itm.querySelector(".itwarn"):null;if(warn)warn.style.display=on?"none":"block"}');

  w('function renderSummary(){var grid=document.getElementById("summaryGrid");if(!grid)return;var contentList=Object.keys(state.content).filter(function(k){return state.content[k]}).map(function(k){return k[0].toUpperCase()+k.slice(1)});if(!contentList.length)contentList=["Music only"];var html="";html+=\'<div class="sum-card"><span class="sum-label">Content</span><div class="sum-value">\'+contentList.join(" &middot; ")+\'</div></div>\';html+=\'<div class="sum-card"><span class="sum-label">Source preset</span><div class="sum-value accent">\'+({full:"Everything",recommended:"Recommended",bigger:"Bigger catalog",custom:"Custom"}[state.preset]||"Custom")+\'</div></div>\';html+=\'<div class="sum-card"><span class="sum-label">Search sources</span>\';state.searchOrder.forEach(function(x){html+=\'<div class="sum-row"><div class="sum-dot\'+(x.on?"":" off")+\'"></div><div class="sum-source-name\'+(x.on?"":" off")+\'">\'+SOURCES[x.s].name+\'</div></div>\'});html+=\'</div>\';html+=\'<div class="sum-card"><span class="sum-label">Stream sources</span>\';state.streamOrder.forEach(function(x){html+=\'<div class="sum-row"><div class="sum-dot\'+(x.on?"":" off")+\'"></div><div class="sum-source-name\'+(x.on?"":" off")+\'">\'+SOURCES[x.s].name+\'</div></div>\'});html+=\'</div>\';html+=\'<div class="sum-card"><span class="sum-label">Qobuz quality</span><div class="sum-value accent">\'+QOBUZ_TIER_LABELS[state.qobuzQuality]+\'</div></div>\';grid.innerHTML=html}');

  w('function generateUrls(){var btn=document.getElementById("genBtn");btn.disabled=true;btn.textContent="Generating\u2026";showStatus("genStatus","","");var body={vercelUrl:BASE_URL||window.location.origin,hifi:(document.getElementById("hifiInst")||{}).value||"",sc:(document.getElementById("scId")||{}).value||"",sc_oauth:(document.getElementById("scOauth")||{}).value||"",pi_key:(document.getElementById("piKey")||{}).value||"",pi_secret:(document.getElementById("piSecret")||{}).value||"",taddy_key:(document.getElementById("taddyKey")||{}).value||"",taddy_uid:(document.getElementById("taddyUid")||{}).value||"",qobuz_token:(document.getElementById("qobuzUserToken")||{}).value||"",qobuz_secret:(document.getElementById("qobuzSecret")||{}).value||"",qobuz_app_id:(document.getElementById("qobuzAppId")||{}).value||"",deezer_arl:(document.getElementById("deezerArl")||{}).value||"",q:state.qobuzQuality==="AUTO"?null:state.qobuzQuality,no_podcast:!state.content.podcast,no_audiobook:!state.content.audiobook,no_radio:!state.content.radio,no_explicit:!state.content.explicit,no_musicbrainz:!isrcToggles.musicbrainz,no_theaudiodb:!isrcToggles.theaudiodb,no_deezer_isrc:!isrcToggles.deezer_isrc,no_qobuz_isrc:!isrcToggles.qobuz_isrc,search_order:state.searchOrder.filter(function(x){return x.on}).map(function(x){return x.s}),stream_order:state.streamOrder.filter(function(x){return x.on}).map(function(x){return x.s}),blocked_isrcs:(document.getElementById("blockedIsrcs")||{}).value?((document.getElementById("blockedIsrcs")||{}).value.split("\\n").map(function(s){return s.trim()}).filter(Boolean)):[],addon_name:(document.getElementById("addonNameInput")||{}).value?(document.getElementById("addonNameInput")||{}).value.trim():""};fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json()}).then(function(data){if(data.error)throw new Error(data.error);var outbox=document.getElementById("outbox");outbox.innerHTML="";outbox.style.display="block";var urls=data.urls||[];if(!urls.length){if(data.manifestUrl)urls.push({label:"🎵 Music",url:data.manifestUrl});if(data.podcastManifestUrl&&!body.no_podcast)urls.push({label:"🎤 Podcasts — install separately for podcast player (±15s skip, speed control)",url:data.podcastManifestUrl});if(data.audiobookManifestUrl&&!body.no_audiobook)urls.push({label:"📚 Audiobooks — install separately for audiobook player (±30s skip, speed control)",url:data.audiobookManifestUrl});if(data.radioManifestUrl&&!body.no_radio)urls.push({label:"📻 Live Radio — install separately for radio-only addon (Radio Browser + SomaFM)",url:data.radioManifestUrl});}urls.forEach(function(u){var label=u.label||u.type||"Addon";var url=u.url||u.manifestUrl||"";var div=document.createElement("div");div.className="url-card";div.innerHTML=\'<div class="url-label">\'+label+\'</div><div class="url-row"><div class="url-box">\'+url+\'</div><button class="copy-btn" onclick="copyText(this.previousElementSibling.textContent,this)">Copy</button></div>\';outbox.appendChild(div)});showStatus("genStatus","Done! Copy your install URLs above.","ok")}).catch(function(e){showStatus("genStatus","Error: "+e.message,"err")}).finally(function(){btn.disabled=false;btn.innerHTML=\'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> Generate My Addon URLs\'})}');

  w('function doRefresh(){var raw=(document.getElementById("existingUrl")||{}).value;if(!raw){showStatus("refStatus","Paste your existing URL first.","err");return}fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:raw})}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json()}).then(function(data){if(data.error)throw new Error(data.error);document.getElementById("urlRef").textContent=data.manifestUrl;document.getElementById("refBox").style.display="block";showStatus("refStatus","Refreshed!","ok")}).catch(function(e){showStatus("refStatus","Error: "+e.message,"err")})}');

  w('function showStatus(id,msg,type){var el=document.getElementById(id);if(!el)return;if(!msg){el.style.display="none";return}el.textContent=msg;el.className="status "+(type==="ok"?"s-ok":"s-err");el.style.display="block"}');
  w('function copyText(text,btn){navigator.clipboard.writeText(text).then(function(){if(btn){btn.textContent="Copied!";btn.classList.add("copied");setTimeout(function(){btn.textContent="Copy";btn.classList.remove("copied")},1800)}toast("Copied to clipboard")}).catch(function(){toast("Copy failed")})}');
  w('var _toastTimer=null;function toast(msg){var t=document.getElementById("toast");var m=document.getElementById("toastMsg");if(!t||!m)return;m.textContent=msg;t.classList.add("show");if(_toastTimer)clearTimeout(_toastTimer);_toastTimer=setTimeout(function(){t.classList.remove("show")},2200)}');

  w('function checkHifiHealth(){var list=document.getElementById("hifiInstList");if(!list)return;list.innerHTML=\'<div style="color:var(--muted);font-size:.72rem;padding:6px 0">Checking instances\u2026</div>\';fetch("/instances").then(function(r){return r.json()}).then(function(data){list.innerHTML="";if(!data.instances||!data.instances.length){list.innerHTML=\'<div style="color:var(--faint);font-size:.72rem;padding:6px 0">No instances configured.</div>\';return}data.instances.forEach(function(inst){var row=document.createElement("div");row.className="inst-row";var dot=document.createElement("span");dot.style.cssText="width:7px;height:7px;border-radius:50%;flex-shrink:0;background:"+(inst.online?"#6ee7b7":"#f87171");var urlSp=document.createElement("span");urlSp.style.cssText="flex:1;color:var(--text);word-break:break-all";urlSp.textContent=inst.url||"";var badge=document.createElement("span");badge.style.cssText="font-size:.62rem;font-weight:700;padding:2px 7px;border-radius:99px;background:"+(inst.online?"var(--accent-dim)":"rgba(248,113,113,.1)")+";border:1px solid "+(inst.online?"var(--accent-bdr)":"rgba(248,113,113,.25)")+";color:"+(inst.online?"var(--accent)":"var(--err)");badge.textContent=inst.online?"Online":"Offline";row.appendChild(dot);row.appendChild(urlSp);row.appendChild(badge);list.appendChild(row)})}).catch(function(){list.innerHTML=\'<div style="color:var(--err);font-size:.72rem;padding:6px 0">Failed to check instances.</div>\'})}');
  w('document.querySelector("[data-svc=\'tidal\'] .svc-head").addEventListener("click",function(){setTimeout(checkHifiHealth,300)});');

  w('(function(){var ec=document.querySelector("[data-type=\'explicit\']");if(ec)ec.classList.add("on");})();');
  w('</script>');
  w('</body>');
  w('</html>');

  return new Response(S.join('\n'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function getBaseUrl(c) {
  return (c.req.header('x-forwarded-proto') || 'https') + '://' + c.req.header('host');
}

// ─── POST /generate — server-side token builder ───────────────────────────────
app.post('/generate', async function(c) {
  var b = await c.req.json().catch(() => ({}));
  var vercel = (b.vercelUrl || '').trim().replace(/\/+$/, '');
  if (!vercel) {
    var proto = c.req.header('x-forwarded-proto') || 'https';
    vercel = proto + '://' + c.req.header('host');
  }
  if (!/^https?:\/\/.+/.test(vercel))
    return c.json({ error: 'Vercel URL must start with http:// or https://' });

  var VALID_QUALITIES = ['HIRES_192', 'HIRES_96', 'LOSSLESS', 'HIGH', 'LOW'];
  var cfg = {};
  if (b.hifi)      cfg.hifi      = b.hifi;
  if (b.sc)        cfg.sc        = b.sc;
  if (b.sc_oauth)  cfg.sc_oauth  = b.sc_oauth;
  if (b.pi_key)    cfg.pi_key    = String(b.pi_key).trim();
  if (b.pi_secret) cfg.pi_secret = String(b.pi_secret).trim();
  if (b.taddy_key) cfg.taddy_key = String(b.taddy_key).trim();
  if (b.taddy_uid) cfg.taddy_uid = String(b.taddy_uid).trim();
  if (b.q && VALID_QUALITIES.includes(b.q)) cfg.q = b.q;
  // Source disable flags
  if (b.no_hifi)      cfg.no_hifi      = true;
  if (b.no_sc)        cfg.no_sc        = true;
  if (b.no_ia)        cfg.no_ia        = true;
  if (b.no_qobuz)     cfg.no_qobuz     = true;
  if (b.no_podcast)   cfg.no_podcast   = true;
  if (b.no_audiobook) cfg.no_audiobook = true;
  if (b.no_radio)     cfg.no_radio     = true;
  // Ordered search/stream priority arrays
  if (Array.isArray(b.search_order) && b.search_order.length) cfg.search_order = b.search_order;
  if (Array.isArray(b.stream_order) && b.stream_order.length) cfg.stream_order = b.stream_order;
  // Blocked ISRCs
  if (Array.isArray(b.blocked_isrcs) && b.blocked_isrcs.length) cfg.blocked_isrcs = b.blocked_isrcs;
  // ISRC enrichment source toggles
  if (b.no_musicbrainz) cfg.no_musicbrainz = true;
  if (b.no_theaudiodb)  cfg.no_theaudiodb  = true;
  if (b.no_deezer_isrc) cfg.no_deezer_isrc = true;
  if (b.no_qobuz_isrc)  cfg.no_qobuz_isrc  = true;
  if (b.qobuz_user_token) cfg.qobuz_user_token = b.qobuz_user_token;
  if (b.qobuz_secret)     cfg.qobuz_secret     = b.qobuz_secret;
  if (b.qobuz_app_id)     cfg.qobuz_app_id     = b.qobuz_app_id;
  if (b.deezer_arl)       cfg.deezer_arl       = b.deezer_arl;
  if (b.addon_name && typeof b.addon_name === 'string' && b.addon_name.trim())
    cfg.addon_name = b.addon_name.trim().slice(0, 40);

  // Always generate a tokenized URL, even when no optional keys are set.
  // This keeps podcast/audiobook installs on the token-prefixed route shape:
  //   /{token}/podcast/manifest.json
  //   /{token}/audiobook/manifest.json
  // and avoids the bare /podcast/manifest.json path the user reported as unreliable.
  var token = encodeBase64Url(JSON.stringify(cfg));
  if (!token) token = 'e30';
  // Append ~base64url(addonName) so Eclipse shows a custom connection name
  if (cfg.addon_name) {
    token = token + '~' + encodeBase64Url(cfg.addon_name);
  }

  return c.json({
    manifestUrl:          vercel + '/' + token + '/manifest.json',
    podcastManifestUrl:   vercel + '/' + token + '/podcast/manifest.json',
    audiobookManifestUrl: vercel + '/' + token + '/audiobook/manifest.json',
    radioManifestUrl:     vercel + '/' + token + '/radio/manifest.json',
    baseUrl:              vercel + '/' + token,
  });
});

// ─── POST /refresh ────────────────────────────────────────────────────────────
app.post('/refresh', async function(c) {
  var rb = await c.req.json().catch(() => ({}));
  var raw = (rb && rb.existingUrl) ? String(rb.existingUrl).trim() : '';
  if (!raw) return c.json({ error: 'Paste your full addon URL.' });
  // Extract base (strip /manifest.json or /{token}/manifest.json)
  var clean = raw.replace(/\/manifest\.json$/, '');
  // Validate it looks like a URL
  if (!/^https?:\/\/.+/.test(clean)) return c.json({ error: 'Invalid URL.' });
  return c.json({ manifestUrl: clean + '/manifest.json', refreshed: true });
});

// ─── GET / and /generator — serve config page ─────────────────────────────────
app.get('/', async function(c) {
  return buildConfigPage(getBaseUrl(c), c.env);
});

app.get('/generator', async function(c) {
  return buildConfigPage(getBaseUrl(c), c.env);
});

// ─── 8SPINE Module Endpoints ──────────────────────────────────────────────────
const SPINE_MODULE_CODE = "var BASE_URL = 'https://improved-all-in-one.cyrusna29.workers.dev';\nvar RB_BASE = 'https://de1.api.radio-browser.info';\n\n// ─── Helpers ──────────────────────────────────────────────────────────────────\n\nfunction eclipseFetch(path, params) {\n  var qs = '';\n  if (params) {\n    var keys = Object.keys(params);\n    if (keys.length) {\n      qs = '?' + keys.map(function(k) {\n        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);\n      }).join('&');\n    }\n  }\n  return fetch(BASE_URL + path + qs, { headers: { 'Accept': 'application/json' } })\n    .then(function(r) {\n      if (!r.ok) throw new Error('HTTP ' + r.status);\n      return r.json();\n    });\n}\n\nfunction rbFetch(path, params) {\n  var qs = '';\n  if (params) {\n    var keys = Object.keys(params);\n    if (keys.length) {\n      qs = '?' + keys.map(function(k) {\n        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);\n      }).join('&');\n    }\n  }\n  return fetch(RB_BASE + path + qs, {\n    headers: { 'Accept': 'application/json', 'User-Agent': 'EclipseAllInOne/1.0' }\n  }).then(function(r) {\n    if (!r.ok) throw new Error('HTTP ' + r.status);\n    return r.json();\n  });\n}\n\nfunction fetchDirect(url, timeoutMs) {\n  var ms = timeoutMs || 2000;\n  var ctrl = new AbortController();\n  var timer = setTimeout(function() { ctrl.abort(); }, ms);\n  return fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Monochrome/1.0' }, signal: ctrl.signal })\n    .then(function(r) {\n      clearTimeout(timer);\n      if (!r.ok) throw new Error('HTTP ' + r.status);\n      return r.json();\n    }).catch(function(e) { clearTimeout(timer); throw e; });\n}\n\nfunction base64Decode(str) {\n  var s = String(str).replace(/-/g, '+').replace(/_/g, '/');\n  while (s.length % 4) { s += '='; }\n  return atob(s);\n}\n\nfunction extractManifestUrl(manifest) {\n  if (!manifest) return null;\n  try {\n    if (typeof manifest === 'string' && manifest.indexOf('http') === 0) return manifest;\n    var decoded = atob(manifest);\n    var parsed = JSON.parse(decoded);\n    if (parsed.urls && parsed.urls.length > 0) return parsed.urls[0];\n  } catch (e) {}\n  return null;\n}\n\nfunction cleanText(s) { return String(s || '').replace(/\\s+/g, ' ').trim(); }\nfunction safeUrl(u) { return /^https?:\\/\\//i.test(String(u || '')) ? String(u) : null; }\nfunction normalizeQ(s) { return cleanText(s).toLowerCase().replace(/[^a-z0-9 ]/g, ''); }\n\nfunction parseHifiId(id) {\n  if (String(id).indexOf('hifi_') !== 0) return null;\n  var rest = String(id).slice(5);\n  var idx = rest.indexOf('_');\n  if (idx === -1) return null;\n  return { instB64: rest.slice(0, idx), origId: rest.slice(idx + 1) };\n}\n\nfunction qualityFallbacks(q) {\n  if (q === 'LOSSLESS') return ['HIGH', 'LOW'];\n  if (q === 'HIGH') return ['LOSSLESS', 'LOW'];\n  return ['HIGH', 'LOSSLESS'];\n}\n\n// ─── Radio Browser helpers ────────────────────────────────────────────────────\n\nfunction stationArtwork(station) {\n  return safeUrl(station.favicon) || 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/radio-browser.png';\n}\n\nfunction stationSubtitle(station) {\n  var bits = [];\n  if (station.country) bits.push(cleanText(station.country));\n  if (station.language) bits.push(cleanText(station.language));\n  if (station.codec) bits.push(cleanText(station.codec));\n  if (station.bitrate) bits.push(station.bitrate + 'k');\n  return bits.join(' \\u2022 ');\n}\n\nfunction detectFormat(url, hls) {\n  var u = String(url || '').toLowerCase().split('?')[0];\n  if (hls === 1 || u.indexOf('.m3u8') >= 0) return 'hls';\n  if (u.indexOf('.aac') >= 0 || u.indexOf('.aacp') >= 0) return 'aac';\n  if (u.indexOf('.ogg') >= 0 || u.indexOf('.opus') >= 0) return 'ogg';\n  if (u.indexOf('.flac') >= 0) return 'flac';\n  return 'mp3';\n}\n\nfunction mapStation(station) {\n  var stream = safeUrl(station.url_resolved || station.urlresolved || station.url);\n  return {\n    id: 'rbst_' + station.stationuuid,\n    title: cleanText(station.name) || 'Radio Station',\n    artist: stationSubtitle(station) || 'Radio Browser',\n    album: cleanText(station.tags || station.country || 'Live Radio'),\n    albumCover: stationArtwork(station),\n    duration: 0,\n    audioQuality: 'HIGH',\n    streamUrl: stream\n  };\n}\n\nfunction isRadioId(id) { return String(id).indexOf('rbst_') === 0; }\n\n// ─── Improved radio scoring ───────────────────────────────────────────────────\n\nfunction scoreStation(station, q) {\n  var needle = normalizeQ(q);\n  var name = normalizeQ(station.name);\n  var tags = normalizeQ(station.tags || '');\n  var country = normalizeQ(station.country || '');\n  var language = normalizeQ(station.language || '');\n  var score = 0;\n\n  if (name === needle) score += 500;\n  else if (name.indexOf(needle) === 0) score += 350;\n  else if (new RegExp('\\\\b' + needle.replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&') + '\\\\b').test(name)) score += 250;\n  else if (name.indexOf(needle) >= 0) score += 150;\n\n  if (tags.indexOf(needle) >= 0) score += 60;\n  if (country.indexOf(needle) >= 0) score += 40;\n  if (language.indexOf(needle) >= 0) score += 20;\n\n  if (station.lastcheckok === 1) score += 80;\n  score += Math.min(parseInt(station.clickcount || 0, 10), 60);\n  score += Math.min(parseInt(station.votes || 0, 10), 40);\n  if (parseInt(station.bitrate || 0, 10) >= 128) score += 20;\n\n  if (!safeUrl(station.url_resolved || station.urlresolved || station.url)) score -= 500;\n\n  return score;\n}\n\nfunction dedupeStations(list) {\n  var seen = {};\n  var out = [];\n  for (var i = 0; i < list.length; i++) {\n    var uuid = list[i].stationuuid;\n    if (!seen[uuid]) { seen[uuid] = true; out.push(list[i]); }\n  }\n  return out;\n}\n\n// ─── Eclipse track normaliser ─────────────────────────────────────────────────\n\nfunction normaliseTrack(t) {\n  var rawId = String(t.id || t._origId || '');\n  var directUrl = t.streamURL || t.stream_url || t.url || '';\n  var isDirectOnly = (\n    rawId.indexOf('radio_') === 0 ||\n    rawId.indexOf('pi_ep_') === 0 ||\n    rawId.indexOf('taddy_ep_') === 0 ||\n    rawId.indexOf('apple_ep_') === 0 ||\n    rawId.indexOf('lvox_ch_') === 0 ||\n    rawId.indexOf('ia_book_file_') === 0\n  );\n  var id = (isDirectOnly && directUrl) ? ('direct__' + encodeURIComponent(directUrl)) : rawId;\n  return {\n    id: id,\n    title: t.title || t.name || 'Unknown Title',\n    artist: t.artist || t.creator || (t.user && t.user.username) || 'Unknown Artist',\n    album: t.album || t.albumTitle || '',\n    albumCover: t.artworkURL || t.artwork_url || t.cover || '',\n    duration: typeof t.duration === 'number' ? t.duration : 0,\n    audioQuality: (rawId.indexOf('hifi_') === 0) ? 'LOSSLESS' : 'HIGH',\n    availableQualities: ['LOSSLESS', 'HIGH', 'LOW']\n  };\n}\n\nfunction resolveHifiDirect(trackId, quality) {\n  var parsed = parseHifiId(trackId);\n  if (!parsed) return Promise.reject(new Error('Invalid HiFi ID'));\n  var inst = base64Decode(parsed.instB64);\n  var url = inst + '/track/?id=' + encodeURIComponent(parsed.origId) + '&quality=' + encodeURIComponent(quality);\n  return fetchDirect(url).then(function(data) {\n    var payload = data.data || data || {};\n    var streamUrl = extractManifestUrl(payload.manifest) || payload.url || null;\n    if (!streamUrl) throw new Error('No stream URL from HiFi');\n    return {\n      streamUrl: streamUrl,\n      track: {\n        id: payload.trackId || trackId,\n        audioQuality: payload.audioQuality || quality,\n        bitDepth: payload.bitDepth,\n        sampleRate: payload.sampleRate\n      }\n    };\n  });\n}\n\n// ─── searchTracks ─────────────────────────────────────────────────────────────\n// FIX: use /resolve for single-track lookups (playlist import context) —\n// /resolve skips podcast/radio/audiobook sources and is 5-8x faster.\n// Use /search only for open-ended user searches (no context or context.type !== 'resolve').\n\nfunction searchTracks(query, limit, context) {\n  var lim = limit || 25;\n  var isResolve = context && (context.type === 'resolve' || context.playlistImport === true);\n\n  // Playlist import / resolve context: use the lightweight /resolve endpoint\n  var eclipsePromise = eclipseFetch(isResolve ? '/resolve' : '/search', { q: query })\n    .then(function(data) {\n      return (data.tracks || []).slice(0, lim).map(normaliseTrack);\n    }).catch(function() { return []; });\n\n  // Skip radio search entirely for playlist import — not useful there\n  if (isResolve) {\n    return eclipsePromise.then(function(tracks) {\n      return { tracks: tracks, total: tracks.length };\n    });\n  }\n\n  // Full search: radio + eclipse in parallel\n  var p1 = rbFetch('/json/stations/search', {\n    name: query, limit: 40, hidebroken: true, order: 'clickcount', reverse: true\n  }).catch(function() { return []; });\n\n  var p2 = rbFetch('/json/stations/byname/' + encodeURIComponent(query), {\n    limit: 20, hidebroken: true, order: 'clickcount', reverse: true\n  }).catch(function() { return []; });\n\n  var p3 = rbFetch('/json/stations/bytag/' + encodeURIComponent(query), {\n    limit: 20, hidebroken: true, order: 'clickcount', reverse: true\n  }).catch(function() { return []; });\n\n  var radioPromise = Promise.all([p1, p2, p3]).then(function(results) {\n    var raw = (Array.isArray(results[0]) ? results[0] : [])\n      .concat(Array.isArray(results[1]) ? results[1] : [])\n      .concat(Array.isArray(results[2]) ? results[2] : []);\n\n    return dedupeStations(raw)\n      .filter(function(s) {\n        return safeUrl(s.url_resolved || s.urlresolved || s.url) && s.lastcheckok === 1;\n      })\n      .sort(function(a, b) { return scoreStation(b, query) - scoreStation(a, query); })\n      .slice(0, 15)\n      .map(mapStation);\n  }).catch(function() { return []; });\n\n  return Promise.all([eclipsePromise, radioPromise]).then(function(results) {\n    var combined = results[0].concat(results[1]);\n    return { tracks: combined, total: combined.length };\n  });\n}\n\n// ─── getTrackStreamUrl ────────────────────────────────────────────────────────\n// FIX: for social/unknown IDs, pass ?title=&artist= so the server's social\n// fallback block can search by song name instead of the raw foreign ID string.\n\nfunction getTrackStreamUrl(trackId, preferredQuality, context) {\n  var id = String(trackId);\n  var settings = (context && context.settings) || {};\n  var targetQuality = (settings.quality && settings.quality.value) || preferredQuality || 'LOSSLESS';\n  var fallbackMode = (settings.fallbackMode && settings.fallbackMode.value) || 'flexible';\n\n  // Radio station — use streamUrl from search result directly (instant, no extra fetch)\n  if (isRadioId(id)) {\n    var ctxUrl = context && context.track && safeUrl(context.track.streamUrl);\n    if (ctxUrl) {\n      return Promise.resolve({ streamUrl: ctxUrl, track: { id: trackId, audioQuality: 'HIGH', format: detectFormat(ctxUrl, 0) } });\n    }\n    var uuid = id.slice(5);\n    return rbFetch('/json/stations/byuuid/' + encodeURIComponent(uuid), {}).then(function(rows) {\n      var station = Array.isArray(rows) && rows[0] ? rows[0] : null;\n      if (!station) throw new Error('Station not found');\n      var url = safeUrl(station.url_resolved || station.urlresolved || station.url);\n      if (!url) throw new Error('No stream URL for station');\n      rbFetch('/json/url/' + encodeURIComponent(station.stationuuid), {}).catch(function() {});\n      return {\n        streamUrl: url,\n        track: { id: trackId, audioQuality: 'HIGH', format: detectFormat(url, station.hls) }\n      };\n    });\n  }\n\n  // Direct stream URL (podcasts, audiobook chapters, etc.)\n  if (id.indexOf('direct__') === 0) {\n    var streamUrl = decodeURIComponent(id.slice(8));\n    return Promise.resolve({\n      streamUrl: streamUrl,\n      track: { id: trackId, audioQuality: 'HIGH' }\n    });\n  }\n\n  // HiFi track — race direct HiFi (fast, no server hop) vs server (Qobuz→HiFi→SC)\n  // fetchDirect now has a 2s timeout so a slow/dead instance fails fast.\n  // Promise.any fires both simultaneously — first to succeed plays.\n  if (id.indexOf('hifi_') === 0) {\n    var qualitiesToTry = [targetQuality];\n    if (fallbackMode !== 'strict') {\n      var fallbacks = qualityFallbacks(targetQuality);\n      for (var i = 0; i < fallbacks.length; i++) { qualitiesToTry.push(fallbacks[i]); }\n    }\n    // Direct HiFi: hits preferred instance from client, no server hop\n    function tryQualityDirect(index) {\n      if (index >= qualitiesToTry.length) return Promise.reject(new Error('Direct HiFi exhausted'));\n      return resolveHifiDirect(id, qualitiesToTry[index])\n        .catch(function() { return tryQualityDirect(index + 1); });\n    }\n    var directPromise = tryQualityDirect(0);\n    // Server promise: Qobuz hi-res → HiFi → SC fallback\n    var serverPromise = eclipseFetch('/stream/' + encodeURIComponent(id), { quality: targetQuality })\n      .then(function(data) {\n        var url = data.url || data.streamURL || data.stream_url || null;\n        if (!url) throw new Error('No stream URL from server');\n        return { streamUrl: url, track: { id: trackId, audioQuality: data.audioQuality || data.quality || targetQuality } };\n      });\n    // Race — whichever resolves first wins\n    return Promise.any([directPromise, serverPromise])\n      .catch(function() { throw new Error('No stream found for: ' + id); });\n  }\n\n  // Known non-hifi prefixes that have a proper /stream/ handler — call directly\n  var knownPrefixes = ['sc_', 'ia_music_', 'ia_book_', 'apple_ep_', 'pi_ep_', 'taddy_ep_', 'lvox_'];\n  var isKnown = false;\n  for (var k = 0; k < knownPrefixes.length; k++) {\n    if (id.indexOf(knownPrefixes[k]) === 0) { isKnown = true; break; }\n  }\n  if (isKnown) {\n    return eclipseFetch('/stream/' + encodeURIComponent(id))\n      .then(function(data) {\n        var url = data.url || data.streamURL || data.stream_url || null;\n        if (!url) throw new Error('No stream URL');\n        return { streamUrl: url, track: { id: trackId, audioQuality: data.audioQuality || data.quality || 'HIGH' } };\n      });\n  }\n\n  // ── Social / Cross-Addon fallback ─────────────────────────────────────────\n  // Unknown ID prefix = Social tab, Tidal app, Apple Music, Deezer, Spotify, etc.\n  // Pass title+artist from context so the server can search by song name.\n  // context.track is populated by Eclipse when playing from Social/Library tabs.\n  var socialTitle  = (context && context.track && context.track.title)  ? String(context.track.title).trim()  : '';\n  var socialArtist = (context && context.track && context.track.artist) ? String(context.track.artist).trim() : '';\n\n  var socialParams = { quality: targetQuality };\n  if (socialTitle)  socialParams.title  = socialTitle;\n  if (socialArtist) socialParams.artist = socialArtist;\n\n  return eclipseFetch('/stream/' + encodeURIComponent(id), socialParams)\n    .then(function(data) {\n      var url = data.url || data.streamURL || data.stream_url || null;\n      if (!url) throw new Error('No stream URL');\n      return { streamUrl: url, track: { id: trackId, audioQuality: data.audioQuality || data.quality || 'HIGH' } };\n    });\n}\n\n// ─── getAlbum ─────────────────────────────────────────────────────────────────\n\nfunction getAlbum(albumId) {\n  var id = String(albumId);\n  if (isRadioId(id)) {\n    var uuid = id.slice(5);\n    return rbFetch('/json/stations/byuuid/' + encodeURIComponent(uuid), {}).then(function(rows) {\n      var station = Array.isArray(rows) && rows[0] ? rows[0] : null;\n      if (!station) throw new Error('Station not found');\n      return {\n        album: {\n          id: id,\n          title: cleanText(station.name) || 'Radio Station',\n          artist: cleanText(station.country || station.language || 'Radio Browser'),\n          albumCover: stationArtwork(station),\n          year: 0,\n          description: stationSubtitle(station),\n          trackCount: 1\n        },\n        tracks: [mapStation(station)]\n      };\n    });\n  }\n  return eclipseFetch('/album/' + encodeURIComponent(id)).then(function(data) {\n    return {\n      album: {\n        id: data.id || id,\n        title: data.title || 'Unknown Album',\n        artist: data.artist || data.creator || '',\n        albumCover: data.artworkURL || data.artwork || '',\n        year: safeYear(data.year),\n        description: data.description || '',\n        trackCount: data.trackCount || (data.tracks ? data.tracks.length : 0)\n      },\n      tracks: (data.tracks || []).map(normaliseTrack)\n    };\n  });\n}\n\n// ─── getArtist ────────────────────────────────────────────────────────────────\n\nfunction getArtist(artistId) {\n  var id = String(artistId);\n  if (id.indexOf('rbartist_') === 0) {\n    var country = decodeURIComponent(id.slice(9));\n    return rbFetch('/json/stations/bycountryexact/' + encodeURIComponent(country), {\n      hidebroken: true, order: 'clickcount', reverse: true, limit: 30\n    }).then(function(rows) {\n      var stations = Array.isArray(rows)\n        ? rows.filter(function(s) { return safeUrl(s.url_resolved || s.urlresolved || s.url) && s.lastcheckok === 1; })\n        : [];\n      return {\n        artist: { id: id, name: country, artworkURL: stations[0] ? stationArtwork(stations[0]) : null },\n        topTracks: stations.slice(0, 8).map(mapStation),\n        albums: stations.slice(0, 12).map(function(s) {\n          return { id: 'rbst_' + s.stationuuid, title: cleanText(s.name), artist: country, albumCover: stationArtwork(s), year: 0 };\n        })\n      };\n    });\n  }\n  return eclipseFetch('/artist/' + encodeURIComponent(id)).then(function(data) {\n    return {\n      artist: { id: data.id || id, name: data.name || 'Unknown Artist', artworkURL: data.artworkURL || data.picture || '' },\n      topTracks: (data.topTracks || []).map(normaliseTrack),\n      albums: (data.albums || []).map(function(a) {\n        return { id: String(a.id || ''), title: a.title || 'Unknown Album', artist: a.artist || data.name || '', albumCover: a.artworkURL || a.cover || '', year: safeYear(a.year) };\n      })\n    };\n  });\n}\n\n// ─── Module export ────────────────────────────────────────────────────────────\n\nreturn {\n  id: 'cyrusna29-all-in-one',\n  name: 'All-In-One',\n  author: 'Cyrus',\n  version: '1.0.7',\n  description: 'HiFi, SoundCloud, Internet Archive, Podcasts, Audiobooks and Radio in one module.',\n  labels: ['High Quality', 'Multi-Source', 'Radio', 'Settings'],\n  settings: {\n    quality: {\n      type: 'selector',\n      label: 'Audio Quality',\n      description: 'Select preferred streaming quality for HiFi tracks',\n      options: [\n        { label: '128kbps',         value: 'LOW'      },\n        { label: '320kbps',         value: 'HIGH'     },\n        { label: 'Lossless (FLAC)', value: 'LOSSLESS' }\n      ],\n      defaultValue: 'LOSSLESS'\n    },\n    fallbackMode: {\n      type: 'selector',\n      label: 'Quality Fallback',\n      description: 'Allow fallback to other qualities if preferred is unavailable',\n      options: [\n        { label: 'Flexible', value: 'flexible' },\n        { label: 'Strict',   value: 'strict'   }\n      ],\n      defaultValue: 'flexible'\n    }\n  },\n  searchTracks: searchTracks,\n  getTrackStreamUrl: getTrackStreamUrl,\n  getAlbum: getAlbum,\n  getArtist: getArtist\n};\n";

app.get('/8spine', async function(c) {
  var base = getBaseUrl(c);
  return c.json({
    id: 'cyrusna29-all-in-one',
    name: 'Improved-All-In-One',
    author: 'Ricky',
    version: '1.0.7',
    description: 'Qobuz, HiFi, SoundCloud, Internet Archive, Podcasts, Audiobooks and Radio in one module.',
    download: base + '/8spine.js'
  });
});

app.get('/8spine.js', async function(c) {
  return c.html(SPINE_MODULE_CODE);
});

app.get('/8spine-source.json', async function(c) {
  var base = getBaseUrl(c);

  var ourEntry = {
    id: 'cyrusna29-all-in-one',
    name: 'Improved-All-In-One',
    author: 'Ricky',
    version: '1.0.7',
    description: 'Qobuz, HiFi, SoundCloud, Internet Archive, Podcasts, Audiobooks and Radio in one module.',
    labels: ['High Quality', 'Multi-Source', 'Radio', 'Settings'],
    download: base + '/8spine.js'
  };

  // Add more 8spine-source.json URLs here to include additional sources
  var EXTRA_SPINE_SOURCES = [
    'https://monochrome.rickyaddons.dpdns.org/8spine-source.json',
    'https://eclipse3.cyrusna29.workers.dev/8spine-source.json',
    'https://qobuz-tidal-eclipse.cyrusna29.workers.dev/8spine-source.json',
  ];

  var merged = { 'category:music': [ourEntry] };

  var results = await Promise.all(
    EXTRA_SPINE_SOURCES.map(function(url) {
      return fetch(url, { headers: { 'Accept': 'application/json' } })
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .catch(function() { return null; });
    })
  );

  for (var i = 0; i < results.length; i++) {
    var ext = results[i];
    if (!ext || typeof ext !== 'object') continue;
    var cats = Object.keys(ext);
    for (var j = 0; j < cats.length; j++) {
      var cat = cats[j];
      var items = ext[cat];
      if (!Array.isArray(items)) continue;
      if (!merged[cat]) merged[cat] = [];
      for (var k = 0; k < items.length; k++) {
        var item = items[k];
        if (!merged[cat].find(function(e) { return e.id === item.id; })) {
          merged[cat].push(item);
        }
      }
    }
  }

  return c.json(merged);
});

// ─── Catch-all token info ─────────────────────────────────────────────────────
app.get('/:token', function(c) {
  var t = c.req.param('token');
  if (['health','favicon.ico','generate','refresh','search','stream','album','playlist','manifest.json'].includes(t)) return c.json({ error: 'Invalid token' }, 400);
  return c.json({ name: 'Eclipse Universal Addon', version: '1.3.0', token: t, status: 'running' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

// ─── Keepalive: ping cold-start instances on cron ────────────────────────────
const KEEPALIVE_TARGETS = [
  'https://hifi-api-bffw.onrender.com',       // Render free — cold starts after 15min idle
  'https://qobuz-api1.onrender.com',          // Render free — cold starts after 15min idle
  'https://trypt-hifi-dl-456461932686.us-west1.run.app', // Cloud Run free — cold starts too
];

async function runKeepalive() {
  await Promise.allSettled(
    KEEPALIVE_TARGETS.map(url =>
      axios.get(url, { timeout: 10000 }).catch(() => {})
    )
  );
  console.log('[keepalive] pinged', KEEPALIVE_TARGETS.length, 'instances');
}

// ─── 404 catch-all & favicon ─────────────────────────────────────────────────
app.get('/favicon.ico', c => new Response(null, { status: 204 }));
app.notFound(c => c.json({ error: 'Not found' }, 404));

export default {
  fetch: app.fetch.bind(app),
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runKeepalive());
  },
};
