// ── 배포 시 필요한 환경변수/바인딩 ──────────────────────────
//   env.AUTH_PASSWORD_HASH   (필수) 공용 비밀번호의 SHA-256 해시
//   env.MASTER_PASSWORD_HASH (선택) 관리자모드(index.html) 비밀번호의 SHA-256 해시. 미설정 시 /master-login은 404.
//                            평문/해시 모두 git에는 올리지 않고 Cloudflare 환경변수로만 설정(2026-08-11,
//                            기존엔 index.html에 해시가 그대로 하드코딩돼 있어 공개 소스에서 크래킹 가능했음).
//   env.AUTH_TOKEN_SECRET    (필수) 토큰 서명용 HMAC 시크릿
//   env.NOTION_TOKEN         (필수) Notion Integration 토큰
//   env.HAJA_BUCKET          (필수, R2 바인딩) 사진/서명 이미지 저장
//   env.R2_PUBLIC_URL        (필수) HAJA_BUCKET의 공개 접근 URL
//   env.TOKEN_VERSION        (선택) 문자열. 값을 바꾸면 기존 발급 토큰이 즉시 전부 무효화됨(폐기 수단). 미설정 시 "1"
//   env.LOGIN_ATTEMPTS_KV    (선택, KV 바인딩) /login 브루트포스 방어용. 미바인딩 시 rate limit은 자동 스킵됨
//   env.APP_META_JSON       (선택) 앱별 민감 정적 설정(JSON 문자열). git에는 절대 커밋하지 않고
//                            Cloudflare 대시보드/wrangler secret으로만 설정. /app-meta 엔드포인트가 서빙.
//                            형식: {"corporate-card":{"preparerTitle":"...","preparerName":"..."},
//                                   "monthly-inspection":{"generatorInspector":{...},"damdangOptions":[...],"hwakinOptions":[...]}}
//   env.KIS_APP_KEY, env.KIS_APP_SECRET  (선택, /kis/quote 사용 시 필수) 한국투자증권 Open API 앱키/시크릿.
//                            stock-portal 포트폴리오 앱의 보유종목 탭 장중 실시간 현재가 조회용(2026-09-03).

const NOTION_API = "https://api.notion.com";

const DB_IDS = {
  "거래대금": "36159c8c-9c0a-80fd-a656-daeb46ec25d5",
  "이슈분석": "2e2fceec-ae43-492d-95d4-edfadb5f8581",
};

const TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 7일 (사용자 요청으로 원복 — 토큰 폐기는 TOKEN_VERSION으로 대응)
const MASTER_TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 관리자모드 — index.html의 기존 MASTER_TTL_MS(7일)와 동일

// /signature 전용(결재 서명 이미지) — 서명은 여전히 이미지로만 제한
const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
// /upload는 인증된 사용자만 접근 가능(Bearer 토큰 필수)해 파일 형식 화이트리스트를 두지 않고 전 파일 허용.
// file.type을 신뢰할 수 없는 확장자(hwp/hwpx 등)를 위해 확장자 기반 contentType 보정만 수행.
const MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
  hwp: "application/x-hwp", hwpx: "application/haansofthwpx",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv", zip: "application/zip",
};
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB (기본, 대부분의 앱 — 사진은 클라이언트에서 500KB로 압축 후 업로드)
// 앱별로 기본값보다 큰 상한이 필요하면 여기 추가(예: 문서 첨부 위주 앱). R2/Worker 자체는 훨씬 큰
// 파일도 스트리밍으로 처리 가능하지만, Cloudflare 기본 요청 업로드 한도(플랜별 100MB 안팎)에 여유를
// 두기 위해 20MB로 설정(2026-07-28, 공지사항 앱 — 사진은 500KB로 압축, 문서 첨부만 이 상한 적용).
const MAX_UPLOAD_BYTES_BY_APP = { notice: 20 * 1024 * 1024 };

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_SECONDS = 15 * 60;

const SIGNATURE_ROLE_RE = /^[\w가-힣-]{1,50}$/;

// 이 Worker를 호출하는 정적 클라이언트 앱들의 배포 origin만 허용.
// 실제 서비스 도메인은 work-portal-4z9.pages.dev (Cloudflare Pages) — 프리뷰 배포용 서브도메인도 함께 허용.
// stock-portal-dxa.pages.dev(주식포털, stock-portfolio.html)도 2026-09-03부터 동일 Worker 공유.
// 로컬 개발 서버(localhost/127.0.0.1, 임의 포트)는 항상 허용.
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === "https://shinfund.github.io") return true;
  if (/^https:\/\/([a-z0-9-]+\.)?work-portal-4z9\.pages\.dev$/.test(origin)) return true;
  if (/^https:\/\/([a-z0-9-]+\.)?stock-portal-dxa\.pages\.dev$/.test(origin)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Notion-Version",
    "Vary": "Origin",
  };
  if (isAllowedOrigin(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function corsJson(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ── 범용 프록시(하단)에서 통과시킬 Notion API 경로 화이트리스트 ──
// 실제로 클라이언트 앱들이 사용하는 경로만 허용하고, 나머지는 차단한다.
const GENERIC_PROXY_ALLOWLIST = [
  { method: "POST", pattern: /^\/v1\/pages$/ },
  { method: "PATCH", pattern: /^\/v1\/pages\/[0-9a-fA-F-]{32,36}$/ },
  { method: "POST", pattern: /^\/v1\/databases\/[0-9a-fA-F-]{32,36}\/query$/ },
];
function isAllowedProxyPath(method, pathname) {
  return GENERIC_PROXY_ALLOWLIST.some((r) => r.method === method && r.pattern.test(pathname));
}

function decodeUnicodeEscapesInString(str) {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
}

// JSON을 먼저 파싱한 뒤, 문자열 leaf 값에만 유니코드 이스케이프 디코딩을 적용한다.
// (파싱 전 원문 텍스트에 정규식을 적용하면 디코딩된 문자가 " 나 \ 일 경우 JSON 구조가 깨질 수 있음)
function decodeUnicodeEscapesDeep(value) {
  if (typeof value === "string") {
    return decodeUnicodeEscapesInString(value);
  }
  if (Array.isArray(value)) {
    return value.map(decodeUnicodeEscapesDeep);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = decodeUnicodeEscapesDeep(v);
    }
    return out;
  }
  return value;
}

// ── base64url / hex 헬퍼 ──────────────────────────────
function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function bufToBase64Url(buf) {
  let bin = "";
  new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlToBuf(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bufToHex(digest);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function issueToken(secret, exp, ver) {
  const payload = bufToBase64Url(new TextEncoder().encode(JSON.stringify({ exp, ver })));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${bufToBase64Url(sig)}`;
}

async function verifyToken(token, secret, expectedVer) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBuf(sig),
    new TextEncoder().encode(payload)
  );
  if (!ok) return false;
  try {
    const { exp, ver } = JSON.parse(new TextDecoder().decode(base64UrlToBuf(payload)));
    if (typeof exp !== "number" || Date.now() / 1000 >= exp) return false;
    // ver가 없는(구버전) 토큰은 expectedVer가 기본값("1")일 때만 유효 — TOKEN_VERSION을 바꾸면 즉시 전부 폐기됨
    if ((ver || "1") !== expectedVer) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// ── 로그인 브루트포스 방어 (KV 바인딩된 경우에만 동작, 없으면 조용히 스킵) ──
async function checkLoginRateLimit(env, ip) {
  if (!env.LOGIN_ATTEMPTS_KV) return { allowed: true, count: 0 };
  const raw = await env.LOGIN_ATTEMPTS_KV.get(`fail:${ip}`);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  return { allowed: count < LOGIN_MAX_ATTEMPTS, count };
}
async function recordLoginFailure(env, ip, count) {
  if (!env.LOGIN_ATTEMPTS_KV) return;
  await env.LOGIN_ATTEMPTS_KV.put(`fail:${ip}`, String((count || 0) + 1), {
    expirationTtl: LOGIN_WINDOW_SECONDS,
  });
}
async function clearLoginFailures(env, ip) {
  if (!env.LOGIN_ATTEMPTS_KV) return;
  await env.LOGIN_ATTEMPTS_KV.delete(`fail:${ip}`);
}

// ── KIS(한국투자증권) 시세 프록시 — stock-portal 포트폴리오 앱 보유종목 탭 장중 실시간 현재가 ──
const KIS_HOST = "https://openapi.koreainvestment.com:9443";
const KIS_TOKEN_CACHE_KEY = "https://internal.cache/kis-token"; // Cache API용 가상 키(실제 요청 아님)
const KIS_TOKEN_CACHE_TTL = 23 * 3600; // KIS 토큰 유효기간 24시간, 여유 1시간 두고 캐시
const KIS_QUOTE_BATCH = 5;
const KIS_QUOTE_DELAY_MS = 200;
const KIS_MAX_CODES = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getKisToken(env) {
  const cache = caches.default;
  const cacheReq = new Request(KIS_TOKEN_CACHE_KEY);
  const cached = await cache.match(cacheReq);
  if (cached) {
    const { access_token } = await cached.json();
    if (access_token) return access_token;
  }
  const res = await fetch(`${KIS_HOST}/oauth2/tokenP`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: env.KIS_APP_KEY, appsecret: env.KIS_APP_SECRET }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`KIS 토큰 발급 실패: ${JSON.stringify(data)}`);
  const cacheRes = new Response(JSON.stringify({ access_token: data.access_token }), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${KIS_TOKEN_CACHE_TTL}` },
  });
  await cache.put(cacheReq, cacheRes);
  return data.access_token;
}

async function fetchKisQuote(token, env, code) {
  const qs = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code });
  try {
    const res = await fetch(`${KIS_HOST}/uapi/domestic-stock/v1/quotations/inquire-price?${qs}`, {
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
        appkey: env.KIS_APP_KEY,
        appsecret: env.KIS_APP_SECRET,
        tr_id: "FHKST01010100",
        custtype: "P",
      },
    });
    const j = await res.json();
    if (j.rt_cd !== "0") return null;
    const o = j.output;
    return {
      현재가: Number(o.stck_prpr || 0),
      등락률: Number(o.prdy_ctrt || 0),
      시가: Number(o.stck_oprc || 0),
      고가: Number(o.stck_hgpr || 0),
      저가: Number(o.stck_lwpr || 0),
    };
  } catch (e) {
    return null;
  }
}

// 국내업종(코스피/코스닥) 현재지수 — 국내증시 앱 지수탭 실시간 조회용(2026-09-04). FID_INPUT_ISCD: 0001=코스피, 1001=코스닥
async function fetchKisIndex(token, env, code) {
  const qs = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: code });
  try {
    const res = await fetch(`${KIS_HOST}/uapi/domestic-stock/v1/quotations/inquire-index-price?${qs}`, {
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
        appkey: env.KIS_APP_KEY,
        appsecret: env.KIS_APP_SECRET,
        tr_id: "FHPUP02100000",
        custtype: "P",
      },
    });
    const j = await res.json();
    if (j.rt_cd !== "0") return null;
    const o = j.output;
    return {
      현재가: Number(o.bstp_nmix_prpr || 0),
      등락률: Number(o.bstp_nmix_prdy_ctrt || 0),
    };
  } catch (e) {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const CORS = corsHeaders(origin);

    if (request.method === "OPTIONS")
      return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const tokenVersion = env.TOKEN_VERSION || "1";

    // ✅ /login — 공용 비밀번호 검증 후 서명된 토큰 발급 (인증 불필요)
    if (url.pathname === "/login" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rl = await checkLoginRateLimit(env, ip);
      if (!rl.allowed) {
        return corsJson({ error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요." }, 429, CORS);
      }

      let password;
      try {
        ({ password } = await request.json());
      } catch (e) {
        return corsJson({ error: "body JSON 파싱 실패" }, 400, CORS);
      }
      if (!password) return corsJson({ error: "password 필드 누락" }, 400, CORS);

      const hash = await sha256Hex(password);
      if (hash !== env.AUTH_PASSWORD_HASH) {
        await recordLoginFailure(env, ip, rl.count);
        return corsJson({ error: "비밀번호가 올바르지 않습니다" }, 401, CORS);
      }
      await clearLoginFailures(env, ip);

      const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
      const token = await issueToken(env.AUTH_TOKEN_SECRET, exp, tokenVersion);
      return corsJson({ token, expires: exp * 1000 }, 200, CORS);
    }

    // ✅ /master-login — 관리자모드(index.html) 비밀번호 검증. 해시를 클라이언트 코드에 두지 않기 위해
    // /login과 동일하게 서버에서만 비교한다(2026-08-11). 로그인 여부와 무관하게 독립적으로 호출 가능.
    if (url.pathname === "/master-login" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rl = await checkLoginRateLimit(env, `master:${ip}`);
      if (!rl.allowed) {
        return corsJson({ error: "시도가 너무 많습니다. 잠시 후 다시 시도해주세요." }, 429, CORS);
      }

      let password;
      try {
        ({ password } = await request.json());
      } catch (e) {
        return corsJson({ error: "body JSON 파싱 실패" }, 400, CORS);
      }
      if (!password) return corsJson({ error: "password 필드 누락" }, 400, CORS);
      if (!env.MASTER_PASSWORD_HASH) return corsJson({ error: "not configured" }, 404, CORS);

      const hash = await sha256Hex(password);
      if (hash !== env.MASTER_PASSWORD_HASH) {
        await recordLoginFailure(env, `master:${ip}`, rl.count);
        return corsJson({ error: "비밀번호가 올바르지 않습니다" }, 401, CORS);
      }

      const exp = Math.floor(Date.now() / 1000) + MASTER_TOKEN_TTL_SECONDS;
      const token = await issueToken(env.AUTH_TOKEN_SECRET, exp, tokenVersion);
      return corsJson({ token, expires: exp * 1000 }, 200, CORS);
    }

    // ── 여기부터는 모두 인증 필요 ─────────────────────────
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const valid = await verifyToken(token, env.AUTH_TOKEN_SECRET, tokenVersion);
    if (!valid) {
      return corsJson({ error: "unauthorized" }, 401, CORS);
    }

    // ✅ /kis/quote — 보유종목 탭 장중 실시간 현재가 (KIS API, stock-portal 전용)
    if (url.pathname === "/kis/quote" && request.method === "GET") {
      const codesParam = url.searchParams.get("codes") || "";
      const codes = [...new Set(codesParam.split(",").map((c) => c.trim()).filter((c) => /^\d{6}$/.test(c)))].slice(0, KIS_MAX_CODES);
      if (!codes.length) return corsJson({ error: "codes 파라미터 누락(6자리 종목코드, 콤마구분)" }, 400, CORS);
      if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) return corsJson({ error: "not configured" }, 404, CORS);

      try {
        const kisToken = await getKisToken(env);
        const result = {};
        for (let i = 0; i < codes.length; i += KIS_QUOTE_BATCH) {
          const batch = codes.slice(i, i + KIS_QUOTE_BATCH);
          const quotes = await Promise.all(batch.map((c) => fetchKisQuote(kisToken, env, c)));
          batch.forEach((c, j) => { if (quotes[j]) result[c] = quotes[j]; });
          if (i + KIS_QUOTE_BATCH < codes.length) await sleep(KIS_QUOTE_DELAY_MS);
        }
        return corsJson(result, 200, CORS);
      } catch (e) {
        return corsJson({ error: `KIS 조회 실패: ${e.message}` }, 502, CORS);
      }
    }

    // ✅ /kis/index — 국내증시 앱 지수탭 코스피·코스닥 실시간 현재지수(KIS API)
    if (url.pathname === "/kis/index" && request.method === "GET") {
      const codesParam = url.searchParams.get("codes") || "";
      const codes = [...new Set(codesParam.split(",").map((c) => c.trim()).filter((c) => /^\d{4}$/.test(c)))].slice(0, 10);
      if (!codes.length) return corsJson({ error: "codes 파라미터 누락(4자리 지수코드, 콤마구분)" }, 400, CORS);
      if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) return corsJson({ error: "not configured" }, 404, CORS);

      try {
        const kisToken = await getKisToken(env);
        const result = {};
        const quotes = await Promise.all(codes.map((c) => fetchKisIndex(kisToken, env, c)));
        codes.forEach((c, j) => { if (quotes[j]) result[c] = quotes[j]; });
        return corsJson(result, 200, CORS);
      } catch (e) {
        return corsJson({ error: `KIS 지수 조회 실패: ${e.message}` }, 502, CORS);
      }
    }

    // ✅ /query-by-date
    if (url.pathname === "/query-by-date") {
      let db, date, page_size;
      try {
        const body = await request.json();
        db = body.db;
        date = body.date;
        page_size = body.page_size ?? 100;
      } catch (e) {
        return corsJson({ error: "body JSON 파싱 실패" }, 400, CORS);
      }

      const dbId = DB_IDS[db];
      if (!dbId) return corsJson({ error: `db 이름 오류: ${db}` }, 400, CORS);
      if (!date) return corsJson({ error: "date 필드 누락" }, 400, CORS);

      try {
        const res = await fetch(
          `${NOTION_API}/v1/databases/${dbId}/query`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.NOTION_TOKEN}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              filter: { property: "날짜", date: { equals: date } },
              sorts: [{ property: "순위", direction: "ascending" }],
              page_size,
            }),
          }
        );

        const data = await res.json();
        return corsJson(data, res.status, CORS);
      } catch (e) {
        return corsJson({ error: `Notion 조회 실패: ${e.message}` }, 502, CORS);
      }
    }

    // ✅ /upload — R2에 파일 업로드 (앱별 폴더 분리, 용량 검증; 인증 필수라 파일 형식은 전체 허용)
    if (url.pathname === "/upload" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const file = formData.get("file");
        if (!file) return corsJson({ error: "file 필드 없음" }, 400, CORS);

        const UPLOAD_APPS = ["defect-management", "asset-register", "overtime-work", "monthly-inspection", "monthly-inspection-team", "notice"];
        const DEFAULT_UPLOAD_APP = "defect-management";
        const appId = formData.get("app");
        const folder = UPLOAD_APPS.includes(appId) ? appId : DEFAULT_UPLOAD_APP;

        const maxBytes = MAX_UPLOAD_BYTES_BY_APP[folder] || MAX_UPLOAD_BYTES;
        if (file.size > maxBytes) {
          return corsJson({ error: `파일 용량 초과 (최대 ${Math.round(maxBytes / 1024 / 1024)}MB)` }, 413, CORS);
        }

        const nameParts = (file.name || "").split(".");
        const ext = nameParts.length > 1 ? nameParts.pop().toLowerCase() : "";
        const mime = (file.type || "").toLowerCase();
        const contentType = mime || MIME_BY_EXT[ext] || "application/octet-stream";

        const key = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext ? "." + ext : ""}`;

        await env.HAJA_BUCKET.put(key, file.stream(), {
          httpMetadata: { contentType },
        });

        const publicUrl = `${env.R2_PUBLIC_URL}/${key}`;
        return corsJson({ url: publicUrl }, 200, CORS);
      } catch (e) {
        return corsJson({ error: e.message }, 500, CORS);
      }
    }

    // ✅ /app-meta — 정적 HTML에 하드코딩하면 안 되는 앱별 민감 설정(직원 실명 등)을
    // env.APP_META_JSON(Cloudflare 환경변수, git 미포함)에서 읽어 인증된 요청에만 반환.
    if (url.pathname === "/app-meta" && request.method === "GET") {
      const app = url.searchParams.get("app") || "";
      if (!app) return corsJson({ error: "app 파라미터 누락" }, 400, CORS);
      if (!env.APP_META_JSON) return corsJson({ error: "not configured" }, 404, CORS);
      let all;
      try {
        all = JSON.parse(env.APP_META_JSON);
      } catch (e) {
        return corsJson({ error: "APP_META_JSON 파싱 실패" }, 500, CORS);
      }
      if (!Object.prototype.hasOwnProperty.call(all, app)) {
        return corsJson({ error: "not found" }, 404, CORS);
      }
      return corsJson(all[app], 200, CORS);
    }

    // ✅ /signature — 차량운행일지 결재 서명 기본값 (R2 signatures/ 전용, role 화이트리스트)
    // 소스코드에 실제 서명 이미지를 하드코딩하지 않기 위한 대체 저장소.
    if (url.pathname === "/signature" && request.method === "GET") {
      const role = url.searchParams.get("role") || "";
      if (!SIGNATURE_ROLE_RE.test(role)) return corsJson({ error: "role 형식 오류" }, 400, CORS);
      const obj = await env.HAJA_BUCKET.get(`signatures/${role}.jpg`);
      if (!obj) return corsJson({ error: "not found" }, 404, CORS);
      const headers = new Headers(CORS);
      headers.set("Content-Type", obj.httpMetadata?.contentType || "image/jpeg");
      return new Response(obj.body, { headers });
    }
    if (url.pathname === "/signature" && request.method === "POST") {
      let role, dataUrl;
      try {
        ({ role, dataUrl } = await request.json());
      } catch (e) {
        return corsJson({ error: "body JSON 파싱 실패" }, 400, CORS);
      }
      if (!SIGNATURE_ROLE_RE.test(role || "")) return corsJson({ error: "role 형식 오류" }, 400, CORS);
      const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(dataUrl || "");
      if (!m) return corsJson({ error: "dataUrl 형식 오류" }, 400, CORS);
      const mime = m[1].toLowerCase();
      if (!ALLOWED_IMAGE_MIME.has(mime)) return corsJson({ error: "허용되지 않는 이미지 형식" }, 415, CORS);

      const bin = atob(m[2]);
      if (bin.length > MAX_UPLOAD_BYTES) return corsJson({ error: "파일 용량 초과 (최대 8MB)" }, 413, CORS);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      await env.HAJA_BUCKET.put(`signatures/${role}.jpg`, bytes, {
        httpMetadata: { contentType: mime },
      });
      return corsJson({ ok: true }, 200, CORS);
    }

    // ✅ 기존 Notion 범용 프록시 — 화이트리스트에 있는 경로/메서드만 통과
    if (!isAllowedProxyPath(request.method, url.pathname)) {
      return corsJson({ error: "허용되지 않는 경로입니다" }, 403, CORS);
    }

    const target = NOTION_API + url.pathname + url.search;
    let body = undefined;
    if (request.method !== "GET") {
      const raw = await request.text();
      try {
        const parsed = JSON.parse(raw);
        body = JSON.stringify(decodeUnicodeEscapesDeep(parsed));
      } catch (e) {
        // JSON이 아니면 원문 그대로 전달 (기존 동작 유지)
        body = raw;
      }
    }

    try {
      const res = await fetch(new Request(target, {
        method: request.method,
        headers: {
          "Authorization": `Bearer ${env.NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body,
      }));

      const out = new Response(res.body, res);
      Object.entries(CORS).forEach(([k, v]) => out.headers.set(k, v));
      return out;
    } catch (e) {
      return corsJson({ error: `Notion 프록시 요청 실패: ${e.message}` }, 502, CORS);
    }
  }
};
