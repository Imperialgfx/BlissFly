// imports and dependencies
const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const { Buffer } = require('buffer');
const { URL } = require('url');
const path = require('path');
const fs = require('fs');

// Configuration and Constants
const PORT = process.env.PORT || 10000;
const VERSION = 'v1.21';
const DEBUG = process.env.DEBUG === 'true';
const MAX_RETRIES = 3;
const TIMEOUT = 30000;
const MAX_CACHE_SIZE = 1000;
const CACHE_TTL = 600000;
const MAX_REDIRECTS = 5;
const CHUNK_SIZE = 16384;

// Content Processing Configurations
const PROCESSABLE_TYPES = [
    'text/html',
    'text/css',
    'application/javascript',
    'application/x-javascript',
    'text/javascript',
    'application/json',
    'text/plain',
    'application/xml',
    'text/xml',
    'application/x-www-form-urlencoded'
];

const BINARY_TYPES = [
    'image/',
    'audio/',
    'video/',
    'application/pdf',
    'application/octet-stream'
];

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'no-referrer',
    'X-DNS-Prefetch-Control': 'on',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Permissions-Policy': 'interest-cohort=()',
    'Content-Security-Policy': "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: *;"
};

// WebSocket Message Types
const WS_MESSAGES = {
    GAME_INIT: 'gameInit',
    GAME_STATE: 'gameState',
    GAME_ACTION: 'gameAction',
    SYNC: 'sync',
    ERROR: 'error',
    CONNECTION: 'connection',
    HEARTBEAT: 'heartbeat',
    STATE_UPDATE: 'stateUpdate',
    CLIENT_EVENT: 'clientEvent'
};

// Enhanced Cache Implementation
class AdvancedCache {
    constructor(options = {}) {
        this.storage = new Map();
        this.maxSize = options.maxSize || MAX_CACHE_SIZE;
        this.maxAge = options.maxAge || CACHE_TTL;
        this.compressionThreshold = options.compressionThreshold || 1024;
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0,
            totalRequests: 0,
            compressionRatio: 0,
            totalSize: 0
        };
        this.lastCleanup = Date.now();
        this.setupPeriodicCleanup();
    }

    async set(key, value, customTTL) {
        if (this.storage.size >= this.maxSize) {
            await this._evictBatch();
        }

        const ttl = customTTL || this.maxAge;
        const compressed = await this._compressIfNeeded(value);
        const size = this._calculateSize(compressed);

        const item = {
            value: compressed,
            expires: Date.now() + ttl,
            lastAccessed: Date.now(),
            accessCount: 0,
            size,
            compressed: compressed !== value
        };

        this.storage.set(key, item);
        this.stats.totalSize += size;
        await this._conditionalCleanup();
    }

    async get(key) {
        this.stats.totalRequests++;
        const item = this.storage.get(key);

        if (!item) {
            this.stats.misses++;
            return null;
        }

        if (Date.now() > item.expires) {
            this.storage.delete(key);
            this.stats.evictions++;
            this.stats.totalSize -= item.size;
            return null;
        }

        item.lastAccessed = Date.now();
        item.accessCount++;
        this.stats.hits++;

        return item.compressed ? 
            await this._decompress(item.value) : 
            item.value;
    }

    async _compressIfNeeded(value) {
        if (typeof value === 'string' && 
            value.length > this.compressionThreshold) {
            try {
                const buffer = Buffer.from(value);
                const compressed = await new Promise((resolve, reject) => {
                    zlib.gzip(buffer, (err, result) => {
                        if (err) reject(err);
                        else resolve(result);
                    });
                });
                
                this.stats.compressionRatio = (compressed.length / buffer.length);
                return compressed;
            } catch (error) {
                DEBUG && console.error('Compression error:', error);
                return value;
            }
        }
        return value;
    }

    async _decompress(value) {
        try {
            const decompressed = await new Promise((resolve, reject) => {
                zlib.gunzip(value, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
            return decompressed.toString();
        } catch (error) {
            DEBUG && console.error('Decompression error:', error);
            return value;
        }
    }

    _calculateSize(value) {
        if (Buffer.isBuffer(value)) {
            return value.length;
        }
        if (typeof value === 'string') {
            return value.length * 2;
        }
        return 512; // Default size for other types
    }

    async _evictBatch() {
        const itemsToEvict = Math.ceil(this.storage.size * 0.1);
        const sortedItems = Array.from(this.storage.entries())
            .sort((a, b) => {
                const scoreA = (Date.now() - a[1].lastAccessed) / a[1].accessCount;
                const scoreB = (Date.now() - b[1].lastAccessed) / b[1].accessCount;
                return scoreB - scoreA;
            });

        for (let i = 0; i < itemsToEvict; i++) {
            if (sortedItems[i]) {
                const [key, item] = sortedItems[i];
                this.storage.delete(key);
                this.stats.evictions++;
                this.stats.totalSize -= item.size;
            }
        }
    }

    async _conditionalCleanup() {
        const now = Date.now();
        if (now - this.lastCleanup > 300000) {
            await this._cleanup();
            this.lastCleanup = now;
        }
    }

    async _cleanup() {
        const now = Date.now();
        for (const [key, item] of this.storage.entries()) {
            if (now > item.expires || item.accessCount === 0) {
                this.storage.delete(key);
                this.stats.evictions++;
                this.stats.totalSize -= item.size;
            }
        }
    }

    setupPeriodicCleanup() {
        setInterval(() => {
            this._conditionalCleanup().catch(error => {
                DEBUG && console.error('Periodic cleanup error:', error);
            });
        }, 60000);
    }

    getStats() {
        return {
            ...this.stats,
            size: this.storage.size,
            maxSize: this.maxSize,
            hitRate: (this.stats.hits / this.stats.totalRequests) || 0,
            evictionRate: (this.stats.evictions / this.stats.totalRequests) || 0,
            memoryUsage: process.memoryUsage().heapUsed,
            compressionRatio: this.stats.compressionRatio
        };
    }
}

// URL and Content Processing Utilities
class ContentProcessor {
    static async transformContent(content, type, baseUrl) {
        switch(type) {
            case 'text/html':
                return await this.transformHtml(content, baseUrl);
            case 'text/css':
                return await this.transformCss(content, baseUrl);
            case 'application/javascript':
            case 'text/javascript':
                return await this.transformJavaScript(content, baseUrl);
            default:
                return content;
        }
    }

    static async transformHtml(html, baseUrl) {
        const cheerio = require('cheerio');
        const $ = cheerio.load(html);

        // Base tag handling
        $('base').remove();
        $('head').prepend(`<base href="${baseUrl}">`);

        // Transform all URLs in attributes
        $('[href], [src], [action]').each((_, elem) => {
            ['href', 'src', 'action'].forEach(attr => {
                const url = $(elem).attr(attr);
                if (url && !this.isExcludedUrl(url)) {
                    try {
                        const absoluteUrl = new URL(url, baseUrl).href;
                        const encodedUrl = Buffer.from(absoluteUrl).toString('base64');
                        $(elem).attr(attr, `/watch?url=${encodedUrl}`);
                    } catch (e) {
                        DEBUG && console.error('URL transformation error:', e);
                    }
                }
            });
        });

        // Transform inline styles
        $('[style]').each((_, elem) => {
            const style = $(elem).attr('style');
            if (style) {
                $(elem).attr('style', this.transformCss(style, baseUrl));
            }
        });

        // Add game support script
        const gameScript = this.generateGameScript();
        $('body').append(gameScript);

        return $.html();
    }

    static transformCss(css, baseUrl) {
        return css.replace(/url\(['"]?((?!data:)[^'"())]+)['"]?\)/g, (match, url) => {
            try {
                const absoluteUrl = new URL(url, baseUrl).href;
                const encodedUrl = Buffer.from(absoluteUrl).toString('base64');
                return `url('/watch?url=${encodedUrl}')`;
            } catch (e) {
                return match;
            }
        });
    }

    static async transformJavaScript(js, baseUrl) {
        const babel = require('@babel/core');
        const result = await babel.transformAsync(js, {
            plugins: [
                () => ({
                    visitor: {
                        CallExpression(path) {
                            if (this.isXHRorFetch(path)) {
                                this.transformXHRFetch(path, baseUrl);
                            }
                        },
                        NewExpression(path) {
                            if (this.isWebSocket(path)) {
                                this.transformWebSocket(path);
                            }
                        }
                    }
                })
            ]
        });
        return result.code;
    }

    static isExcludedUrl(url) {
        return url.startsWith('data:') || 
               url.startsWith('javascript:') || 
               url.startsWith('#') || 
               url.startsWith('mailto:') || 
               url.startsWith('tel:');
    }

    static generateGameScript() {
        return `
            <script>
                (function() {
                    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                    const ws = new WebSocket(wsProtocol + '//' + window.location.host);
                    let gameState = null;
                    let gameFrame = null;

                    function detectAndSetupGame() {
                        const frames = Array.from(document.getElementsByTagName('iframe'));
                        const gameFrames = frames.filter(frame => {
                            const src = frame.src.toLowerCase();
                            return src.includes('game') || 
                                   src.includes('play') || 
                                   frame.id.includes('game') || 
                                   frame.className.includes('game');
                        });

                        if (gameFrames.length > 0) {
                            gameFrame = gameFrames[0];
                            initializeGame();
                        }
                    }

                    function initializeGame() {
                        if (!gameFrame) return;

                        const gameType = detectGameType(gameFrame);
                        ws.send(JSON.stringify({
                            type: 'gameInit',
                            gameType: gameType,
                            gameId: crypto.randomUUID(),
                            settings: {
                                url: gameFrame.src,
                                dimensions: {
                                    width: gameFrame.width,
                                    height: gameFrame.height
                                }
                            }
                        }));

                        setupGameMessageHandling();
                    }

                    function detectGameType(frame) {
                        const src = frame.src.toLowerCase();
                        if (src.includes('unity')) return 'unity';
                        if (src.includes('html5')) return 'html5';
                        return 'default';
                    }

                    function setupGameMessageHandling() {
                        window.addEventListener('message', function(event) {
                            if (event.source === gameFrame.contentWindow) {
                                ws.send(JSON.stringify({
                                    type: 'gameAction',
                                    action: event.data
                                }));
                            }
                        });
                    }

                    ws.onmessage = function(event) {
                        try {
                            const data = JSON.parse(event.data);
                            handleWebSocketMessage(data);
                        } catch (error) {
                            console.error('Game message handling error:', error);
                        }
                    };

                    function handleWebSocketMessage(data) {
                        switch(data.type) {
                            case 'gameStateUpdated':
                                updateGameState(data.gameState);
                                break;
                            case 'actionProcessed':
                                handleGameAction(data);
                                break;
                            case 'error':
                                console.error('Game error:', data.message);
                                break;
                        }
                    }

                    if (document.readyState === 'loading') {
                        document.addEventListener('DOMContentLoaded', detectAndSetupGame);
                    } else {
                        detectAndSetupGame();
                    }
                })();
            </script>
        `;
    }
}

// Initialize core components
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const cache = new AdvancedCache({
    maxSize: MAX_CACHE_SIZE,
    maxAge: CACHE_TTL,
    compressionThreshold: 1024
});

// Middleware setup
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use((req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
});

// Main route handlers and server initialization
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>BlissFly 🪰</title>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
            <style>
                :root {
                    --primary-color: #2196F3;
                    --hover-color: #1976D2;
                    --background: #f5f5f5;
                    --card-background: #ffffff;
                    --error-color: #ff4444;
                }

                * {
                    box-sizing: border-box;
                    margin: 0;
                    padding: 0;
                }

                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                    line-height: 1.6;
                    background: var(--background);
                    color: #333;
                    min-height: 100vh;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    overflow-x: hidden;
                }

                .container {
                    width: 100%;
                    max-width: 600px;
                    padding: 2rem;
                    perspective: 1000px;
                    position: relative;
                }

                .proxy-card {
                    background: var(--card-background);
                    border-radius: 10px;
                    padding: 2rem;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    position: relative;
                    transition: transform 0.3s ease;
                    transform-style: preserve-3d;
                }

                .title {
                    text-align: center;
                    margin-bottom: 2rem;
                    color: var(--primary-color);
                    position: relative;
                    font-size: 2.5em;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .title-fly {
                    margin-left: 10px;
                    font-size: 1.2em;
                    animation: flyHover 2s infinite;
                }

                .proxy-form {
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                }

                .url-input {
                    width: 100%;
                    padding: 12px;
                    border: 2px solid #e0e0e0;
                    border-radius: 6px;
                    font-size: 16px;
                    transition: all 0.3s ease;
                    background: transparent;
                }

                .url-input:focus {
                    border-color: var(--primary-color);
                    outline: none;
                    box-shadow: 0 0 0 3px rgba(33, 150, 243, 0.1);
                }

                .submit-btn {
                    background: var(--primary-color);
                    color: white;
                    border: none;
                    padding: 12px;
                    border-radius: 6px;
                    font-size: 16px;
                    cursor: pointer;
                    transition: all 0.3s ease;
                }

                .submit-btn:hover {
                    background: var(--hover-color);
                    transform: translateY(-2px);
                }

                .info-warning {
                    position: absolute;
                    bottom: -60px;
                    left: 0;
                    right: 0;
                    background: #fff;
                    padding: 15px;
                    border-radius: 10px;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    cursor: pointer;
                    transition: all 0.3s ease;
                    z-index: 1;
                }

                .warning-icon {
                    display: flex;
                    align-items: center;
                    color: var(--error-color);
                }

                .warning-icon i {
                    margin-right: 10px;
                    animation: pulsate 2s infinite;
                }

                .dropdown-arrow {
                    margin-left: auto;
                    transition: transform 0.3s ease;
                }

                .info-content {
                    position: absolute;
                    bottom: -120px;
                    left: 0;
                    right: 0;
                    background: #fff;
                    padding: 15px;
                    border-radius: 10px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.1);
                    display: none;
                    z-index: 0;
                }

                @keyframes pulsate {
                    0% { opacity: 1; }
                    50% { opacity: 0.5; }
                    100% { opacity: 1; }
                }

                @keyframes flyHover {
                    0%, 100% { transform: translate(0, 0); }
                    50% { transform: translate(5px, -5px); }
                }

                .error-popup {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background: var(--error-color);
                    color: white;
                    padding: 15px 25px;
                    border-radius: 8px;
                    box-shadow: 0 4px 12px rgba(255, 68, 68, 0.2);
                    transform: translateX(120%);
                    animation: slideIn 0.3s forwards, slideOut 0.3s 2.7s forwards;
                }

                @keyframes slideIn {
                    to { transform: translateX(0); }
                }

                @keyframes slideOut {
                    to { transform: translateX(120%); }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="proxy-card">
                    <h1 class="title">BlissFly<span class="title-fly">🪰</span></h1>
                    <form id="proxyForm" class="proxy-form">
                        <input type="text" 
                               class="url-input" 
                               placeholder="Enter website URL" 
                               required
                               autocomplete="off"
                               spellcheck="false">
                        <button type="submit" class="submit-btn">Browse</button>
                    </form>
                </div>
                <div class="info-warning">
                    <div class="warning-icon">
                        <i class="fas fa-exclamation-triangle"></i>
                        <span>Important Information</span>
                    </div>
                    <i class="fas fa-chevron-down dropdown-arrow"></i>
                </div>
                <div class="info-content">
                    This proxy only searches with URLs please use a URL when searching (example.com)
                </div>
            </div>

            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    const form = document.getElementById('proxyForm');
                    const input = form.querySelector('input');
                    const proxyCard = document.querySelector('.proxy-card');
                    const infoWarning = document.querySelector('.info-warning');
                    const infoContent = document.querySelector('.info-content');
                    const dropdownArrow = document.querySelector('.dropdown-arrow');

                    // Tilt effect
                    document.addEventListener('mousemove', (e) => {
                        const rect = proxyCard.getBoundingClientRect();
                        const x = e.clientX - rect.left;
                        const y = e.clientY - rect.top;
                        
                        const centerX = rect.width / 2;
                        const centerY = rect.height / 2;
                        
                        const tiltX = (y - centerY) / 20;
                        const tiltY = (centerX - x) / 20;
                        
                        proxyCard.style.transform = `perspective(1000px) rotateX(${tiltX}deg) rotateY(${tiltY}deg)`;
                    });

                    proxyCard.addEventListener('mouseleave', () => {
                        proxyCard.style.transform = 'perspective(1000px) rotateX(0) rotateY(0)';
                    });

                    // Warning dropdown
                    infoWarning.addEventListener('click', () => {
                        const isVisible = infoContent.style.display === 'block';
                        infoContent.style.display = isVisible ? 'none' : 'block';
                        dropdownArrow.style.transform = isVisible ? 'rotate(0deg)' : 'rotate(180deg)';
                        infoWarning.style.borderRadius = isVisible ? '10px' : '10px 10px 0 0';
                    });

                    // Form submission
                    form.addEventListener('submit', async (e) => {
                        e.preventDefault();
                        let url = input.value.trim();
                        
                        // Remove any protocol if present
                        url = url.replace(/^(https?:\/\/)?(www\.)?/, '');
                        
                        if (!url) {
                            showError('Please enter a URL');
                            return;
                        }

                        try {
                            const encodedUrl = btoa(encodeURIComponent(`https://${url}`));
                            window.location.href = '/watch?url=' + encodedUrl;
                        } catch (error) {
                            showError('Invalid URL format');
                        }
                    });

                    function showError(message) {
                        const existingError = document.querySelector('.error-popup');
                        if (existingError) {
                            existingError.remove();
                        }

                        const errorPopup = document.createElement('div');
                        errorPopup.className = 'error-popup';
                        errorPopup.textContent = message;
                        document.body.appendChild(errorPopup);
                    }

                    input.focus();
                });
            </script>
        </body>
        </html>
    `);
});

// Watch route handler
app.get('/watch', async (req, res) => {
    try {
        const encodedUrl = req.query.url;
        if (!encodedUrl) {
            return res.status(400).send('URL parameter is required');
        }

        const url = Buffer.from(encodedUrl, 'base64').toString('utf8');
        const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
        
        const cachedResponse = await cache.get(normalizedUrl);
        if (cachedResponse) {
            return res.send(cachedResponse);
        }

        const response = await fetch(normalizedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            redirect: 'follow',
            follow: MAX_REDIRECTS
        });

        const contentType = response.headers.get('content-type') || '';
        const isProcessableType = PROCESSABLE_TYPES.some(type => contentType.includes(type));

        if (!isProcessableType) {
            response.body.pipe(res);
            return;
        }

        let content = await response.text();
        
        if (contentType.includes('text/html')) {
            content = await ContentProcessor.transformHtml(content, normalizedUrl);
        } else if (contentType.includes('text/css')) {
            content = ContentProcessor.transformCss(content, normalizedUrl);
        } else if (contentType.includes('javascript')) {
            content = await ContentProcessor.transformJavaScript(content, normalizedUrl);
        }

        await cache.set(normalizedUrl, content);
        res.send(content);

    } catch (error) {
        DEBUG && console.error('Proxy error:', error);
        res.status(500).send(`
            <div style="
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: linear-gradient(135deg, #ff4444, #ff6b6b);
                color: white;
                padding: 20px;
                border-radius: 10px;
                box-shadow: 0 4px 15px rgba(255, 68, 68, 0.3);
                text-align: center;
                font-family: sans-serif;
            ">
                <h2>Error Loading Page</h2>
                <p>${error.message}</p>
                <button onclick="window.location.href='/'" style="
                    background: white;
                    color: #ff4444;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 5px;
                    margin-top: 15px;
                    cursor: pointer;
                ">Return Home</button>
            </div>
        `);
    }
});

// Start server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Version: ${VERSION}`);
    if (DEBUG) console.log('Debug mode enabled');
});

// Error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (!DEBUG) process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (!DEBUG) process.exit(1);
});
