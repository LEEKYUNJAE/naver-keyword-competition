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

        // STEP 1: 검색광고 API - PC/모바일 검색수 (키워드별 개별 호출)
        for (const kw of keywords) {
            try {
                // 공백 제거 후 API 호출 (네이버 API가 공백 포함 키워드를 거부함)
                const cleanKw = kw.replace(/\s/g, '');
                const uri = `/keywordstool?hintKeywords=${encodeURIComponent(cleanKw)}&showDetail=1`;
                const data = await callSearchAdAPI(uri, adApiKey, adSecretKey, adCustomerId);

                if (data && data.keywordList && data.keywordList.length > 0) {
                    // 공백 제거 후 정확한 키워드 매칭
                    const kwNorm = kw.replace(/\s/g, '').toLowerCase();
                    const found = data.keywordList.find(
                        item => item.relKeyword.replace(/\s/g, '').toLowerCase() === kwNorm
                    );
                    const match = found || data.keywordList[0];

                    const pcVal = match.monthlyPcQcCnt;
                    const mbVal = match.monthlyMobileQcCnt;
                    searchVolumeMap[kw] = {
                        pc: (pcVal === '< 10' || pcVal === '< 10') ? 5 : (parseInt(pcVal) || 0),
                        mobile: (mbVal === '< 10' || mbVal === '< 10') ? 5 : (parseInt(mbVal) || 0),
                    };
                } else {
                    searchVolumeMap[kw] = { pc: 0, mobile: 0 };
                    errors.push(`"${kw}" 검색수 데이터 없음`);
                }
            } catch (e) {
                errors.push(`검색광고 API (${kw}): ${e.message}`);
                searchVolumeMap[kw] = { pc: 0, mobile: 0 };
            }
        }

        // STEP 2: 검색 API - 블로그 문서수
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

        return res.status(200).json({
            results,
            errors: errors.length > 0 ? errors : undefined,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        return res.status(500).json({ error: `서버 오류: ${error.message}` });
    }
};
