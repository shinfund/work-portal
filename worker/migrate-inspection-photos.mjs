// 6월 템플릿 엑셀(청하/남정5/흥해)의 '점검사진' 시트에서 추출한 24장을
// R2(monthly-inspection/)에 업로드하고, 노션 점검사진DB의 해당 레코드에 연결하는 1회성 스크립트.
// 사용법: node migrate-inspection-photos.mjs <WORKER_URL> <공용비밀번호>
// 예:     node migrate-inspection-photos.mjs https://notion-proxy.shinfund.workers.dev "실제비밀번호"

import fs from "fs";
import path from "path";

const [, , workerUrl, password] = process.argv;
if (!workerUrl || !password) {
  console.error("사용법: node migrate-inspection-photos.mjs <WORKER_URL> <공용비밀번호>");
  process.exit(1);
}

const PHOTO_DIR = String.raw`C:\Users\shinf\AppData\Local\Temp\claude\C--users-shinf-workspace\d44cf1fe-cb10-4d54-9680-af2f48d4a2a5\scratchpad\photos`;
const manifest = JSON.parse(fs.readFileSync(path.join(PHOTO_DIR, "_manifest_matched.json"), "utf8"));

const MIME_BY_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };
function mimeForFile(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

async function main() {
  const loginRes = await fetch(`${workerUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!loginRes.ok) {
    console.error("로그인 실패:", await loginRes.text());
    process.exit(1);
  }
  const { token } = await loginRes.json();
  const authHeaders = { Authorization: `Bearer ${token}` };

  let okCount = 0, failCount = 0;
  for (const m of manifest) {
    const filePath = path.join(PHOTO_DIR, m.file);
    if (!fs.existsSync(filePath)) {
      console.warn("파일 없음, 스킵:", m.file);
      failCount++;
      continue;
    }
    try {
      const buf = fs.readFileSync(filePath);
      const blob = new Blob([buf], { type: mimeForFile(m.file) });
      const formData = new FormData();
      formData.append("file", blob, m.file);
      formData.append("app", "monthly-inspection");
      const upRes = await fetch(`${workerUrl}/upload`, { method: "POST", headers: authHeaders, body: formData });
      if (!upRes.ok) throw new Error(`upload HTTP ${upRes.status}: ${await upRes.text()}`);
      const { url } = await upRes.json();

      const patchRes = await fetch(`${workerUrl}/v1/pages/${m.pageId}`, {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          properties: { "점검사진": { files: [{ name: m.file, type: "external", external: { url } }] } },
        }),
      });
      if (!patchRes.ok) throw new Error(`patch HTTP ${patchRes.status}: ${await patchRes.text()}`);

      console.log("OK", m.tunnel, m.일자, m.사진설명, "→", url);
      okCount++;
    } catch (e) {
      console.error("FAIL", m.tunnel, m.일자, m.사진설명, "→", e.message);
      failCount++;
    }
  }
  console.log(`\n완료: 성공 ${okCount} / 실패 ${failCount} / 전체 ${manifest.length}`);
}

main();
