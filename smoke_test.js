// ============================================================
// 배포 전 스모크 테스트 (CI 품질 게이트 2단계)
// 사용법: node smoke_test.js index.html
//
// 실제 생성된 index.html을 jsdom(헤드리스 DOM)에 로드해 핵심 상호작용이
// 살아있는지 검증한다. 특정 식당 이름 같은 "그날의 데이터"에는 의존하지 않고,
// 어떤 데이터가 오든 참이어야 하는 불변식(invariant)만 검사한다.
// 하나라도 실패하면 exit 1 -> 워크플로우의 배포 단계가 중단되어
// 라이브 사이트는 직전 정상 버전을 유지한다.
// ============================================================
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");

const target = process.argv[2] || "index.html";
const html = fs.readFileSync(target, "utf8");

const pageErrors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => {
  // jsdom이 지원 안 하는 API(scrollTo 등) 경고는 무해하므로 무시
  if (!/not implemented/i.test(String(e))) pageErrors.push(String(e));
});

const dom = new JSDOM(html, {
  url: "https://example.com/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(w) {
    w.matchMedia = w.matchMedia || (() => ({
      matches: false, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
    }));
    Object.defineProperty(w.navigator, "clipboard", {
      value: { writeText: () => Promise.resolve() }, configurable: true,
    });
  },
});
const doc = dom.window.document;

let passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log("  OK:", label); }
  else { failed++; console.log("  FAIL:", label, detail !== undefined ? JSON.stringify(detail) : ""); }
}
function visibleCards(panel) {
  return [...panel.querySelectorAll(".card-list .card:not(.cat-hidden):not(.lg-hidden)")];
}
function ranksSequential(panel) {
  const ranks = visibleCards(panel).map(c =>
    (c.querySelector(".rank-num") || c.querySelector(".rank")).textContent.trim());
  return ranks.every((r, i) => r === String(i + 1));
}

// --- 1. 기본 구조 ---
const panels = [...doc.querySelectorAll(".tab-panel")];
const overall = panels.find(p => p.dataset.tabname === "전체");
check("탭 패널 존재", panels.length >= 2, panels.length);
check("전체 탭 존재", !!overall);
check("탭 버튼과 패널 연결", [...doc.querySelectorAll(".tab-btn")].every(b => doc.getElementById(b.dataset.tab)));

// --- 2. 순위 번호 불변식: 카드가 있는 모든 패널에서 보이는 순위 = 1..N ---
const cardPanels = panels.filter(p => p.querySelector(".card-list .card"));
check("카드 패널 1개 이상", cardPanels.length >= 1);
check("모든 패널 순위 연속(1..N)", cardPanels.every(ranksSequential));

// --- 3. 협찬 포함 토글 (lg 카드가 있는 경우에만) ---
const lgCards = [...doc.querySelectorAll(".tab-panel:not(#tab-favorites) .card.lg-card")];
const toggleBtn = doc.querySelector(".lg-toggle-btn");
if (lgCards.length && toggleBtn) {
  check("협찬 카드 기본 숨김", lgCards.every(c => c.classList.contains("lg-hidden")));
  toggleBtn.click();
  check("토글 ON: 협찬 카드 표시", lgCards.every(c => !c.classList.contains("lg-hidden")));
  check("토글 ON: 순위 재계산 연속", cardPanels.every(ranksSequential));
  check("토글 상태 저장", dom.window.localStorage.getItem("naver_trend_show_sponsored") === "1");
  toggleBtn.click();
  check("토글 OFF: 다시 숨김 + 순위 복원", lgCards.every(c => c.classList.contains("lg-hidden")) && cardPanels.every(ranksSequential));
} else {
  console.log("  (협찬 카드 없음 - 토글 검사 건너뜀: 정상 케이스)");
}

// --- 4. 정렬: 보이는 순서가 실제 data 속성 내림차순과 일치 ---
const sortPanel = cardPanels.find(p => p.querySelector('.sort-btn[data-sort="thisweek"]'));
if (sortPanel && visibleCards(sortPanel).length >= 2) {
  sortPanel.querySelector('.sort-btn[data-sort="thisweek"]').click();
  const vals = visibleCards(sortPanel).map(c => Number(c.dataset.thisweek));
  check("언급많은순 정렬 일치", vals.every((v, i) => i === 0 || vals[i - 1] >= v), vals);
  check("정렬 후 순위 연속", ranksSequential(sortPanel));
}

// --- 5. 유틸리티 줄 + 즐겨찾기 패널 전환 ---
check("유틸 버튼 3종 존재", !!doc.querySelector(".vote-btn")
  && !!doc.querySelector(".lg-toggle-btn")
  && [...doc.querySelectorAll(".util-btn")].some(b => b.textContent.includes("즐겨찾기")));
if (typeof dom.window.openFavoritesTab === "function") {
  dom.window.openFavoritesTab();
  const fav = doc.getElementById("tab-favorites");
  check("즐겨찾기 패널 전환", fav && fav.classList.contains("active")
    && panels.filter(p => p.classList.contains("active")).length === 1);
}

// --- 6. 메타/경량화 산출물 ---
check("OG 설명 존재", !!doc.querySelector('meta[property="og:description"]')
  && doc.querySelector('meta[property="og:description"]').content.length > 10);

// --- 7. 페이지 JS 런타임 에러 ---
check("런타임 에러 0건", pageErrors.length === 0, pageErrors.slice(0, 2));

console.log(`\n스모크 테스트: ${passed} 통과 / ${failed} 실패`);
process.exit(failed ? 1 : 0);
