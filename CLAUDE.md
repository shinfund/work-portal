# work-portal (통합업무포털)

정적 HTML로 만든 사내 업무포털. `index.html`이 셸(사이드바/헤더)이고, 각 업무 앱은 독립 실행도 가능한 단일 HTML 파일이며 `index.html`에서 iframe으로 불러온다.

- `index.html` — 포털 셸 (사이드바, 모바일 상단 메뉴, 탭 관리)
- `announcement.html` — 공지사항
- `asset-register.html` — 비품대장
- `defect-management.html` — 하자보수현황
- `monthly-inspection.html` — 월간점검결과-안전관리
- `monthly-inspection-team.html` — 월간점검결과-점검팀
- `overtime-work.html` — 연장근무
- `corporate-card.html` — 법인카드 (관리자모드 전용, index.html 사이드바에서 잠금 게이트)
- `solar-power.html` — 태양광발전량
- `vehicle-log.html` — 차량운행일지

## 배포 (중요)

실제 서비스 주소는 Cloudflare Pages: **https://work-portal-4z9.pages.dev/**

Cloudflare Pages는 **`main` 브랜치를 push할 때만 자동 배포**된다. 별도 브랜치에만 커밋·푸시해서는 배포에 반영되지 않는다.

**따라서 사용자가 "배포해줘", "worker에도 반영해줘", "적용 안 됐는데" 라고 하면:**
1. 작업 브랜치의 변경사항을 `main`으로 병합 (가능하면 fast-forward: `git checkout main && git pull origin main && git merge --ff-only <작업브랜치>`)
2. `git push origin main`
3. 다시 작업 브랜치로 `git checkout <작업브랜치>` (세션 지침상 브랜치별 작업 규칙을 지키기 위함)

main은 프로덕션에 직결되는 공유 브랜치이므로, 병합 전에 사용자에게 확인받는다 (이미 이런 흐름으로 진행하기로 합의된 경우가 많음 — 그래도 매번 명시적으로 언급하고 진행).

### 라이브 확인 시 `curl` 필수 규칙 (반복 실수 이력 있음 — 2026-07-11, 2026-08-05, 2026-08-07 총 3회)

`work-portal-4z9.pages.dev`의 `*.html` URL은 Cloudflare Pages가 확장자 없는 경로로 **308 리다이렉트**한다
(예: `/corporate-card.html` → `/corporate-card`). `curl`에 `-L`이 없으면 빈 응답(size 0)만 받고 이를
"배포 안 됨"으로 오판하게 된다 — 실제로는 이미 정상 배포된 상태를 몇 분씩 "배포 지연"으로 잘못 진단한
사례가 세 번 반복됐다.

**규칙: 이 도메인을 대상으로 하는 `curl` 명령은 일회성 확인이든 `Monitor`/`Bash`의 폴링·until 루프든
예외 없이 항상 `curl -sL`(최소 `-L`)을 쓴다.** 특히 Monitor 폴링 스크립트처럼 반복 실행되는 curl은
작성 직후 `-L` 유무를 한 번 더 눈으로 확인한다. grep이 매치되지 않을 때 "아직 배포 안 됨"이라고
바로 결론 내리지 말고, "curl이 리다이렉트를 못 따라가서 빈 응답을 받았을 가능성"부터 먼저 배제할 것.

## 백엔드

Notion DB + Cloudflare Worker(`notion-proxy.shinfund.workers.dev`) 연동. 로그인은 공용 비밀번호 방식이며 로그인 상태는 기기별 localStorage에 저장(`wp_authToken`).

## 모바일 최적화 체크포인트

각 업무 앱 HTML은 자체 `@media` 반응형 규칙을 갖고 있어야 하며, 다음은 자주 나오는 실수이니 새 기능 추가 시 확인:
- input/select 폰트 16px 미만 → iOS Safari 자동 확대(줌) 유발
- 토스트/알림 문구가 `white-space:nowrap`이면 좁은 화면에서 잘림
- 넓은 테이블은 `overflow-x:auto` 컨테이너로 감싸거나 저우선순위 열을 좁은 화면에서 숨김
- 모달은 `max-height` + `overflow-y:auto`로 내부 스크롤 되게
