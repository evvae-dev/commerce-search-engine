import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import Head from '../../../components/admin/admin-page-head';
import AdminLayout from '../../../components/layout/admin-layout';
import { getAdminPageSession } from '../../../service/admin-auth';
import styles from './search-tuning-guide.module.css';

export const getServerSideProps: GetServerSideProps<{ email: string }> = async (context) => {
  const admin = await getAdminPageSession(context);
  return admin
    ? { props: { email: admin.email } }
    : { redirect: { destination: '/login', permanent: false } };
};

const contents = [
  ['choose-menu', '어떤 메뉴를 사용해야 하나요?'],
  ['workflow', '공통 작업 절차'],
  ['jigott-boost', '가중치·페널티 주기'],
  ['business-look', '동의어·유의어 만들기'],
  ['popularity', '인기도 변경하기'],
  ['personalization', '개인화 검색 설정하기'],
  ['field-boost', '검색 필드 가중치 조정'],
  ['pin-product', '특정 상품 순위 고정'],
  ['filter', '검색필터 설정'],
  ['other-settings', '그 밖의 튜닝 설정'],
  ['verify', '검증과 되돌리기'],
] as const;

function MenuLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className={styles.menuLink}>{children}<span aria-hidden="true">↗</span></Link>;
}

function TopLink() {
  return <a href="#guide-top" className={styles.topLink}>목차로 이동 ↑</a>;
}

function OperationsGuide() {
  return <>
    <nav className={styles.contents} aria-label="검색엔진 운영설정 가이드 목차">
      <strong>운영설정 목차</strong>
      <ol>
        <li><a href="#search-flow">검색 요청이 결과로 만들어지는 과정</a></li>
        <li><a href="#index-management">인덱스와 알리아스</a></li>
        <li><a href="#index-template">인덱스 템플릿</a></li>
        <li><a href="#embedding-management">임베딩과 벡터 검색</a></li>
        <li><a href="#sort-operations">검색정렬</a></li>
        <li><a href="#indexing-operations">전체색인과 추가색인</a></li>
        <li><a href="#operations-checklist">개발관리자 운영 점검표</a></li>
      </ol>
    </nav>

    <section id="search-flow" className={styles.section}>
      <h2>검색 요청이 결과로 만들어지는 과정</h2>
      <p>공개 검색 API와 관리자 시뮬레이터는 같은 핵심 검색 로직을 사용합니다. 관리자 화면은 점수와 적용 근거를 추가로 보여주고, 공개 API는 상품과 페이징 정보만 반환합니다.</p>
      <div className={styles.flow}>
        <div><b>1</b><strong>요청 수신</strong><span>검색어·페이지·개수·정렬과 대상 인덱스를 확인합니다.</span></div>
        <div><b>2</b><strong>설정 조회</strong><span>랭킹, AI, 개인화, 비즈니스 룰, 동의어, 단어 정책, 필터와 요청 표현을 한 번에 조회합니다.</span></div>
        <div><b>3</b><strong>검색어 전처리</strong><span>금지어 검사 → 요청 표현 제거 → 가격·필드 필터 감지 → 형태소 분석 → 불용어 제거 → 동의어 확장 순으로 처리합니다.</span></div>
        <div><b>4</b><strong>의도 판정</strong><span>브랜드·카테고리를 감지하고 남은 검색어와 설정에 따라 키워드·AI·벡터 검색 사용 여부를 정합니다.</span></div>
        <div><b>5</b><strong>후보 검색</strong><span>키워드 검색과 벡터 검색을 수행하며 동일한 필수 필터를 양쪽에 적용합니다.</span></div>
        <div><b>6</b><strong>순위 결합</strong><span>키워드·벡터 순위를 RRF로 결합한 뒤 인기도, 개인화, 비즈니스 룰과 카테고리 보정을 적용합니다.</span></div>
        <div><b>7</b><strong>정렬·고정</strong><span>사용자 정렬을 적용하고 키워드별 고정 상품을 필터 조건 안에서 지정 위치에 넣습니다.</span></div>
        <div><b>8</b><strong>최종 응답</strong><span>최종 페이지의 상품 문서를 읽고 공개 응답 또는 관리자 진단 결과를 만듭니다.</span></div>
      </div>
      <div className={styles.callout}><strong>설정 캐시</strong><p>검색 설정은 프로세스 내부 캐시에 저장됩니다. 관리자에서 랭킹·비즈니스 룰·동의어·단어 정책·요청 표현·검색필터를 변경하면 관련 캐시를 즉시 무효화합니다. 관리자 시뮬레이터는 미저장 초안을 시험하기 위해 설정 캐시를 우회합니다.</p></div>
      <TopLink />
    </section>

    <section id="index-management" className={styles.section}>
      <h2>인덱스와 알리아스</h2>
      <p><MenuLink href="/admin/indexing">인덱스</MenuLink> 메뉴에서 개발·운영 인덱스의 원본 SQL, 색인 일정, 문서 ID, 템플릿과 작업 이력을 관리합니다.</p>
      <div className={styles.tableWrap}><table><thead><tr><th>개념</th><th>역할</th><th>개발관리자가 알아야 할 점</th></tr></thead><tbody>
        <tr><td>기준 인덱스</td><td><code>dev-goods</code>, <code>prd-goods</code>처럼 애플리케이션이 조회하는 이름입니다.</td><td>일반 검색 코드는 날짜형 물리 인덱스 이름을 직접 사용하지 않고 알리아스를 조회해야 합니다.</td></tr>
        <tr><td>물리 인덱스</td><td><code>prd-goods-yyyyMMddHHmm</code> 형식으로 전체색인마다 새로 생성됩니다.</td><td>DB 수집·ES 저장·임베딩이 모두 성공하기 전에는 검색 트래픽을 받지 않습니다.</td></tr>
        <tr><td>알리아스</td><td>현재 서비스할 물리 인덱스를 가리키는 논리 이름입니다.</td><td>전체색인 성공 후 원자적으로 새 인덱스로 전환되며 실패하면 기존 대상을 유지합니다.</td></tr>
        <tr><td>문서 ID</td><td>같은 상품을 추가색인할 때 갱신할 기준 키입니다.</td><td>잘못 지정하면 중복 문서나 덮어쓰기가 발생할 수 있으므로 원본 SQL의 고유성을 확인해야 합니다.</td></tr>
      </tbody></table></div>
      <h3>설정 변경 시 확인할 것</h3>
      <ul><li>원본 SQL은 `SELECT` 또는 `WITH` 기반 읽기 전용이어야 합니다.</li><li>운영 SQL 변경은 좁은 상품 ID로 먼저 실행 결과와 문서 ID 중복 여부를 확인합니다.</li><li>화면 문서 수는 와일드카드 전체 합계가 아니라 현재 알리아스 대상 인덱스를 기준으로 판단합니다.</li><li>전체색인 완료 후 현재 인덱스와 최신 과거 인덱스 2개만 유지하며, 이름 규칙에 맞지 않는 테스트 인덱스는 자동 삭제 대상이 아닙니다.</li></ul>
      <TopLink />
    </section>

    <section id="index-template" className={styles.section}>
      <h2>인덱스 템플릿</h2>
      <p>인덱스 템플릿은 새 물리 인덱스의 필드 타입, 분석기, Nori 설정과 벡터 필드 구조를 결정합니다. <MenuLink href="/admin/indexing">인덱스</MenuLink> 설정에서 대상 템플릿을 관리합니다.</p>
      <div className={styles.cards}>
        <article><h3>매핑</h3><p><code>text</code>, <code>keyword</code>, 숫자, 날짜, 벡터 타입을 정의합니다. 검색·정렬·필터에서 사용할 방식과 일치해야 합니다.</p></article>
        <article><h3>분석기</h3><p>상품명 등 한국어 텍스트의 Nori 토큰화와 사용자 사전을 결정합니다. 분석기 변경은 기존 문서에 소급되지 않습니다.</p></article>
        <article><h3>벡터 필드</h3><p><code>goods_vector</code>는 현재 임베딩 모델의 차원과 매핑이 정확히 맞아야 합니다.</p></article>
        <article><h3>검증</h3><p>저장 전에 JSON 문법뿐 아니라 Elasticsearch template simulate와 실제 참조 필드를 확인합니다.</p></article>
      </div>
      <div className={`${styles.callout} ${styles.warning}`}><strong>재색인 필요</strong><p>매핑, 분석기, Nori 사용자 사전처럼 인덱스 생성 시 확정되는 설정은 저장만으로 현재 인덱스에 반영되지 않습니다. 전체색인으로 새 물리 인덱스를 만들고 알리아스를 전환해야 합니다.</p></div>
      <TopLink />
    </section>

    <section id="embedding-management" className={styles.section}>
      <h2>임베딩과 벡터 검색</h2>
      <p><MenuLink href="/admin/embedding">임베딩</MenuLink> 메뉴에서는 어떤 원본 필드를 어떤 이름으로 묶어 의미 검색 문장을 만들지 설정합니다.</p>
      <div className={styles.codeExample}><code>브랜드명: 모던리프 MODERN LEAF<br />상품명: 테일러드 재킷<br />카테고리: 패션 &gt; 아우터 &gt; 재킷</code></div>
      <h3>처리 원리</h3>
      <ol><li>설정된 항목 순서대로 `항목명: 값` 문장을 조립합니다.</li><li>임베딩 서버가 문장을 384차원 벡터로 변환합니다.</li><li>문서에 벡터, 모델 버전과 문장 해시를 저장합니다.</li><li>검색어도 같은 모델로 벡터화하고 가까운 상품을 후보로 조회합니다.</li></ol>
      <h3>변경과 재생성</h3>
      <ul><li>항목이나 원본 필드가 바뀌면 조립 문장 해시가 달라집니다.</li><li>전체색인은 모델 버전·해시·벡터 차원이 모두 같으면 기존 벡터를 재사용합니다.</li><li>추가색인은 문장 해시가 같으면 임베딩 생성을 건너뛰고 기존 벡터를 보존합니다.</li><li>의미 구성이 크게 바뀌면 임베딩 메뉴의 전체 재생성 또는 다음 전체색인으로 전체 문서를 갱신합니다.</li></ul>
      <div className={styles.callout}><strong>성능 주의</strong><p>임베딩은 전체색인에서 가장 오래 걸릴 수 있는 단계입니다. 처리량을 높이려고 배치와 동시 요청을 과도하게 올리면 CPU 포화와 요청 대기가 증가하므로 단계별 시간, 신규 생성·재사용 건수와 임베딩 서버 자원을 함께 확인합니다.</p></div>
      <TopLink />
    </section>

    <section id="sort-operations" className={styles.section}>
      <h2>검색정렬</h2>
      <p><MenuLink href="/admin/sort-management">검색정렬</MenuLink> 메뉴는 기본 관련도 외에 가격순·신상품순 등 사용자가 선택할 정렬을 관리합니다.</p>
      <div className={styles.tableWrap}><table><thead><tr><th>항목</th><th>설명</th></tr></thead><tbody>
        <tr><td>적용 인덱스</td><td>정렬을 사용할 개발 또는 운영 인덱스입니다.</td></tr><tr><td>정렬명·설명</td><td>화면과 API에서 구분할 운영 명칭입니다.</td></tr><tr><td>sort JSON</td><td>Elasticsearch sort 배열이며 필드, 방향과 필요한 옵션을 정의합니다.</td></tr>
      </tbody></table></div>
      <div className={styles.codeExample}><code>{`[{ "sale_amt": "asc" }]`}</code></div>
      <ul><li>저장 시 JSON 문법, 참조 필드와 Elasticsearch 실행 가능 여부를 검증합니다.</li><li>정렬 필드는 현재 인덱스 매핑에서 정렬 가능한 타입이어야 합니다. 분석된 <code>text</code> 필드는 그대로 정렬할 수 없습니다.</li><li>사용자 정렬 뒤에는 <code>_score</code> 내림차순이 자동으로 붙어 같은 값의 순서를 보정합니다.</li><li>필드를 추가하거나 타입을 바꾸는 정렬은 템플릿과 전체색인이 먼저 필요할 수 있습니다.</li></ul>
      <TopLink />
    </section>

    <section id="indexing-operations" className={styles.section}>
      <h2>전체색인과 추가색인</h2>
      <p><MenuLink href="/admin/indexing">인덱스</MenuLink> 메뉴에서 작업을 실행하고 진행 단계와 이력을 확인합니다.</p>
      <div className={styles.tableWrap}><table><thead><tr><th>구분</th><th>전체색인</th><th>추가색인</th></tr></thead><tbody>
        <tr><td>목적</td><td>DB 전체를 새 물리 인덱스로 다시 구성</td><td>변경 대기 큐의 상품만 추가·갱신·삭제</td></tr>
        <tr><td>알리아스</td><td>모든 단계 성공 후 새 인덱스로 전환</td><td>현재 알리아스 대상 문서를 직접 갱신</td></tr>
        <tr><td>임베딩</td><td>기존 벡터 재사용 또는 신규 생성</td><td>변경 문장만 생성하고 삭제는 실행하지 않음</td></tr>
        <tr><td>기본 제한 시간</td><td>2시간</td><td>30분</td></tr>
        <tr><td>실패 시</td><td>기존 알리아스 유지</td><td>큐를 재시도 가능한 상태로 되돌리고 삭제 단계 중단</td></tr>
      </tbody></table></div>
      <h3>작업 단계</h3><div className={styles.chips}><span>SQLite 연결·SQL</span><span>SQLite 행 스트리밍</span><span>Elasticsearch Bulk</span><span>임베딩</span><span>알리아스 변경</span></div>
      <ul><li>같은 인덱스의 작업은 잠금과 슬롯으로 중복 실행을 막습니다.</li><li>대기·실행 작업은 하트비트와 watchdog으로 고아 작업을 감지합니다.</li><li>강제중지 전에 이미 저장된 Bulk 결과는 되돌리지 않습니다.</li><li>SQL 처리 건수와 ES 문서 수가 다르면 동일 문서 ID 덮어쓰기를 확인합니다.</li></ul>
      <TopLink />
    </section>

    <section id="operations-checklist" className={styles.section}>
      <h2>개발관리자 운영 점검표</h2>
      <div className={styles.checklist}>
        <label><input type="checkbox" disabled /> 변경 대상이 개발인지 운영인지 확인했다.</label>
        <label><input type="checkbox" disabled /> 현재 알리아스 대상과 문서 수를 기록했다.</label>
        <label><input type="checkbox" disabled /> SQL·문서 ID·참조 필드가 실제 매핑과 일치한다.</label>
        <label><input type="checkbox" disabled /> 템플릿 변경이 전체색인을 요구하는지 판단했다.</label>
        <label><input type="checkbox" disabled /> 임베딩 변경의 전체 재생성 범위와 예상 시간을 확인했다.</label>
        <label><input type="checkbox" disabled /> 정렬 JSON을 실제 인덱스에서 검증했다.</label>
        <label><input type="checkbox" disabled /> 전체·추가색인의 DB, ES, 임베딩, 알리아스 단계 시간을 확인했다.</label>
        <label><input type="checkbox" disabled /> 실패 시 기존 알리아스 유지 또는 큐 복구 상태를 확인했다.</label>
        <label><input type="checkbox" disabled /> 대표 검색어로 키워드·벡터·필터·정렬을 회귀 확인했다.</label>
      </div>
      <div className={`${styles.callout} ${styles.warning}`}><strong>운영 원칙</strong><p>이름이나 성공 로그만으로 완료를 판단하지 않습니다. 실제 알리아스 대상, 작업 단계, 문서 수, 벡터 생성·재사용 건수와 검색 결과까지 확인합니다. 인증정보와 원본 환경파일 내용은 화면 캡처나 문서에 남기지 않습니다.</p></div>
      <TopLink />
    </section>
  </>;
}

export default function SearchTuningGuidePage({ email }: { email: string }) {
  const [activeTab, setActiveTab] = useState<'tuning' | 'operations'>('tuning');
  return (
    <AdminLayout email={email}>
      <Head><title>검색엔진 가이드 | 검색엔진 관리자</title></Head>
      <div id="guide-top" className={styles.page}>
        <header className={styles.hero}>
          <div>
            <span className={styles.eyebrow}>SEARCH TUNING GUIDE</span>
            <h1>검색엔진 가이드</h1>
            <p>검색 튜닝 방법과 검색엔진 운영 설정을 실제 관리자 메뉴 기준으로 설명합니다.</p>
          </div>
          <div className={styles.environmentNote}>
            <strong>먼저 확인하세요</strong>
            <span>왼쪽의 사용 환경이 개발(DEV)인지 운영(PROD)인지 확인하세요. 설정은 환경별 인덱스에 따로 저장됩니다.</span>
          </div>
        </header>

        <div className={styles.tabs} role="tablist" aria-label="검색엔진 가이드 구분">
          <button type="button" role="tab" aria-selected={activeTab === 'tuning'} className={activeTab === 'tuning' ? styles.activeTab : ''} onClick={() => setActiveTab('tuning')}>검색튜닝</button>
          <button type="button" role="tab" aria-selected={activeTab === 'operations'} className={activeTab === 'operations' ? styles.activeTab : ''} onClick={() => setActiveTab('operations')}>운영설정</button>
        </div>

        {activeTab === 'tuning' ? <>

        <nav className={styles.contents} aria-label="검색 튜닝 가이드 목차">
          <strong>목차</strong>
          <ol>{contents.map(([id, title]) => <li key={id}><a href={`#${id}`}>{title}</a></li>)}</ol>
        </nav>

        <section id="choose-menu" className={styles.section}>
          <h2>어떤 메뉴를 사용해야 하나요?</h2>
          <div className={styles.tableWrap}><table><thead><tr><th>하고 싶은 일</th><th>사용할 메뉴</th><th>적용 방식</th></tr></thead><tbody>
            <tr><td>특정 브랜드·카테고리 상품을 더 위로 올리기</td><td><MenuLink href="/admin/business-rule-management">비즈니스 룰 설정</MenuLink></td><td>조건에 맞는 검색 후보의 최종 점수를 조정합니다.</td></tr>
            <tr><td>같은 의미의 검색어를 함께 검색하기</td><td><MenuLink href="/admin/synonym-management">동의어/유의어 관리</MenuLink></td><td>입력 검색어를 대표어 또는 동의어로 확장합니다.</td></tr>
            <tr><td>판매·조회 반응이 좋은 상품을 더 위로 올리기</td><td><MenuLink href="/admin/search-weight-tuning">검색설정/시뮬레이션</MenuLink></td><td>기존 후보에 인기도 보정을 적용합니다.</td></tr>
            <tr><td>회원 행동에 맞는 상품을 더 위로 올리기</td><td><MenuLink href="/admin/personalization">개인화</MenuLink></td><td>장바구니·최근 본 상품·관심상품·주문 이력으로 기존 후보를 보정합니다.</td></tr>
            <tr><td>상품명·브랜드명 일치를 더 중요하게 보기</td><td><MenuLink href="/admin/search-weight-tuning">검색설정/시뮬레이션</MenuLink></td><td>키워드 검색 필드의 Boost를 조정합니다.</td></tr>
            <tr><td>특정 검색어에서 상품 순위를 고정하기</td><td><MenuLink href="/admin/business-rule-management">비즈니스 룰 설정</MenuLink></td><td>상품을 지정한 결과 위치에 고정합니다.</td></tr>
            <tr><td>가격·카테고리 조건을 반드시 만족시키기</td><td><MenuLink href="/admin/search-filter-management">검색필터 관리</MenuLink></td><td>감지한 표현을 필수 조건으로 적용합니다.</td></tr>
          </tbody></table></div>
          <div className={styles.callout}><strong>필터와 가중치의 차이</strong><p>검색필터는 조건에 맞지 않는 상품을 제외합니다. 상품을 제외하지 않고 위아래로만 조정하려면 비즈니스 룰을 사용하세요. 인기도와 비즈니스 룰은 이미 검색 후보에 들어온 상품의 순위만 바꿉니다.</p></div>
          <TopLink />
        </section>

        <section id="workflow" className={styles.section}>
          <h2>공통 작업 절차</h2>
          <ol className={styles.steps}>
            <li><b>개발 환경 선택</b><span>먼저 개발(DEV)에서 변경합니다.</span></li>
            <li><b>변경 전 결과 기록</b><span><MenuLink href="/admin/search-weight-tuning">검색설정/시뮬레이션</MenuLink>에서 대표 검색어 3~10개의 상위 결과를 확인합니다.</span></li>
            <li><b>한 가지 설정만 변경</b><span>원인을 구분할 수 있도록 여러 설정을 동시에 바꾸지 않습니다.</span></li>
            <li><b>시뮬레이션</b><span>저장 전 초안으로 검색하고 점수와 적용 근거를 확인합니다.</span></li>
            <li><b>회귀 확인</b><span>대상 검색어뿐 아니라 다른 브랜드·일반 카테고리 검색어도 확인합니다.</span></li>
            <li><b>운영 반영</b><span><MenuLink href="/admin/search-weight-tuning">검색설정/시뮬레이션</MenuLink>에서 검증을 마친 뒤 운영(PROD)에 같은 값을 적용합니다.</span></li>
          </ol>
          <TopLink />
        </section>

        <section id="jigott-boost" className={styles.section}>
          <h2>가중치·페널티 주기</h2>
          <p>상품의 필드값이 조건과 일치할 때 최종 검색 점수를 올리거나 내립니다. 특정 브랜드, 카테고리, 가격대나 속성에 한시적 또는 상시 우선순위를 줄 때 사용합니다.</p>
          <p><MenuLink href="/admin/business-rule-management">비즈니스 룰 설정</MenuLink> → <b>점수 부스트·페널티</b> → <b>＋ 룰 추가</b></p>
          <h3>연산자 선택 방법</h3>
          <div className={styles.tableWrap}><table><thead><tr><th>연산자</th><th>사용 대상</th><th>예시</th></tr></thead><tbody>
            <tr><td>초과</td><td>숫자</td><td><code>sale_amt</code>가 100,000원 초과</td></tr>
            <tr><td>이상</td><td>숫자</td><td><code>sale_amt</code>가 100,000원 이상</td></tr>
            <tr><td>미만</td><td>숫자</td><td><code>sale_amt</code>가 50,000원 미만</td></tr>
            <tr><td>이하</td><td>숫자</td><td><code>sale_amt</code>가 50,000원 이하</td></tr>
            <tr><td>같음</td><td>숫자</td><td>조회수나 판매수량이 입력값과 정확히 같음</td></tr>
            <tr><td>포함</td><td>문자열·배열</td><td><code>bnd_nm_ko</code>에 `모던리프` 포함</td></tr>
          </tbody></table></div>
          <h3>점수 조정과 적용 기간</h3>
          <ul>
            <li><b>가중치:</b> 양수를 입력합니다. `20`은 조건에 맞는 상품의 점수를 20% 올립니다.</li>
            <li><b>페널티:</b> 음수를 입력합니다. `-15`는 조건에 맞는 상품의 점수를 15% 낮춥니다.</li>
            <li><b>계속 적용:</b> 시작·종료 일시와 관계없이 사용 상태인 동안 계속 적용합니다.</li>
            <li><b>기간 적용:</b> `계속 적용`을 끄고 시작·종료 일시를 입력합니다. 행사나 시즌 프로모션처럼 종료 시점이 있는 조정에 사용합니다.</li>
            <li><b>사용 여부:</b> `중지`로 바꾸면 계속 적용 또는 기간 설정과 관계없이 룰이 적용되지 않습니다.</li>
          </ul>
          <div className={styles.exampleTitle}><span>실전 예시</span><h3>모던리프 브랜드에 가중치 주기</h3></div>
          <p>모던리프 한 브랜드만 올릴 때는 모든 브랜드에 영향을 주는 필드 Boost 대신 조건 기반 비즈니스 룰을 사용합니다.</p>
          <div className={styles.exampleGrid}>
            <dl><dt>룰 이름</dt><dd>모던리프 브랜드 우대</dd><dt>설명</dt><dd>모던리프 브랜드 상품의 검색 점수 20% 상향</dd></dl>
            <dl><dt>조건 필드</dt><dd><code>bnd_nm_ko</code></dd><dt>연산자 / 조건 값</dt><dd>포함 / 모던리프</dd></dl>
            <dl><dt>점수 조정</dt><dd><code>20%</code></dd><dt>기간 / 상태</dt><dd>계속 적용 / 사용</dd></dl>
          </div>
          <h3>검증 검색어</h3>
          <div className={styles.chips}><span>모던리프 원피스</span><span>모던리프 재킷</span><span>여성 원피스</span><span>데일리루프 원피스</span></div>
          <ul><li><code>+20%</code>는 20점을 더하는 것이 아니라 기존 점수에 배율을 적용합니다.</li><li>`포함` 조건은 `데일리루프`에도 일치할 수 있으므로 두 브랜드를 구분해야 한다면 실제 필드값과 결과를 반드시 확인합니다.</li><li>처음에는 10~20%처럼 작은 값으로 시험합니다.</li></ul>
          <TopLink />
        </section>

        <section id="business-look" className={styles.section}>
          <h2>동의어·유의어 만들기</h2>
          <p>사용자가 서로 다른 표현을 입력해도 같은 의도의 상품을 찾도록 검색어를 확장합니다. 대표어와 terms의 관계에 따라 양방향 또는 단방향을 선택합니다.</p>
          <p><MenuLink href="/admin/synonym-management">동의어/유의어 관리</MenuLink> → <b>＋ 규칙 추가</b></p>
          <h3>양방향과 단방향</h3>
          <div className={styles.tableWrap}><table><thead><tr><th>방향</th><th>동작</th><th>사용 예</th></tr></thead><tbody>
            <tr><td>양방향</td><td>대표어와 모든 terms를 서로 확장합니다. 어느 단어로 검색해도 나머지 표현이 함께 사용됩니다.</td><td>`비즈니스룩`, `오피스룩`, `출근룩`처럼 거의 같은 의미로 함께 검색해도 되는 표현</td></tr>
            <tr><td>단방향</td><td>terms에 입력한 표현을 대표어 방향으로만 확장합니다. 대표어 검색이 terms 방향으로 역확장되지는 않습니다.</td><td>오탈자·구어체·좁은 표현을 표준 대표어로 모으되 대표어의 범위는 넓히고 싶지 않을 때</td></tr>
          </tbody></table></div>
          <div className={styles.exampleTitle}><span>실전 예시</span><h3>비즈니스룩 동의어 만들기</h3></div>
          <div className={styles.exampleGrid}>
            <dl><dt>방향</dt><dd>양방향</dd><dt>대표어</dt><dd>비즈니스룩</dd></dl>
            <dl><dt>동의어 terms</dt><dd>오피스룩, 출근룩</dd><dt>사용</dt><dd>체크</dd></dl>
          </div>
          <p>이 예시의 양방향 설정은 세 단어를 서로 확장합니다. 사용자 표현을 대표 표현 하나로만 모으려면 `단방향`을 선택하고 대표어를 `비즈니스룩`으로 지정합니다.</p>
          <ul><li>terms는 쉼표로 구분하며 규칙당 1~20개입니다.</li><li>대표어와 terms를 중복 입력하거나 단방향 순환 관계를 만들 수 없습니다.</li><li>동의어와 불용어·금지어에 같은 단어를 동시에 등록할 수 없습니다.</li></ul>
          <TopLink />
        </section>

        <section id="popularity" className={styles.section}>
          <h2>인기도 변경하기</h2>
          <p>검색어와 관련된 후보 안에서 판매금액, 판매수량, 조회수의 비중을 조정해 반응이 좋은 상품을 더 위로 올립니다.</p>
          <p><MenuLink href="/admin/search-weight-tuning">검색설정/시뮬레이션</MenuLink> → <b>인기도 보정</b>에서 설정합니다.</p>
          <div className={styles.exampleTitle}><span>실전 예시</span><h3>주간 판매 반응 중심으로 인기도 설정하기</h3></div>
          <div className={styles.tableWrap}><table><thead><tr><th>항목</th><th>시작 예시</th><th>의미</th></tr></thead><tbody>
            <tr><td>인기도 사용</td><td>켬</td><td>검색 후보에 인기도를 반영합니다.</td></tr><tr><td>최대 보정률</td><td>20%</td><td>최고 인기도 후보에 최대 20%를 적용합니다.</td></tr><tr><td>판매금액 기간 / 비중</td><td>주 / 40%</td><td>주 판매금액을 반영합니다.</td></tr><tr><td>판매수량 기간 / 비중</td><td>주 / 50%</td><td>주 주문수량을 반영합니다.</td></tr><tr><td>조회수 비중</td><td>10%</td><td>사용자 관심도를 반영합니다.</td></tr><tr><td>적용 방식</td><td>최대값</td><td>후보 중 최대 인기도를 정규화 기준으로 사용합니다.</td></tr>
          </tbody></table></div>
          <div className={styles.callout}><strong>필수 조건</strong><p>판매금액·판매수량·조회수 비중 합계는 반드시 100%여야 합니다. 판매금액 또는 판매수량 값이 0 이하인 상품은 인기도 원점수가 0입니다.</p></div>
          <h3>적용 방식</h3><ul><li><b>최대값:</b> 가장 인기 있는 한 상품을 기준으로 삼는 보수적인 시작값입니다.</li><li><b>상위:</b> 지정한 상위 비율의 경계값을 기준으로 하여 한 상품의 극단값 영향을 줄입니다.</li><li><b>로그:</b> 큰 값의 차이를 줄여 중간 인기 상품도 비교적 강하게 보정합니다.</li></ul>
          <TopLink />
        </section>

        <section id="personalization" className={styles.section}>
          <h2>개인화 검색 설정하기</h2>
          <p>회원번호가 확인된 상품 검색에서 장바구니·최근 본 상품·관심상품·주문 이력을 회원 프로필로 계산하고, 검색된 후보의 상품·브랜드·카테고리 일치 정도에 따라 최종 점수를 올립니다. 개인화는 새로운 후보를 추가하지 않습니다.</p>
          <p><MenuLink href="/admin/personalization">개인화</MenuLink>에서 행동별 조회 기간과 비중, 상품·브랜드·카테고리 비중, 최대 보정률과 캐시 시간을 설정합니다. 사용 여부와 테스트 회원번호는 <MenuLink href="/admin/search-weight-tuning">검색설정/시뮬레이션</MenuLink>에서 지정합니다.</p>
          <div className={styles.tableWrap}><table><thead><tr><th>항목</th><th>기본값</th><th>역할</th></tr></thead><tbody>
            <tr><td>장바구니</td><td>30일 / 20%</td><td>현재 구매 의도가 높은 상품·브랜드·카테고리 신호</td></tr>
            <tr><td>최근 본 상품</td><td>30일 / 10%</td><td>최근 탐색한 상품과 유사한 후보 신호</td></tr>
            <tr><td>관심상품</td><td>180일 / 30%</td><td>명시적으로 저장한 선호 신호</td></tr>
            <tr><td>주문</td><td>365일 / 40%</td><td>취소 후 남은 수량이 있는 구매 이력 신호</td></tr>
          </tbody></table></div>
          <h3>점수와 진단 확인</h3>
          <ol className={styles.steps}>
            <li><b>개인화 사용</b><span>검색설정/시뮬레이션에서 개인화 사용을 켭니다.</span></li>
            <li><b>회원번호 입력</b><span>테스트 회원번호를 입력한 뒤 대표 검색어로 검색합니다.</span></li>
            <li><b>결과 비교</b><span>개인화 열에서 총 보정률과 장바구니·최근 본 상품·관심상품·주문별 가산율을 확인합니다.</span></li>
            <li><b>회귀 확인</b><span>회원번호를 비우거나 개인화를 끈 결과와 비교해 관련 없는 상품이 과도하게 올라오지 않는지 확인합니다.</span></li>
          </ol>
          <div className={styles.callout}><strong>적용 조건</strong><p>회원번호가 없거나 개인화가 꺼져 있으면 적용하지 않습니다. 가격순·신상품순 같은 사용자 지정 정렬에서는 해당 정렬을 우선하므로 개인화를 생략합니다. 원천 Elasticsearch 조회에 실패하면 일반 검색은 유지하고 개인화만 생략합니다.</p></div>
          <div className={`${styles.callout} ${styles.warning}`}><strong>운영 주의</strong><p>행동별 비중 합계와 상품·브랜드·카테고리 비중 합계는 각각 100%여야 합니다. 회원번호와 행동 원본 데이터는 문서나 화면 캡처에 남기지 않습니다.</p></div>
          <TopLink />
        </section>

        <section id="field-boost" className={styles.section}>
          <h2>검색 필드 가중치 조정</h2>
          <p><MenuLink href="/admin/search-weight-tuning">검색설정/시뮬레이션</MenuLink>의 <b>키워드 검색 필드 및 가중치</b>에서 설정합니다.</p>
          <div className={styles.codeExample}><code>bnd_nm_ko: 200 → 250<br />bnd_nm_en: 200 → 250<br />goods_nm: 200 유지</code></div>
          <ul><li>브랜드명 검색을 전반적으로 강하게 할 때 사용하는 예시입니다.</li><li>허용 Boost 범위는 0.1~1000이며 절대값보다 필드 사이 상대 크기가 중요합니다.</li><li>특정 브랜드 하나만 올리려면 필드 Boost가 아니라 비즈니스 룰을 사용합니다.</li></ul>
          <TopLink />
        </section>

        <section id="pin-product" className={styles.section}>
          <h2>특정 상품 순위 고정</h2>
          <p><MenuLink href="/admin/business-rule-management">비즈니스 룰 설정</MenuLink> → <b>키워드별 상품 고정</b> → <b>＋ 룰 추가</b></p>
          <div className={styles.exampleGrid}><dl><dt>대상 검색어</dt><dd>가을 원피스</dd><dt>매칭 방식</dt><dd>검색어 정확히 일치</dd></dl><dl><dt>상품 ID</dt><dd><code>GD22190039</code></dd><dt>고정 순위</dt><dd>1위</dd></dl></div>
          <p>`추출 키워드 포함`은 영향 범위가 넓으므로 캠페인성 검색어는 `검색어 정확히 일치`부터 사용합니다. 고정 상품도 현재 인덱스에 존재하고 필수 필터를 만족해야 합니다.</p>
          <TopLink />
        </section>

        <section id="filter" className={styles.section}>
          <h2>검색필터 설정</h2>
          <p><MenuLink href="/admin/search-filter-management">검색필터 관리</MenuLink>는 검색어의 표현을 반드시 만족해야 하는 조건으로 바꿉니다.</p>
          <h3>예시: 쌀쌀한 날씨 검색을 아우터·니트웨어로 제한</h3>
          <div className={styles.exampleGrid}><dl><dt>필터명</dt><dd>쌀쌀한 날씨 상품</dd><dt>감지어</dt><dd>쌀쌀할, 쌀쌀한, 추울, 추운</dd></dl><dl><dt>대상 필드</dt><dd><code>up_disp_clsf_nm.keyword</code></dd><dt>비교 방식</dt><dd>시작값</dd></dl><dl><dt>필터값</dt><dd>패션&gt;아우터<br />패션&gt;상의&gt;니트웨어</dd><dt>사용</dt><dd>사용</dd></dl></div>
          <ul><li>한 룰 안의 여러 필터값은 OR, 서로 다른 룰 사이는 AND로 적용합니다.</li><li>`5만원대`, `5만원 이하`, `5만 원 초과` 같은 가격 표현은 별도 룰 없이 자동 감지합니다.</li><li>단지 점수만 올리고 싶다면 검색필터가 아니라 비즈니스 룰을 사용합니다.</li></ul>
          <TopLink />
        </section>

        <section id="other-settings" className={styles.section}>
          <h2>그 밖의 튜닝 설정</h2>
          <div className={styles.cards}>
            <article><h3>카테고리 일치 보정</h3><p>카테고리가 맞으면 점수를 올리고 다르면 낮춥니다. 상품을 제외하지 않습니다.</p><MenuLink href="/admin/search-weight-tuning">검색설정/시뮬레이션</MenuLink></article>
            <article><h3>개인화</h3><p>회원 행동별 기간과 비중을 설정하고 테스트 회원번호로 보정 결과를 확인합니다.</p><MenuLink href="/admin/personalization">개인화</MenuLink></article>
            <article><h3>검색 정렬</h3><p>가격순·신상품순처럼 사용자가 선택할 Elasticsearch sort를 관리합니다.</p><MenuLink href="/admin/sort-management">검색정렬 관리</MenuLink></article>
            <article><h3>불용어·금지어</h3><p>의미 없는 단어를 제거하거나 정책상 허용하지 않는 검색어를 차단합니다.</p><MenuLink href="/admin/word-policy-management">불용어/금지어 관리</MenuLink></article>
            <article><h3>요청 표현</h3><p>`추천해줘`, `찾아주세요`, `보여줘` 같은 요청 구문을 키워드 분석 전에 제거합니다.</p><MenuLink href="/admin/request-expression-management">요청 표현 관리</MenuLink></article>
          </div>
          <TopLink />
        </section>

        <section id="verify" className={styles.section}>
          <h2>검증과 되돌리기</h2>
          <h3>최소 회귀 검색어</h3>
          <div className={styles.chips}><span>모던리프 원피스</span><span>모던리프 가을 원피스</span><span>스튜디오블룸 원피스</span><span>여성 원피스</span><span>출근룩</span><span>비즈니스룩</span><span>출근룩 10만원 이하</span></div>
          <h3>확인 항목</h3><ul><li>정제 검색어, 동의어와 제거된 요청 표현</li><li>키워드·벡터 후보 순위와 RRF 점수</li><li>매칭 필드, 인기도·개인화 보정과 비즈니스 룰 적용값</li><li>검색필터, 최종 점수와 최종 순위</li></ul>
          <p><MenuLink href="/admin/search-weight-tuning">검색설정/시뮬레이션</MenuLink>에서 현재 검색과 기존 검색을 나란히 확인한 뒤 운영에 반영합니다.</p>
          <div className={`${styles.callout} ${styles.warning}`}><strong>문제가 생겼다면</strong><p>마지막 변경부터 하나씩 되돌립니다. 비즈니스 룰은 `중지`, 동의어·필터는 새 규칙 삭제 또는 사용 해제, 인기도·카테고리 보정은 사용 스위치를 끄거나 기존 값으로 복원합니다.</p></div>
          <TopLink />
        </section>
        </> : <OperationsGuide />}
      </div>
    </AdminLayout>
  );
}
