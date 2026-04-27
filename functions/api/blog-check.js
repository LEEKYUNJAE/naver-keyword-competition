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

// ===== 글 페이지에서 제목 추출 =====
async function fetchPostTitle(postUrl, depth = 0) {
    if (depth > 2) throw new Error('리다이렉트 한도 초과');
    let url;
    try { url = new URL(postUrl); }
    catch (e) { throw new Error('잘못된 URL 형식'); }

    const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html',
            'Accept-Language': 'ko-KR,ko;q=0.9',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    let title = '';
    const ogMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
    if (ogMatch) title = ogMatch[1];
    else {
        const tMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (tMatch) title = tMatch[1];
    }
    title = title.replace(/\s*[:|·\-]\s*네이버\s*블로그\s*$/i, '').trim();
    if (!title) throw new Error('제목을 찾을 수 없습니다');
    return title;
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
        return (seg[0] || '').toLowerCase();
    } catch (e) { return ''; }
}

function normalizePostUrl(link) {
    if (!link) return '';
    try {
        const u = new URL(link);
        const host = u.hostname.replace(/^m\./, '');
        if (host !== 'blog.naver.com') return link.toLowerCase();
        const seg = u.pathname.split('/').filter(Boolean);
        const id = (seg[0] || '').toLowerCase();
        const postId = seg[1] || '';
        return `blog.naver.com/${id}/${postId}`;
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

        // ===== (B) missing 모드 =====
        if (mode === 'missing') {
            if (!postUrl) return jsonResponse({ error: '블로그 글 URL을 입력해주세요.' }, 400);

            const targetNorm = normalizePostUrl(postUrl);
            const targetBlogId = extractBlogIdFromLink(postUrl);

            let title;
            try { title = await fetchPostTitle(postUrl); }
            catch (e) { return jsonResponse({ error: `글 제목을 가져올 수 없습니다: ${e.message}` }, 400); }

            const queries = [title];
            if (title.length > 25) queries.push(title.substring(0, 20));

            const checks = [];
            for (const q of queries) {
                try {
                    const data = await searchBlog(q, clientId, clientSecret, 100, 1);
                    const items = data.items || [];
                    let foundRank = -1;
                    for (let i = 0; i < items.length; i++) {
                        if (normalizePostUrl(items[i].link) === targetNorm) {
                            foundRank = i + 1;
                            break;
                        }
                    }
                    checks.push({
                        query: q,
                        rank: foundRank,
                        totalResults: data.total || 0,
                        topItems: items.slice(0, 3).map(it => ({
                            title: (it.title || '').replace(/<[^>]+>/g, ''),
                            blogId: extractBlogIdFromLink(it.link),
                            link: it.link,
                        })),
                    });
                    await new Promise(r => setTimeout(r, 100));
                } catch (e) {
                    checks.push({ query: q, rank: -1, totalResults: 0, error: e.message });
                }
            }

            const exposedAnywhere = checks.some(c => c.rank > 0);
            let verdict, verdictDesc;
            if (exposedAnywhere) {
                const bestCheck = checks.find(c => c.rank > 0);
                verdict = '정상 노출';
                verdictDesc = `제목 검색 시 ${bestCheck.rank}위에 노출됩니다.`;
            } else {
                verdict = '누락 의심';
                verdictDesc = '제목으로 검색해도 100위 안에 노출되지 않습니다. 저품질/스팸 필터링 가능성이 있으나, 키워드 경쟁이 매우 치열한 경우에도 발생할 수 있습니다.';
            }

            return jsonResponse({
                mode: 'missing',
                postUrl,
                blogId: targetBlogId,
                title,
                checks,
                verdict,
                verdictDesc,
                timestamp: new Date().toISOString(),
            });
        }

        return jsonResponse({ error: 'mode는 "rank" 또는 "missing"이어야 합니다.' }, 400);

    } catch (error) {
        return jsonResponse({ error: `서버 오류: ${error.message}` }, 500);
    }
}
