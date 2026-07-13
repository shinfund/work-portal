// ── 배포 시 필요한 환경변수/바인딩 ──────────────────────────
//   env.AUTH_PASSWORD_HASH   (필수) 공용 비밀번호의 SHA-256 해시
//   env.AUTH_TOKEN_SECRET    (필수) 토큰 서명용 HMAC 시크릿
//   env.NOTION_TOKEN         (필수) Notion Integration 토큰
//   env.HAJA_BUCKET          (필수, R2 바인딩) 사진/서명 이미지 저장
//   env.R2_PUBLIC_URL        (필수) HAJA_BUCKET의 공개 접근 URL
//   env.TOKEN_VERSION        (선택) 문자열. 값을 바꾸면 기존 발급 토큰이 즉시 전부 무효화됨(폐기 수단). 미설정 시 "1"
//   env.LOGIN_ATTEMPTS_KV    (선택, KV 바인딩) /login 브루트포스 방어용. 미바인딩 시 rate limit은 자동 스킵됨

const NOTION_API = "https://api.notion.com";

const DB_IDS = {
  "거래대금": "36159c8c-9c0a-80fd-a656-daeb46ec25d5",
  "이슈분석": "2e2fceec-ae43-492d-95d4-edfadb5f8581",
};

const TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 7일 (사용자 요청으로 원복 — 토큰 폐기는 TOKEN_VERSION으로 대응)

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
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_SECONDS = 15 * 60;

const SIGNATURE_ROLE_RE = /^[\w가-힣-]{1,50}$/;

// 이 Worker를 호출하는 정적 클라이언트 앱들의 배포 origin만 허용.
// 실제 서비스 도메인은 work-portal-4z9.pages.dev (Cloudflare Pages) — 프리뷰 배포용 서브도메인도 함께 허용.
// 로컬 개발 서버(localhost/127.0.0.1, 임의 포트)는 항상 허용.
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === "https://shinfund.github.io") return true;
  if (/^https:\/\/([a-z0-9-]+\.)?work-portal-4z9\.pages\.dev$/.test(origin)) return true;
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

    // ── 여기부터는 모두 인증 필요 ─────────────────────────
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const valid = await verifyToken(token, env.AUTH_TOKEN_SECRET, tokenVersion);
    if (!valid) {
      return corsJson({ error: "unauthorized" }, 401, CORS);
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

        if (file.size > MAX_UPLOAD_BYTES) {
          return corsJson({ error: "파일 용량 초과 (최대 8MB)" }, 413, CORS);
        }

        const UPLOAD_APPS = ["defect-management", "asset-register", "overtime-work", "monthly-inspection"];
        const DEFAULT_UPLOAD_APP = "defect-management";
        const appId = formData.get("app");
        const folder = UPLOAD_APPS.includes(appId) ? appId : DEFAULT_UPLOAD_APP;

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
