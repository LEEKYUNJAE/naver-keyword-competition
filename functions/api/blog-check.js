// Cloudflare Pages Function: 내 블로그 진단 (순위 / 누락)
// 라우트: POST /api/blog-check

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
};

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: corsHeaders });
}

// ===== 네이버 검색 API: 블로그 검색 =====
async function searchBlog(keyword, clientId, clientSecret, display = 100, start = 1) {
    const path = `/v1/search/blog.json?query=${encodeURIComponent(keyword)}&display=${display}&start=${start}&sort=sim`;
    const res = await fetch(`https://openapi.naver.com${path}`, {
        method: 'GET',
        headers: {
            'X-Naver-Client-Id': clientId,
            'X-Naver-Client-Secret': clientSecret,
        },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`검색 API ${res.status}: ${text.substring(0, 200)}`);
    return JSON.parse(text);
}

// ===== 네이버 블로그 RSS에서 최근 글 목록 추출 =====
async function fetchBlogRecentPosts(blogId, limit = 10) {
    const rssUrl = `https://rss.blog.naver.com/${encodeURIComponent(blogId)}.xml`;
    const res = await fetch(rssUrl, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/xml, text/xml',
        },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`RSS 가져오기 실패 (${res.status}). 블로그 ID 확인 필요.`);
    const xml = await res.text();

    // <item>...</item> 블록 추출
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    const posts = [];
    let m;
    while ((m = itemRegex.exec(xml)) !== null && posts.length < limit) {
        const block = m[1];
        // title (CDATA 또는 일반 텍스트)
        const titleMatch = block.match(/<title>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/);
        const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
        if (titleMatch && linkMatch) {
            const title = (titleMatch[1] || titleMatch[2] || '').trim();
            const link = linkMatch[1].trim();
            if (title && link) posts.push({ title, link });
        }
    }
    if (posts.length === 0) throw new Error('RSS에서 글을 찾을 수 없습니다. 블로그가 비공개거나 글이 없을 수 있습니다.');
    return posts;
}

function normalizeBlogId(input) {
    if (!input) return '';
    let s = String(input).trim();
    s = s.replace(/^https?:\/\//, '');
    s = s.replace(/^m\./, '');
    s = s.replace(/^blog\.naver\.com\//, '');
    s = s.split('/')[0];
    s = s.split('?')[0];
    return s.toLowerCase();
}

function extractBlogIdFromLink(link) {
    if (!link) return '';
    try {
        const u = new URL(link);
        const host = u.hostname.replace(/^m\./, '');
        if (host !== 'blog.naver.com') return '';
        const seg = u.pathname.split('/').filter(Boolean);
        const first = seg[0] || '';
        // PostView.naver?blogId=X 형식
        if (first === 'PostView.naver' || first === 'PostView.nhn') {
            return (u.searchParams.get('blogId') || '').toLowerCase();
        }
        return first.toLowerCase();
    } catch (e) { return ''; }
}

// 네이버 블로그 URL을 다양한 형식에서 통일된 키로 정규화
// 지원 형식:
// - blog.naver.com/myid/12345  (RSS / 일반)
// - blog.naver.com/myid?Redirect=Log&logNo=12345  (Search API 응답)
// - blog.naver.com/PostView.naver?blogId=myid&logNo=12345  (구식)
// - m.blog.naver.com/* (모바일)
function normalizePostUrl(link) {
    if (!link) return '';
    try {
        const u = new URL(link);
        const host = u.hostname.replace(/^m\./, '');
        if (host !== 'blog.naver.com') return link.toLowerCase();

        let id = '';
        let postId = u.searchParams.get('logNo') || '';
        const seg = u.pathname.split('/').filter(Boolean);

        if (seg.length > 0) {
            const first = seg[0];
            if (first === 'PostView.naver' || first === 'PostView.nhn') {
                id = (u.searchParams.get('blogId') || '').toLowerCase();
            } else {
                id = first.toLowerCase();
                if (seg.length > 1 && /^\d+$/.test(seg[1])) {
                    postId = postId || seg[1];
                }
            }
        }

        return `${id}/${postId}`;
    } catch (e) { return String(link).toLowerCase(); }
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
        const { mode, blogId, keywords, postUrl } = await request.json();

        // ===== (A) rank 모드 =====
        if (mode === 'rank') {
            const id = normalizeBlogId(blogId);
            if (!id) return jsonResponse({ error: '블로그 ID(또는 URL)을 입력해주세요.' }, 400);
            if (!Array.isArray(keywords) || keywords.length === 0)
                return jsonResponse({ error: '키워드를 1개 이상 입력해주세요.' }, 400);
            if (keywords.length > 10)
                return jsonResponse({ error: '키워드는 최대 10개까지 가능합니다.' }, 400);

            const results = [];
            const errors = [];

            for (const kw of keywords) {
                try {
                    const data = await searchBlog(kw, clientId, clientSecret, 100, 1);
                    const items = data.items || [];
                    let rank = -1;
                    let matchedTitle = '';
                    let matchedLink = '';
                    for (let i = 0; i < items.length; i++) {
                        const linkId = extractBlogIdFromLink(items[i].link);
                        const bnId = normalizeBlogId(items[i].bloggerlink || '');
                        if (linkId === id || bnId === id) {
                            rank = i + 1;
                            matchedTitle = (items[i].title || '').replace(/<[^>]+>/g, '');
                            matchedLink = items[i].link;
                            break;
                        }
                    }
                    results.push({
                        keyword: kw,
                        rank,
                        total: data.total || 0,
                        matchedTitle,
                        matchedLink,
                        status: rank > 0 ? 'exposed' : 'not_exposed',
                    });
                    await new Promise(r => setTimeout(r, 100));
                } catch (e) {
                    errors.push(`${kw}: ${e.message}`);
                    results.push({ keyword: kw, rank: -1, total: 0, status: 'error', error: e.message });
                }
            }

            return jsonResponse({
                mode: 'rank',
                blogId: id,
                results,
                errors: errors.length > 0 ? errors : undefined,
                timestamp: new Date().toISOString(),
            });
        }

        // ===== (B) missing 모드: 블로그 ID로 최근 10개 글 일괄 진단 =====
        if (mode === 'missing') {
            const id = normalizeBlogId(blogId);
            if (!id) return jsonResponse({ error: '블로그 ID를 입력해주세요.' }, 400);

            // 1. RSS에서 최근 10개 글 목록 가져오기
            let posts;
            try { posts = await fetchBlogRecentPosts(id, 10); }
            catch (e) { return jsonResponse({ error: e.message }, 400); }

            // 2. 각 글마다 "제목 전체" 정확 일치 검색 → 인덱스 여부 판별
            //    (쌍따옴표로 감싸면 네이버가 정확 구문 검색 → 동일 제목 글만 결과에 나옴)
            const results = [];
            const errors = [];
            for (const post of posts) {
                const targetNorm = normalizePostUrl(post.link);
                // 제목에서 쌍따옴표 제거 후 정확 구문 검색 쿼리 생성
                const safeTitle = post.title.replace(/["']/g, '').trim();
                const exactQuery = `"${safeTitle}"`;
                try {
                    const data = await searchBlog(exactQuery, clientId, clientSecret, 100, 1);
                    const items = data.items || [];
                    let foundRank = -1;
                    // URL 매칭 (정확 구문 검색이라 동일 블로그·동일 제목 글이 거의 무조건 상위)
                    for (let i = 0; i < items.length; i++) {
                        if (normalizePostUrl(items[i].link) === targetNorm) {
                            foundRank = i + 1;
                            break;
                        }
                    }
                    // fallback: 같은 블로그 ID 매칭 (URL 형식 변형 대비)
                    if (foundRank === -1) {
                        for (let i = 0; i < items.length; i++) {
                            if (extractBlogIdFromLink(items[i].link) === id) {
                                foundRank = i + 1;
                                break;
                            }
                        }
                    }
                    results.push({
                        title: post.title,
                        link: post.link,
                        rank: foundRank,
                        totalResults: data.total || 0,
                        status: foundRank > 0 ? 'exposed' : 'missing',
                        debug: foundRank === -1 ? {
                            query: exactQuery,
                            rssLink: post.link,
                            rssNorm: targetNorm,
                            apiTop3: items.slice(0, 3).map(it => ({
                                link: it.link,
                                norm: normalizePostUrl(it.link),
                                title: (it.title || '').replace(/<[^>]+>/g, ''),
                                blogId: extractBlogIdFromLink(it.link),
                            })),
                        } : undefined,
                    });
                    await new Promise(r => setTimeout(r, 100));
                } catch (e) {
                    errors.push(`${post.title}: ${e.message}`);
                    results.push({
                        title: post.title,
                        link: post.link,
                        rank: -1,
                        totalResults: 0,
                        status: 'error',
                        error: e.message,
                    });
                }
            }

            // 3. 종합 진단
            const exposedCount = results.filter(r => r.status === 'exposed').length;
            const missingCount = results.filter(r => r.status === 'missing').length;
            const totalCount = results.length;

            // 정확 구문 검색(쌍따옴표) 결과 기준이므로 인덱스된 글은 거의 100% 노출되어야 정상
            let verdict, verdictDesc;
            const exposedRate = totalCount > 0 ? exposedCount / totalCount : 0;
            if (exposedRate >= 0.9) {
                verdict = '건강한 블로그';
                verdictDesc = `최근 ${totalCount}개 중 ${exposedCount}개 정상 인덱스. 필터링 위험 낮음.`;
            } else if (exposedRate >= 0.7) {
                verdict = '일부 누락';
                verdictDesc = `최근 ${totalCount}개 중 ${missingCount}개 인덱스 누락. 해당 글들 점검 권장.`;
            } else if (exposedRate >= 0.3) {
                verdict = '누락 다수';
                verdictDesc = `최근 ${totalCount}개 중 ${missingCount}개 인덱스 누락. 저품질 필터링 가능성 있음.`;
            } else if (exposedRate > 0) {
                verdict = '저품질 강력 의심';
                verdictDesc = `최근 ${totalCount}개 중 ${missingCount}개 인덱스 누락. 블로그 전반 필터링 의심.`;
            } else {
                verdict = '저품질 확정 가능성';
                verdictDesc = `최근 글 모두 정확 검색 시 미노출. 블로그 자체가 검색 차단된 상태로 보임.`;
            }

            return jsonResponse({
                mode: 'missing',
                blogId: id,
                results,
                summary: { totalCount, exposedCount, missingCount, exposedRate: Math.round(exposedRate * 100) },
                verdict,
                verdictDesc,
                errors: errors.length > 0 ? errors : undefined,
                timestamp: new Date().toISOString(),
            });
        }

        return jsonResponse({ error: 'mode는 "rank" 또는 "missing"이어야 합니다.' }, 400);

    } catch (error) {
        return jsonResponse({ error: `서버 오류: ${error.message}` }, 500);
    }
}
