// 노션 점검사진DB(월간점검결과_점검팀)의 "번호"를 월별 전체 연번(터널마다 고정된 오프셋을 더한
// 1~42 형태, 예: 흥해=1~6·청하=7~12·남정1·2=13~15...)에서 터널별로 1부터 시작하는 순번으로
// 바꾸는 스크립트(2026-07-29 사용자 요청).
//
// 오프셋은 하드코딩하지 않고, (터널명, 연월) 조합별로 그 안의 최소 번호를 구해 자동 계산한다
// (신규번호 = 기존번호 - 그룹내최소번호 + 1). 월 단위로 그룹을 나누는 이유 — 앱의 번호 자동
// 제안 로직이 한동안 예전 방식(터널 구분 없이 그 달 전체 최대번호+1)으로 되돌아가 있어서
// (2026-07-29 재발견) 이미 정상화된 달과 아직 안 된 달이 섞여 있을 수 있다. 터널 단위로만
// 오프셋을 구하면 이미 고쳐진 달(최소값 1) 때문에 안 고쳐진 달의 오프셋이 0으로 잘못 계산되므로,
// 반드시 (터널, 연월) 조합 단위로 그룹을 나눠야 한다.
//
// 사용법:
//   node migrate-photo-numbering.mjs <WORKER_URL> <공용비밀번호> [시작일] [종료일(제외)]        → 미리보기만(쓰기 없음)
//   node migrate-photo-numbering.mjs <WORKER_URL> <공용비밀번호> [시작일] [종료일(제외)] --apply → 실제 반영
// 날짜 생략 시 기본값은 2026-01-01 ~ 2027-01-01(2026년 전체).

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const positional = args.filter((a) => a !== "--apply");
const [workerUrl, password, startArg, endArg] = positional;
if (!workerUrl || !password) {
  console.error("사용법: node migrate-photo-numbering.mjs <WORKER_URL> <공용비밀번호> [시작일] [종료일(제외)] [--apply]");
  process.exit(1);
}

const PHOTO_DB_ID = "83a945c6-79fe-4f2b-87e6-2ceef9557d0a";
const START_DATE = startArg || "2026-01-01";
const END_DATE_EXCLUSIVE = endArg || "2027-01-01";

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
  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // 1) 대상 레코드 전부 조회(페이지네이션)
  let pages = [];
  let cursor = null;
  do {
    const body = {
      filter: {
        and: [
          { property: "일자", date: { on_or_after: START_DATE } },
          { property: "일자", date: { before: END_DATE_EXCLUSIVE } },
        ],
      },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const res = await fetch(`${workerUrl}/v1/databases/${PHOTO_DB_ID}/query`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`query HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    pages = pages.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  console.log(`대상 레코드 ${pages.length}건 조회됨`);

  // 2) 레코드 파싱 (터널명, 번호, id)
  const records = pages
    .map((p) => ({
      id: p.id,
      tunnel: p.properties?.["터널명"]?.select?.name || "",
      date: p.properties?.["일자"]?.date?.start || "",
      num: p.properties?.["번호"]?.number,
    }))
    .filter((r) => r.tunnel && r.num != null);

  if (records.length !== pages.length) {
    console.warn(`터널명/번호가 비어있는 레코드 ${pages.length - records.length}건은 건너뜁니다.`);
  }

  // 3) (터널명, 연월) 조합별 최소 번호(오프셋) 계산 — 이미 정상화된 달과 안 된 달이 섞여
  // 있어도 각 달을 독립적으로 취급하기 위해 터널만이 아니라 연월까지 키에 포함한다.
  const groupKey = (r) => `${r.tunnel}|${r.date.slice(0, 7)}`;
  const minByGroup = {};
  records.forEach((r) => {
    const k = groupKey(r);
    if (minByGroup[k] == null || r.num < minByGroup[k]) minByGroup[k] = r.num;
  });
  console.log("터널·연월 조합별 기존 최소 번호(오프셋 기준):");
  Object.entries(minByGroup)
    .sort((a, b) => a[1] - b[1])
    .forEach(([k, min]) => console.log(`  ${k}: ${min}`));

  // 4) 새 번호 계산 + 실제로 바뀌는 것만 대상
  const updates = records
    .map((r) => ({ ...r, newNum: r.num - minByGroup[groupKey(r)] + 1 }))
    .filter((r) => r.newNum !== r.num);

  console.log(`\n갱신 대상 ${updates.length}건 / 전체 ${records.length}건`);

  if (!APPLY) {
    console.log("\n[미리보기 모드] --apply 없이 실행되어 실제 쓰기는 하지 않았습니다.");
    console.log("예시 10건:");
    updates.slice(0, 10).forEach((u) => console.log(`  ${u.tunnel} ${u.date} ${u.num} → ${u.newNum}`));
    return;
  }

  // 5) 순차 PATCH(동시 과다요청 방지)
  let ok = 0,
    fail = 0;
  for (const u of updates) {
    try {
      const res = await fetch(`${workerUrl}/v1/pages/${u.id}`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({ properties: { 번호: { number: u.newNum } } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      ok++;
      console.log(`OK ${u.tunnel} ${u.date} ${u.num} → ${u.newNum}`);
    } catch (e) {
      fail++;
      console.error(`FAIL ${u.tunnel} ${u.date} ${u.id} (${u.num}→${u.newNum}):`, e.message);
    }
  }
  console.log(`\n완료: 성공 ${ok} / 실패 ${fail} / 전체 ${updates.length}`);
}

main();
