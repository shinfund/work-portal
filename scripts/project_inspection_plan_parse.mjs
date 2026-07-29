// 수자원기술(주)이 매달 "공지사항"에 올리는 "N월 점검계획서_수자원.xlsx"를 파싱해, 월간점검결과
// 앱(안전관리·점검팀)에서 참고자료로 쓸 수 있는 구조화 JSON으로 변환한다(2026-07-29 사용자 요청).
//
// 매달 새 계획서가 공지사항에 올라올 때마다 아래처럼 1회 실행 — 산출물은
// apps/work-portal/data/inspection-plan/{YYYY-MM}.json 로 저장되고, 앱이 fetch로 읽어간다.
//
// 사용법: node project_inspection_plan_parse.mjs <입력 xlsx 경로> <YYYY-MM>
//
// 정기점검1/2_점검팀(+_분기) 시트는 터널을 컬럼으로, 점검항목을 행으로 갖는 매트릭스다. "_분기"
// 시트는 분기점검이 이번 달에 해당될 때 분기 항목 마크(◎)까지 채워진 버전이라, 분기 여부와 무관하게
// 항상 안전한 쪽으로 기본판+분기판 마크를 합집합(하나라도 마크가 있으면 해당)해서 사용한다.
import XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";

const [, , inputPath, ymArg] = process.argv;
if (!inputPath || !ymArg) {
  console.error("사용법: node project_inspection_plan_parse.mjs <입력 xlsx 경로> <YYYY-MM>");
  process.exit(1);
}
if (!/^\d{4}-\d{2}$/.test(ymArg)) {
  console.error("YYYY-MM 형식이 아닙니다:", ymArg);
  process.exit(1);
}

const wb = XLSX.readFile(inputPath);
const sheetRows = (name) => {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: true });
};
const clean = (v) => String(v ?? "").replace(/\r\n/g, " ").trim();
const isBlankMark = (v) => {
  const s = clean(v);
  return s === "" || s === "-";
};

// ── 1) 근무표 (날짜별 담당자/터널 배정) — 헤더 4행, 데이터 5행부터, 마지막 "근무일수" 합계행 제외 ──
function parseWorkSchedule(sheetName) {
  const rows = sheetRows(sheetName);
  if (!rows) return null;
  const header = rows[4].map(clean);
  const out = [];
  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];
    const dayNum = row[0];
    if (dayNum === "" || dayNum === "근무일수" || typeof dayNum !== "number") continue;
    const entry = { 일자: `${ymArg}-${String(dayNum).padStart(2, "0")}` };
    header.forEach((h, ci) => {
      if (ci <= 1 || !h) return; // 일자·요일 컬럼 제외
      const v = clean(row[ci]);
      if (v) entry[h] = v;
    });
    entry.요일 = clean(row[1]);
    out.push(entry);
  }
  return out;
}

// ── 2) 정기점검(점검팀) 매트릭스 — 터널을 컬럼으로 갖는 시트, 기본판+분기판 마크 합집합 ──
function parseTeamMatrix(baseName, quarterName) {
  const base = sheetRows(baseName);
  const quarter = sheetRows(quarterName);
  if (!base) return null;
  const header = base[4]; // ["구분","설비명","점검내용","터     널", 터널1, 터널2, ..., "비고"]
  const tunnelCols = [];
  for (let ci = 4; ci < header.length; ci++) {
    const name = clean(header[ci]);
    if (!name) continue;
    if (name === "비고") break; // 터널 컬럼은 "비고" 컬럼 바로 앞까지
    tunnelCols.push({ ci, tunnel: name });
  }
  const 비고Col = tunnelCols.length ? tunnelCols[tunnelCols.length - 1].ci + 1 : 7;
  const 점검일수 = {};
  const 점검일 = {};
  tunnelCols.forEach(({ ci, tunnel }) => {
    if (base[5]?.[ci] !== "") 점검일수[tunnel] = base[5][ci];
    if (base[6]?.[ci] !== "") 점검일[tunnel] = clean(base[6][ci]);
  });

  const byTunnel = {};
  tunnelCols.forEach(({ tunnel }) => {
    byTunnel[tunnel] = { 점검일수: 점검일수[tunnel] ?? null, 점검일: 점검일[tunnel] ?? "", gubuns: {} };
  });

  const appGubunDue = {};
  tunnelCols.forEach(({ tunnel }) => { appGubunDue[tunnel] = {}; });

  let curGubun = "", curSetbi = "";
  for (let ri = 7; ri < base.length; ri++) {
    const row = base[ri];
    const qRow = quarter ? quarter[ri] : null;
    if (row.every((v) => v === "")) continue;
    if (clean(row[0])) curGubun = clean(row[0]);
    if (clean(row[1])) curSetbi = clean(row[1]);
    const 점검내용 = clean(row[2]).replace(/^ㅇ\s*/, "");
    if (!curGubun || !점검내용) continue;
    const 비고 = clean(row[비고Col]);
    const appGubun = mapToAppGubun(curGubun, curSetbi, 점검내용);
    tunnelCols.forEach(({ ci, tunnel }) => {
      const baseMark = clean(row[ci]);
      const qMark = qRow ? clean(qRow[ci]) : "";
      const mark = !isBlankMark(qMark) ? qMark : baseMark; // 분기판에 마크 있으면 우선
      if (isBlankMark(mark)) return;
      const g = (byTunnel[tunnel].gubuns[curGubun] ||= { due: true, items: [] });
      g.items.push({ 설비명: curSetbi, 점검내용, 비고, mark });
      if (appGubun) appGubunDue[tunnel][appGubun] = true;
    });
  }
  tunnelCols.forEach(({ tunnel }) => { byTunnel[tunnel].appGubunDue = appGubunDue[tunnel]; });
  return byTunnel;
}

// 계획서 원본 "구분"(자동제어/조명설비/방재설비/관리동설비/터널진입차단설비/비상전원설비(단터널))을
// 앱의 5개 구분(TEAM_CHECKLIST_BY_GUBUN 키)에 맞춰준다. 원본 표는 "기타"라는 설비명 아래 실제로는
// 다른 구분에 속하는 항목(실내 조명등→조명설비, 옥외 수배전반 소화기→방재설비)을 앞 구분 라벨을
// 그대로 이어받아 적어놓는 서식 관행이 있어(장터널 시트 44~45행 확인), 설비명이 "기타"인 행은
// 점검내용으로 실제 소속 구분을 다시 판별한다. 매칭되지 않는 구분(예: 비상전원설비)은 null을
// 반환해 자동채움 대상에서 제외하고 참고표시로만 남긴다.
function mapToAppGubun(rawGubun, setbi, item) {
  const g = clean(rawGubun).replace(/\s+/g, "");
  const s = clean(setbi);
  if (s === "기타") {
    if (item.includes("실내 조명등") || item.includes("공동구 조명")) return "조명설비";
    if (item.includes("옥외 수배전반 소화기")) return "방재설비";
  }
  const KNOWN = ["자동제어", "조명설비", "방재설비", "관리동설비", "터널진입차단설비"];
  return KNOWN.includes(g) ? g : null;
}

// 계획서 원본 터널 라벨("흥해","남정1,2")을 앱 TUNNEL_OPTIONS_STD 표기("흥해터널","남정1·2터널")로
// 맞춰서, 앱에서 터널명 그대로 조회 키로 쓸 수 있게 한다.
const KNOWN_RAW_TUNNELS = new Set([
  "흥해", "청하", "남정1,2", "남정3", "남정4", "남정5", "남정6", "남정7", "남정8", "남정9",
  "강구1", "강구2", "강구3",
]);
function normalizeTunnelName(raw) {
  if (!KNOWN_RAW_TUNNELS.has(raw)) return raw; // 터널명이 아닌 값(비고성 텍스트 등)은 그대로 둔다
  if (raw === "남정1,2") return "남정1·2터널";
  return `${raw}터널`;
}

function mergeTeamPlan(...plans) {
  const merged = {};
  plans.filter(Boolean).forEach((plan) => {
    Object.entries(plan).forEach(([tunnel, data]) => {
      merged[normalizeTunnelName(tunnel)] = data;
    });
  });
  return merged;
}

// ── 3) 정기점검(안전관리자) 매트릭스 — 날짜를 컬럼으로 갖는 시트(4행 헤더에 일자 숫자) ──
function parseSafetyMatrix(baseName, quarterName) {
  const base = sheetRows(baseName);
  const quarter = sheetRows(quarterName);
  if (!base) return null;
  const dateRow = base[4];
  const dateCols = [];
  for (let ci = 3; ci < dateRow.length; ci++) {
    if (typeof dateRow[ci] === "number") dateCols.push({ ci, day: dateRow[ci] });
  }
  const byDate = {};
  let curGubun = "", curSetbi = "";
  for (let ri = 5; ri < base.length; ri++) {
    const row = base[ri];
    const qRow = quarter ? quarter[ri] : null;
    if (row.every((v) => v === "")) continue;
    if (clean(row[0])) curGubun = clean(row[0]);
    if (clean(row[1])) curSetbi = clean(row[1]);
    const 점검내용 = clean(row[2]).replace(/^ㅇ\s*/, "");
    if (!curGubun || !점검내용) continue;
    const 비고 = clean(row[7]) || (row[7 + 1] !== undefined ? "" : "");
    dateCols.forEach(({ ci, day }) => {
      const baseMark = clean(row[ci]);
      const qMark = qRow ? clean(qRow[ci]) : "";
      const mark = !isBlankMark(qMark) ? qMark : baseMark;
      if (isBlankMark(mark)) return;
      const dateStr = `${ymArg}-${String(day).padStart(2, "0")}`;
      (byDate[dateStr] ||= []).push({ 구분: curGubun, 설비명: curSetbi, 점검내용, mark });
    });
  }
  return byDate;
}

const result = {
  월: ymArg,
  생성시각: null, // 재현성 위해 스크립트에서는 채우지 않음 — 호출부(사용자)가 필요시 별도 기록
  workSchedule: {
    safety: parseWorkSchedule("근무표_안전관리자"),
    team: (parseWorkSchedule("근무표_점검팀") || []).map((e) => {
      // "장터널"/"단터널" 컬럼 값은 그날의 점검대상 터널명(예: "흥해") — 앱 표기로 정규화해
      // 터널명 기준 조회가 가능하게 한다.
      ["장터널", "단터널"].forEach((k) => {
        if (e[k]) e[k] = normalizeTunnelName(e[k]);
      });
      return e;
    }),
  },
  teamPlan: mergeTeamPlan(
    parseTeamMatrix("정기점검1_점검팀", "정기점검1_점검팀_분기"),
    parseTeamMatrix("정기점검2_점검팀", "정기점검2_점검팀_분기")
  ),
  safetyPlan: {
    byDate: Object.assign(
      {},
      parseSafetyMatrix("정기점검1_안전관리자", null),
      // 두 시트를 날짜별로 병합(각 시트가 서로 다른 설비군을 다룸 → 같은 날짜 키에 항목 합산)
      (() => {
        const p2 = parseSafetyMatrix("정기점검2_안전관리자", null) || {};
        const p1 = parseSafetyMatrix("정기점검1_안전관리자", null) || {};
        const merged = {};
        new Set([...Object.keys(p1), ...Object.keys(p2)]).forEach((d) => {
          merged[d] = [...(p1[d] || []), ...(p2[d] || [])];
        });
        return merged;
      })()
    ),
  },
};

// work-portal의 .gitignore가 이름이 "data"인 폴더를 통째로 무시하므로(로컬 전용 산출물 규칙),
// 배포에 실제로 포함돼야 하는 이 JSON은 "data/" 밖의 별도 폴더에 저장한다.
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "inspection-plan");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${ymArg}.json`);
fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
console.log("저장 완료:", outPath);
console.log("터널 목록:", Object.keys(result.teamPlan));
console.log("근무표(점검팀) 행수:", result.workSchedule.team?.length, "/ 근무표(안전관리자) 행수:", result.workSchedule.safety?.length);
console.log("안전관리 정기점검 날짜 수:", Object.keys(result.safetyPlan.byDate).length);
