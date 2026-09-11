// 시설물현황/비품수자원/비품도공/하자보수/월간점검결과(안전관리·점검팀) 6개 앱의 기존 사진들에
// 대해 목록용 썸네일(80px 표시, 원본 160px 리사이즈+~15KB 압축)을 소급 생성해 각 DB의 "*_썸네일"
// files 속성에 채워 넣는다 (2026-09-11, 사용자 요청 — 목록 테이블 초기 로딩 속도 개선을 위해 신규
// 업로드분은 이미 각 앱 코드에서 원본+썸네일 동시 업로드로 전환됨. 이 스크립트는 그 전환 이전에
// 이미 올라간 사진들을 일괄 백필한다).
//
// 사용법:
//   node migrate-photo-thumbnails.mjs <WORKER_URL> <공용비밀번호>          → 미리보기만(쓰기 없음)
//   node migrate-photo-thumbnails.mjs <WORKER_URL> <공용비밀번호> --apply  → 실제 반영

import sharp from "sharp";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const positional = args.filter((a) => a !== "--apply");
const [workerUrl, password] = positional;
if (!workerUrl || !password) {
  console.error("사용법: node migrate-photo-thumbnails.mjs <WORKER_URL> <공용비밀번호> [--apply]");
  process.exit(1);
}

const THUMB_MAX_DIM = 160;
const THUMB_MAX_BYTES = 15 * 1024;

const DB_CONFIGS = [
  {
    name: "facility-status (시설물DB)",
    dbId: "3d659c8c-9c0a-80b5-9de9-df4af2fe98a2",
    uploadApp: "facility-status",
    fields: [
      { orig: "사진", thumb: "사진_썸네일" },
      { orig: "명판", thumb: "명판_썸네일" },
    ],
  },
  {
    name: "asset-register (비품수자원DB)",
    dbId: "15f75447-7a79-4f6f-aa8d-b4c547958d58",
    uploadApp: "asset-register",
    fields: [{ orig: "사진", thumb: "사진_썸네일" }],
  },
  {
    name: "asset-register-dogong (비품도공DB)",
    dbId: "75359c8c-9c0a-8337-84f3-0175600ce1f2",
    uploadApp: "asset-register", // 비품도공 앱도 asset-register R2 폴더를 공유
    fields: [{ orig: "사진", thumb: "사진_썸네일" }],
  },
  {
    name: "defect-management (하자보수DB)",
    dbId: "2e159c8c9c0a80d4afa2d9421e1fdc0e",
    uploadApp: "defect-management",
    fields: [
      { orig: "하자사진", thumb: "하자사진_썸네일" },
      { orig: "조치사진", thumb: "조치사진_썸네일" },
    ],
  },
  {
    name: "monthly-inspection (점검사진DB, 안전관리)",
    dbId: "60f5cbbf-54e4-465e-8901-af41ba515dd0",
    uploadApp: "monthly-inspection",
    fields: [{ orig: "점검사진", thumb: "점검사진_썸네일" }],
  },
  {
    name: "monthly-inspection-team (점검사진DB, 점검팀)",
    dbId: "83a945c6-79fe-4f2b-87e6-2ceef9557d0a",
    uploadApp: "monthly-inspection-team",
    fields: [{ orig: "점검사진", thumb: "점검사진_썸네일" }],
  },
];

async function login() {
  const res = await fetch(`${workerUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`로그인 실패: HTTP ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  return { Authorization: `Bearer ${token}` };
}

function getFileUrls(prop) {
  if (!prop || prop.type !== "files" || !prop.files) return [];
  return prop.files
    .map((f) => (f.type === "external" ? f.external?.url : f.file?.url) || "")
    .filter(Boolean);
}

async function queryAllPages(dbId, authHeaders) {
  let pages = [];
  let cursor = null;
  do {
    const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const res = await fetch(`${workerUrl}/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`query HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    pages = pages.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return pages;
}

async function makeThumbBuffer(origBuffer) {
  let quality = 80;
  let attempts = 1;
  let buf = await sharp(origBuffer)
    .resize(THUMB_MAX_DIM, THUMB_MAX_DIM, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
  while (buf.length > THUMB_MAX_BYTES && attempts < 6) {
    quality = Math.max(35, quality - 15);
    attempts++;
    buf = await sharp(origBuffer)
      .resize(THUMB_MAX_DIM, THUMB_MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
  }
  return buf;
}

async function uploadBuffer(buf, filename, appFolder, authHeaders) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "image/jpeg" }), filename);
  form.append("app", appFolder);
  const res = await fetch(`${workerUrl}/upload`, { method: "POST", headers: authHeaders, body: form });
  if (!res.ok) throw new Error(`upload HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.url;
}

async function main() {
  const authHeaders = await login();
  let totalMissing = 0,
    totalOk = 0,
    totalFail = 0;

  for (const cfg of DB_CONFIGS) {
    console.log(`\n=== ${cfg.name} ===`);
    const pages = await queryAllPages(cfg.dbId, authHeaders);
    console.log(`${pages.length}건 조회됨`);

    for (const page of pages) {
      const props = page.properties || {};
      for (const f of cfg.fields) {
        const origUrls = getFileUrls(props[f.orig]);
        if (!origUrls.length) continue;
        const existingThumbUrls = getFileUrls(props[f.thumb]);
        if (existingThumbUrls.length >= origUrls.length) continue; // 이미 전부 썸네일 있음

        const newThumbUrls = [];
        let changed = false;
        for (let i = 0; i < origUrls.length; i++) {
          if (existingThumbUrls[i]) {
            newThumbUrls.push(existingThumbUrls[i]);
            continue;
          }
          changed = true;
          totalMissing++;
          if (!APPLY) {
            newThumbUrls.push("(생성예정)");
            continue;
          }
          try {
            const origRes = await fetch(origUrls[i]);
            if (!origRes.ok) throw new Error(`원본 다운로드 실패 HTTP ${origRes.status}`);
            const origBuf = Buffer.from(await origRes.arrayBuffer());
            const thumbBuf = await makeThumbBuffer(origBuf);
            const thumbUrl = await uploadBuffer(
              thumbBuf,
              `thumb-${Date.now()}-${i}.jpg`,
              cfg.uploadApp,
              authHeaders
            );
            newThumbUrls.push(thumbUrl);
            totalOk++;
            console.log(`  OK ${page.id} [${f.orig}][${i}] ${thumbBuf.length}B (원본 ${origBuf.length}B)`);
          } catch (e) {
            totalFail++;
            console.error(`  FAIL ${page.id} [${f.orig}][${i}]: ${e.message}`);
            newThumbUrls.push(origUrls[i]); // 실패 시 원본 URL로 폴백(앱단 fallback과 동일 효과)
          }
        }

        if (changed && APPLY) {
          const patchBody = {
            properties: {
              [f.thumb]: {
                files: newThumbUrls.map((u, i) => ({
                  name: `${f.thumb}${i + 1}`,
                  type: "external",
                  external: { url: u },
                })),
              },
            },
          };
          const res = await fetch(`${workerUrl}/v1/pages/${page.id}`, {
            method: "PATCH",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify(patchBody),
          });
          if (!res.ok) console.error(`  PATCH FAIL ${page.id}: HTTP ${res.status} ${await res.text()}`);
        }
      }
    }
  }

  console.log(`\n전체 누락 사진 ${totalMissing}건 / 성공 ${totalOk} / 실패 ${totalFail}`);
  if (!APPLY) console.log("\n[미리보기 모드] --apply 없이 실행되어 실제 쓰기는 하지 않았습니다.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
