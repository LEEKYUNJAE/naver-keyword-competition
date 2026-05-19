// Cloudflare Pages Function: 블로그 분석
// 라우트: POST /api/blog-analysis
// 입력: { blogId, postCount }
// 출력: 블로그 메타 + 통계 + 방문자 추세 + 인플루언서 + 카테고리 + 최근 글

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: corsHeaders });
}

function decodeEntities(s) {
    if (!s) return '';
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

// 모바일 블로그 페이지에서 __INITIAL_STATE__ JSON 추출
async function fetchBlogMobile(blogId) {
    const url = `https://m.blog.naver.com/PostList.naver?blogId=${encodeURIComponent(blogId)}`;
    const res = await fetch(url, {
        headers: { 'User-Agent': MOBILE_UA, 'Accept': 'text/html' },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`블로그 페이지 ${res.status} - 블로그 ID를 확인하세요`);
    const html = await res.text();

    // __INITIAL_STATE__ JSON 추출
    const initMatch = html.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*(?:<\/script>|window\.)/);
    let state = null;
    if (initMatch) {
        try { state = JSON.parse(initMatch[1]); } catch (e) {}
    }

    const data = { blogId, html: html.substring(0, 30000) };
    if (state && state.basicInfo) {
        const b = state.basicInfo;
        data.blogName = b.blogName || '';
        data.nickName = b.nickName || '';
        data.profileImage = b.profileImage || '';
        data.introduction = b.introduction || '';
        data.totalVisitorCount = b.totalVisitorCount || 0;
        data.dayVisitorCount = b.dayVisitorCount || 0;
        data.subscriberCount = b.subscriberCount || 0;
        data.postCount = b.postCount || 0;
        data.themeName = b.themeName || '';
        data.blogCreatedAt = b.blogCreatedAt || '';
    }
    // 백업: HTML 정규식 추출
    if (!data.blogName) {
        const m = html.match(/"blogName"\s*:\s*"([^"]+)"/);
        if (m) data.blogName = m[1];
    }
    if (!data.nickName) {
        const m = html.match(/"nickName"\s*:\s*"([^"]+)"/);
        if (m) data.nickName = m[1];
    }
    if (!data.totalVisitorCount) {
        const m = html.match(/"totalVisitorCount"\s*:\s*(\d+)/);
        if (m) data.totalVisitorCount = parseInt(m[1], 10);
    }
    if (!data.dayVisitorCount) {
        const m = html.match(/"dayVisitorCount"\s*:\s*(\d+)/);
        if (m) data.dayVisitorCount = parseInt(m[1], 10);
    }
    if (!data.subscriberCount) {
        const m = html.match(/"subscriberCount"\s*:\s*(\d+)/);
        if (m) data.subscriberCount = parseInt(m[1], 10);
    }
    if (!data.postCount) {
        const m = html.match(/"postCount"\s*:\s*(\d+)/);
        if (m) data.postCount = parseInt(m[1], 10);
    }
    if (!data.profileImage) {
        const m = html.match(/"profileImage"\s*:\s*"([^"]+)"/);
        if (m) data.profileImage = m[1].replace(/\\\//g, '/');
    }
    if (!data.themeName) {
        const m = html.match(/"themeName"\s*:\s*"([^"]+)"/);
        if (m) data.themeName = m[1];
    }
    return data;
}

// 일별 방문자 (최근 5일)
async function fetchDailyVisitors(blogId) {
    try {
        const url = `https://blog.naver.com/NVisitorgp4Ajax.naver?blogId=${encodeURIComponent(blogId)}`;
        const res = await fetch(url, {
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return [];
        const xml = await res.text();
        const matches = [...xml.matchAll(/<visitorcnt\s+id="(\d{8})"\s+cnt="(\d+)"\s*\/>/g)];
        return matches.map(m => ({
            date: `${m[1].substring(0,4)}-${m[1].substring(4,6)}-${m[1].substring(6,8)}`,
            count: parseInt(m[2], 10),
        }));
    } catch (e) { return []; }
}

// 최근 N개 글 목록 — JSON.parse가 실패할 수 있어 regex로도 백업
async function fetchRecentPosts(blogId, count) {
    // 1) 모바일 API로 카테고리 이름 매핑 빌드 (최근 10개 글까지 카테고리명 확보 가능)
    // 2) 데스크탑 API로 전체 글 목록 (count개 모두) 가져옴
    const mobileUrl = `https://m.blog.naver.com/api/blogs/${encodeURIComponent(blogId)}/post-list?categoryNo=0&listType=POST&fromNo=1&toNo=10`;
    const desktopUrl = `https://blog.naver.com/PostTitleListAsync.naver?blogId=${encodeURIComponent(blogId)}&currentPage=1&countPerPage=${count}&parentCategoryNo=&categoryNo=0`;

    const [mobileRes, desktopRes] = await Promise.all([
        fetch(mobileUrl, {
            headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': `https://m.blog.naver.com/${blogId}` },
            signal: AbortSignal.timeout(10000),
        }).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(desktopUrl, {
            headers: {
                'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*',
                'X-Requested-With': 'XMLHttpRequest', 'Referer': `https://blog.naver.com/${blogId}`,
            },
            signal: AbortSignal.timeout(10000),
        }).then(r => r.ok ? r.text() : null).catch(() => null),
    ]);

    // 카테고리 매핑 빌드 (모바일 API의 categoryName 활용)
    const catMap = {};
    const mobileItems = (mobileRes && mobileRes.result && mobileRes.result.items) || [];
    const mobileExtras = {}; // logNo → {sympathy, share, brief, thumb}
    mobileItems.forEach(it => {
        const cno = String(it.categoryNo || '');
        const cname = decodeEntities(it.categoryName || '');
        if (cno && cname && !catMap[cno]) catMap[cno] = cname;
        const ln = String(it.logNo || '');
        if (ln) {
            mobileExtras[ln] = {
                sympathy: parseInt(it.sympathyCnt || 0, 10),
                share: parseInt(it.shareCnt || 0, 10),
                brief: decodeEntities(it.briefContents || '').slice(0, 200),
                thumb: (it.thumbnailList && it.thumbnailList[0] && it.thumbnailList[0].encodedThumbnailUrl) || '',
            };
        }
    });

    // 데스크탑 API로 받은 전체 글 목록
    let postList = [];
    if (desktopRes && desktopRes.trim().startsWith('{')) {
        try {
            const data = JSON.parse(desktopRes);
            postList = data.postList || [];
        } catch (e) {
            const itemRe = /"logNo":"(\d+)"[^}]*?"title":"([^"]*)"[^}]*?"categoryNo":"([^"]*)"[^}]*?"commentCount":"([^"]*)"[^}]*?"addDate":"([^"]*)"/g;
            let m;
            while ((m = itemRe.exec(desktopRes)) !== null) {
                postList.push({ logNo: m[1], title: m[2], categoryNo: m[3], commentCount: m[4], addDate: m[5] });
            }
        }
    }

    const list = postList.map(p => {
        let title = p.title || '';
        try { title = decodeURIComponent(title.replace(/\+/g, ' ')); } catch (e) {}
        const cno = String(p.categoryNo || '');
        const ln = String(p.logNo || '');
        const extra = mobileExtras[ln] || {};
        return {
            logNo: ln,
            title: decodeEntities(title),
            categoryNo: cno,
            categoryName: catMap[cno] || '기타',
            commentCount: parseInt(p.commentCount || 0, 10),
            sympathyCount: extra.sympathy || 0,
            shareCount: extra.share || 0,
            addDate: p.addDate || '',
            briefContents: extra.brief || '',
            thumbnail: extra.thumb || '',
            url: `https://blog.naver.com/${blogId}/${ln}`,
        };
    });

    return { _list: list };
}

// 카테고리 목록 (JSON)
async function fetchCategories(blogId) {
    try {
        const url = `https://blog.naver.com/CategoryList.naver?blogId=${encodeURIComponent(blogId)}`;
        const res = await fetch(url, {
            headers: {
                'User-Agent': UA,
                'Accept': 'application/json,text/plain,*/*',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': `https://blog.naver.com/${blogId}`,
            },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return [];
        const text = await res.text();
        // JSONP 형태일 수 있음: try strip
        const jsonStr = text.replace(/^[^{]*/, '').replace(/[^}]*$/, '');
        try {
            const data = JSON.parse(jsonStr);
            const cats = data.resultList || data.categoryList || [];
            return cats.filter(c => c.categoryNo && c.categoryNo !== '0').map(c => ({
                categoryNo: c.categoryNo,
                name: decodeEntities(c.categoryName || ''),
                postCount: parseInt(c.postCnt || c.postCount || 0, 10),
                parent: c.parentCategoryNo || '',
            }));
        } catch (e) { return []; }
    } catch (e) { return []; }
}

// 인플루언서 여부 확인
async function checkInfluencer(blogId) {
    try {
        const url = `https://in.naver.com/${encodeURIComponent(blogId)}`;
        const res = await fetch(url, {
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(5000),
            redirect: 'follow',
        });
        if (!res.ok) return { isInfluencer: false };
        const html = await res.text();
        // 인플루언서가 아닌 경우 메인 페이지로 리다이렉트되거나 빈 페이지
        if (!html.includes('인플루언서') && !html.includes('influencer')) {
            return { isInfluencer: false };
        }
        const result = { isInfluencer: true };
        // 활동 분야
        const catMatch = html.match(/"category(?:Name)?"\s*:\s*"([^"]+)"/);
        if (catMatch) result.category = catMatch[1];
        // 팬 수
        const fanMatch = html.match(/"fan(?:Count|Cnt)"\s*:\s*(\d+)/i) ||
                         html.match(/팬\s*([\d,]+)\s*명/);
        if (fanMatch) result.fanCount = parseInt(String(fanMatch[1]).replace(/,/g, ''), 10);
        // 콘텐츠 수
        const contentMatch = html.match(/"contentsCount"\s*:\s*(\d+)/);
        if (contentMatch) result.contentsCount = parseInt(contentMatch[1], 10);
        return result;
    } catch (e) { return { isInfluencer: false }; }
}

// 글 제목 정확 검색 노출 확인 (한 글 = 1 API 호출)
async function checkPostExposure(blogId, post, clientId, clientSecret) {
    try {
        const safeTitle = post.title.replace(/["']/g, '').trim();
        if (!safeTitle) return { exposed: false, reason: '제목 없음' };
        const query = `"${safeTitle}"`;
        const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&display=30&sort=sim`;
        const res = await fetch(url, {
            headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return { exposed: null, totalResults: 0 };
        const data = await res.json();
        const items = data.items || [];
        for (let i = 0; i < items.length; i++) {
            const link = items[i].link || '';
            try {
                const u = new URL(link);
                const seg = u.pathname.split('/').filter(Boolean);
                const itemLogNo = u.searchParams.get('logNo') || (seg[1] && /^\d+$/.test(seg[1]) ? seg[1] : '');
                const itemBlogId = (seg[0] === 'PostView.naver' || seg[0] === 'PostView.nhn')
                    ? (u.searchParams.get('blogId') || '').toLowerCase()
                    : (seg[0] || '').toLowerCase();
                if (itemLogNo === post.logNo && itemBlogId === blogId.toLowerCase()) {
                    return { exposed: true, rank: i + 1, totalResults: data.total || 0 };
                }
            } catch (e) {}
        }
        return { exposed: false, totalResults: data.total || 0 };
    } catch (e) {
        return { exposed: null, totalResults: 0 };
    }
}

// 키워드 빈도 (제목 기준)
function extractKeywords(posts, topN = 20) {
    const stopWords = new Set([
        '이다','있다','없다','하다','되다','같다','이런','그런','저런','어떤','이번','저번',
        '그리고','그러나','하지만','그래서','때문','경우','부분','모습','정도','상황',
        '오늘','내일','어제','지금','현재','요즘','오랜','정말','진짜','너무','매우','다른',
        '여기','거기','저기','이것','그것','저것','우리','자기','자신','가지','이때','조금',
        '바로','다시','계속','그냥','대해','모든','각자','다양','이상','이하','이외','외부',
        '대부분','일부','전체','관련','일반','특정','당시','당일','당사','수있','니다','입니다','리뷰','내돈내산','솔직','후기',
    ]);
    const counts = {};
    posts.forEach(p => {
        const matches = (p.title || '').match(/[가-힣]{2,8}/g) || [];
        matches.forEach(w => {
            if (stopWords.has(w)) return;
            counts[w] = (counts[w] || 0) + 1;
        });
    });
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([word, count]) => ({ word, count }));
}

// 카테고리별 글 수 집계 (이름이 매핑된 것은 개별, 미매핑은 "기타"로 합침)
function aggregateCategories(posts, categories) {
    const catMap = {};
    (categories || []).forEach(c => { catMap[c.categoryNo] = c.name; });
    const groups = {};
    let unmapped = 0;
    posts.forEach(p => {
        const key = p.categoryNo || '0';
        const name = (p.categoryName && p.categoryName !== '기타') ? p.categoryName : catMap[key];
        if (name) {
            if (!groups[name]) groups[name] = { categoryNo: key, name, count: 0 };
            groups[name].count++;
        } else {
            unmapped++;
        }
    });
    const list = Object.values(groups);
    if (unmapped > 0) list.push({ categoryNo: '0', name: '기타', count: unmapped });
    return list.sort((a, b) => b.count - a.count);
}

// 최근 30일 글 수
function countRecent30(posts) {
    const now = Date.now();
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    return posts.filter(p => {
        const raw = p.addDate;
        if (!raw) return false;
        // 숫자(timestamp ms)
        if (typeof raw === 'number') return raw >= cutoff;
        // 문자열: "2026. 4. 16." 형태 또는 "N시간 전"
        const s = String(raw);
        if (/시간 전|분 전|초 전|방금/.test(s)) return true;
        const m = s.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
        if (!m) return false;
        const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
        return d.getTime() >= cutoff;
    }).length;
}

export async function onRequestOptions() {
    return new Response('', { status: 200, headers: corsHeaders });
}

export async function onRequestPost({ request, env }) {
    const clientId = env.NAVER_SEARCH_CLIENT_ID;
    const clientSecret = env.NAVER_SEARCH_CLIENT_SECRET;

    try {
        const body = await request.json();
        let blogId = (body.blogId || '').trim().toLowerCase();
        const postCount = Math.min(Math.max(parseInt(body.postCount || 20, 10), 5), 50);

        // URL → ID 추출
        if (blogId.includes('/') || blogId.includes('.')) {
            try {
                let v = blogId;
                if (!/^https?:\/\//.test(v)) v = 'https://' + v;
                const u = new URL(v);
                const seg = u.pathname.split('/').filter(Boolean);
                blogId = (seg[0] || '').toLowerCase();
            } catch (e) {}
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(blogId)) {
            return jsonResponse({ error: '블로그 아이디 형식이 올바르지 않습니다.' }, 400);
        }

        // 1~3 단계 병렬 실행
        const [blogData, dailyVisitors, recentPostsResult, categories, influencer] = await Promise.all([
            fetchBlogMobile(blogId).catch(e => ({ blogId, _error: e.message })),
            fetchDailyVisitors(blogId),
            fetchRecentPosts(blogId, postCount),
            fetchCategories(blogId),
            checkInfluencer(blogId),
        ]);
        const recentPosts = recentPostsResult._list || [];

        if (blogData._error && !blogData.blogName) {
            return jsonResponse({ error: blogData._error }, 404);
        }

        // 노출 진단 (3개씩 청크, 청크 사이 350ms 지연, 재시도 1회 → rate limit 회피)
        let exposures = [];
        if (clientId && clientSecret && recentPosts.length > 0) {
            const targets = recentPosts.slice(0, 20);
            const CHUNK_SIZE = 3;
            for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
                const chunk = targets.slice(i, i + CHUNK_SIZE);
                const results = await Promise.all(
                    chunk.map(p => checkPostExposure(blogId, p, clientId, clientSecret))
                );
                // 실패(null)는 한 번 더 시도
                for (let j = 0; j < results.length; j++) {
                    if (results[j] && results[j].exposed === null) {
                        await new Promise(r => setTimeout(r, 200));
                        results[j] = await checkPostExposure(blogId, chunk[j], clientId, clientSecret);
                    }
                }
                exposures.push(...results);
                if (i + CHUNK_SIZE < targets.length) {
                    await new Promise(r => setTimeout(r, 350));
                }
            }
        }

        // 글 + 노출 결합
        const postsWithExposure = recentPosts.map((p, i) => ({
            ...p,
            exposure: exposures[i] || null,
        }));

        // 카테고리별 집계 (글 목록 기반)
        const categoryStats = aggregateCategories(recentPosts, categories);

        // 키워드
        const keywords = extractKeywords(recentPosts, 20);

        // 최근 30일 글 수
        const recent30 = countRecent30(recentPosts);

        // 일 평균 방문자 = totalVisitor / 운영일수 (개설일이 있을 때)
        let avgDailyVisitor = 0;
        if (blogData.totalVisitorCount && blogData.blogCreatedAt) {
            const m = String(blogData.blogCreatedAt).match(/(\d{4})[-./]?\s*(\d{1,2})[-./]?\s*(\d{1,2})/);
            if (m) {
                const createDate = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
                const days = Math.max(1, Math.floor((Date.now() - createDate.getTime()) / (1000 * 60 * 60 * 24)));
                avgDailyVisitor = Math.round(blogData.totalVisitorCount / days);
            }
        }
        // fallback: 5일 평균
        if (!avgDailyVisitor && dailyVisitors.length > 0) {
            const sum = dailyVisitors.reduce((s, d) => s + d.count, 0);
            avgDailyVisitor = Math.round(sum / dailyVisitors.length);
        }

        // 노출 요약
        const expSummary = (() => {
            const valid = exposures.filter(e => e && e.exposed !== null);
            if (valid.length === 0) return null;
            const exposed = valid.filter(e => e.exposed === true).length;
            const missing = valid.length - exposed;
            return {
                total: valid.length,
                exposed,
                missing,
                rate: Math.round((exposed / valid.length) * 100),
            };
        })();

        // 최근 글 작성일
        const recentDate = recentPosts.length > 0 ? recentPosts[0].addDate : '';

        return jsonResponse({
            blogId,
            blog: {
                name: blogData.blogName || blogId,
                nickname: blogData.nickName || '',
                profileImage: blogData.profileImage || '',
                introduction: blogData.introduction || '',
                theme: blogData.themeName || '',
                createdAt: blogData.blogCreatedAt || '',
            },
            stats: {
                totalVisitor: blogData.totalVisitorCount || 0,
                dayVisitor: blogData.dayVisitorCount || 0,
                subscriber: blogData.subscriberCount || 0,
                totalPost: blogData.postCount || 0,
                avgDailyVisitor,
                recent30Posts: recent30,
                recentPostDate: recentDate,
            },
            dailyVisitors,
            categories: categoryStats,
            categoryList: categories,
            influencer,
            keywords,
            recentPosts: postsWithExposure,
            expSummary,
            timestamp: new Date().toISOString(),
        });
    } catch (e) {
        return jsonResponse({ error: e.message || '서버 오류' }, 500);
    }
}
