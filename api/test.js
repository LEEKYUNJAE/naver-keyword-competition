const crypto = require('crypto');
const https = require('https');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const adApiKey = process.env.NAVER_AD_API_KEY;
    const adSecretKey = process.env.NAVER_AD_SECRET_KEY;
    const adCustomerId = process.env.NAVER_AD_CUSTOMER_ID;

    // 환경변수 확인
    const envCheck = {
        NAVER_AD_API_KEY: adApiKey ? `설정됨 (${adApiKey.substring(0, 10)}...${adApiKey.substring(adApiKey.length - 5)}, 길이: ${adApiKey.length})` : '미설정',
        NAVER_AD_SECRET_KEY: adSecretKey ? `설정됨 (${adSecretKey.substring(0, 5)}...${adSecretKey.substring(adSecretKey.length - 5)}, 길이: ${adSecretKey.length})` : '미설정',
        NAVER_AD_CUSTOMER_ID: adCustomerId || '미설정',
        NAVER_SEARCH_CLIENT_ID: process.env.NAVER_SEARCH_CLIENT_ID ? '설정됨' : '미설정',
        NAVER_SEARCH_CLIENT_SECRET: process.env.NAVER_SEARCH_CLIENT_SECRET ? '설정됨' : '미설정',
    };

    // 검색광고 API 테스트
    let apiResult = '테스트 안함';
    if (adApiKey && adSecretKey && adCustomerId) {
        try {
            const timestamp = Date.now().toString();
            const method = 'GET';
            const basePath = '/keywordstool';
            const uri = '/keywordstool?hintKeywords=' + encodeURIComponent('블로그') + '&showDetail=1';

            const hmac = crypto.createHmac('sha256', adSecretKey);
            hmac.update(timestamp + '.' + method + '.' + basePath);
            const signature = hmac.digest('base64');

            const result = await new Promise((resolve, reject) => {
                const options = {
                    hostname: 'api.searchad.naver.com',
                    path: uri,
                    method: 'GET',
                    headers: {
                        'X-Timestamp': timestamp,
                        'X-API-KEY': adApiKey,
                        'X-Customer': String(adCustomerId),
                        'X-Signature': signature
                    }
                };

                const r = https.request(options, (response) => {
                    let data = '';
                    response.on('data', (chunk) => data += chunk);
                    response.on('end', () => {
                        resolve({
                            status: response.statusCode,
                            headers: response.headers,
                            body: data.substring(0, 500)
                        });
                    });
                });
                r.on('error', (e) => resolve({ error: e.message }));
                r.setTimeout(10000, () => { r.destroy(); resolve({ error: '시간 초과' }); });
                r.end();
            });

            apiResult = result;
        } catch (e) {
            apiResult = { error: e.message };
        }
    }

    return res.status(200).json({
        message: 'API 디버그 테스트',
        envCheck,
        apiResult,
        timestamp: new Date().toISOString()
    });
};
