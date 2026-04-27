const https = require('https');

// ===== 네이버 검색 API: 블로그 검색 (display 최대 100) =====
function searchBlog(keyword, clientId, clientSecret, display = 100, start = 1) {
    return new Promise((resolve, reject) => {
        const path = `/v1/search/blog.json?query=${encodeURIComponent(keyword)}&display=${display}&start=${start}&sort=sim`;
        const options = {
            hostname: 'openapi.naver.com',
            path,
            method: 'GET',
            headers: {
                'X-Naver-Client-Id': clientId,
                'X-Naver-Client-Secret': clientSecret,
            },
        };
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const data = Buffer.concat(chunks).toString('utf-8');
                if (res.statusCode === 200) {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error('파싱 오류')); }
                } else {
                    reject(new Error(`검색 API ${res.statusCode}: ${data.substring(0, 200)}`));
                }
            });
        });
        req.on('error', (e) => reject(new Error('네트워크: ' + e.message)));
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('시간 초과')); });
        req.end();
    });
}

// ===== 네이버 블로그 RSS에서 최근 글 목록 추출 =====
function fetchBlogRecentPosts(blogId, limit = 10) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'rss.blog.naver.com',
            path: `/${encodeURIComponent(blogId)}.xml`,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/rss+xml, application/xml, text/xml',
            },
        };
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`RSS 가져오기 실패 (${res.statusCode}). 블로그 ID 확인 필요.`));
                }
                const xml = Buffer.concat(chunks).toString('utf-8');
                const itemRegex = /<item>([\s\S]*?)<\/item>/g;
                const posts = [];
                let m;
                while ((m = itemRegex.exec(xml)) !== null && posts.length < limit) {
                    const block = m[1];
                    const titleMatch = block.match(/<title>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/);
                    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
                    if (titleMatch && linkMatch) {
                        const title = (titleMatch[1] || titleMatch[2] || '').trim();
                        const link = linkMatch[1].trim();
                        if (title && link) posts.push({ title, link });
                    }
                }
                if (posts.length === 0) return reject(new Error('RSS에서 글을 찾을 수 없습니다. 블로그가 비공개거나 글이 없을 수 있습니다.'));
                resolve(posts);
            });
        });
        req.on('error', (e) => reject(new Error('네트워크: ' + e.message)));
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('시간 초과')); });
        req.end();
    });
}

// ===== 블로그 ID 정규화 =====
// 입력: 'myid' / 'blog.naver.com/myid' / 'https://blog.naver.com/myid' / 'https://blog.naver.com/myid/12345'
// 출력: 'myid' (소문자)
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

// link 필드에서 블로그 ID 추출
// 예: https://blog.naver.com/myid/123  → 'myid'
function extractBlogIdFromLink(link) {
    if (!link) return '';
    try {
        const u = new URL(link);
        const host = u.hostname.replace(/^m\./, '');
        if (host !== 'blog.naver.com') return '';
        const seg = u.pathname.split('/').filter(Boolean);
        return (seg[0] || '').toLowerCase();
    } catch (e) {
        return '';
    }
}

// URL 정규화 (PC/모바일 동일시, postId 비교)
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
    } catch (e) {
        return String(link).toLowerCase();
    }
}

// ===== 메인 핸들러 =====
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const clientId = process.env.NAVER_SEARCH_CLIENT_ID;
    const clientSecret = process.env.NAVER_SEARCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        return res.status(500).json({ error: '서버에 검색 API 키가 설정되지 않았습니다.' });
    }

    try {
        const { mode, blogId, keywords, postUrl } = req.body || {};

        // ===== (A) rank: 키워드별 본인 블로그 노출 순위 =====
        if (mode === 'rank') {
            const id = normalizeBlogId(blogId);
            if (!id) return res.status(400).json({ error: '블로그 ID(또는 URL)을 입력해주세요.' });
            if (!Array.isArray(keywords) || keywords.length === 0)
                return res.status(400).json({ error: '키워드를 1개 이상 입력해주세요.' });
            if (keywords.length > 10)
                return res.status(400).json({ error: '키워드는 최대 10개까지 가능합니다.' });

            const results = [];
            const errors = [];

            for (const kw of keywords) {
                try {
                    // 100개 1회 호출 (네이버 검색 API 최대 display=100, start=1만 사용)
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
                        rank,                            // -1 이면 100위권 밖
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

            return res.status(200).json({
                mode: 'rank',
                blogId: id,
                results,
                errors: errors.length > 0 ? errors : undefined,
                timestamp: new Date().toISOString(),
            });
        }

        // ===== (B) missing: 블로그 ID로 최근 10개 글 일괄 누락 진단 =====
        if (mode === 'missing') {
            const id = normalizeBlogId(blogId);
            if (!id) return res.status(400).json({ error: '블로그 ID를 입력해주세요.' });

            let posts;
            try { posts = await fetchBlogRecentPosts(id, 10); }
            catch (e) { return res.status(400).json({ error: e.message }); }

            const results = [];
            const errors = [];
            for (const post of posts) {
                const targetNorm = normalizePostUrl(post.link);
                try {
                    const data = await searchBlog(post.title, clientId, clientSecret, 100, 1);
                    const items = data.items || [];
                    let foundRank = -1;
                    for (let i = 0; i < items.length; i++) {
                        if (normalizePostUrl(items[i].link) === targetNorm) {
                            foundRank = i + 1;
                            break;
                        }
                    }
                    results.push({
                        title: post.title,
                        link: post.link,
                        rank: foundRank,
                        totalResults: data.total || 0,
                        status: foundRank > 0 ? 'exposed' : 'missing',
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

            const exposedCount = results.filter(r => r.status === 'exposed').length;
            const missingCount = results.filter(r => r.status === 'missing').length;
            const totalCount = results.length;
            const exposedRate = totalCount > 0 ? exposedCount / totalCount : 0;

            let verdict, verdictDesc;
            if (exposedRate >= 0.8) {
                verdict = '건강한 블로그';
                verdictDesc = `최근 ${totalCount}개 중 ${exposedCount}개 정상 노출. 누락 위험 낮음.`;
            } else if (exposedRate >= 0.5) {
                verdict = '부분 누락';
                verdictDesc = `최근 ${totalCount}개 중 ${missingCount}개 누락 의심. 일부 글에 SEO/품질 문제 가능성.`;
            } else if (exposedRate > 0) {
                verdict = '누락 다수';
                verdictDesc = `최근 ${totalCount}개 중 ${missingCount}개 누락 의심. 저품질 필터링 가능성 검토 필요.`;
            } else {
                verdict = '저품질 의심';
                verdictDesc = `최근 글 대부분이 100위 안에 노출되지 않음. 저품질 블로그 필터링 가능성 높음.`;
            }

            return res.status(200).json({
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

        return res.status(400).json({ error: 'mode는 "rank" 또는 "missing"이어야 합니다.' });

    } catch (error) {
        return res.status(500).json({ error: `서버 오류: ${error.message}` });
    }
};
