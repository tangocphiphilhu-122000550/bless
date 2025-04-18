const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const crypto = require('crypto');
const chalk = require('chalk');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

const apiBaseUrl = 'https://gateway-run.bls.dev/api/v1/nodes';
const ipServiceUrl = 'https://tight-block-2413.txlabs.workers.dev';
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 giây
const REQUEST_TIMEOUT = 60000; // 60 giây
const PING_INTERVAL = 120000; // 2 phút

// Endpoint để UptimeRobot ping
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Hàm đọc danh sách token từ file data.txt
async function readTokensFromFile() {
    try {
        const data = await fs.readFile('data.txt', 'utf8');
        return data.split('\n').map(line => line.trim()).filter(line => line);
    } catch (error) {
        console.error(chalk.red(`[${new Date().toISOString()}] Lỗi khi đọc tệp data.txt: ${error.message}`));
        throw error;
    }
}

// Hàm đọc danh sách nodeId từ file node.txt
async function readNodeIdsFromFile() {
    try {
        const data = await fs.readFile('node.txt', 'utf8');
        return data.split('\n').map(line => line.trim()).filter(line => line);
    } catch (error) {
        console.error(chalk.red(`[${new Date().toISOString()}] Lỗi khi đọc tệp node.txt: ${error.message}`));
        throw error;
    }
}

// Hàm lấy địa chỉ IP công cộng
async function fetchIpAddress() {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.goto(ipServiceUrl, { waitUntil: 'networkidle2', timeout: REQUEST_TIMEOUT });
        const ipData = await page.evaluate(() => document.body.innerText);
        const ip = JSON.parse(ipData).ip;
        console.log(chalk.green(`[${new Date().toISOString()}] Địa chỉ IP: ${ip}`));
        return ip;
    } catch (error) {
        console.error(chalk.red(`[${new Date().toISOString()}] Lỗi khi lấy IP: ${error.message}`));
        throw error;
    } finally {
        if (browser) await browser.close();
    }
}

// Hàm tạo hardwareId
function getHardwareIdentifierFromNodeId(nodeId) {
    const hardwareInfo = {
        cpu_architecture: 'x64',
        cpu_model: `Custom CPU Model from Node ID ${nodeId}`,
        cpu_count: 4,
        total_memory: 8000000000
    };
    return Buffer.from(JSON.stringify(hardwareInfo)).toString('base64');
}

function generateDeviceIdentifier(hardwareIdentifier) {
    return crypto.createHash('sha256')
        .update(JSON.stringify({ hardwareIdentifier }))
        .digest('hex');
}

// Hàm tạo x-extension-signature
function generateExtensionSignature(method, path, body, token, timestamp) {
    const stringToSign = `${method}\n${path}\n${JSON.stringify(body)}\n${timestamp}`;
    const hmac = crypto.createHmac('sha512', token);
    hmac.update(stringToSign);
    return hmac.digest('hex');
}

// Hàm gửi yêu cầu HTTP chung
async function sendRequest(url, method, headers, body, nodeId, accountIndex, retryCount = 0) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
        });
        const page = await browser.newPage();
        await page.setExtraHTTPHeaders(headers);

        await page.goto('https://bless.network', { waitUntil: 'networkidle2', timeout: REQUEST_TIMEOUT });

        const response = await page.evaluate(async (url, method, headers, body, timeout) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeout);
                const res = await fetch(url, {
                    method,
                    headers,
                    body: body ? JSON.stringify(body) : undefined,
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                return {
                    status: res.status,
                    statusText: res.statusText,
                    body: await res.text()
                };
            } catch (error) {
                return { error: `Fetch error: ${error.message}` };
            }
        }, url, method, headers, body, REQUEST_TIMEOUT);

        if (response.error) {
            console.error(chalk.red(`[${new Date().toISOString()}] Lỗi fetch cho tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}: ${response.error}`));
            if (retryCount < MAX_RETRIES) {
                console.log(chalk.yellow(`[${new Date().toISOString()}] Thử lại lần ${retryCount + 1} sau ${RETRY_DELAY}ms cho tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}...`));
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                return await sendRequest(url, method, headers, body, nodeId, accountIndex, retryCount + 1);
            }
            throw new Error(response.error);
        }

        if (response.body.includes('Sorry, you have been blocked')) {
            console.error(chalk.red(`[${new Date().toISOString()}] Lỗi: Bị chặn bởi Cloudflare cho tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}. Mã trạng thái: ${response.status}`));
            if (retryCount < MAX_RETRIES) {
                console.log(chalk.yellow(`[${new Date().toISOString()}] Thử lại lần ${retryCount + 1} sau ${RETRY_DELAY}ms cho tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}...`));
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                return await sendRequest(url, method, headers, body, nodeId, accountIndex, retryCount + 1);
            }
            throw new Error(`API error: ${response.status} - Cloudflare blocked`);
        }

        let data;
        try {
            data = JSON.parse(response.body);
        } catch (error) {
            console.error(chalk.red(`[${new Date().toISOString()}] Lỗi phân tích JSON cho tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}. Mã trạng thái: ${response.status}. Phản hồi: ${response.body}`));
            throw new Error(`Phản hồi không hợp lệ: ${response.body}`);
        }

        if (response.status === 500) {
            console.error(chalk.red(`[${new Date().toISOString()}] Lỗi API cho tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}: ${response.status} - ${JSON.stringify(data)}`));
            if (retryCount < MAX_RETRIES) {
                console.log(chalk.yellow(`[${new Date().toISOString()}] Thử lại lần ${retryCount + 1} sau ${RETRY_DELAY}ms cho tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}...`));
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                return await sendRequest(url, method, headers, body, nodeId, accountIndex, retryCount + 1);
            }
            throw new Error(`Lỗi API: ${response.status} - ${JSON.stringify(data)}`);
        }

        if (response.status !== 200 && response.status !== 201) {
            console.error(chalk.red(`[${new Date().toISOString()}] Lỗi API cho tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}: ${response.status} - ${JSON.stringify(data)}`));
            throw new Error(`Lỗi API: ${response.status} - ${JSON.stringify(data)}`);
        }

        return data;
    } catch (error) {
        console.error(chalk.red(`[${new Date().toISOString()}] Lỗi khi gửi yêu cầu cho tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}: ${error.message}`));
        throw error;
    } finally {
        if (browser) await browser.close();
    }
}

// Hàm kiểm tra trạng thái node
async function checkNodeStatus(nodeId, token, accountIndex) {
    const url = `${apiBaseUrl}/${nodeId}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'vi,fr-FR;q=0.9,fr;q=0.8,en-US;q=0.7,en;q=0.6',
        'Origin': 'chrome-extension://pljbjcehnhcnofmkdbjolghdcjnmekia',
        'Priority': 'u=1, i',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'X-Extension-Version': '0.1.8'
    };
    console.log(chalk.yellow(`[${new Date().toISOString()}] Đang kiểm tra trạng thái tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}...`));
    const data = await sendRequest(url, 'GET', headers, null, nodeId, accountIndex);
    console.log(chalk.green(`[${new Date().toISOString()}] Tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}: Hoạt động, Phần thưởng hôm nay: ${data.todayReward || 0}, Tổng: ${data.totalReward || 0}`));
    return data;
}

// Hàm đăng ký node
async function registerNode(nodeId, token, accountIndex) {
    const hardwareId = getHardwareIdentifierFromNodeId(nodeId);
    const deviceId = generateDeviceIdentifier(hardwareId);
    const ipAddress = await fetchIpAddress();

    const url = `${apiBaseUrl}/${nodeId}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'vi,fr-FR;q=0.9,fr;q=0.8,en-US;q=0.7,en;q=0.6',
        'Origin': 'chrome-extension://pljbjcehnhcnofmkdbjolghdcjnmekia',
        'Priority': 'u=1, i',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'X-Extension-Version': '0.1.8'
    };
    const body = { ipAddress, hardwareId, deviceId };

    console.log(chalk.yellow(`[${new Date().toISOString()}] Đang đăng ký tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}...`));
    const data = await sendRequest(url, 'POST', headers, body, nodeId, accountIndex);
    console.log(chalk.green(`[${new Date().toISOString()}] Tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}: Đăng ký thành công`));
    return data;
}

// Hàm khởi tạo phiên
async function startSession(nodeId, token, accountIndex) {
    const url = `${apiBaseUrl}/${nodeId}/start-session`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'vi,fr-FR;q=0.9,fr;q=0.8,en-US;q=0.7,en;q=0.6',
        'Origin': 'chrome-extension://pljbjcehnhcnofmkdbjolghdcjnmekia',
        'Priority': 'u=1, i',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'X-Extension-Version': '0.1.8'
    };
    const body = {};

    console.log(chalk.yellow(`[${new Date().toISOString()}] Đang khởi tạo phiên cho tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}...`));
    const data = await sendRequest(url, 'POST', headers, body, nodeId, accountIndex);
    console.log(chalk.green(`[${new Date().toISOString()}] Tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}: Khởi tạo phiên thành công`));
    return data;
}

// Hàm gửi ping
async function pingNode(token, nodeId, isConnected, accountIndex) {
    const url = `${apiBaseUrl}/${nodeId}/ping`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = { isB7SConnected: isConnected };
    const path = `/api/v1/nodes/${nodeId}/ping`;
    const signature = generateExtensionSignature('POST', path, body, token, timestamp);

    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'vi,fr-FR;q=0.9,fr;q=0.8,en-US;q=0.7,en;q=0.6',
        'Origin': 'chrome-extension://pljbjcehnhcnofmkdbjolghdcjnmekia',
        'Priority': 'u=1, i',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'X-Extension-Version': '0.1.8',
        'X-Extension-Signature': signature,
        'X-Timestamp': timestamp // Sửa lỗi typo từ 'tưtimestamp'
    };

    console.log(chalk.yellow(`[${new Date().toISOString()}] Đang ping tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}...`));
    const data = await sendRequest(url, 'POST', headers, body, nodeId, accountIndex);
    console.log(chalk.green(`[${new Date().toISOString()}] Tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}: Ping thành công`));
    return data;
}

// Hàm xử lý một tài khoản
async function processAccount(token, nodeId, accountIndex) {
    try {
        console.log(chalk.blue(`[${new Date().toISOString()}] Bắt đầu xử lý tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}`));

        // Đăng ký node
        await registerNode(nodeId, token, accountIndex);

        // Khởi tạo phiên
        await startSession(nodeId, token, accountIndex);

        // Kiểm tra trạng thái node
        const nodeStatus = await checkNodeStatus(nodeId, token, accountIndex);
        const isConnected = nodeStatus.isConnected || false;

        // Gửi ping định kỳ
        const pingInterval = setInterval(async () => {
            try {
                await pingNode(token, nodeId, isConnected, accountIndex);
            } catch (error) {
                console.error(chalk.red(`[${new Date().toISOString()}] Lỗi khi ping tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}: ${error.message}`));
            }
        }, PING_INTERVAL);

        // Gửi ping lần đầu
        const pingResult = await pingNode(token, nodeId, isConnected, accountIndex);
        return pingResult;
    } catch (error) {
        console.error(chalk.red(`[${new Date().toISOString()}] Lỗi tài khoản ${accountIndex + 1}: ${nodeId.slice(-3)}: ${error.message}`));
        throw error;
    }
}

// Hàm chính
async function main() {
    try {
        const tokens = await readTokensFromFile();
        const nodeIds = await readNodeIdsFromFile();

        if (tokens.length === 0 || nodeIds.length === 0) {
            console.error(chalk.red(`[${new Date().toISOString()}] Lỗi: File data.txt hoặc node.txt trống`));
            return;
        }

        if (tokens.length !== nodeIds.length) {
            console.error(chalk.red(`[${new Date().toISOString()}] Lỗi: Số lượng token (${tokens.length}) không khớp với số lượng nodeId (${nodeIds.length})`));
            return;
        }

        console.log(chalk.blue(`[${new Date().toISOString()}] Bắt đầu xử lý ${tokens.length} tài khoản...`));

        // Chạy song song các tài khoản
        const results = await Promise.all(
            tokens.map((token, index) => 
                processAccount(token, nodeIds[index], index).catch(error => {
                    return { error: `Tài khoản ${index + 1}: ${nodeIds[index].slice(-3)}: ${error.message}` };
                })
            )
        );

        // Kiểm tra kết quả
        results.forEach((result, index) => {
            if (result.error) {
                console.error(chalk.red(`[${new Date().toISOString()}] ${result.error}`));
            } else {
                console.log(chalk.green(`[${new Date().toISOString()}] Tài khoản ${index + 1}: ${nodeIds[index].slice(-3)}: Hoàn tất khởi tạo`));
            }
        });

    } catch (error) {
        console.error(chalk.red(`[${new Date().toISOString()}] Chương trình gặp lỗi: ${error.message}`));
        process.exit(1);
    }
}

// Khởi động server Express và chạy main
app.listen(port, () => {
    console.log(chalk.blue(`[${new Date().toISOString()}] Server đang chạy trên cổng ${port}`));
    main();
});
