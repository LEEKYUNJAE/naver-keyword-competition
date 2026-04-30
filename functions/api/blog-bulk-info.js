// Cloudflare Pages Function: 블로그 대량 조회
// 라우트: POST /api/blog-bulk-info
// 입력: { blogIds: ["lovekyunjae", "mckyunjae", ...] } (최대 20개)
// 출력: 블로그별 정보 + 최근 10개 글 노출 진단 + 인플루언서 여부

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

// HTML 엔티티 디코드 (간단한 케이스만)
function decodeEntities(s) {
    if (!s) return '';
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

// ===== 검색 API (정확 구문 검색용) =====
async function searchBlogExact(title, clientId, clientSecret) {
    const safe = title.replace(/["']/g, '').trim();
    const query = `"${safe}"`;
    const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&display=100&sort=sim`;
    const res = await fetch(url, {
        headers: {
            'X-Naver-Client-Id': clientId,
            'X-Naver-Client-Secret': clientSecret,
        },
    });
    if (!res.ok) throw new Error(`검색API ${res.status}`);
    return res.json();
}

function extractBlogIdFromLink(link) {
    if (!link) return '';
    try {
        const u = new URL(link);
        const host = u.hostname.replace(/^m\./, '');
        if (host !== 'blog.naver.com') return '';
        const seg = u.pathname.split('/').filter(Boolean);
        const first = seg[0] || '';
        if (first === 'PostView.naver' || first === 'PostView.nhn') {
            return (u.searchParams.get('blogId') || '').toLowerCase();
        }
        return first.toLowerCase();
    } catch (e) { return ''; }
}

// ===== RSS에서 최근 글 + pubDate 추출 =====
async function fetchRSS(blogId, limit = 10) {
    const url = `https://rss.blog.naver.com/${encodeURIComponent(blogId)}.xml`;
    const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`RSS ${res.status}`);
    const xml = await res.text();

    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    const allPosts = [];
    let m;
    while ((m = itemRegex.exec(xml)) !== null) {
        const block = m[1];
        const titleMatch = block.match(/<title>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/);
        const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
        const pubMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
        if (titleMatch && linkMatch) {
            const title = decodeEntities((titleMatch[1] || titleMatch[2] || '').trim());
            const link = linkMatch[1].trim();
            const pubDate = pubMatch ? new Date(pubMatch[1].trim()) : null;
            if (title && link) allPosts.push({ title, link, pubDate });
        }
    }
    return allPosts.slice(0, limit);
}

// ===== 블로그 홈 HTML에서 메타 정보 추출 (모바일 페이지) =====
async function fetchBlogMeta(blogId) {
    const url = `https://m.blog.naver.com/${encodeURIComponent(blogId)}`;
    const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTML ${res.status}`);
    const html = await res.text();

    const meta = {};

    // 닉네임: og:title 또는 _nickname 클래스
    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
    if (ogTitle) meta.nickname = decodeEntities(ogTitle[1]).replace(/'s blog$/i, '').replace(/의 블로그$/, '').trim();

    // 닉네임 fallback: <strong class="nickname">...</strong>
    if (!meta.nickname) {
        const nickMatch = html.match(/class=["'][^"']*nick(?:name)?[^"']*["'][^>]*>([^<]+)</i);
        if (nickMatch) meta.nickname = decodeEntities(nickMatch[1].trim());
    }

    // 인플루언서 여부: 모바일 페이지에 인플루언서 뱃지/배너 키워드
    meta.isInfluencer = /인플루언서/.test(html) || /influencer/i.test(html) && !/influencer-banner-promo/i.test(html);

    // og:description에서 카테고리/주제 단서
    const ogDesc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
    if (ogDesc) meta.description = decodeEntities(ogDesc[1]);

    return meta;
}

// ===== 인플루언서 프로필 페이지 존재 여부 확인 (보조) =====
async function checkInfluencer(blogId) {
    try {
        const url = `https://in.naver.com/${encodeURIComponent(blogId)}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(5000),
            redirect: 'manual',
        });
        // 200 또는 영구 리다이렉트면 존재로 간주, 404면 미인플루언서
        if (res.status === 200) return true;
        if (res.status === 301 || res.status === 302 || res.status === 308) return true;
        return false;
    } catch (e) {
        return null; // 오류는 unknown
    }
}

// ===== URL 정규화 (글 매칭용) =====
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

// ===== 단일 블로그 분석 =====
async function analyzeBlog(blogId, clientId, clientSecret) {
    const result = {
        blogId,
        nickname: null,
        isInfluencer: null,
        description: null,
        postCount30Days: 0,
        lastPostDate: null,
        posts: [],
        exposedCount: 0,
        missingCount: 0,
        verdict: null,
        verdictDesc: null,
        errors: [],
    };

    // 1. 메타 정보 + RSS 병렬
    const [metaRes, rssRes, infRes] = await Promise.allSettled([
        fetchBlogMeta(blogId),
        fetchRSS(blogId, 10),
        checkInfluencer(blogId),
    ]);

    if (metaRes.status === 'fulfilled') {
        result.nickname = metaRes.value.nickname || null;
        result.description = metaRes.value.description || null;
        if (metaRes.value.isInfluencer) result.isInfluencer = true;
    } else {
        result.errors.push(`HTML: ${metaRes.reason?.message || 'fail'}`);
    }

    // 인플루언서 별도 확인 (in.naver.com 우선)
    if (infRes.status === 'fulfilled' && infRes.value !== null) {
        result.isInfluencer = infRes.value;
    }

    let posts = [];
    if (rssRes.status === 'fulfilled') {
        posts = rssRes.value;
        // 최근 30일 글수
        const now = Date.now();
        const cutoff = now - 30 * 24 * 60 * 60 * 1000;
        result.postCount30Days = posts.filter(p => p.pubDate && p.pubDate.getTime() >= cutoff).length;
        if (posts.length > 0 && posts[0].pubDate) {
            result.lastPostDate = posts[0].pubDate.toISOString().slice(0, 10);
        }
    } else {
        result.errors.push(`RSS: ${rssRes.reason?.message || 'fail'}`);
    }

    // 2. 각 글 노출 진단 (정확 구문 검색)
    if (posts.length > 0) {
        for (const post of posts) {
            const postRes = {
                title: post.title,
                link: post.link,
                pubDate: post.pubDate ? post.pubDate.toISOString().slice(0, 10) : null,
                rank: -1,
                status: 'pending',
            };
            try {
                const data = await searchBlogExact(post.title, clientId, clientSecret);
                const items = data.items || [];
                const targetNorm = normalizePostUrl(post.link);
                let foundRank = -1;
                for (let i = 0; i < items.length; i++) {
                    if (normalizePostUrl(items[i].link) === targetNorm) {
                        foundRank = i + 1;
                        break;
                    }
                }
                // fallback: 같은 블로그 ID 매칭
                if (foundRank === -1) {
                    for (let i = 0; i < items.length; i++) {
                        if (extractBlogIdFromLink(items[i].link) === blogId) {
                            foundRank = i + 1;
                            break;
                        }
                    }
                }
                postRes.rank = foundRank;
                postRes.status = foundRank > 0 ? 'exposed' : 'missing';
            } catch (e) {
                postRes.status = 'error';
                postRes.error = e.message;
                result.errors.push(`${post.title.substring(0, 20)}: ${e.message}`);
            }
            result.posts.push(postRes);
            await new Promise(r => setTimeout(r, 100));
        }

        result.exposedCount = result.posts.filter(p => p.status === 'exposed').length;
        result.missingCount = result.posts.filter(p => p.status === 'missing').length;

        const total = result.posts.length;
        const rate = total > 0 ? result.exposedCount / total : 0;
        if (rate >= 0.9) { result.verdict = '건강'; result.verdictDesc = '정상 인덱스'; }
        else if (rate >= 0.7) { result.verdict = '주의'; result.verdictDesc = '일부 누락'; }
        else if (rate >= 0.3) { result.verdict = '경고'; result.verdictDesc = '누락 다수'; }
        else if (rate > 0) { result.verdict = '위험'; result.verdictDesc = '저품질 강력 의심'; }
        else { result.verdict = '치명'; result.verdictDesc = '저품질 확정 가능성'; }
    } else {
        result.verdict = '조회 불가';
        result.verdictDesc = '비공개 블로그거나 RSS 가져오기 실패';
    }

    return result;
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
        const { blogIds } = await request.json();
        if (!Array.isArray(blogIds) || blogIds.length === 0) {
            return jsonResponse({ error: '블로그 ID를 1개 이상 입력해주세요.' }, 400);
        }
        if (blogIds.length > 20) {
            return jsonResponse({ error: '블로그 ID는 최대 20개까지 가능합니다.' }, 400);
        }

        const ids = [...new Set(blogIds.map(normalizeBlogId).filter(Boolean))];
        const results = [];
        // 블로그 단위 순차 처리 (각 블로그 내부에서 메타/RSS/인플루언서는 병렬, 글 진단은 순차)
        for (const id of ids) {
            try {
                const r = await analyzeBlog(id, clientId, clientSecret);
                results.push(r);
            } catch (e) {
                results.push({
                    blogId: id,
                    nickname: null,
                    isInfluencer: null,
                    posts: [],
                    verdict: '조회 불가',
                    verdictDesc: e.message,
                    errors: [e.message],
                });
            }
        }

        return jsonResponse({
            count: results.length,
            results,
            timestamp: new Date().toISOString(),
        });
    } catch (e) {
        return jsonResponse({ error: e.message || '서버 오류' }, 500);
    }
}
