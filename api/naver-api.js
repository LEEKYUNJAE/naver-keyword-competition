const crypto = require('crypto');
const https = require('https');

// ===== 네이버 검색광고 API (PC/모바일 검색수) =====
function callSearchAdAPI(uri, apiKey, secretKey, customerId) {
    return new Promise((resolve, reject) => {
        const timestamp = Date.now().toString();
        const method = 'GET';
        const basePath = uri.split('?')[0];

        // HMAC-SHA256 서명 생성
        const hmac = crypto.createHmac('sha256', secretKey);
        hmac.update(timestamp + '.' + method + '.' + basePath);
        const signature = hmac.digest('base64');

        const url = `https://api.searchad.naver.com${uri}`;

        const options = {
            method: 'GET',
            hostname: 'api.searchad.naver.com',
            path: uri,
            headers: {
                'X-Timestamp': timestamp,
                'X-API-KEY': apiKey,
                'X-Customer': String(customerId),
                'X-Signature': signature
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('응답 파싱 오류: ' + data.substring(0, 100)));
                    }
                } else {
                    reject(new Error(`SA API ${res.statusCode}: ${data.substring(0, 300)}`));
                }
            });
        });

        req.on('error', (e) => reject(new Error('네트워크: ' + e.message)));
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('시간 초과')); });
        req.end();
    });
}

// ===== 네이버 검색 API (블로그 문서수) =====
function callSearchAPI(keyword, clientId, clientSecret) {
    return new Promise((resolve, reject) => {
        const encodedKeyword = encodeURIComponent(keyword);
        const path = `/v1/search/blog.json?query=${encodedKeyword}&display=1`;

        const options = {
            hostname: 'openapi.naver.com',
            path: path,
            method: 'GET',
            headers: {
                'X-Naver-Client-Id': clientId,
                'X-Naver-Client-Secret': clientSecret
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(data).total || 0);
                    } catch (e) { reject(new Error('검색 API 파싱 오류')); }
                } else {
                    reject(new Error(`검색 API ${res.statusCode}`));
                }
            });
        });

        req.on('error', (e) => reject(new Error('네트워크: ' + e.message)));
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('시간 초과')); });
        req.end();
    });
}

// ===== 네이버 DataLab API (검색 트렌드) =====
function callDataLabAPI(keyword, clientId, clientSecret) {
    return new Promise((resolve, reject) => {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setFullYear(startDate.getFullYear() - 1);

        const fmt = (d) => d.toISOString().split('T')[0];
        const body = JSON.stringify({
            startDate: fmt(startDate),
            endDate: fmt(endDate),
            timeUnit: 'month',
            keywordGroups: [{ groupName: keyword, keywords: [keyword] }]
        });

        const options = {
            hostname: 'openapi.naver.com',
            path: '/v1/datalab/search',
            method: 'POST',
            headers: {
                'X-Naver-Client-Id': clientId,
                'X-Naver-Client-Secret': clientSecret,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.results && parsed.results[0] && parsed.results[0].data) {
                            resolve(parsed.results[0].data);
                        } else { resolve([]); }
                    } catch (e) { resolve([]); }
                } else { resolve([]); }
            });
        });

        req.on('error', () => resolve([]));
        req.setTimeout(10000, () => { req.destroy(); resolve([]); });
        req.write(body);
        req.end();
    });
}

// DataLab 일별 데이터 (요일별 분석용)
function callDataLabDailyAPI(keyword, clientId, clientSecret) {
    return new Promise((resolve, reject) => {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setMonth(startDate.getMonth() - 3);

        const fmt = (d) => d.toISOString().split('T')[0];
        const body = JSON.stringify({
            startDate: fmt(startDate),
            endDate: fmt(endDate),
            timeUnit: 'date',
            keywordGroups: [{ groupName: keyword, keywords: [keyword] }]
        });

        const options = {
            hostname: 'openapi.naver.com',
            path: '/v1/datalab/search',
            method: 'POST',
            headers: {
                'X-Naver-Client-Id': clientId,
                'X-Naver-Client-Secret': clientSecret,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.results && parsed.results[0] && parsed.results[0].data) {
                            resolve(parsed.results[0].data);
                        } else { resolve([]); }
                    } catch (e) { resolve([]); }
                } else { resolve([]); }
            });
        });

        req.on('error', () => resolve([]));
        req.setTimeout(10000, () => { req.destroy(); resolve([]); });
        req.write(body);
        req.end();
    });
}

// 트렌드 분석 함수
function analyzeTrend(monthlyData) {
    if (!monthlyData || monthlyData.length < 6) return { direction: '데이터 부족', growth: 0, seasonal: false, bestMonth: '-', peakMonths: [] };

    const len = monthlyData.length;
    const recent3 = monthlyData.slice(len - 3).reduce((s, d) => s + d.ratio, 0) / 3;
    const prev3 = monthlyData.slice(len - 6, len - 3).reduce((s, d) => s + d.ratio, 0) / 3;
    const growth = prev3 > 0 ? ((recent3 - prev3) / prev3 * 100) : 0;

    let direction = '유지';
    if (growth > 10) direction = '상승 ↑';
    else if (growth < -10) direction = '하락 ↓';

    // 시즌 판별: 최대값/최소값 비율이 2배 이상이면 시즌 키워드
    const values = monthlyData.map(d => d.ratio);
    const maxVal = Math.max(...values);
    const minVal = Math.min(...values);
    const seasonal = minVal > 0 ? (maxVal / minVal > 2) : false;

    // 최고 검색 월
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

    // 최적 발행 시기: 검색 피크 1달 전
    const publishMonth = monthNames[(bestMonthIdx + 11) % 12];

    // 피크 월 (평균 이상)
    const avgRatio = monthAvgs.reduce((a, b) => a + b, 0) / 12;
    const peakMonths = monthNames.filter((_, i) => monthAvgs[i] > avgRatio);

    return { direction, growth: Math.round(growth * 10) / 10, seasonal, bestMonth, publishMonth, peakMonths };
}

// 요일별 분석
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

// ===== 네이버 검색 페이지에서 스마트블록 키워드 추출 =====
function fetchSmartBlock(keyword) {
    return new Promise((resolve, reject) => {
        const encodedKw = encodeURIComponent(keyword);
        const path = `/search.naver?where=nexearch&query=${encodedKw}`;

        const options = {
            hostname: 'search.naver.com',
            path: path,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'ko-KR,ko;q=0.9',
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const smartBlocks = [];
                    // 스마트블록 인기주제 키워드 추출 (fds-comps-keyword-chip 패턴)
                    const chipRegex = /data-keyword="([^"]+)"/g;
                    let match;
                    while ((match = chipRegex.exec(data)) !== null) {
                        const kw = match[1].trim();
                        if (kw && !smartBlocks.includes(kw)) smartBlocks.push(kw);
                    }

                    // 추가 패턴: 인기주제 텍스트 추출
                    const topicRegex = /class="[^"]*fds-keyword-text[^"]*"[^>]*>([^<]+)</g;
                    while ((match = topicRegex.exec(data)) !== null) {
                        const kw = match[1].trim();
                        if (kw && !smartBlocks.includes(kw)) smartBlocks.push(kw);
                    }

                    // 추가 패턴: api_subject_bx 영역
                    const subjectRegex = /"subject":"([^"]+)"/g;
                    while ((match = subjectRegex.exec(data)) !== null) {
                        const kw = match[1].trim();
                        if (kw && !smartBlocks.includes(kw)) smartBlocks.push(kw);
                    }

                    resolve(smartBlocks);
                } catch (e) {
                    resolve([]);
                }
            });
        });

        req.on('error', () => resolve([]));
        req.setTimeout(10000, () => { req.destroy(); resolve([]); });
        req.end();
    });
}

// ===== Vercel Serverless Function =====
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { keywords } = req.body;

        const adApiKey = process.env.NAVER_AD_API_KEY;
        const adSecretKey = process.env.NAVER_AD_SECRET_KEY;
        const adCustomerId = process.env.NAVER_AD_CUSTOMER_ID;
        const searchClientId = process.env.NAVER_SEARCH_CLIENT_ID;
        const searchClientSecret = process.env.NAVER_SEARCH_CLIENT_SECRET;

        if (!adApiKey || !adSecretKey || !adCustomerId)
            return res.status(500).json({ error: '서버에 검색광고 API 키가 설정되지 않았습니다.' });
        if (!searchClientId || !searchClientSecret)
            return res.status(500).json({ error: '서버에 검색 API 키가 설정되지 않았습니다.' });
        if (!keywords || keywords.length === 0)
            return res.status(400).json({ error: '키워드를 입력해주세요.' });
        if (keywords.length > 10)
            return res.status(400).json({ error: '최대 10개까지 가능합니다.' });

        const results = [];
        const errors = [];
        const searchVolumeMap = {};

        // STEP 1: 검색광고 API - PC/모바일 검색수 + 연관 키워드
        function parseVolume(val) {
            if (val === '< 10' || val === '< 10') return 10;
            return parseInt(val) || 0;
        }

        const relatedKeywordsMap = {};

        for (const kw of keywords) {
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
                        };
                    } else {
                        searchVolumeMap[kw] = { pc: 0, mobile: 0 };
                    }

                    // 연관 키워드 저장 (최대 50개)
                    relatedKeywordsMap[kw] = data.keywordList
                        .filter(item => item.relKeyword.replace(/\s/g, '').toLowerCase() !== kwNorm)
                        .slice(0, 50)
                        .map(item => ({
                            keyword: item.relKeyword,
                            pc: parseVolume(item.monthlyPcQcCnt),
                            mobile: parseVolume(item.monthlyMobileQcCnt),
                            total: parseVolume(item.monthlyPcQcCnt) + parseVolume(item.monthlyMobileQcCnt),
                            compIdx: item.compIdx || '-',
                        }));
                } else {
                    searchVolumeMap[kw] = { pc: 0, mobile: 0 };
                    relatedKeywordsMap[kw] = [];
                }
            } catch (e) {
                errors.push(`검색광고 API (${kw}): ${e.message}`);
                searchVolumeMap[kw] = { pc: 0, mobile: 0 };
                relatedKeywordsMap[kw] = [];
            }
        }

        // STEP 2: 검색 API - 블로그 문서수 (메인 키워드)
        for (const kw of keywords) {
            try {
                const blogCount = await callSearchAPI(kw, searchClientId, searchClientSecret);
                const vol = searchVolumeMap[kw] || { pc: 0, mobile: 0 };
                results.push({ keyword: kw, pc: vol.pc, mobile: vol.mobile, blogCount });
                await new Promise(r => setTimeout(r, 100));
            } catch (e) {
                const vol = searchVolumeMap[kw] || { pc: 0, mobile: 0 };
                results.push({ keyword: kw, pc: vol.pc, mobile: vol.mobile, blogCount: 0 });
                errors.push(`${kw} 블로그: ${e.message}`);
            }
        }

        // STEP 3: 연관 키워드 블로그 문서수 (상위 20개만)
        for (const kw of keywords) {
            const related = relatedKeywordsMap[kw] || [];
            for (let i = 0; i < Math.min(related.length, 20); i++) {
                try {
                    const blogCount = await callSearchAPI(related[i].keyword, searchClientId, searchClientSecret);
                    related[i].blogCount = blogCount;
                    await new Promise(r => setTimeout(r, 80));
                } catch (e) {
                    related[i].blogCount = 0;
                }
            }
            // 블로그 수를 못 가져온 나머지는 0으로 설정
            for (let i = 20; i < related.length; i++) {
                related[i].blogCount = 0;
            }
        }

        // STEP 4: 스마트블록 키워드 추출
        const smartBlockMap = {};
        for (const kw of keywords) {
            try {
                smartBlockMap[kw] = await fetchSmartBlock(kw);
            } catch (e) {
                smartBlockMap[kw] = [];
            }
        }

        // STEP 5: DataLab 트렌드 분석
        const trendMap = {};
        for (const kw of keywords) {
            try {
                const monthlyData = await callDataLabAPI(kw, searchClientId, searchClientSecret);
                const dailyData = await callDataLabDailyAPI(kw, searchClientId, searchClientSecret);
                const analysis = analyzeTrend(monthlyData);
                const dayOfWeek = analyzeDayOfWeek(dailyData);

                // 월별 비율 계산
                const monthlyTotal = monthlyData.reduce((s, d) => s + d.ratio, 0);
                const monthlyPercent = monthlyData.map(d => ({
                    period: d.period,
                    ratio: d.ratio,
                    percent: monthlyTotal > 0 ? Math.round(d.ratio / monthlyTotal * 1000) / 10 : 0
                }));

                trendMap[kw] = {
                    monthly: monthlyPercent,
                    dayOfWeek,
                    analysis,
                };
                await new Promise(r => setTimeout(r, 100));
            } catch (e) {
                trendMap[kw] = { monthly: [], dayOfWeek: [], analysis: {} };
            }
        }

        return res.status(200).json({
            results,
            relatedKeywords: relatedKeywordsMap,
            smartBlocks: smartBlockMap,
            trends: trendMap,
            errors: errors.length > 0 ? errors : undefined,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        return res.status(500).json({ error: `서버 오류: ${error.message}` });
    }
};
