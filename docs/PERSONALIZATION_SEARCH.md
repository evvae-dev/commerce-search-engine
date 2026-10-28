# 가상 회원 개인화

가상 회원 `1001`은 재킷·슬랙스·코트, `1002`는 원피스·블라우스·스커트에 대한 행동을 가집니다. 원본은 `fixtures/events.json`입니다. 이름·연락처·실제 회원 식별자는 저장하지 않습니다.

초기화 명령은 같은 로컬 Elasticsearch의 `demo-events-cart`, `demo-events-recent`, `demo-events-wish`, `demo-events-order`에 이벤트를 기록합니다. 기간과 출처별 가중치, 상품·브랜드·카테고리 비중, 최대 보정률과 캐시는 관리자에서 설정합니다. 기본은 비활성입니다.

공개 API의 개인화 요청은 `X-Demo-Member-No`, `X-Demo-Timestamp`, `X-Demo-Signature` 헤더를 사용합니다. `회원번호.timestamp` 문자열에 `.env.local`의 `PERSONALIZATION_CONTEXT_SECRET`로 HMAC-SHA256 서명을 만들며 기본 유효 시간은 5분입니다. 헤더가 모두 없으면 익명 검색입니다. 일부만 있거나 서명이 유효하지 않으면 401을 반환합니다.

관리자 시뮬레이터의 회원 입력은 인증된 관리자 세션에서만 사용할 수 있습니다. 검색 결과의 출처별 점수로 가상 행동이 어떤 상품의 점수를 보정했는지 확인할 수 있습니다.
