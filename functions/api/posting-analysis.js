// Cloudflare Pages Function: 포스팅 분석
// 라우트: POST /api/posting-analysis
// 입력: { url: "https://blog.naver.com/myid/12345" }
// 출력: 글 정보 + 노출 진단 + 본문/이미지/링크 분석 + 형태소 + 금칙어 + AI-Fit 등급

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: corsHeaders });
}

function decodeEntities(s) {
    if (!s) return '';
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

// URL → blogId, logNo 추출
function parseNaverPostUrl(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^m\./, '');
        if (!host.endsWith('blog.naver.com')) return null;

        let blogId = '';
        let logNo = u.searchParams.get('logNo') || '';
        const seg = u.pathname.split('/').filter(Boolean);
        if (seg.length > 0) {
            const first = seg[0];
            if (first === 'PostView.naver' || first === 'PostView.nhn') {
                blogId = u.searchParams.get('blogId') || '';
            } else {
                blogId = first;
                if (seg.length > 1 && /^\d+$/.test(seg[1])) logNo = logNo || seg[1];
            }
        }
        if (!blogId || !logNo) return null;
        return { blogId: blogId.toLowerCase(), logNo };
    } catch (e) { return null; }
}

// 모바일 포스트 페이지 가져오기 (PC보다 파싱 쉬움)
async function fetchPostHtml(blogId, logNo) {
    const url = `https://m.blog.naver.com/${encodeURIComponent(blogId)}/${encodeURIComponent(logNo)}`;
    const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`포스트 HTML ${res.status} (URL을 다시 확인하세요)`);
    return res.text();
}

// HTML에서 본문/메타 추출
function extractPostMeta(html) {
    const meta = {};

    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
    meta.title = ogTitle ? decodeEntities(ogTitle[1]) : '';

    const ogDesc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
    meta.description = ogDesc ? decodeEntities(ogDesc[1]) : '';

    // 작성일 추출 (모바일 페이지)
    // <span class="se_publishDate">2026. 4. 29.</span> 또는 비슷한 패턴
    const dateMatch = html.match(/se_publishDate[^>]*>([^<]+)</)
        || html.match(/class="blog_date"[^>]*>([^<]+)</)
        || html.match(/data-date=["']([^"']+)["']/);
    meta.publishDate = dateMatch ? dateMatch[1].trim() : '';

    // 댓글 수 추출 (commentCount="6" 또는 "commentCount":6)
    const commentMatch = html.match(/commentCount\s*=\s*["'](\d+)["']/i)
        || html.match(/"commentCount"\s*:\s*(\d+)/i)
        || html.match(/commentCount\\":\s*(\d+)/i);
    meta.commentCount = commentMatch ? parseInt(commentMatch[1], 10) : 0;

    // 공감 수는 HTML에 없음 (별도 API로 가져옴 - fetchLikeCount 사용)
    meta.sympathyCount = 0;

    // 본문 영역 추출: SmartEditor se-main-container를 균형 div 카운팅으로 정확히 자름
    let bodyHtml = '';
    const seStart = html.match(/<div[^>]*class="[^"]*se-main-container[^"]*"[^>]*>/);
    if (seStart) {
        const startIdx = seStart.index + seStart[0].length;
        let i = startIdx;
        let depth = 1;
        const len = html.length;
        while (i < len && depth > 0) {
            const nextOpen = html.indexOf('<div', i);
            const nextClose = html.indexOf('</div>', i);
            if (nextClose === -1) break;
            if (nextOpen !== -1 && nextOpen < nextClose) {
                depth++;
                i = nextOpen + 4;
            } else {
                depth--;
                i = nextClose + 6;
            }
        }
        if (i > startIdx) bodyHtml = html.substring(startIdx, i - 6);
    }
    // Fallback: 구식 에디터 / 다른 구조
    if (!bodyHtml) {
        const fallback = [
            /<div[^>]*id="postViewArea"[^>]*>([\s\S]*?)<\/div>/,
            /<div[^>]*class="[^"]*post_ct[^"]*"[^>]*>([\s\S]*?)<div[^>]*class="[^"]*postLike/i,
            /<div[^>]*class="[^"]*post-view[^"]*"[^>]*>([\s\S]*?)<script/,
        ];
        for (const re of fallback) {
            const m = html.match(re);
            if (m && m[1]) { bodyHtml = m[1]; break; }
        }
    }
    // Last resort: og:description
    if (!bodyHtml) bodyHtml = meta.description || '';
    meta.bodyHtml = bodyHtml;

    return meta;
}

// 본문 HTML → 텍스트, 이미지, 동영상, 링크
function analyzeBody(bodyHtml) {
    const result = { text: '', images: [], videos: 0, links: [] };
    if (!bodyHtml) return result;

    // 링크 카드 / OG 미리보기 / placeholder 컨테이너 사전 제거
    // (외부 링크 썸네일은 본문 이미지가 아니므로 카운트에서 제외)
    const cleanedHtml = bodyHtml
        .replace(/<a[^>]*class=["'][^"']*(?:oglink|se-link)[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, '')
        .replace(/<div[^>]*class=["'][^"']*(?:se-oglink|se-section-oglink|se-placeholder)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');

    const isLinkCardImg = (tag) => /class=["'][^"']*(?:oglink|se-section-oglink|se-placeholder|se-link-thumbnail)/i.test(tag);

    // 이미지 src 수집 (링크 카드 썸네일 제외)
    const imgMatches = cleanedHtml.matchAll(/<img[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi);
    for (const m of imgMatches) {
        if (isLinkCardImg(m[0])) continue;
        let src = m[1];
        if (src.startsWith('//')) src = 'https:' + src;
        if (src && !src.startsWith('data:')) result.images.push(src);
    }
    // lazy 로딩 이미지 (링크 카드 제외)
    const lazyMatches = cleanedHtml.matchAll(/<img[^>]*\bdata-(?:lazy-)?src=["']([^"']+)["'][^>]*>/gi);
    for (const m of lazyMatches) {
        if (isLinkCardImg(m[0])) continue;
        let src = m[1];
        if (src.startsWith('//')) src = 'https:' + src;
        if (src && !src.startsWith('data:') && !result.images.includes(src)) {
            result.images.push(src);
        }
    }

    // 동영상 (iframe + video)
    const iframeCount = (bodyHtml.match(/<iframe[^>]*>/gi) || []).length;
    const videoCount = (bodyHtml.match(/<video[^>]*>/gi) || []).length;
    result.videos = iframeCount + videoCount;

    // 링크
    const aMatches = bodyHtml.matchAll(/<a[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
    for (const m of aMatches) {
        const href = m[1];
        const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (href && href.startsWith('http')) {
            result.links.push({ href, text: text.substring(0, 80) });
        }
    }

    // 텍스트: 모든 태그 제거 + 엔티티 디코드
    let text = bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, '')
                       .replace(/<style[\s\S]*?<\/style>/gi, '')
                       .replace(/<[^>]+>/g, ' ')
                       .replace(/&nbsp;/g, ' ');
    text = decodeEntities(text).replace(/\s+/g, ' ').trim();
    result.text = text;

    return result;
}

// 한국어 명사 추출 (간이형: 2~6자 한글, 빈도 카운트)
function extractKeywords(text, topN = 12) {
    if (!text) return [];
    // 2자 이상 한글 시퀀스 추출
    const matches = text.match(/[가-힣]{2,8}/g) || [];

    // 흔한 어미·조사·접속사 제외 stop words
    const stopWords = new Set([
        '이다','있다','없다','하다','되다','같다','이런','그런','저런','어떤','이번','저번',
        '그리고','그러나','하지만','그래서','그러면','때문','경우','부분','모습','정도','상황',
        '오늘','내일','어제','지금','현재','요즘','오랜','정말','진짜','너무','매우','다른',
        '여기','거기','저기','이것','그것','저것','우리','자기','자신','가지','이때','조금',
        '바로','다시','계속','그냥','대해','모든','각자','다양','이상','이하','이외','외부',
        '대부분','일부','전체','관련','일반','특정','당시','당일','당사','수있','니다','입니다',
    ]);

    const counts = {};
    for (const word of matches) {
        if (stopWords.has(word)) continue;
        counts[word] = (counts[word] || 0) + 1;
    }

    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([word, count]) => ({ word, count }));
}

// 금칙어/유해성 사전 (확장 가능)
const FORBIDDEN_WORDS = {
    '광고성/유인':  ['최저가', '특가', '무료체험', '무료배포', '돈벌기', '리워드 지급', '구매하면 즉시'],
    '도배/스팸':    ['클릭하세요', '꼭 보세요', '여기 클릭', 'must read', '꿀팁공유'],
    '의료/허위':    ['100% 효과', '완치', '부작용 없음', '치료 보장', '의료법'],
    '도박/사행성':  ['카지노', '바카라', '슬롯머신', '토토사이트', '먹튀'],
};

function checkForbiddenWords(text) {
    if (!text) return { hits: [], categories: [] };
    const lower = text.toLowerCase();
    const hits = [];
    const cats = new Set();
    for (const [category, words] of Object.entries(FORBIDDEN_WORDS)) {
        for (const w of words) {
            if (lower.includes(w.toLowerCase())) {
                hits.push({ word: w, category });
                cats.add(category);
            }
        }
    }
    return { hits, categories: Array.from(cats) };
}

// 콘텐츠 분석 (4가지 평가 항목)
function analyzeContent(meta, body, kw) {
    const textLen = body.text.length;
    const imgCnt = body.images.length;
    const videoCnt = body.videos;
    const linkCnt = body.links.length;
    const externalLinks = body.links.filter(l => !isInternalNaverLink(l.href));

    const analysis = {};

    // 1. 콘텐츠 품질: 글자수 + 이미지 균형
    if (textLen >= 1500 && imgCnt >= 5) {
        analysis.quality = { ok: true, msg: '콘텐츠 품질 우수. 충분한 글자 수와 적절한 이미지 구성.' };
    } else if (textLen >= 800 && imgCnt >= 3) {
        analysis.quality = { ok: true, msg: '콘텐츠 품질 양호. 기본 요건 충족.' };
    } else if (textLen >= 400) {
        analysis.quality = { ok: false, msg: '글자 수 또는 이미지 부족. 본문을 더 풍성하게 채워보세요.' };
    } else {
        analysis.quality = { ok: false, msg: '본문이 너무 짧습니다. 800자 이상 권장.' };
    }

    // 2. 구조화: 형태소 다양성 (다양한 단어 사용 여부)
    const uniqueWords = kw.length;
    if (uniqueWords >= 8) {
        analysis.structure = { ok: true, msg: '주제 다양성 충분. 다양한 키워드로 잘 구성됨.' };
    } else if (uniqueWords >= 4) {
        analysis.structure = { ok: false, msg: '키워드 다양성이 다소 단조롭습니다. 관련 주제어를 더 활용해 보세요.' };
    } else {
        analysis.structure = { ok: false, msg: '주제 폭이 좁습니다. 본문에 다양한 정보·사례·표현을 추가하세요.' };
    }

    // 3. 적합도: 글 길이와 미디어 비율
    if (textLen > 0) {
        const ratio = (imgCnt + videoCnt) / Math.max(1, textLen / 500);
        if (ratio >= 0.5 && ratio <= 4) {
            analysis.fit = { ok: true, msg: '적합도 양호. 텍스트와 미디어 비율이 균형적입니다.' };
        } else if (ratio < 0.5) {
            analysis.fit = { ok: false, msg: '텍스트 대비 이미지가 부족합니다.' };
        } else {
            analysis.fit = { ok: false, msg: '이미지가 너무 많습니다. 본문 텍스트를 보강하세요.' };
        }
    } else {
        analysis.fit = { ok: false, msg: '본문 추출 실패.' };
    }

    // 4. 최신성: 작성일 기준 (있으면)
    analysis.recency = { ok: true, msg: '최신 정보로 가득해요!' };
    if (meta.publishDate) {
        const dateMatch = meta.publishDate.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
        if (dateMatch) {
            const postDate = new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]));
            const daysAgo = Math.floor((Date.now() - postDate.getTime()) / (1000 * 60 * 60 * 24));
            if (daysAgo > 365) {
                analysis.recency = { ok: false, msg: `1년 이상 지난 글입니다 (${daysAgo}일 전). 최신성 보강을 고려하세요.` };
            } else if (daysAgo > 180) {
                analysis.recency = { ok: false, msg: `6개월 이상 지난 글입니다 (${daysAgo}일 전).` };
            }
        }
    }

    return analysis;
}

// 광고성 / 어뷰징 / 권위 인용 패턴
const AD_WORDS = ['최저가', '최저 가격', '특가', '한정 수량', '마감 임박', '품질보증', '품질 보증', '100% 보장', '확실', '단언', '필수', '무조건', 'NO.1', 'No.1'];
const AUTHORITY_PATTERN = /(?:공식 ?홈페이지|공식 ?사이트|보건복지부|식약처|국가기관|논문|학회|연구|통계청|기획재정부|국세청)/g;
const CONTACT_PATTERN = /(?:01[016789][-\s]?\d{3,4}[-\s]?\d{4})|(?:카카오톡 ?(?:아이디|ID)|카톡 ?(?:아이디|ID))/g;
const HASHTAG_PATTERN = /(?:^|\s|\n)#[가-힣a-zA-Z0-9_]{1,30}/g;
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu;

// 콘텐츠 품질 지표 종합 분석
function analyzeQualityIndicators(title, body, bodyHtml) {
    const text = body.text || '';
    const ind = {};

    // 제목 길이
    ind.titleLength = (title || '').length;

    // 소제목 개수 (h1-h6 + 네이버 SE2 소제목 div)
    const headingCount = ((bodyHtml || '').match(/<h[1-6][^>]*>/gi) || []).length;
    const seHeadingCount = ((bodyHtml || '').match(/class=["'][^"']*se-section-text se-section-text--title|se-fs-fs26|se-fs-fs28/gi) || []).length;
    ind.subheadingCount = headingCount + seHeadingCount;

    // 문단 개수
    const pCount = ((bodyHtml || '').match(/<p[^>]*>/gi) || []).length;
    const divParaCount = ((bodyHtml || '').match(/<div[^>]*class=[^>]*se-text-paragraph/gi) || []).length;
    const textParaCount = text.split(/\n\s*\n/).filter(p => p.trim()).length;
    ind.paragraphCount = Math.max(pCount, divParaCount, textParaCount);

    // 문단 분리 (텍스트 기준)
    const paragraphs = text.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0);
    ind.firstParaLen = paragraphs[0] ? paragraphs[0].length : 0;
    ind.lastParaLen = paragraphs[paragraphs.length-1] ? paragraphs[paragraphs.length-1].length : 0;
    ind.paragraphsForCheck = paragraphs;

    // 제목 키워드 본문 정확 반복
    if (title && title.length >= 5) {
        const escTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escTitle, 'g');
        ind.titleRepeatCount = (text.match(regex) || []).length;
    } else {
        ind.titleRepeatCount = 0;
    }

    // 본문 해시태그 (글 끝 모음 영역의 태그는 제외 — 마지막 200자에서는 무시)
    const mainText = text.length > 200 ? text.substring(0, text.length - 200) : text;
    ind.hashtagsInBody = (mainText.match(HASHTAG_PATTERN) || []).length;

    // 반복 문장 검출
    const sentences = text.split(/[.!?。]\s+/).map(s => s.trim()).filter(s => s.length > 15);
    const sentMap = {};
    let dupCount = 0;
    for (const s of sentences) {
        sentMap[s] = (sentMap[s] || 0) + 1;
        if (sentMap[s] === 2) dupCount++;
    }
    ind.duplicateSentences = dupCount;

    // 광고성 문구
    ind.adWordsHits = AD_WORDS.reduce((acc, w) => acc + (text.includes(w) ? 1 : 0), 0);

    // 연락처 노출
    const contactMatches = text.match(CONTACT_PATTERN);
    ind.hasContact = !!(contactMatches && contactMatches.length > 0);

    // 이모지 카운트
    ind.emojiCount = (text.match(EMOJI_PATTERN) || []).length;

    // 이모지 시작 문단 패턴
    let emojiStartCount = 0;
    for (const p of paragraphs) {
        const firstChar = p[0] || '';
        if (firstChar && EMOJI_PATTERN.test(firstChar)) emojiStartCount++;
        EMOJI_PATTERN.lastIndex = 0;
    }
    ind.allParasStartWithEmoji = paragraphs.length >= 3 && emojiStartCount >= paragraphs.length * 0.8;

    // 숫자/통계 인용
    const numericPattern = /\d+(?:\.\d+)?\s*(?:%|원|점|분|시간|km|kg|개|회|위|명|년|월|일|호|등)|평점\s*\d|약\s*\d+/g;
    ind.numericMentions = (text.match(numericPattern) || []).length;

    // 외부 신뢰 인용
    ind.authorityMentions = (text.match(AUTHORITY_PATTERN) || []).length;

    // 마무리 정리 문단 (결론/요약 키워드 포함 여부)
    const conclusionPattern = /(?:정리|마무리|결론|요약|총평|마지막으로|이상으로|이렇게|지금까지)/;
    const lastPara = paragraphs[paragraphs.length-1] || '';
    ind.hasConclusion = conclusionPattern.test(lastPara) || paragraphs.slice(-2).some(p => conclusionPattern.test(p));

    // [네이버 D.I.A.+ ①] 제목-본문 일치도 (클릭베이트 체크)
    if (title) {
        const stopWords = new Set(['그리고','하지만','그래서','입니다','있는','같은','대한','이번','오늘','정말','진짜','완전','너무']);
        const titleWords = (title.match(/[가-힣a-zA-Z0-9]{2,}/g) || []).filter(w => !stopWords.has(w));
        const matched = titleWords.filter(w => text.includes(w)).length;
        ind.titleWordMatchRatio = titleWords.length > 0 ? matched / titleWords.length : 1;
        ind.titleWordsTotal = titleWords.length;
        ind.titleWordsMatched = matched;
    } else {
        ind.titleWordMatchRatio = 1; ind.titleWordsTotal = 0; ind.titleWordsMatched = 0;
    }

    // [네이버 D.I.A.+ ②] 첫 문단 훅 (도입부에 결론/숫자/소개 단서)
    const firstPara = paragraphs[0] || '';
    const hookPattern = /(?:오늘은|이번 ?글|이 ?글에서|결론부터|먼저|소개합니다|알려드립니다|정리했|준비했|살펴보|다뤄|핵심은)/;
    ind.hasOpeningHook = firstPara.length >= 50 && (hookPattern.test(firstPara) || /\d/.test(firstPara));

    // [네이버 ③] 네이티브(네이버 직접 업로드) 이미지 비율
    const nativePattern = /(?:pstatic\.net|naver\.net|blogfiles|postfiles)/i;
    const totalImg = (body.images || []).length;
    const nativeImg = (body.images || []).filter(s => nativePattern.test(s)).length;
    ind.nativeImageRatio = totalImg > 0 ? nativeImg / totalImg : 1;
    ind.totalImageCount = totalImg;
    ind.nativeImageCount = nativeImg;

    // [네이버 ④] 멀티미디어 균형 점수 (글자수 대비 이미지 배치)
    // 이상적: 200~400자당 이미지 1장
    if (totalImg > 0 && text.length > 0) {
        const charsPerImg = text.length / totalImg;
        ind.mediaBalance = (charsPerImg >= 150 && charsPerImg <= 500) ? 'good' :
                           (charsPerImg < 80 || charsPerImg > 800) ? 'bad' : 'fair';
        ind.charsPerImage = Math.round(charsPerImg);
    } else {
        ind.mediaBalance = 'na'; ind.charsPerImage = 0;
    }

    return ind;
}

// 글 지수 등급 산정 (100점 만점, 22가지 지표 종합)
function calculateAIFit(meta, body, kw, contentAnalysis, forbiddenResult, missingImages, qualityInd, exposedInfo, coreKeywordRanks) {
    let score = 100;
    const breakdown = [];

    // 1. 글자수 (-35 ~ 0) - 1,500자 sweet spot, 미달/초과 모두 감점
    const textLen = body.text.length;
    if (textLen < 400) { score -= 35; breakdown.push({ name: '글자수 매우 부족 (400자 미만)', delta: -35 }); }
    else if (textLen < 800) { score -= 22; breakdown.push({ name: '글자수 부족 (800자 미만)', delta: -22 }); }
    else if (textLen < 1200) { score -= 12; breakdown.push({ name: '글자수 미흡 (1,200자 미만)', delta: -12 }); }
    else if (textLen <= 1800) { /* sweet spot 1200~1800: 감점 없음 */ }
    else if (textLen <= 2500) { score -= 5; breakdown.push({ name: '글자수 다소 김 (1,800~2,500자)', delta: -5 }); }
    else if (textLen <= 3500) { score -= 12; breakdown.push({ name: '글자수 과다 (2,500~3,500자)', delta: -12 }); }
    else { score -= 20; breakdown.push({ name: '글자수 매우 과다 (3,500자 초과)', delta: -20 }); }

    // 2. 이미지 (-25 ~ 0) - 7개 이상 만점 (네이버 권장 수준)
    const imgCnt = body.images.length;
    if (imgCnt === 0) { score -= 25; breakdown.push({ name: '이미지 없음', delta: -25 }); }
    else if (imgCnt < 2) { score -= 15; breakdown.push({ name: '이미지 부족 (1개)', delta: -15 }); }
    else if (imgCnt < 4) { score -= 8; breakdown.push({ name: '이미지 미흡 (2~3개)', delta: -8 }); }
    else if (imgCnt < 7) { score -= 3; breakdown.push({ name: '이미지 보통 (4~6개)', delta: -3 }); }

    // 3. 누락 이미지 (-15 ~ 0)
    if (missingImages > 0) {
        const penalty = Math.min(15, missingImages * 3);
        score -= penalty;
        breakdown.push({ name: `누락 이미지 ${missingImages}개`, delta: -penalty });
    }

    // 4. 주제어 다양성 (-15 ~ 0)
    const kwUniq = kw.length;
    if (kwUniq < 4) { score -= 15; breakdown.push({ name: '주제어 다양성 낮음', delta: -15 }); }
    else if (kwUniq < 8) { score -= 7; breakdown.push({ name: '주제어 다양성 보통', delta: -7 }); }

    // 5. 위험어/금칙어 (-30 ~ 0)
    if (forbiddenResult.hits.length > 0) {
        const penalty = Math.min(30, forbiddenResult.hits.length * 8);
        score -= penalty;
        breakdown.push({ name: `위험어 ${forbiddenResult.hits.length}건`, delta: -penalty });
    }

    // 6. 외부링크 (-20 ~ 0) - 개당 -2
    const externalCnt = body.links.filter(l => !isInternalNaverLink(l.href)).length;
    if (externalCnt > 0) {
        const penalty = Math.min(20, externalCnt * 2);
        score -= penalty;
        breakdown.push({ name: `외부링크 ${externalCnt}개`, delta: -penalty });
    }

    // 7. 제목 키워드 본문 정확 반복 (4회 이상 -10)
    if (qualityInd.titleRepeatCount >= 4) {
        score -= 10;
        breakdown.push({ name: `제목 그대로 ${qualityInd.titleRepeatCount}회 반복 (어뷰징 의심)`, delta: -10 });
    }

    // 8. 본문 해시태그 (-15 ~ 0)
    if (qualityInd.hashtagsInBody > 0) {
        const penalty = Math.min(15, qualityInd.hashtagsInBody * 3);
        score -= penalty;
        breakdown.push({ name: `본문 해시태그 ${qualityInd.hashtagsInBody}개`, delta: -penalty });
    }

    // 9. 반복 문장 (-15 ~ 0)
    if (qualityInd.duplicateSentences > 0) {
        const penalty = Math.min(15, qualityInd.duplicateSentences * 5);
        score -= penalty;
        breakdown.push({ name: `반복 문장 ${qualityInd.duplicateSentences}건`, delta: -penalty });
    }

    // 10. 첫 문단 길이
    if (qualityInd.firstParaLen > 0 && qualityInd.firstParaLen < 50) {
        score -= 5;
        breakdown.push({ name: '첫 문단 너무 짧음 (훅 부실)', delta: -5 });
    } else if (qualityInd.firstParaLen > 300) {
        score -= 5;
        breakdown.push({ name: '첫 문단 너무 김 (장황)', delta: -5 });
    }

    // 11. 마무리 정리 없음
    if (textLen > 1000 && !qualityInd.hasConclusion) {
        score -= 5;
        breakdown.push({ name: '마무리 정리 문단 없음', delta: -5 });
    }

    // 12. 광고성 문구 (-15 ~ 0)
    if (qualityInd.adWordsHits > 0) {
        const penalty = Math.min(15, qualityInd.adWordsHits * 3);
        score -= penalty;
        breakdown.push({ name: `광고성 문구 ${qualityInd.adWordsHits}건`, delta: -penalty });
    }

    // 13. 연락처 노출
    if (qualityInd.hasContact) {
        score -= 10;
        breakdown.push({ name: '본문 연락처 노출', delta: -10 });
    }

    // 14. 이모지 과다 (30+)
    if (qualityInd.emojiCount > 30) {
        score -= 5;
        breakdown.push({ name: `이모지 과다 (${qualityInd.emojiCount}개)`, delta: -5 });
    }

    // 15. 이모지 시작 문단 패턴
    if (qualityInd.allParasStartWithEmoji) {
        score -= 5;
        breakdown.push({ name: '모든 문단이 이모지 시작 (스팸 패턴)', delta: -5 });
    }

    // 16. 소제목 개수
    if (textLen > 1500 && qualityInd.subheadingCount < 3) {
        score -= 10;
        breakdown.push({ name: `소제목 부족 (${qualityInd.subheadingCount}개)`, delta: -10 });
    } else if (textLen > 1000 && qualityInd.subheadingCount < 2) {
        score -= 5;
        breakdown.push({ name: '소제목 부족', delta: -5 });
    }

    // 17. 문단 분리
    if (textLen > 500 && qualityInd.paragraphCount < 5) {
        score -= 5;
        breakdown.push({ name: '문단 분리 부족', delta: -5 });
    }

    // 18. 제목 길이
    if (qualityInd.titleLength > 0 && (qualityInd.titleLength < 15 || qualityInd.titleLength > 40)) {
        score -= 5;
        breakdown.push({ name: '제목 길이 부적절 (15~40자 권장)', delta: -5 });
    }

    // 19. 검색 노출 반영
    if (exposedInfo) {
        if (exposedInfo.exposed === false) {
            score -= 25;
            breakdown.push({ name: '검색 인덱스 누락', delta: -25 });
        } else if (exposedInfo.exposed === true) {
            const rank = exposedInfo.rank || 1;
            if (rank > 20) { score -= 10; breakdown.push({ name: `검색 결과 ${rank}번째 (하위)`, delta: -10 }); }
            else if (rank > 10) { score -= 5; breakdown.push({ name: `검색 결과 ${rank}번째`, delta: -5 }); }
        }
    }

    // 20. 글자수/이미지 균형 (이미지 도배 감점)
    if (imgCnt >= 5 && textLen / imgCnt < 100) {
        score -= 8;
        breakdown.push({ name: '이미지 대비 글자수 부족 (이미지 도배 의심)', delta: -8 });
    }

    // === 가산점 ===

    // 21. 동영상 보너스
    if (body.videos > 0) {
        score += 5;
        breakdown.push({ name: '동영상 포함', delta: +5 });
    }

    // 22. 구체 수치 인용 보너스
    if (qualityInd.numericMentions >= 5) {
        score += 5;
        breakdown.push({ name: `구체 수치 ${qualityInd.numericMentions}회 인용`, delta: +5 });
    }

    // 23. 신뢰 출처 인용 보너스
    if (qualityInd.authorityMentions >= 1) {
        score += 3;
        breakdown.push({ name: '공인 출처 인용', delta: +3 });
    }

    // === 네이버 D.I.A.+ 기준 추가 항목 ===

    // 25. 제목-본문 일치도 (클릭베이트 감점)
    if (qualityInd.titleWordsTotal >= 2) {
        if (qualityInd.titleWordMatchRatio < 0.3) {
            score -= 15;
            breakdown.push({ name: `제목-본문 불일치 (제목 단어 ${qualityInd.titleWordsMatched}/${qualityInd.titleWordsTotal} 등장)`, delta: -15 });
        } else if (qualityInd.titleWordMatchRatio < 0.6) {
            score -= 7;
            breakdown.push({ name: `제목-본문 일치 약함 (${qualityInd.titleWordsMatched}/${qualityInd.titleWordsTotal})`, delta: -7 });
        }
    }

    // 26. 첫 문단 훅 (D.I.A.+ 핵심: 도입부 결론·소개)
    if (qualityInd.hasOpeningHook) {
        score += 5;
        breakdown.push({ name: '도입부 훅 양호 (검색 의도 즉시 응답)', delta: +5 });
    } else if (textLen > 800 && qualityInd.firstParaLen >= 30) {
        score -= 5;
        breakdown.push({ name: '도입부 훅 부족 (결론·핵심·숫자 없음)', delta: -5 });
    }

    // 27. 소제목 가산 (3개 이상 + 1500자 이상 본문)
    if (textLen >= 1200 && qualityInd.subheadingCount >= 3) {
        score += 3;
        breakdown.push({ name: `소제목 구조 양호 (${qualityInd.subheadingCount}개)`, delta: +3 });
    }

    // 28. 네이티브 이미지 비율 (직접 업로드 = 네이버 선호)
    if (qualityInd.totalImageCount >= 3) {
        if (qualityInd.nativeImageRatio >= 0.8) {
            score += 5;
            breakdown.push({ name: `직접 업로드 이미지 ${Math.round(qualityInd.nativeImageRatio*100)}% (네이티브)`, delta: +5 });
        } else if (qualityInd.nativeImageRatio < 0.3) {
            score -= 8;
            breakdown.push({ name: `외부 이미지 다수 (네이티브 ${Math.round(qualityInd.nativeImageRatio*100)}%)`, delta: -8 });
        }
    }

    // 29. 멀티미디어 균형 (글자수/이미지 배치)
    if (qualityInd.mediaBalance === 'good') {
        score += 3;
        breakdown.push({ name: `글·이미지 균형 양호 (${qualityInd.charsPerImage}자/장)`, delta: +3 });
    } else if (qualityInd.mediaBalance === 'bad') {
        score -= 5;
        breakdown.push({ name: `글·이미지 균형 불량 (${qualityInd.charsPerImage}자/장)`, delta: -5 });
    }

    // 24. 핵심 키워드 SEO 순위 (실제 검색 노출 측정)
    if (Array.isArray(coreKeywordRanks) && coreKeywordRanks.length > 0) {
        let kwBonus = 0;
        const summary = [];
        for (const kr of coreKeywordRanks) {
            if (!kr.rank) {
                kwBonus -= 3;
                summary.push(`${kr.keyword} 누락`);
            } else if (kr.rank <= 3) {
                kwBonus += 5;
                summary.push(`${kr.keyword} ${kr.rank}위`);
            } else if (kr.rank <= 10) {
                kwBonus += 2;
                summary.push(`${kr.keyword} ${kr.rank}위`);
            } else if (kr.rank >= 50) {
                kwBonus -= 2;
                summary.push(`${kr.keyword} ${kr.rank}위`);
            }
        }
        if (kwBonus !== 0) {
            score += kwBonus;
            const label = `핵심 키워드 노출 (${summary.join(' / ')})`;
            breakdown.push({ name: label, delta: kwBonus });
        }
    }

    score = Math.max(0, Math.min(100, score));

    // 등급 매핑
    let grade;
    if (score >= 92) grade = 'S';
    else if (score >= 82) grade = 'A';
    else if (score >= 68) grade = 'B';
    else if (score >= 52) grade = 'C';
    else if (score >= 36) grade = 'D';
    else if (score >= 20) grade = 'E';
    else grade = 'F';

    const gradeDesc = {
        'S': '황금 글 — 모든 항목 완벽',
        'A': '탄탄한 글 — 매우 우수',
        'B': '쓸만한 글 — 양호',
        'C': '보강 필요 — 일부 개선',
        'D': '손질 시급 — 다수 개선',
        'E': '재구성 권장 — 품질 부족',
        'F': '처음부터 — 재작성 권장',
    }[grade];

    // breakdown은 내부 채점 알고리즘 노출 위험으로 API 응답에서 제거
    return { score, grade, gradeDesc };
}

// 네이버 지도 URL 패턴 (외부 GET 차단되므로 누락 체크 면제)
function isNaverMapImage(src) {
    if (!src) return false;
    return /map[-.]?(?:static|api)|simg\.pstatic\.net\/static\.map|map\.pstatic\.net/i.test(src);
}

// 이미지 누락(404) 검사 — Range GET 요청 + Referer 헤더로 false positive 최소화
async function checkImageMissing(images) {
    if (!images || images.length === 0) return [];
    const checks = images.slice(0, 30).map(async (src, idx) => {
        // 네이버 지도 이미지는 외부 접근 차단되므로 정상으로 간주
        if (isNaverMapImage(src)) {
            return { src, idx, ok: true, status: 200, type: 'map' };
        }
        try {
            const res = await fetch(src, {
                method: 'GET',
                headers: {
                    'User-Agent': UA,
                    'Referer': 'https://m.blog.naver.com/',
                    'Range': 'bytes=0-1023',
                },
                signal: AbortSignal.timeout(5000),
            });
            const ok = res.ok || res.status === 206;
            return { src, idx, ok, status: res.status };
        } catch (e) {
            return { src, idx, ok: false, status: 0 };
        }
    });
    return Promise.all(checks);
}

// 공감(좋아요) 수: 네이버 별도 API로 조회
async function fetchLikeCount(blogId, logNo) {
    try {
        const q = `BLOG[${blogId}_${logNo}]`;
        const url = `https://blog.like.naver.com/v1/search/contents?suffix=blog&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json', 'User-Agent': UA },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return 0;
        const data = await res.json();
        const content = (data.contents || [])[0];
        if (!content) return 0;
        const likeReaction = (content.reactions || []).find(r => r.reactionType === 'like');
        return likeReaction ? (likeReaction.count || 0) : 0;
    } catch (e) {
        return 0;
    }
}

// 링크가 네이버 내부(*.naver.com)인지 판별
function isInternalNaverLink(href) {
    try {
        const u = new URL(href);
        const host = u.hostname.toLowerCase();
        return host === 'naver.com' || host.endsWith('.naver.com');
    } catch (e) { return false; }
}

// 제목 기반 핵심 키워드 자동 추출 (제목 + 본문 빈도 검증)
function extractCoreKeywords(title, bodyText, topN = 3) {
    if (!title || !bodyText) return [];
    const STOPWORDS = new Set(['추천','후기','가는법','가격','정보','정리','BEST','best','TOP','top','솔직한','진짜','진심','확인','방법','이용','경험','체험','소개','안내','오늘','어제','내일','이번','요즘','정말','매우','너무','가장','제대로','즐기기','즐겁다','입니다','했다','한다','됩니다','있다','없다']);
    const candidates = new Map();
    const cleanTitle = title.replace(/[\[\](){}「」『』<>!?.,~`'":;|@#$%^&*+=]/g, ' ').replace(/\s+/g, ' ').trim();
    const titleWords = cleanTitle.split(/\s+/).filter(w => w.length >= 2 && !STOPWORDS.has(w));

    // 단일 단어 (3자 이상)
    for (const w of titleWords) if (w.length >= 3) candidates.set(w, 0);

    // 인접 2단어 조합
    for (let i = 0; i < titleWords.length - 1; i++) {
        const pair = `${titleWords[i]} ${titleWords[i+1]}`;
        if (pair.length >= 5 && pair.length <= 20) candidates.set(pair, 0);
    }

    // 인접 3단어 조합
    for (let i = 0; i < titleWords.length - 2; i++) {
        const trio = `${titleWords[i]} ${titleWords[i+1]} ${titleWords[i+2]}`;
        if (trio.length <= 25) candidates.set(trio, 0);
    }

    // 본문 빈도로 점수 부여
    for (const [kw, _] of candidates) {
        const escKw = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escKw, 'g');
        const count = (bodyText.match(regex) || []).length;
        candidates.set(kw, kw.length * count);
    }

    // 점수 순 정렬 + 중복 제거
    const sorted = Array.from(candidates.entries()).filter(([_, s]) => s >= 2).sort((a, b) => b[1] - a[1]);
    const result = [];
    for (const [kw, _] of sorted) {
        if (result.length >= topN) break;
        const redundant = result.some(r => r.includes(kw) || kw.includes(r));
        if (!redundant) result.push(kw);
    }
    return result;
}

// 키워드별 검색 순위 측정
async function checkKeywordRank(keyword, blogId, logNo, clientId, clientSecret) {
    const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(keyword)}&display=100&sort=sim`;
    try {
        const res = await fetch(url, {
            headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { keyword, rank: null, total: 0 };
        const data = await res.json();
        const items = data.items || [];
        for (let i = 0; i < items.length; i++) {
            const link = items[i].link || '';
            let itemLogNo = '', itemBlogId = '';
            try {
                const u = new URL(link);
                const seg = u.pathname.split('/').filter(Boolean);
                if (seg[0] === 'PostView.naver' || seg[0] === 'PostView.nhn') {
                    itemBlogId = (u.searchParams.get('blogId') || '').toLowerCase();
                    itemLogNo = u.searchParams.get('logNo') || '';
                } else {
                    itemBlogId = (seg[0] || '').toLowerCase();
                    itemLogNo = (seg[1] && /^\d+$/.test(seg[1]) ? seg[1] : '');
                }
            } catch (e) {}
            if (itemLogNo === logNo && itemBlogId === blogId) {
                return { keyword, rank: i + 1, total: data.total || 0 };
            }
        }
        return { keyword, rank: null, total: data.total || 0 };
    } catch (e) {
        return { keyword, rank: null, total: 0, error: e.message };
    }
}

// 핵심 키워드 3개 추출 + 각각 순위 병렬 측정
async function checkCoreKeywordRanks(title, bodyText, blogId, logNo, clientId, clientSecret) {
    const keywords = extractCoreKeywords(title, bodyText, 3);
    if (keywords.length === 0) return [];
    return Promise.all(keywords.map(kw => checkKeywordRank(kw, blogId, logNo, clientId, clientSecret)));
}

// 노출 진단 (정확 구문 검색)
async function checkExposed(title, blogId, logNo, clientId, clientSecret) {
    const safe = title.replace(/["']/g, '').trim();
    if (!safe) return { exposed: false, reason: '제목 없음' };
    // ① 정확구문 → ② 따옴표 없는 원제목(특수문자 제목 오탐 방지). 2단계까지만.
    const queryPlan = [`"${safe}"`, safe];

    let lastTotal = 0;
    let apiError = null;
    for (const query of queryPlan) {
        const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&display=100&sort=sim`;
        const res = await fetch(url, {
            headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
        });
        if (!res.ok) { apiError = `검색API ${res.status}`; continue; }
        const data = await res.json();
        const items = data.items || [];
        lastTotal = data.total || 0;
        for (let i = 0; i < items.length; i++) {
            const link = items[i].link || '';
            // logNo 추출
            let itemLogNo = '';
            try {
                const u = new URL(link);
                const seg = u.pathname.split('/').filter(Boolean);
                itemLogNo = u.searchParams.get('logNo') || (seg[1] && /^\d+$/.test(seg[1]) ? seg[1] : '');
            } catch (e) {}
            const itemBlogId = (() => {
                try {
                    const u = new URL(link);
                    const seg = u.pathname.split('/').filter(Boolean);
                    if (seg[0] === 'PostView.naver' || seg[0] === 'PostView.nhn') {
                        return (u.searchParams.get('blogId') || '').toLowerCase();
                    }
                    return (seg[0] || '').toLowerCase();
                } catch (e) { return ''; }
            })();
            if (itemLogNo === logNo && itemBlogId === blogId) {
                return { exposed: true, rank: i + 1 };
            }
        }
    }
    if (apiError && lastTotal === 0) return { exposed: null, reason: apiError };
    return { exposed: false, totalResults: lastTotal };
}

export async function onRequestOptions() {
    return new Response('', { status: 200, headers: corsHeaders });
}

export async function onRequestPost({ request, env }) {
    const clientId = env.NAVER_SEARCH_CLIENT_ID;
    const clientSecret = env.NAVER_SEARCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        return jsonResponse({ error: '서버에 검색 API 키가 설정되지 않았습니다.' }, 500);
    }

    try {
        const { url } = await request.json();
        if (!url) return jsonResponse({ error: '글 URL을 입력해주세요.' }, 400);

        const parsed = parseNaverPostUrl(url);
        if (!parsed) return jsonResponse({ error: '네이버 블로그 글 URL 형식이 아닙니다. (예: https://blog.naver.com/myid/12345)' }, 400);

        const { blogId, logNo } = parsed;

        // 1. HTML 가져오기
        const html = await fetchPostHtml(blogId, logNo);

        // 2. 메타 + 본문 추출
        const meta = extractPostMeta(html);
        const body = analyzeBody(meta.bodyHtml);

        // 3. 형태소 / 키워드
        const keywords = extractKeywords(body.text, 12);

        // 4. 금칙어 검사
        const forbidden = checkForbiddenWords(body.text);

        // 5. 누락 이미지 검사 (병렬) + 공감 수 별도 API (병렬)
        const [imageChecks, likeCount] = await Promise.all([
            checkImageMissing(body.images),
            fetchLikeCount(blogId, logNo),
        ]);
        const missingImages = imageChecks.filter(c => !c.ok).length;
        meta.sympathyCount = likeCount;

        // 6. 노출 진단 + 핵심 키워드 SEO 순위 (병렬)
        const [exposed, coreKeywordRanks] = await Promise.all([
            checkExposed(meta.title, blogId, logNo, clientId, clientSecret),
            checkCoreKeywordRanks(meta.title, body.text, blogId, logNo, clientId, clientSecret),
        ]);

        // 7. 콘텐츠 분석
        const contentAnalysis = analyzeContent(meta, body, keywords);

        // 7-1. 품질 지표 종합 (22가지)
        const qualityInd = analyzeQualityIndicators(meta.title, body, meta.bodyHtml);

        // 8. 글 지수 등급 (검색 노출 + 키워드 순위 반영)
        const aiFit = calculateAIFit(meta, body, keywords, contentAnalysis, forbidden, missingImages, qualityInd, exposed, coreKeywordRanks);

        return jsonResponse({
            url,
            blogId,
            logNo,
            title: meta.title,
            description: meta.description,
            publishDate: meta.publishDate,
            stats: {
                textLength: body.text.length,
                imageCount: body.images.length,
                videoCount: body.videos,
                linkCount: body.links.length,
                externalLinkCount: body.links.filter(l => !isInternalNaverLink(l.href)).length,
                missingImageCount: missingImages,
                commentCount: meta.commentCount || 0,
                sympathyCount: meta.sympathyCount || 0,
            },
            exposed,
            coreKeywordRanks,
            bodyText: body.text.substring(0, 2000),
            images: imageChecks,
            videos: body.videos,
            links: body.links,
            keywords,
            forbidden,
            contentAnalysis,
            aiFit,
            timestamp: new Date().toISOString(),
        });
    } catch (e) {
        return jsonResponse({ error: e.message || '서버 오류' }, 500);
    }
}
