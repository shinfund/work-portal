# work-portal (통합업무포털)

정적 HTML로 만든 사내 업무포털. `index.html`이 셸(사이드바/헤더)이고, 각 업무 앱은 독립 실행도 가능한 단일 HTML 파일이며 `index.html`에서 iframe으로 불러온다.

- `index.html` — 포털 셸 (사이드바, 모바일 상단 메뉴, 탭 관리)
- `asset-register.html` — 비품대장
- `defect-management.html` — 하자보수현황
- `monthly-inspection.html` — 월간점검결과-안전관리
- `overtime-work.html` — 연장근무
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

## 백엔드

Notion DB + Cloudflare Worker(`notion-proxy.shinfund.workers.dev`) 연동. 로그인은 공용 비밀번호 방식이며 로그인 상태는 기기별 localStorage에 저장(`wp_authToken`).

## 모바일 최적화 체크포인트

각 업무 앱 HTML은 자체 `@media` 반응형 규칙을 갖고 있어야 하며, 다음은 자주 나오는 실수이니 새 기능 추가 시 확인:
- input/select 폰트 16px 미만 → iOS Safari 자동 확대(줌) 유발
- 토스트/알림 문구가 `white-space:nowrap`이면 좁은 화면에서 잘림
- 넓은 테이블은 `overflow-x:auto` 컨테이너로 감싸거나 저우선순위 열을 좁은 화면에서 숨김
- 모달은 `max-height` + `overflow-y:auto`로 내부 스크롤 되게
