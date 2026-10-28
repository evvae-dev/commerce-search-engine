# 저장소 작업 지침

## 프로젝트

가상 상품을 사용하는 개인 포트폴리오입니다. 운영 서버·회사 시스템·실제 고객 데이터에 연결하지 않습니다. 구조와 실행 계약은 `docs/SEARCH_ELK_HANDOFF.md`, 실행 절차는 `docs/DEMO.md`를 읽습니다.

## 구조와 명령어

- `pages/api/v1/`: Next.js Pages Router API, `NextApiRequest`·`NextApiResponse` 타입 사용
- `service/`: 검색 및 관리자 로직, `constant/`: 인덱스와 상수
- `fixtures/`: 가상 데이터, `scripts/`: SQLite 원본·색인 워커·초기화
- `npm run dev`: 로컬 3200 포트, `npm run demo:setup`: 로컬 환경과 DB 생성
- `npm run demo:seed`: 전용 Elasticsearch에 예제 색인
- `npm run test:demo`, `npm run lint`, `npx tsc --noEmit`, `npm run build`: 검증

## 작성 규칙

기존 2칸 들여쓰기와 single quote를 따릅니다. Markdown과 Git 커밋 메시지는 한글로 작성합니다. 실제 인증정보, 데이터, 운영 문서, 내부 주소를 추가하지 않습니다. `.env.local`, `.demo`, `node_modules`, `.next`는 커밋하지 않습니다.

<!-- BEGIN:nextjs-agent-rules -->

## Next.js 버전 확인

이 프로젝트는 Next.js 16을 사용합니다. 코드를 변경하기 전에 관련 가이드를 `node_modules/next/dist/docs/`에서 읽고 현재 버전의 API와 폐기 예정 항목을 확인합니다.

<!-- END:nextjs-agent-rules -->
