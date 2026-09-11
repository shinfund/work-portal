# work-portal 페이지네이션 감사 보고서

생성: pagination-audit.mjs (재실행 가능) · 대상 앱 11개

## 1. 앱별 페이지네이션 시스템 현황

| 앱 | 옵션배열 | localStorage 키 | 함수명 | CSS | 전체옵션 |
|---|---|---|---|---|---|
| announcement.html | PAGE_SIZE_OPTIONS=[10,15,20,30,50,100] | announcement_pageSize | buildPageSizeDd, togglePageSizeDd, renderPaginationRow, goToPage | 신형(.page-btn) | 있음 |
| asset-register-dogong.html | PAGE_SIZE_OPTIONS=[10,15,20,30,50,100] | assetRegisterDogong_pageSize | buildPageSizeDd, togglePageSizeDd, renderPaginationRow, goToPage | 신형(.page-btn) | 있음 |
| asset-register.html | PAGE_SIZE_OPTIONS=[10,15,20,30,50,100] | assetRegister_pageSize | buildPageSizeDd, togglePageSizeDd, renderPaginationRow, goToPage | 신형(.page-btn) | 있음 |
| corporate-card.html | PAGE_SIZE_OPTIONS=[10,15,20,30,31,50,100] | corpCard_pageSize | buildPageSizeDd, renderPaginationRow, goToPage, pickPageSize | 신형(.page-btn) | 있음 |
| defect-management.html | PAGE_SIZE_OPTIONS=[10,15,20,30,50,100] | defectMgmt_pageSize_, defectMgmt_pageSize_<dynamic> | buildPageSizeDd, togglePageSizeDd, renderPaginationRow, goToPage, getPageState, paginate | 신형(.page-btn) | 있음 |
| facility-status.html | PAGE_SIZE_OPTIONS=[10,15,20,30,50,100] | facilityStatus_pageSize | buildPageSizeDd, togglePageSizeDd, renderPaginationRow, goToPage | 신형(.page-btn) | 있음 |
| monthly-inspection-team.html | PAGE_SIZE_OPTIONS=[10,15,20,30,50,100] | mit_pageSize_, mit_pageSize_<dynamic> | buildPageSizeDd, renderTabPaginationRow, goToTabPage, getPageState, pickPageSize | 신형(.page-btn) | ⚠️ 없음 |
| monthly-inspection.html | PAGE_SIZE_OPTIONS=[10,15,20,30,50,100] | mi_pageSize_, mi_pageSize_<dynamic> | buildPageSizeDd, renderTabPaginationRow, goToTabPage, getPageState, pickPageSize | 신형(.page-btn) | ⚠️ 없음 |
| overtime-work.html | PAGE_SIZE_OPTIONS=[10,15,20,30,31,50,100] | overtimeWork_pageSize | buildPageSizeDd, togglePageSizeDd, renderPaginationRow, goToPage | 신형(.page-btn) | 있음 |
| solar-power.html | PAGE_SIZE_OPTIONS=[10,15,20,30,31,50,100] | solarPower_pageSize | buildPageSizeDd, togglePageSizeDd, renderPaginationRow, goToPage | 신형(.page-btn) | 있음 |
| vehicle-log.html | PAGE_SIZE_OPTIONS=[10,15,20,30,31,50,100] | vehicleLog_pageSize | buildPageSizeDd, togglePageSizeDd, renderPaginationRow, goToPage | 신형(.page-btn) | 있음 |

## 2. 앱별 기본 페이지 크기(추정)

- **announcement.html**: IIFE return 15
- **asset-register-dogong.html**: IIFE return 15
- **asset-register.html**: IIFE return 15
- **corporate-card.html**: IIFE return 31
- **defect-management.html**: getPageState size=15
- **facility-status.html**: IIFE return 15
- **monthly-inspection-team.html**: PAGE_DEFAULT_SIZE={elecinsp:15, photo:15, repair:15, photoMulti:15}
- **monthly-inspection.html**: PAGE_DEFAULT_SIZE={monthly:15, elec:15, transformer:15, generator:15, photo:15, power:15, task:15, photoMulti:15}
- **overtime-work.html**: IIFE return 31
- **solar-power.html**: IIFE return 31
- **vehicle-log.html**: IIFE return 31

## 3. tbody별 페이지네이션 연결 여부

### announcement.html
- `detailTableBody`: ✅ 연결됨

### asset-register-dogong.html
- `detailTableBody`: ✅ 연결됨
- `tunnelTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)
- `categoryTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)

### asset-register.html
- `detailTableBody`: ✅ 연결됨
- `tunnelTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)
- `categoryTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)

### corporate-card.html
- `dtTbody`: ✅ 연결됨
- `topTbody`: ➖ 요약표(페이지네이션 불필요, 확인됨)
- `accTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)
- `limTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)
- `monthlyTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)

### defect-management.html
- `listBody`: ✅ 연결됨
- `unprocBody`: ✅ 연결됨
- `contactBody`: ✅ 연결됨
- `mgmtBody`: ✅ 연결됨

### facility-status.html
- `detailTableBody`: ✅ 연결됨
- `tunnelTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)
- `bytunnelTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)
- `categoryTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)

### monthly-inspection-team.html
- `tbody-elecinsp`: ✅ 연결됨
- `tbody-repair`: ✅ 연결됨
- `tbody-photo`: ✅ 연결됨

### monthly-inspection.html
- `tbody-monthly`: ✅ 연결됨
- `tbody-elec`: ✅ 연결됨
- `tbody-transformer`: ✅ 연결됨
- `tbody-generator`: ✅ 연결됨
- `tbody-photo`: ✅ 연결됨
- `tbody-power`: ✅ 연결됨
- `tbody-task`: ✅ 연결됨

### overtime-work.html
- `empTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)
- `trendTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)
- `detailTableBody`: ✅ 연결됨

### solar-power.html
- `detailTableBody`: ✅ 연결됨
- `tunnelTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)
- `trendTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)

### vehicle-log.html
- `detailTableBody`: ✅ 연결됨
- `vehicleTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)
- `driverTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)
- `trendTableBody`: ➖ 요약표(페이지네이션 불필요, 확인됨)

## 4. 자동 감지된 불일치 요약

- CSS 클래스가 다른 앱과 다름(구형 .pg/.pager): 없음
- "전체" 옵션이 없는 앱: monthly-inspection-team.html, monthly-inspection.html
- 서로 다른 옵션배열 조합 수: 2종 (완전 통일이면 1이어야 함)
- 미연결(검토 필요) tbody 총 0건
