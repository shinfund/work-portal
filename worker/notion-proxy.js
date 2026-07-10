const NOTION_API = "https://api.notion.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,Notion-Version",
};

const DB_IDS = {
  "거래대금": "36159c8c-9c0a-80fd-a656-daeb46ec25d5",
  "이슈분석": "2e2fceec-ae43-492d-95d4-edfadb5f8581",
};

const TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 7일

function decodeUnicodeEscapes(str) {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
}

function corsJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
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

async function issueToken(secret, exp) {
  const payload = bufToBase64Url(new TextEncoder().encode(JSON.stringify({ exp })));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${bufToBase64Url(sig)}`;
}

async function verifyToken(token, secret) {
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
    const { exp } = JSON.parse(new TextDecoder().decode(base64UrlToBuf(payload)));
    return typeof exp === "number" && Date.now() / 1000 < exp;
  } catch (e) {
    return false;
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS")
      return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    // ✅ /login — 공용 비밀번호 검증 후 서명된 토큰 발급 (인증 불필요)
    if (url.pathname === "/login" && request.method === "POST") {
      let password;
      try {
        ({ password } = await request.json());
      } catch (e) {
        return corsJson({ error: "body JSON 파싱 실패" }, 400);
      }
      if (!password) return corsJson({ error: "password 필드 누락" }, 400);

      const hash = await sha256Hex(password);
      if (hash !== env.AUTH_PASSWORD_HASH) {
        return corsJson({ error: "비밀번호가 올바르지 않습니다" }, 401);
      }
      const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
      const token = await issueToken(env.AUTH_TOKEN_SECRET, exp);
      return corsJson({ token, expires: exp * 1000 });
    }

    // ── 여기부터는 모두 인증 필요 ─────────────────────────
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const valid = await verifyToken(token, env.AUTH_TOKEN_SECRET);
    if (!valid) {
      return corsJson({ error: "unauthorized" }, 401);
    }

    // ✅ /query-by-date
    if (url.pathname === "/query-by-date") {
      let db, date, page_size = 100;
      try {
        const body = await request.json();
        db = body.db;
        date = body.date;
        page_size = body.page_size ?? 100;
      } catch (e) {
        return corsJson({ error: "body JSON 파싱 실패" }, 400);
      }

      const dbId = DB_IDS[db];
      if (!dbId) return corsJson({ error: `db 이름 오류: ${db}` }, 400);
      if (!date) return corsJson({ error: "date 필드 누락" }, 400);

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
      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

     // ✅ /upload — R2에 이미지 업로드 (앱별 폴더 분리)
    if (url.pathname === "/upload" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const file = formData.get("file");
        if (!file) return corsJson({ error: "file 필드 없음" }, 400);

        const UPLOAD_APPS = ["defect-management", "asset-register", "overtime-work"];
        const DEFAULT_UPLOAD_APP = "defect-management";
        const appId = formData.get("app");
        const folder = UPLOAD_APPS.includes(appId) ? appId : DEFAULT_UPLOAD_APP;

        const ext = (file.name || "image").split(".").pop().toLowerCase();
        const key = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

        await env.HAJA_BUCKET.put(key, file.stream(), {
          httpMetadata: { contentType: file.type || "image/jpeg" },
        });

        const publicUrl = `${env.R2_PUBLIC_URL}/${key}`;
        return corsJson({ url: publicUrl });
      } catch (e) {
        return corsJson({ error: e.message }, 500);
      }
    }

    // ✅ 기존 Notion 범용 프록시
    const target = NOTION_API + url.pathname + url.search;
    let body = undefined;
    if (request.method !== "GET") {
      const raw = await request.text();
      body = decodeUnicodeEscapes(raw);
    }

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
  }
};
