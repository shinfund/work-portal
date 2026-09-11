// 페이지네이션(레코드 표시개수) 통일성·커버리지 감사 스크립트 (2026-09-11 사용자 요청).
//
// work-portal 각 앱은 페이지네이션 기능이 시기별로 따로따로 이식돼(facility-status 최초 도입 →
// defect-management/asset-register/announcement/overtime-work/vehicle-log/solar-power 확장 →
// corporate-card·monthly-inspection[-team] 별도 구현) 세부 구현이 조금씩 달라졌다. 이 스크립트는
// 매번 手동 grep하지 않고도 재실행만으로:
//   1) 앱별로 어떤 페이지네이션 "시스템"(옵션배열·기본값·localStorage 키·함수명·CSS클래스)이
//      몇 개나 있는지
//   2) 각 앱의 모든 <tbody id="..."> 중 페이지네이션이 실제로 연결된 것과 안 된 것
//   3) 옵션배열·기본값·localStorage 네이밍·CSS 클래스·"전체" 옵션 존재 여부가 앱 간에 갈라진 지점
// 을 기계적으로 뽑아 report(마크다운)로 남긴다. "이 tbody가 굳이 페이지네이션 필요없는 고정
// 요약표냐"는 최종 판단은 사람이 KNOWN_BOUNDED 목록에 추가해 관리한다(아래 참고) — 새로 생긴
// tbody는 기본적으로 "검토 필요"로 표시된다.
//
// 사용법: node scripts/pagination-audit.mjs  (work-portal 루트에서 실행, 인자 없음)
// 출력: scripts/pagination-audit-report.md 에 저장 + 터미널에도 요약 출력.

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const APP_FILES = readdirSync(ROOT)
  .filter((f) => f.endsWith(".html") && f !== "index.html")
  .sort();

// 요약표 형태라 데이터가 늘어나도 상한이 있는(터널 수·직원 수·최근 12개월 등) tbody는 페이지네이션이
// 없어도 정상이다 — 감사 때마다 "왜 없냐"고 다시 묻지 않도록 확인된 것만 여기 등록해둔다.
// key: "파일명::tbody id"
const KNOWN_BOUNDED = new Set([
  "facility-status.html::tunnelTableBody",
  "facility-status.html::bytunnelTableBody",
  "facility-status.html::categoryTableBody",
  "asset-register.html::tunnelTableBody",
  "asset-register.html::categoryTableBody",
  "asset-register-dogong.html::tunnelTableBody",
  "asset-register-dogong.html::categoryTableBody",
  "overtime-work.html::empTableBody",
  "overtime-work.html::trendTableBody",
  "vehicle-log.html::vehicleTableBody",
  "vehicle-log.html::driverTableBody",
  "vehicle-log.html::trendTableBody",
  "solar-power.html::tunnelTableBody",
  "solar-power.html::trendTableBody",
  "corporate-card.html::topTbody",
  "corporate-card.html::accTableBody",
  "corporate-card.html::limTableBody",
  "corporate-card.html::monthlyTableBody",
]);

function extractAll(re, text, groupIdx = 1) {
  const out = [];
  let m;
  const g = new RegExp(re, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = g.exec(text))) out.push(m[groupIdx]);
  return out;
}

function auditFile(fname) {
  const text = readFileSync(join(ROOT, fname), "utf8");
  const findings = { file: fname, systems: [], tbodies: [] };

  // ── 1) 페이지 크기 옵션 배열 ──
  const optionArrays = [];
  for (const m of text.matchAll(/(?:var|let|const)\s+(PAGE_SIZE_OPTIONS|PS_OPTIONS)\s*=\s*\[([^\]]+)\]/g)) {
    optionArrays.push({ varName: m[1], values: m[2].split(",").map((s) => s.trim()) });
  }
  findings.optionArrays = optionArrays;

  // ── 2) localStorage 페이지 크기 키 ──
  const lsKeys = new Set();
  for (const m of text.matchAll(/localStorage\.(?:getItem|setItem)\(\s*(['"])([\w]*[Pp]age[Ss]ize[\w]*)\1/g)) {
    lsKeys.add(m[2]);
  }
  // 'key'+ 조합(동적 키) 패턴도 별도로 잡는다 (예: 'defectMgmt_pageSize_'+key)
  for (const m of text.matchAll(/localStorage\.(?:getItem|setItem)\(\s*(['"])([\w]*[Pp]age[Ss]ize[\w]*)\1\s*\+/g)) {
    lsKeys.add(m[2] + "<dynamic>");
  }
  findings.localStorageKeys = [...lsKeys];

  // ── 3) 관련 함수명 존재 여부 ──
  const FN_NAMES = [
    "buildPageSizeDd", "togglePageSizeDd", "renderPaginationRow", "renderTabPaginationRow",
    "goToPage", "goToTabPage", "getPageState", "pickPageSize", "renderDDPS", "pickPS", "paginate",
  ];
  findings.functionsPresent = FN_NAMES.filter((fn) => new RegExp(`function\\s+${fn}\\s*\\(|\\b${fn}\\s*\\(`).test(text));

  // ── 4) CSS 클래스 패턴 (신형 dd-wrap+page-btn+pagination-row vs 구형 pager+pg) ──
  findings.css = {
    hasPageBtn: /\.page-btn\s*\{/.test(text),
    hasPaginationRow: /\.pagination-row\s*\{/.test(text),
    hasLegacyPg: /\.pg\s*\{/.test(text) || /\.pg\.on\s*\{/.test(text),
    hasLegacyPager: /\.pager\s*\{/.test(text),
  };

  // ── 5) "전체"(전체 보기) 옵션 존재 여부 — 옵션배열을 실제 드롭다운 항목으로 변환하는 지점
  //        (PAGE_SIZE_OPTIONS.map(...) / PS_OPTIONS.map(...)) 바로 뒤 500자 안에 '전체' 리터럴이
  //        있는지만 본다. 파일 전체에서 느슨하게 찾으면 "전체 터널"·"총 건수" 같은 무관한 문구까지
  //        걸려 오탐이 난다 — 실제 옵션 생성 코드 범위로 좁혀야 정확하다.
  let hasAllOption = false;
  for (const m of text.matchAll(/(PAGE_SIZE_OPTIONS|PS_OPTIONS)\.map\(/g)) {
    const window = text.slice(m.index, Math.min(text.length, m.index + 500));
    if (/전체/.test(window)) { hasAllOption = true; break; }
  }
  findings.hasAllOption = hasAllOption;

  // ── 6) 기본 페이지 크기 추정 — 여러 알려진 선언 패턴을 순서대로 시도 ──
  const defaultSizeGuesses = [];
  for (const m of text.matchAll(/const\s+PS\s*=\s*(\d+)\s*;/g)) defaultSizeGuesses.push(`const PS=${m[1]}`);
  for (const m of text.matchAll(/(?:var|let)\s+size\s*=\s*(\d+)\s*;/g)) defaultSizeGuesses.push(`getPageState size=${m[1]}`);
  for (const m of text.matchAll(/return\s+(\d+)\s*;\s*\}\)\(\)/g)) defaultSizeGuesses.push(`IIFE return ${m[1]}`);
  for (const m of text.matchAll(/PAGE_DEFAULT_SIZE\s*=\s*\{([^}]*)\}/g)) defaultSizeGuesses.push(`PAGE_DEFAULT_SIZE={${m[1].trim()}}`);
  // corporate-card 스타일: let PS=(()=>{...localStorage.getItem("key")||"31"...return 31...})();
  // 페이지 크기와 무관한 다른 localStorage 기본값(예: 테마 설정)까지 걸리지 않도록 키 이름에
  // page/size/PS가 들어간 경우만 채택한다.
  for (const m of text.matchAll(/localStorage\.getItem\(\s*(['"])([^'"]*)\1\s*\)\s*\|\|\s*["'](\d+)["']/g)) {
    if (/page|size|ps/i.test(m[2])) defaultSizeGuesses.push(`localStorage fallback(${m[2]}) ${m[3]}`);
  }
  findings.defaultSizeGuesses = [...new Set(defaultSizeGuesses)];

  // ── 7) tbody id 전수 수집 + 직전 tbody와 현재 tbody 사이 HTML 구간에 페이지 크기 드롭다운
  //        마크업이 있는지로 페이지네이션 연결 여부 판정. 고정폭(N자) 대신 "바로 앞 tbody부터"로
  //        구간을 잡아야 한 앱 안에 tbody가 여러 개일 때 앞쪽 드롭다운이 뒤쪽 tbody까지 잘못
  //        "연결됨"으로 새는 것을 막는다(JS 변수명이 앱마다 달라도 이 HTML 근접 패턴은 공통).
  //        <style> 블록에도 ".page-size-wrap .dd-btn{...}" 같은 CSS 셀렉터 텍스트가 그대로 들어
  //        있어 첫 tbody의 검색 구간(0~해당 위치)에 CSS 블록이 포함되면 오탐이 난다 — </style> 이후
  //        (실제 body 마크업)부터만 스캔한다. ──
  const bodyScanStart = Math.max(0, text.lastIndexOf("</style>"));
  const tbodyMatches = [...text.matchAll(/<tbody\s+id="([\w-]+)"/g)].filter((m) => m.index >= bodyScanStart);
  let prevEnd = bodyScanStart;
  for (const m of tbodyMatches) {
    const tbodyId = m[1];
    const window = text.slice(prevEnd, m.index);
    prevEnd = m.index + m[0].length;
    const wired = /page-size-wrap|pageSizeDdBtn|pageSizeBtn_|psDdBtn|psDdWrap/.test(window);
    const key = `${fname}::${tbodyId}`;
    findings.tbodies.push({
      tbodyId,
      paginated: wired,
      knownBounded: KNOWN_BOUNDED.has(key),
    });
  }

  return findings;
}

function fmtOptionArrays(arrs) {
  if (!arrs.length) return "(없음)";
  return arrs.map((a) => `${a.varName}=[${a.values.join(",")}]`).join(", ");
}

function buildReport(allFindings) {
  const lines = [];
  lines.push("# work-portal 페이지네이션 감사 보고서");
  lines.push("");
  lines.push(`생성: pagination-audit.mjs (재실행 가능) · 대상 앱 ${allFindings.length}개`);
  lines.push("");
  lines.push("## 1. 앱별 페이지네이션 시스템 현황");
  lines.push("");
  lines.push("| 앱 | 옵션배열 | localStorage 키 | 함수명 | CSS | 전체옵션 |");
  lines.push("|---|---|---|---|---|---|");
  for (const f of allFindings) {
    const css = f.css.hasLegacyPg || f.css.hasLegacyPager ? "⚠️ 구형(.pg/.pager)" : (f.css.hasPageBtn ? "신형(.page-btn)" : "(없음)");
    lines.push(
      `| ${f.file} | ${fmtOptionArrays(f.optionArrays)} | ${f.localStorageKeys.join(", ") || "(없음)"} | ${f.functionsPresent.join(", ") || "(없음)"} | ${css} | ${f.hasAllOption ? "있음" : "⚠️ 없음"} |`
    );
  }
  lines.push("");

  lines.push("## 2. 앱별 기본 페이지 크기(추정)");
  lines.push("");
  for (const f of allFindings) {
    lines.push(`- **${f.file}**: ${f.defaultSizeGuesses.length ? f.defaultSizeGuesses.join(" / ") : "(자동 추출 실패 — 수동 확인 필요)"}`);
  }
  lines.push("");

  lines.push("## 3. tbody별 페이지네이션 연결 여부");
  lines.push("");
  let gapCount = 0;
  for (const f of allFindings) {
    if (!f.tbodies.length) continue;
    lines.push(`### ${f.file}`);
    for (const t of f.tbodies) {
      let mark;
      if (t.paginated) mark = "✅ 연결됨";
      else if (t.knownBounded) mark = "➖ 요약표(페이지네이션 불필요, 확인됨)";
      else { mark = "❌ 미연결 — 검토 필요"; gapCount++; }
      lines.push(`- \`${t.tbodyId}\`: ${mark}`);
    }
    lines.push("");
  }

  lines.push("## 4. 자동 감지된 불일치 요약");
  lines.push("");
  const legacyApps = allFindings.filter((f) => f.css.hasLegacyPg || f.css.hasLegacyPager).map((f) => f.file);
  const noAllOption = allFindings.filter((f) => f.optionArrays.length && !f.hasAllOption).map((f) => f.file);
  const optionSets = new Set(allFindings.filter((f) => f.optionArrays.length).map((f) => f.optionArrays.map((a) => a.values.join(",")).join("|")));
  lines.push(`- CSS 클래스가 다른 앱과 다름(구형 .pg/.pager): ${legacyApps.join(", ") || "없음"}`);
  lines.push(`- "전체" 옵션이 없는 앱: ${noAllOption.join(", ") || "없음"}`);
  lines.push(`- 서로 다른 옵션배열 조합 수: ${optionSets.size}종 (완전 통일이면 1이어야 함)`);
  lines.push(`- 미연결(검토 필요) tbody 총 ${gapCount}건`);
  lines.push("");

  return lines.join("\n");
}

const allFindings = APP_FILES.map(auditFile);
const report = buildReport(allFindings);
const outPath = join(__dirname, "pagination-audit-report.md");
writeFileSync(outPath, report, "utf8");
console.log(report);
console.log(`\n(저장됨: ${outPath})`);
