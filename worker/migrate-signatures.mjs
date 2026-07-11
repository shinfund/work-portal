// Worker 배포 완료 후, 로컬에 백업된 서명 이미지 3개를 R2(signatures/)로 1회 업로드하는 스크립트.
// 사용법: node migrate-signatures.mjs <WORKER_URL> <공용비밀번호>
// 예:     node migrate-signatures.mjs https://notion-proxy.shinfund.workers.dev "실제비밀번호"

import fs from "fs";
import path from "path";

const [, , workerUrl, password] = process.argv;
if (!workerUrl || !password) {
  console.error("사용법: node migrate-signatures.mjs <WORKER_URL> <공용비밀번호>");
  process.exit(1);
}

const SIG_DIR = String.raw`C:\Users\shinf\AppData\Local\Temp\claude\C--users-shinf-workspace\8a2d57c8-93dd-4063-a39a-d41cd59e8b9c\scratchpad\signatures`;
const FILES = [
  ["소장", "소장.jpg"],
  ["담당_396거2246", "담당_396거2246.jpg"],
  ["담당_875너3224", "담당_875너3224.jpg"],
];

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

  for (const [role, filename] of FILES) {
    const filePath = path.join(SIG_DIR, filename);
    if (!fs.existsSync(filePath)) {
      console.warn("파일 없음, 스킵:", filePath);
      continue;
    }
    const buf = fs.readFileSync(filePath);
    const dataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
    const res = await fetch(`${workerUrl}/signature`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ role, dataUrl }),
    });
    const body = await res.json();
    console.log(role, "→", res.status, JSON.stringify(body));
  }
}

main();
