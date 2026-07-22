// Cloudflare Pages Function: 네이버 키워드 경쟁도 분석
// 라우트: POST /api/naver-api

// ===== Web Crypto: HMAC-SHA256 → Base64 =====
async function hmacSha256Base64(secret, message) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    const bytes = new Uint8Array(sig);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

// ===== 네이버 검색광고 API =====
async function callSearchAdAPI(uri, apiKey, secretKey, customerId) {
    const timestamp = Date.now().toString();
    const method = 'GET';
    const basePath = uri.split('?')[0];
    const signature = await hmacSha256Base64(secretKey, `${timestamp}.${method}.${basePath}`);

    const res = await fetch(`https://api.searchad.naver.com${uri}`, {
        method,
        headers: {
            'X-Timestamp': timestamp,
            'X-API-KEY': apiKey,
            'X-Customer': String(customerId),
            'X-Signature': signature,
        },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`SA API ${res.status}: ${text.substring(0, 300)}`);
    try { return JSON.parse(text); }
    catch (e) { throw new Error('응답 파싱 오류: ' + text.substring(0, 100)); }
}

// ===== 네이버 검색 API: 블로그 누적 문서수 =====
async function callSearchAPI(keyword, clientId, clientSecret) {
    const path = `/v1/search/blog.json?query=${encodeURIComponent(keyword)}&display=1`;
    const res = await fetch(`https://openapi.naver.com${path}`, {
        method: 'GET',
        headers: {
            'X-Naver-Client-Id': clientId,
            'X-Naver-Client-Secret': clientSecret,
        },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`검색 API ${res.status}`);
    try { return JSON.parse(text).total || 0; }
    catch (e) { throw new Error('검색 API 파싱 오류'); }
}

// ===== 네이버 검색 페이지 스크래핑: 기간별 블로그 발행수 =====
async function fetchBlogCountByPeriod(keyword, period) {
    const path = `/search.naver?where=blog&query=${encodeURIComponent(keyword)}&nso=so:dd,p:${period}`;
    try {
        const res = await fetch(`https://search.naver.com${path}`, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html',
                'Accept-Language': 'ko-KR,ko;q=0.9',
            },
            signal: AbortSignal.timeout(8000),
        });
        const html = await res.text();
        const matches = html.match(/"total":(\d+)/g) || [];
        let maxTotal = 0;
        for (const m of matches) {
            const n = parseInt(m.replace('"total":', ''), 10);
            if (n > maxTotal) maxTotal = n;
        }
        return maxTotal;
    } catch (e) {
        return 0;
    }
}

// ===== DataLab 월간 트렌드 =====
async function callDataLabAPI(keyword, clientId, clientSecret) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 1);
    const fmt = (d) => d.toISOString().split('T')[0];

    const body = JSON.stringify({
        startDate: fmt(startDate),
        endDate: fmt(endDate),
        timeUnit: 'month',
        keywordGroups: [{ groupName: keyword, keywords: [keyword] }],
    });

    const res = await fetch('https://openapi.naver.com/v1/datalab/search', {
        method: 'POST',
        headers: {
            'X-Naver-Client-Id': clientId,
            'X-Naver-Client-Secret': clientSecret,
            'Content-Type': 'application/json',
        },
        body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`DataLab ${res.status}: ${text.substring(0, 200)}`);
    const parsed = JSON.parse(text);
    if (parsed.results && parsed.results[0] && parsed.results[0].data) return parsed.results[0].data;
    throw new Error('DataLab 빈 응답');
}

// ===== DataLab 일간 트렌드 (요일 분석용) =====
async function callDataLabDailyAPI(keyword, clientId, clientSecret) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 3);
    const fmt = (d) => d.toISOString().split('T')[0];

    const body = JSON.stringify({
        startDate: fmt(startDate),
        endDate: fmt(endDate),
        timeUnit: 'date',
        keywordGroups: [{ groupName: keyword, keywords: [keyword] }],
    });

    const res = await fetch('https://openapi.naver.com/v1/datalab/search', {
        method: 'POST',
        headers: {
            'X-Naver-Client-Id': clientId,
            'X-Naver-Client-Secret': clientSecret,
            'Content-Type': 'application/json',
        },
        body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`DataLab일별 ${res.status}: ${text.substring(0, 200)}`);
    const parsed = JSON.parse(text);
    if (parsed.results && parsed.results[0] && parsed.results[0].data) return parsed.results[0].data;
    throw new Error('DataLab일별 빈응답');
}

// ===== 분석 함수 =====
function analyzeTrend(monthlyData) {
    if (!monthlyData || monthlyData.length < 6) return { direction: '데이터 부족', growth: 0, seasonal: false, bestMonth: '-', peakMonths: [] };

    const len = monthlyData.length;
    const recent3 = monthlyData.slice(len - 3).reduce((s, d) => s + d.ratio, 0) / 3;
    const prev3 = monthlyData.slice(len - 6, len - 3).reduce((s, d) => s + d.ratio, 0) / 3;
    const growth = prev3 > 0 ? ((recent3 - prev3) / prev3 * 100) : 0;

    let direction = '유지';
    if (growth > 10) direction = '상승 ↑';
    else if (growth < -10) direction = '하락 ↓';

    const values = monthlyData.map(d => d.ratio);
    const maxVal = Math.max(...values);
    const minVal = Math.min(...values);
    const seasonal = minVal > 0 ? (maxVal / minVal > 2) : false;

    const monthNames = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];
    const monthTotals = new Array(12).fill(0);
    const monthCounts = new Array(12).fill(0);
    monthlyData.forEach(d => {
        const m = new Date(d.period).getMonth();
        monthTotals[m] += d.ratio;
        monthCounts[m]++;
    });
    const monthAvgs = monthTotals.map((t, i) => monthCounts[i] > 0 ? t / monthCounts[i] : 0);
    const bestMonthIdx = monthAvgs.indexOf(Math.max(...monthAvgs));
    const bestMonth = monthNames[bestMonthIdx];
    const publishMonth = monthNames[(bestMonthIdx + 11) % 12];

    const avgRatio = monthAvgs.reduce((a, b) => a + b, 0) / 12;
    const peakMonths = monthNames.filter((_, i) => monthAvgs[i] > avgRatio);

    return { direction, growth: Math.round(growth * 10) / 10, seasonal, bestMonth, publishMonth, peakMonths };
}

function analyzeDayOfWeek(dailyData) {
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const dayTotals = new Array(7).fill(0);
    const dayCounts = new Array(7).fill(0);
    dailyData.forEach(d => {
        const day = new Date(d.period).getDay();
        dayTotals[day] += d.ratio;
        dayCounts[day]++;
    });
    const dayAvgs = dayTotals.map((t, i) => dayCounts[i] > 0 ? Math.round(t / dayCounts[i] * 10) / 10 : 0);
    const total = dayAvgs.reduce((a, b) => a + b, 0);
    const dayPercents = dayAvgs.map(v => total > 0 ? Math.round(v / total * 1000) / 10 : 0);
    return dayNames.map((name, i) => ({ day: name, ratio: dayAvgs[i], percent: dayPercents[i] }));
}

// ===== 스마트블록 키워드 추출 =====
async function fetchSmartBlock(keyword) {
    try {
        const res = await fetch(`https://search.naver.com/search.naver?where=nexearch&query=${encodeURIComponent(keyword)}`, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'ko-KR,ko;q=0.9',
            },
            signal: AbortSignal.timeout(10000),
        });
        const html = await res.text();
        const smartBlocks = [];
        const chipRegex = /data-keyword="([^"]+)"/g;
        let match;
        while ((match = chipRegex.exec(html)) !== null) {
            const kw = match[1].trim();
            if (kw && !smartBlocks.includes(kw)) smartBlocks.push(kw);
        }
        const topicRegex = /class="[^"]*fds-keyword-text[^"]*"[^>]*>([^<]+)</g;
        while ((match = topicRegex.exec(html)) !== null) {
            const kw = match[1].trim();
            if (kw && !smartBlocks.includes(kw)) smartBlocks.push(kw);
        }
        const subjectRegex = /"subject":"([^"]+)"/g;
        while ((match = subjectRegex.exec(html)) !== null) {
            const kw = match[1].trim();
            if (kw && !smartBlocks.includes(kw)) smartBlocks.push(kw);
        }
        return smartBlocks;
    } catch (e) {
        return [];
    }
}

function parseVolume(val) {
    if (val === '< 10') return 10;
    return parseInt(val) || 0;
}

// ===== 공통 응답 헬퍼 =====
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
};

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: corsHeaders });
}

// ===== Cloudflare Pages Function 핸들러 =====
export async function onRequestOptions() {
    return new Response('', { status: 200, headers: corsHeaders });
}

export async function onRequestPost({ request, env }) {
    try {
        const { keywords } = await request.json();

        const adApiKey = env.NAVER_AD_API_KEY;
        const adSecretKey = env.NAVER_AD_SECRET_KEY;
        const adCustomerId = env.NAVER_AD_CUSTOMER_ID;
        const searchClientId = env.NAVER_SEARCH_CLIENT_ID;
        const searchClientSecret = env.NAVER_SEARCH_CLIENT_SECRET;

        if (!adApiKey || !adSecretKey || !adCustomerId)
            return jsonResponse({ error: '서버에 검색광고 API 키가 설정되지 않았습니다.' }, 500);
        if (!searchClientId || !searchClientSecret)
            return jsonResponse({ error: '서버에 검색 API 키가 설정되지 않았습니다.' }, 500);
        if (!keywords || keywords.length === 0)
            return jsonResponse({ error: '키워드를 입력해주세요.' }, 400);
        if (keywords.length > 10)
            return jsonResponse({ error: '최대 10개까지 가능합니다.' }, 400);

        const results = [];
        const errors = [];
        const searchVolumeMap = {};
        const relatedKeywordsMap = {};

        // 연관키워드 중 문서수를 조회할 개수 (50 → 20으로 축소해 속도 개선)
        const REL_LIMIT = 20;
        // 프론트 getCompIdxMultiplier와 동일 기준 (낮음 0.7 / 보통 1.0 / 높음 1.3)
        const relCompMul = (c) => (c === '낮음' ? 0.7 : c === '높음' ? 1.3 : 1.0);

        // STEP 1: 검색광고 API (키워드별 병렬)
        await Promise.all(keywords.map(async (kw) => {
            try {
                const cleanKw = kw.replace(/\s/g, '');
                const uri = `/keywordstool?hintKeywords=${encodeURIComponent(cleanKw)}&showDetail=1`;
                const data = await callSearchAdAPI(uri, adApiKey, adSecretKey, adCustomerId);

                if (data && data.keywordList && data.keywordList.length > 0) {
                    const kwNorm = cleanKw.toLowerCase();
                    const match = data.keywordList.find(
                        item => item.relKeyword.replace(/\s/g, '').toLowerCase() === kwNorm
                    );

                    if (match) {
                        searchVolumeMap[kw] = {
                            pc: parseVolume(match.monthlyPcQcCnt),
                            mobile: parseVolume(match.monthlyMobileQcCnt),
                            compIdx: match.compIdx || '-',
                            avgPcClk: match.monthlyAvePcClkCnt || 0,
                            avgMobileClk: match.monthlyAveMobileClkCnt || 0,
                            avgPcCtr: match.monthlyAvePcCtr || 0,
                            avgMobileCtr: match.monthlyAveMobileCtr || 0,
                        };
                    } else {
                        searchVolumeMap[kw] = { pc: 0, mobile: 0, compIdx: '-', avgPcClk: 0, avgMobileClk: 0, avgPcCtr: 0, avgMobileCtr: 0 };
                    }

                    // 연관 후보(관련도순 50개) 중 "좋은 등급이 나올 가능성이 높은" 상위 REL_LIMIT개만 남긴다.
                    // 등급 = 문서수/검색량 × 경쟁배수 인데, 문서수는 아직 조회 전이라 알 수 없음.
                    // → 등급식의 분모(검색량)와 배수(경쟁정도)만으로 후보 점수(total/배수)를 매겨 선별.
                    // ⚠️ 선별에서 빠진 키워드는 문서수가 없어 등급 계산 불가 → 응답에서도 제외
                    //    (blogCount=0으로 내보내면 ratio 0 → 전부 가짜 'S 황금키워드'로 표시됨).
                    relatedKeywordsMap[kw] = data.keywordList
                        .filter(item => item.relKeyword.replace(/\s/g, '').toLowerCase() !== kwNorm)
                        .slice(0, 50)
                        .map(item => ({
                            keyword: item.relKeyword,
                            pc: parseVolume(item.monthlyPcQcCnt),
                            mobile: parseVolume(item.monthlyMobileQcCnt),
                            total: parseVolume(item.monthlyPcQcCnt) + parseVolume(item.monthlyMobileQcCnt),
                            compIdx: item.compIdx || '-',
                        }))
                        .sort((a, b) => (b.total / relCompMul(b.compIdx)) - (a.total / relCompMul(a.compIdx)))
                        .slice(0, REL_LIMIT);
                } else {
                    searchVolumeMap[kw] = { pc: 0, mobile: 0 };
                    relatedKeywordsMap[kw] = [];
                }
            } catch (e) {
                errors.push(`검색광고 API (${kw}): ${e.message}`);
                searchVolumeMap[kw] = { pc: 0, mobile: 0 };
                relatedKeywordsMap[kw] = [];
            }
        }));

        // STEP 2: 누적 블로그 문서수 + 월간 발행수 (키워드별 병렬)
        // Promise.all은 입력 순서대로 결과를 돌려주므로 화면 표시 순서가 보존된다.
        const step2Results = await Promise.all(keywords.map(async (kw) => {
            const vol = searchVolumeMap[kw] || { pc: 0, mobile: 0, compIdx: '-' };
            try {
                const [blogCount, monthlyBlogCount] = await Promise.all([
                    callSearchAPI(kw, searchClientId, searchClientSecret),
                    fetchBlogCountByPeriod(kw, '1m'),
                ]);
                return {
                    keyword: kw, pc: vol.pc, mobile: vol.mobile, blogCount, monthlyBlogCount,
                    compIdx: vol.compIdx, avgPcClk: vol.avgPcClk, avgMobileClk: vol.avgMobileClk,
                    avgPcCtr: vol.avgPcCtr, avgMobileCtr: vol.avgMobileCtr,
                };
            } catch (e) {
                errors.push(`${kw} 블로그: ${e.message}`);
                return { keyword: kw, pc: vol.pc, mobile: vol.mobile, blogCount: 0, monthlyBlogCount: 0, compIdx: vol.compIdx };
            }
        }));
        results.push(...step2Results);

        // STEP 3: 연관 키워드 블로그 문서수
        // 네이버 Search API 한도: ~10 req/s. batch 2 + 250ms 간격 = 8 req/s (안전)
        // 429 감지 시 exponential backoff
        async function fetchWithRetry(item) {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    item.blogCount = await callSearchAPI(item.keyword, searchClientId, searchClientSecret);
                    return;
                } catch (e) {
                    const isRateLimit = /\b429\b/.test(e.message);
                    if (attempt < 2) {
                        const wait = isRateLimit ? 1000 * (attempt + 1) : 200;
                        await new Promise(r => setTimeout(r, wait));
                    }
                }
            }
            item.blogCount = 0;
        }

        // 모든 메인 키워드의 연관을 평탄화해서 일괄 처리
        // → 마지막 메인이 통째로 누락되는 현상 방지 (시간 부족 시 균등 분배)
        const allRelated = [];
        for (const kw of keywords) {
            const related = relatedKeywordsMap[kw] || [];
            for (const item of related) allRelated.push(item);
        }
        for (let i = 0; i < allRelated.length; i += 2) {
            const batch = allRelated.slice(i, i + 2);
            await Promise.all(batch.map(item => fetchWithRetry(item)));
            await new Promise(r => setTimeout(r, 250));
        }

        // STEP 4: 스마트블록 — 조회 비활성화 (2026-07-22)
        // fetchSmartBlock의 data-keyword 정규식이 네이버 HTML 구조 변경으로 더 이상 매치되지 않아
        // 결과가 항상 빈 배열이었음(로컬에서도 0 → IP 차단 아님). 그런데도 키워드마다
        // search.naver.com 1.5MB 페이지를 "순차로" 받아오느라 시간만 크게 소모했음.
        // → 얻는 것이 0이므로 조회 자체를 제거. 응답 형태(빈 배열)는 유지해 프론트 영향 없음.
        const smartBlockMap = {};
        for (const kw of keywords) smartBlockMap[kw] = [];

        // STEP 5: DataLab 트렌드 (키워드별 병렬, 월별·일별도 동시)
        const trendMap = {};
        await Promise.all(keywords.map(async (kw) => {
            let monthlyData = [], dailyData = [];
            const [mRes, dRes] = await Promise.allSettled([
                callDataLabAPI(kw, searchClientId, searchClientSecret),
                callDataLabDailyAPI(kw, searchClientId, searchClientSecret),
            ]);
            if (mRes.status === 'fulfilled') monthlyData = mRes.value || [];
            else errors.push(`트렌드(월별) ${kw}: ${mRes.reason && mRes.reason.message}`);
            if (dRes.status === 'fulfilled') dailyData = dRes.value || [];
            else errors.push(`트렌드(일별) ${kw}: ${dRes.reason && dRes.reason.message}`);

            const analysis = monthlyData.length > 0 ? analyzeTrend(monthlyData) : {};
            const dayOfWeek = dailyData.length > 0 ? analyzeDayOfWeek(dailyData) : [];

            const monthlyTotal = monthlyData.reduce((s, d) => s + d.ratio, 0);
            const monthlyPercent = monthlyData.map(d => ({
                period: d.period,
                ratio: d.ratio,
                percent: monthlyTotal > 0 ? Math.round(d.ratio / monthlyTotal * 1000) / 10 : 0,
            }));

            trendMap[kw] = { monthly: monthlyPercent, dayOfWeek, analysis };
        }));

        return jsonResponse({
            results,
            relatedKeywords: relatedKeywordsMap,
            smartBlocks: smartBlockMap,
            trends: trendMap,
            errors: errors.length > 0 ? errors : undefined,
            timestamp: new Date().toISOString(),
        });

    } catch (error) {
        return jsonResponse({ error: `서버 오류: ${error.message}` }, 500);
    }
}
