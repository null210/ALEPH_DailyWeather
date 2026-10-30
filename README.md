# 서울 기온 진짜 정보판 (T04)

비개인 공개 원천인 **Open-Meteo 서울 기온(°C)**을 하루 한 번 실제로 조회해 저장하고, 저장값을 그대로 보여주는 정적 웹앱입니다. 지표 이름은 `signal_id: seoul-temperature-2m`입니다.
데이터가 늦거나 틀릴 때도 마지막 정상값을 지우지 않고, `freshness / error_code`로 지금 상태를 정직하게 표시합니다.

- **실제 조회**: GitHub Actions(`scripts/collect.mjs`)가 서버 쪽에서 원천을 호출하고, 결과를 `data/live-state.json`에 커밋합니다. 브라우저는 외부 API를 직접 부르지 않고 저장값만 읽으므로, 화면값과 저장값이 항상 같습니다.
- **합성 재생**: 공개 fixture 9개(contract 1.1.0)를 원본 그대로 `fixtures/`에 두고 재생합니다. sha256은 asset-manifest와 일치합니다.
- **비밀키**: 없습니다. 원천이 키를 요구하지 않습니다.

## 배포 (계정 없이 열리는 URL 만들기)
1. GitHub에 **공개(Public)** 저장소를 만들고 이 폴더 내용을 그대로 올립니다. `.github` 폴더도 포함해야 합니다.
2. Settings → Pages → `Deploy from a branch` → `main` / `(root)`로 설정합니다. 결과물 URL은 `https://<계정>.github.io/<저장소>/`입니다.
3. Settings → Actions → General → Workflow permissions를 **Read and write permissions**로 설정합니다.
4. Actions → `collect-live` → **Run workflow**를 누르면 오늘(1일차) 실제 기록이 생깁니다.
5. 다음 날 09:07 KST에 자동 실행되면 2일차 기록이 생깁니다. 실제 날짜 2건이 모이면 수집기는 새 날짜 행을 더 만들지 않습니다(`LIVE_MAX_DATES=2`). 그래야 제출한 두 기록과 화면이 계속 일치합니다.

### 과정영수증(t04_day) 남기는 시점
영수증은 **그날 수집이 끝난 뒤** 화면에 보이는 값으로 남기세요. 같은 날 수집을 다시 실행하면 그 날짜 행이 새 값으로 갱신되어 이미 남긴 영수증과 달라질 수 있습니다.

### 소스 URL (C35)
커밋 SHA가 들어간 주소를 제출합니다. 예: `https://github.com/<계정>/<저장소>/tree/<40자리 커밋 SHA>`
SHA는 저장소 첫 화면의 커밋 링크, 또는 `git rev-parse HEAD`로 확인합니다. 2일차 수집 커밋 이후의 SHA를 쓰면 두 기록이 모두 들어간 상태가 됩니다.

### 개인정보 (C25)
Git 커밋에 본인 이메일이 남지 않도록, GitHub Settings → Emails에서 **Keep my email addresses private**를 켜고 noreply 주소로 커밋하세요.

## 확인 방법
- 실제 화면: 결과물 URL (`#live`)
- 합성 재생: 결과물 URL 뒤에 `#replay`
- 자동 확인용 함수: `T04.reset()`, `T04.run("T04-TIMEOUT")`, `T04.runSequence([...])`, `T04.retry()`, `T04.state()`
- 로컬 검사: `node scripts/selftest.mjs` (공식 expected와 C19 전이표 대조)
- 로컬 실행: `python3 -m http.server` 후 `http://localhost:8000/` (파일을 더블클릭해서 열면 동작하지 않습니다)

## 구조
| 파일 | 역할 |
|---|---|
| `lib/core.js` | 정규화 검증, 같은 날짜 갱신·다음 날짜 새 행 저장, 실패 상태, 전일 대비 계산, 재계산 대조 |
| `lib/adapters.js` | live(Open-Meteo → normalized reading)와 replay(fixture)가 같은 저장 함수를 호출 |
| `app.js`, `index.html` | 실제 조회 화면과 합성 재생 화면 |
| `scripts/collect.mjs` | Actions 수집기 |
| `scripts/selftest.mjs` | 공식 fixture 시퀀스 검사 |
| `fixtures/` | 공개 fixture 원본 9개와 manifest |
| `data/live-state.json` | 실제 조회 저장소(일별 행, 마지막 정상값, 상태) |

## 실패별 표시와 다음 행동
| error_code | fixture | 다음 행동 |
|---|---|---|
| `timeout` | T04-TIMEOUT | 잠시 뒤 다시 시도 |
| `auth` | T04-AUTH-401 | 다시 시도로는 대개 해결되지 않음, 원천 정책 확인 |
| `rate_limit` | T04-RATE-429 | Retry-After가 지난 뒤 다시 시도 |
| `offline` | T04-OFFLINE | 연결 확인 후 다시 시도 |
| `schema_error` | T04-SCHEMA-BREAK | 앱 해석 코드 수정 필요, 관리자에게 알림 |
