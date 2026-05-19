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

// AI-Fit 등급 산정 (100점 만점)
function calculateAIFit(meta, body, kw, contentAnalysis, forbiddenResult, missingImages) {
    let score = 100;
    const breakdown = [];

    // 1. 글자수 (-30 ~ 0)
    const textLen = body.text.length;
    if (textLen < 400) { score -= 30; breakdown.push({ name: '글자수 부족', delta: -30 }); }
    else if (textLen < 800) { score -= 15; breakdown.push({ name: '글자수 보통 (800자 미만)', delta: -15 }); }
    else if (textLen < 1500) { score -= 5; breakdown.push({ name: '글자수 양호', delta: -5 }); }

    // 2. 이미지 (-20 ~ 0)
    const imgCnt = body.images.length;
    if (imgCnt === 0) { score -= 20; breakdown.push({ name: '이미지 없음', delta: -20 }); }
    else if (imgCnt < 3) { score -= 10; breakdown.push({ name: '이미지 부족 (3개 미만)', delta: -10 }); }

    // 3. 누락 이미지 (-15 ~ 0)
    if (missingImages > 0) {
        const penalty = Math.min(15, missingImages * 3);
        score -= penalty;
        breakdown.push({ name: `누락 이미지 ${missingImages}개`, delta: -penalty });
    }

    // 4. 키워드 다양성 (-15 ~ 0)
    const kwUniq = kw.length;
    if (kwUniq < 4) { score -= 15; breakdown.push({ name: '키워드 다양성 낮음', delta: -15 }); }
    else if (kwUniq < 8) { score -= 7; breakdown.push({ name: '키워드 다양성 보통', delta: -7 }); }

    // 5. 금칙어 (-30 ~ 0)
    if (forbiddenResult.hits.length > 0) {
        const penalty = Math.min(30, forbiddenResult.hits.length * 8);
        score -= penalty;
        breakdown.push({ name: `금칙어 ${forbiddenResult.hits.length}건`, delta: -penalty });
    }

    // 6. 외부링크 과다 (-10 ~ 0)
    const externalCnt = body.links.filter(l => !isInternalNaverLink(l.href)).length;
    if (externalCnt > 5) { score -= 10; breakdown.push({ name: '외부링크 과다', delta: -10 }); }

    score = Math.max(0, Math.min(100, score));

    // 등급 매핑
    let grade;
    if (score >= 90) grade = 'S';
    else if (score >= 80) grade = 'A';
    else if (score >= 65) grade = 'B';
    else if (score >= 50) grade = 'C';
    else if (score >= 35) grade = 'D';
    else if (score >= 20) grade = 'E';
    else grade = 'F';

    const gradeDesc = {
        'S': '황금 콘텐츠 — 모든 항목 우수',
        'A': '매우 우수한 콘텐츠',
        'B': '양호한 콘텐츠',
        'C': '준최적 — 일부 보강 필요',
        'D': '평균 이하 — 다수 개선 필요',
        'E': '품질 부족 — 대대적 개선 권장',
        'F': '심각 — 재작성 권장',
    }[grade];

    return { score, grade, gradeDesc, breakdown };
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

// 노출 진단 (정확 구문 검색)
async function checkExposed(title, blogId, logNo, clientId, clientSecret) {
    const safe = title.replace(/["']/g, '').trim();
    if (!safe) return { exposed: false, reason: '제목 없음' };
    const query = `"${safe}"`;
    const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&display=100&sort=sim`;
    const res = await fetch(url, {
        headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
    });
    if (!res.ok) return { exposed: null, reason: `검색API ${res.status}` };
    const data = await res.json();
    const items = data.items || [];

    const targetMatch = `${blogId}/${logNo}`;
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
    return { exposed: false, totalResults: data.total || 0 };
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

        // 6. 노출 진단
        const exposed = await checkExposed(meta.title, blogId, logNo, clientId, clientSecret);

        // 7. 콘텐츠 분석
        const contentAnalysis = analyzeContent(meta, body, keywords);

        // 8. AI-Fit 등급
        const aiFit = calculateAIFit(meta, body, keywords, contentAnalysis, forbidden, missingImages);

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
