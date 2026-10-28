# Commerce Search Engine

가상 패션 상품으로 검색·색인·운영 관리 흐름을 재현하는 Elasticsearch 포트폴리오 프로젝트입니다. 상품 24개, 가상 브랜드 3개, 콘텐츠 3개, 회원 2명의 행동 예제를 포함합니다. 상품 번호·가격·판매 지표와 이미지는 모두 데모용으로 작성했습니다.

## 주요 기능

- Nori 한글 분석과 사용자 사전, 필드 가중치, 동의어·불용어 관리
- 전체색인 → 검증 → 별칭 전환, 변경 큐 기반 추가·삭제 색인
- 워커 중복 실행 방지, 작업 이력, 취소와 하트비트 감시
- 비즈니스 룰, 카테고리·가격 의도 분석, 정렬과 검색 시뮬레이터
- 가상 회원 행동을 이용한 개인화와 기본 키워드 검색 비교
- 선택 기능: 384차원 임베딩과 RRF 혼합 검색, 임베딩 해시 재사용

## 빠른 실행

Node.js 24 이상과 Docker Compose가 필요합니다. API는 호스트에서, Elasticsearch는 전용 Docker 프로젝트에서 실행합니다.

Windows에서 Docker가 WSL에만 설치되어 있다면 WSL의 저장소 경로에서 `docker compose up --build`를 실행한 터미널을 유지합니다. 나머지 npm 명령은 Windows에서 실행할 수 있습니다.

```powershell
npm ci
npm run demo:setup
docker compose up -d --build --wait
npm run demo:seed
npm run dev
```

관리자: http://127.0.0.1:3200/login

`demo:setup`은 `.env.local`에 로그인 비밀번호(`DEMO_ADMIN_PASSWORD`), 세션 및 개인화 서명 비밀키를 난수로 생성합니다. 비밀번호는 해당 파일에서 확인합니다. 재실행해도 기존 로컬 설정과 DB를 덮어쓰지 않습니다. 로컬 데모 로그인은 `localhost:3200` 또는 `127.0.0.1:3200`에서만 허용합니다.

Elasticsearch는 `127.0.0.1:19200`에 바인딩합니다. `demo:seed`는 클러스터 이름이 `commerce-search-demo`인 로컬 인스턴스에만 기록하며, 기존 인덱스와 관리자 설정은 유지합니다. `dev`와 `prd`는 모두 로컬 가상 데이터의 논리적 구분입니다. 예약 색인은 기본 비활성입니다.

```powershell
Invoke-RestMethod 'http://127.0.0.1:3200/api/v1/search?q=재킷&page=1&size=5'
```

## 변경 색인 체험

```powershell
npm run demo:changes
```

`DEMO0001`의 가격을 88,000원으로 바꾸고 `DEMO0002`를 판매 중지합니다. 관리자 대시보드에서 상품의 **추가색인**을 실행하면 변경 상품을 갱신하고 판매 중지 상품을 삭제합니다. 원본과 큐는 `.demo/catalog.sqlite`에 저장됩니다. 원본 DB 변경은 개발·운영 데모에 공통이며 각 별칭의 문서 반영은 해당 환경 작업을 실행한 뒤 이루어집니다.

## 구성과 검증

```text
fixtures → SQLite → 색인 워커 → Elasticsearch Bulk → 별칭 전환
                                      ↓
검색 API ← 검색 정책·개인화·정렬 ← 관리자 화면
```

```powershell
npm run test:demo
npm run lint
npx tsc --noEmit
npm run build
```

API와 전용 Elasticsearch를 실행한 상태에서 `npm run test:integration`으로 로그인·실제 검색·개인화·분리 워커의 추가색인과 전체색인을 검증합니다. 이 검증은 가상 상품 2개를 변경한 뒤 원본과 상품 24개를 복원합니다.

상품 필드명은 검색 API와 관리자 기능의 계약을 유지합니다. 원본 테이블은 `DEMO_PRODUCTS`, `DEMO_SYNC_QUEUE`, `DEMO_PRODUCT_DESCRIPTIONS`, `DEMO_CONTENTS`입니다. SQL은 SQLite 문법을 사용합니다. DB·환경 파일·실행 결과는 Git에서 제외됩니다.

## 선택 기능과 범위

기본 실행은 외부 AI 호출 없이 키워드 검색을 수행합니다. 실제 `intfloat/multilingual-e5-small` 임베딩 서버를 별도로 실행한 뒤 `.env.local`의 `EMBEDDING_NODE`와 `SEMANTIC_SEARCH_ENABLED=true`를 설정하고, 관리자에서 임베딩 필드를 구성하고 벡터화를 실행하면 혼합 검색을 사용할 수 있습니다. 가짜 벡터는 생성하지 않습니다. Gemini 확장은 별도 API 키와 관리자 설정이 필요합니다.

이 저장소는 가상 데이터 데모이며 운영 성능 개선 수치를 제시하지 않습니다. 검색 비교의 기준은 같은 데이터에 대한 기본 `multi_match` 검색입니다. 공개 호스팅 시 로컬 데모 인증을 끄고 Google OAuth·허용 도메인·HTTPS를 설정해야 합니다.

- [실행과 검증 시나리오](docs/DEMO.md)
- [구조와 실행 계약](docs/SEARCH_ELK_HANDOFF.md)
- [개인화 예제](docs/PERSONALIZATION_SEARCH.md)
