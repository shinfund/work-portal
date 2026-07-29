// 노션 점검사진DB(월간점검결과_점검팀)의 "번호"를 월별 전체 연번(터널마다 고정된 오프셋을 더한
// 1~42 형태, 예: 흥해=1~6·청하=7~12·남정1·2=13~15...)에서 터널별로 1부터 시작하는 순번으로
// 바꾸는 스크립트(2026-07-29 사용자 요청).
//
// (터널명, 연월) 조합별로 그룹을 나눈 뒤, 그룹 안에서 현재 번호(동률이면 생성시각) 순서를 그대로
// 보존하며 1..n으로 재배정한다. 오프셋(최소값) 빼기 방식이 아니라 순위 기반인 이유 — 앱의 번호
// 자동 제안 로직이 한동안 예전 방식(터널 구분 없이 그 달 전체 최대번호+1)으로 되돌아가 있어서
// (2026-07-29 재발견), 같은 (터널,연월) 그룹 안에 "이미 정상화된 소수"와 "코드 수정 배포 전에
// 등록돼 계속 누적된 큰 값"이 섞여 있는 경우가 있다. 이럴 때 최소값이 이미 1이라 오프셋 방식으로는
// 오염된 큰 값을 못 고치지만, 순위 기반 재배정은 절대값과 무관하게 상대 순서만 보존하므로 항상
// 안전하다.
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

  // 2) 레코드 파싱 (터널명, 번호, id, 생성시각)
  const records = pages
    .map((p) => ({
      id: p.id,
      tunnel: p.properties?.["터널명"]?.select?.name || "",
      date: p.properties?.["일자"]?.date?.start || "",
      num: p.properties?.["번호"]?.number,
      createdTime: p.created_time || "",
    }))
    .filter((r) => r.tunnel && r.num != null);

  if (records.length !== pages.length) {
    console.warn(`터널명/번호가 비어있는 레코드 ${pages.length - records.length}건은 건너뜁니다.`);
  }

  // 3) (터널명, 연월) 조합별로 그룹을 나눈 뒤, 그룹 안에서 현재 번호(동률이면 생성시각) 순으로
  // 재정렬해 1..n을 다시 매긴다. 오프셋(최소값) 빼기 방식은 한 그룹 안에 "이미 정상화된 소수"와
  // "여전히 큰 값을 가진 오염된 레코드"가 섞여 있으면(2026-07-29 재발견 — 코드 수정 배포 전에
  // 등록된 건들이 계속 누적된 큰 값을 가짐) 최소값이 이미 1이라 오염된 값을 못 고친다. 순위 기반
  // 재배정은 절대값과 무관하게 상대 순서만 보존하므로 이런 혼재 상황에서도 항상 안전하다.
  const groupKey = (r) => `${r.tunnel}|${r.date.slice(0, 7)}`;
  const groups = {};
  records.forEach((r) => {
    const k = groupKey(r);
    (groups[k] || (groups[k] = [])).push(r);
  });
  console.log(`대상 (터널명,연월) 그룹 ${Object.keys(groups).length}개`);

  const updates = [];
  Object.values(groups).forEach((group) => {
    const sorted = group
      .slice()
      .sort((a, b) => a.num - b.num || a.createdTime.localeCompare(b.createdTime));
    sorted.forEach((r, i) => {
      const newNum = i + 1;
      if (newNum !== r.num) updates.push({ ...r, newNum });
    });
  });

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
