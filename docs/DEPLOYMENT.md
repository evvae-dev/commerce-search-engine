# 로컬 실행 환경

Docker Compose 프로젝트 이름은 `commerce-search-demo`입니다. Elasticsearch 9.5.1 이미지에 `analysis-nori` 플러그인을 설치합니다. API는 Node.js 24 이상으로 호스트에서 실행합니다.

- Elasticsearch: `127.0.0.1:19200`
- API·관리자: `127.0.0.1:3200`
- SQLite: `.demo/catalog.sqlite`

`docker compose up -d --build --wait` 후 `npm run demo:seed`를 실행합니다. Elasticsearch 인증을 끈 구성은 루프백에만 바인딩합니다. 공개 배포에는 별도 HTTPS, Elasticsearch 인증 및 접근 제한을 구성해야 합니다.

`.env.production.example`은 별도 배포 시 사용할 빈 설정 틀입니다. 데모 인증은 비활성 상태이며 Google OAuth와 허용 도메인을 직접 설정해야 합니다. 기존 서버, 사내 CI/CD, SSH 배포 구성은 포함하지 않습니다.
