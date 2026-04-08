const crypto = require('crypto');
const https = require('https');

// ===== 네이버 검색광고 API (PC/모바일 검색수) =====
function callSearchAdAPI(path, apiKey, secretKey, customerId) {
    return new Promise((resolve, reject) => {
        const timestamp = Date.now().toString();
        const method = 'GET';
        const signature = generateSignature(timestamp, method, path, secretKey);

        const options = {
            hostname: 'api.naver.com',
            path: path,
            method: method,
            headers: {
                'X-Timestamp': timestamp,
                'X-API-KEY': apiKey,
                'X-Customer': customerId,
                'X-Signature': signature,
                'Content-Type': 'application/json; charset=UTF-8'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode === 200) {
                        resolve(JSON.parse(data));
                    } else {
                        reject(new Error(`검색광고 API 오류 (${res.statusCode}): ${data}`));
                    }
                } catch (e) {
                    reject(new Error('검색광고 API 응답 파싱 오류'));
                }
            });
        });

        req.on('error', (e) => reject(new Error(`네트워크 오류: ${e.message}`)));
        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error('검색광고 API 요청 시간 초과'));
        });
        req.end();
    });
}

// HMAC-SHA256 서명 생성 (검색광고 API용)
function generateSignature(timestamp, method, path, secretKey) {
    const message = `${timestamp}.${method}.${path}`;
    const hmac = crypto.createHmac('sha256', secretKey);
    hmac.update(message);
    return hmac.digest('base64');
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
                try {
                    if (res.statusCode === 200) {
                        const parsed = JSON.parse(data);
                        resolve(parsed.total || 0);
                    } else {
                        reject(new Error(`검색 API 오류 (${res.statusCode}): ${data}`));
                    }
                } catch (e) {
                    reject(new Error('검색 API 응답 파싱 오류'));
                }
            });
        });

        req.on('error', (e) => reject(new Error(`네트워크 오류: ${e.message}`)));
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('검색 API 요청 시간 초과'));
        });
        req.end();
    });
}

// ===== 메인 핸들러 =====
exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json; charset=utf-8'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const body = JSON.parse(event.body);
        const {
            // 네이버 검색광고 API 키
            adApiKey, adSecretKey, adCustomerId,
            // 네이버 검색 API 키
            searchClientId, searchClientSecret,
            // 키워드 목록
            keywords
        } = body;

        // 유효성 검사
        if (!adApiKey || !adSecretKey || !adCustomerId) {
            return {
                statusCode: 400, headers,
                body: JSON.stringify({ error: '네이버 검색광고 API 인증 정보를 모두 입력해주세요.' })
            };
        }

        if (!searchClientId || !searchClientSecret) {
            return {
                statusCode: 400, headers,
                body: JSON.stringify({ error: '네이버 검색 API 인증 정보를 모두 입력해주세요.' })
            };
        }

        if (!keywords || keywords.length === 0) {
            return {
                statusCode: 400, headers,
                body: JSON.stringify({ error: '키워드를 최소 1개 이상 입력해주세요.' })
            };
        }

        if (keywords.length > 10) {
            return {
                statusCode: 400, headers,
                body: JSON.stringify({ error: '키워드는 최대 10개까지 가능합니다.' })
            };
        }

        const results = [];
        const errors = [];

        // ===== STEP 1: 검색광고 API로 PC/모바일 검색수 조회 =====
        const searchVolumeMap = {};

        // 5개씩 청크로 나눠서 요청
        const chunks = [];
        for (let i = 0; i < keywords.length; i += 5) {
            chunks.push(keywords.slice(i, i + 5));
        }

        for (const chunk of chunks) {
            try {
                const keywordParam = chunk.map(k => encodeURIComponent(k)).join(',');
                const apiPath = `/keywordstool?hintKeywords=${keywordParam}&showDetail=1`;
                const response = await callSearchAdAPI(apiPath, adApiKey, adSecretKey, adCustomerId);

                if (response && response.keywordList) {
                    for (const kw of chunk) {
                        const found = response.keywordList.find(
                            item => item.relKeyword.toLowerCase() === kw.toLowerCase()
                        );

                        if (found) {
                            const pcCount = found.monthlyPcQcCnt;
                            const mobileCount = found.monthlyMobileQcCnt;

                            searchVolumeMap[kw] = {
                                pc: pcCount === '< 10' ? 5 : (parseInt(pcCount) || 0),
                                mobile: mobileCount === '< 10' ? 5 : (parseInt(mobileCount) || 0),
                                compIdx: found.compIdx || '-'
                            };
                        } else {
                            searchVolumeMap[kw] = { pc: 0, mobile: 0, compIdx: '-' };
                            errors.push(`"${kw}" - 검색광고 API에서 데이터를 찾을 수 없습니다.`);
                        }
                    }
                }
            } catch (apiError) {
                for (const kw of chunk) {
                    searchVolumeMap[kw] = { pc: 0, mobile: 0, compIdx: '-' };
                }
                errors.push(`검색광고 API 오류: ${apiError.message}`);
            }
        }

        // ===== STEP 2: 검색 API로 블로그 문서수 조회 =====
        for (const kw of keywords) {
            try {
                const blogCount = await callSearchAPI(kw, searchClientId, searchClientSecret);
                const volume = searchVolumeMap[kw] || { pc: 0, mobile: 0, compIdx: '-' };

                results.push({
                    keyword: kw,
                    pc: volume.pc,
                    mobile: volume.mobile,
                    blogCount: blogCount,
                    compIdx: volume.compIdx
                });

                // API 과부하 방지: 100ms 대기
                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (searchError) {
                const volume = searchVolumeMap[kw] || { pc: 0, mobile: 0, compIdx: '-' };
                results.push({
                    keyword: kw,
                    pc: volume.pc,
                    mobile: volume.mobile,
                    blogCount: 0,
                    compIdx: volume.compIdx
                });
                errors.push(`"${kw}" 블로그 문서수 조회 실패: ${searchError.message}`);
            }
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                results,
                errors: errors.length > 0 ? errors : undefined,
                timestamp: new Date().toISOString()
            })
        };

    } catch (error) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: `서버 오류: ${error.message}` })
        };
    }
};
