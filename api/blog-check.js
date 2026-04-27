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

// ===== 블로그 글 페이지에서 제목 추출 =====
function fetchPostTitle(postUrl) {
    return new Promise((resolve, reject) => {
        let url;
        try { url = new URL(postUrl); }
        catch (e) { return reject(new Error('잘못된 URL 형식')); }

        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html',
                'Accept-Language': 'ko-KR,ko;q=0.9',
            },
        };

        const req = https.request(options, (res) => {
            // blog.naver.com → m.blog.naver.com 등 리다이렉트 1회만 추적
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const next = res.headers.location.startsWith('http')
                    ? res.headers.location
                    : `https://${url.hostname}${res.headers.location}`;
                return fetchPostTitle(next).then(resolve, reject);
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const html = Buffer.concat(chunks).toString('utf-8');
                // og:title 우선, 없으면 <title>
                let title = '';
                const ogMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
                if (ogMatch) title = ogMatch[1];
                else {
                    const tMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
                    if (tMatch) title = tMatch[1];
                }
                title = title.replace(/\s*[:|·\-]\s*네이버\s*블로그\s*$/i, '').trim();
                if (!title) return reject(new Error('제목을 찾을 수 없습니다'));
                resolve(title);
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

        // ===== (B) missing: 특정 글 누락 진단 =====
        if (mode === 'missing') {
            if (!postUrl) return res.status(400).json({ error: '블로그 글 URL을 입력해주세요.' });

            const targetNorm = normalizePostUrl(postUrl);
            const targetBlogId = extractBlogIdFromLink(postUrl);

            // 1. 글 제목 추출
            let title;
            try {
                title = await fetchPostTitle(postUrl);
            } catch (e) {
                return res.status(400).json({ error: `글 제목을 가져올 수 없습니다: ${e.message}` });
            }

            // 2. 검색 쿼리 후보 만들기
            // 전체 제목, 그리고 제목 앞 20자 (긴 경우)
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

            // 3. 진단
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

            return res.status(200).json({
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

        return res.status(400).json({ error: 'mode는 "rank" 또는 "missing"이어야 합니다.' });

    } catch (error) {
        return res.status(500).json({ error: `서버 오류: ${error.message}` });
    }
};
