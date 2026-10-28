# 검색 실험 API

`POST /api/v1/lab/search`로 검색 진단 결과를 조회합니다. 별도 클라이언트에서 사용하려면 `.env.local`의 `SEARCH_LAB_API_KEY`를 난수로 설정하고 `Authorization: Bearer <키>` 헤더에 전달합니다. 기본값은 비어 있으며 공개 검색은 `/api/v1/search`, 관리자 실험은 `/admin/search-weight-tuning`에서 수행합니다.

외부 CMS나 회사 서비스는 필요하지 않습니다. 대상은 로컬 가상 상품 인덱스입니다.
