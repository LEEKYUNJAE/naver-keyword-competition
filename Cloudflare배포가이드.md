# Cloudflare Pages 배포 가이드

## 1. Cloudflare 대시보드 → Pages 새 프로젝트

1. [https://dash.cloudflare.com/](https://dash.cloudflare.com/) 접속
2. 왼쪽 메뉴 **Workers & Pages** → **Create application** → **Pages** 탭 → **Connect to Git**
3. GitHub 저장소 연결: `LEEKYUNJAE/naver-keyword-competition`
4. 프로젝트 이름 정하기 (예: `naver-keyword-competition`)

## 2. 빌드 설정

| 항목 | 값 |
|---|---|
| **Production branch** | `main` |
| **Framework preset** | None |
| **Build command** | (비워두기) |
| **Build output directory** | `/` (또는 비워두기) |
| **Root directory** | `/` |

> 정적 사이트 + Pages Functions 구조라 빌드 단계 불필요. `functions/` 폴더는 Cloudflare가 자동 인식.

## 3. 환경 변수 등록 (필수)

배포 후 **Settings → Environment variables → Production**에 추가:

| 변수명 | 설명 |
|---|---|
| `NAVER_AD_API_KEY` | 네이버 검색광고 API 액세스 라이선스 |
| `NAVER_AD_SECRET_KEY` | 네이버 검색광고 비밀키 |
| `NAVER_AD_CUSTOMER_ID` | 검색광고 CUSTOMER_ID |
| `NAVER_SEARCH_CLIENT_ID` | 네이버 개발자센터 검색 API Client ID |
| `NAVER_SEARCH_CLIENT_SECRET` | 네이버 개발자센터 검색 API Client Secret |

**중요:** 환경변수 추가 후 **Deployments** 탭에서 **Retry deployment**로 재배포해야 적용됨.

## 4. 라우팅 자동 인식

- `index.html` → `/` 또는 `/index.html`
- `functions/api/naver-api.js` → `/api/naver-api`
- `functions/api/blog-check.js` → `/api/blog-check`

프론트엔드는 `/api/naver-api`, `/api/blog-check`로 fetch하도록 이미 설정됨.

## 5. 무료 플랜 한도 주의

| 항목 | 무료 | Workers Paid ($5/월) |
|---|---|---|
| 일일 요청 | 100,000 | 1천만 (포함) + 추가 과금 |
| CPU 시간/요청 | **10ms** | **30s** |
| Wall time | 30s | 30s |

**10ms CPU 한도는 빠듯할 수 있음.** I/O 대기는 안 카운트되나, 정규식·HMAC·JSON 파싱 등 연산이 누적되면 초과 가능. 키워드 10개 분석 시 timeout 발생하면 **Workers Paid 업그레이드** 권장.

## 6. 배포 후 확인

배포 완료되면 `https://naver-keyword-competition.pages.dev/` 같은 URL이 발급됨. 접속 후:

1. 키워드 1~2개 입력 → 경쟁도 분석 실행 → 결과 정상 표시 확인
2. 내 블로그 진단 → 키워드 순위 확인 → 본인 블로그 ID 입력 → 결과 확인
3. 콘솔(F12)에 에러 없는지 확인

## 7. Vercel 정리 (선택)

Cloudflare 정상 동작 확인 후 Vercel 배포 비활성화 가능:
- Vercel 대시보드 → 프로젝트 → Settings → 일시정지 또는 삭제
- 로컬에서 `api/`, `vercel.json`, `netlify/`, `netlify.toml` 폴더/파일 삭제 (Cloudflare에는 영향 없음)

## 8. 문제 발생 시

- **500 에러 + "API 키가 설정되지 않았습니다"**: 환경변수 누락 또는 재배포 안 됨. Settings 확인 후 Retry deployment.
- **Timeout 오류**: 무료 플랜 10ms CPU 초과. Workers Paid 업그레이드 또는 키워드 수 줄이기.
- **CORS 에러**: 같은 도메인이면 발생 안 함. 다른 도메인에서 호출 시 발생 — `corsHeaders`는 이미 `*` 설정됨.
- **search.naver.com 스크래핑 실패**: User-Agent 차단 가능성. 빈 결과 반환되어도 분석은 동작.
