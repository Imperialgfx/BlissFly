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

// Initialize express and server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Constants and configurations
const PORT = process.env.PORT || 10000;
const VERSION = 'v1.21';
const DEBUG = process.env.DEBUG === 'true';
const MAX_RETRIES = 3;
const TIMEOUT = 30000;
const MAX_CACHE_SIZE = 1000;
const CACHE_TTL = 600000;

const PROCESSABLE_TYPES = [
    'text/html',
    'text/css',
    'application/javascript',
    'application/x-javascript',
    'text/javascript',
    'application/json',
    'text/plain',
    'application/xml',
    'text/xml'
];

const WS_MESSAGES = {
    GAME_INIT: 'gameInit',
    GAME_STATE: 'gameState',
    GAME_ACTION: 'gameAction',
    SYNC: 'sync',
    ERROR: 'error',
    CONNECTION: 'connection'
};

class AdvancedCache {
    constructor(options = {}) {
        this.storage = new Map();
        this.maxSize = options.maxSize || MAX_CACHE_SIZE;
        this.maxAge = options.maxAge || CACHE_TTL;
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0,
            totalRequests: 0
        };
        this.lastCleanup = Date.now();
    }

    set(key, value, customTTL) {
        if (this.storage.size >= this.maxSize) {
            this._evictBatch();
        }

        const ttl = customTTL || this.maxAge;
        const item = {
            value,
            expires: Date.now() + ttl,
            lastAccessed: Date.now(),
            accessCount: 0,
            size: this._calculateSize(value)
        };

        this.storage.set(key, item);
        this._conditionalCleanup();
    }

    get(key) {
        this.stats.totalRequests++;
        const item = this.storage.get(key);

        if (!item) {
            this.stats.misses++;
            return null;
        }

        if (Date.now() > item.expires) {
            this.storage.delete(key);
            this.stats.evictions++;
            return null;
        }

        item.lastAccessed = Date.now();
        item.accessCount++;
        this.stats.hits++;
        return item.value;
    }

    _calculateSize(value) {
        if (typeof value === 'string') {
            return value.length * 2;
        }
        return 512;
    }

    _evictBatch() {
        const itemsToEvict = Math.ceil(this.storage.size * 0.1);
        const sortedItems = Array.from(this.storage.entries())
            .sort((a, b) => (a[1].lastAccessed - b[1].lastAccessed));

        for (let i = 0; i < itemsToEvict; i++) {
            if (sortedItems[i]) {
                this.storage.delete(sortedItems[i][0]);
                this.stats.evictions++;
            }
        }
    }

    _conditionalCleanup() {
        const now = Date.now();
        if (now - this.lastCleanup > 300000) {
            this._cleanup();
            this.lastCleanup = now;
        }
    }

    _cleanup() {
        const now = Date.now();
        for (const [key, item] of this.storage.entries()) {
            if (now > item.expires || item.accessCount === 0) {
                this.storage.delete(key);
                this.stats.evictions++;
            }
        }
    }

    getStats() {
        return {
            ...this.stats,
            size: this.storage.size,
            maxSize: this.maxSize,
            hitRate: (this.stats.hits / this.stats.totalRequests) || 0,
            evictionRate: (this.stats.evictions / this.stats.totalRequests) || 0
        };
    }
}

class WebSocketManager {
    constructor(wss) {
        this.wss = wss;
        this.clients = new Map();
        this.gameStates = new Map();
        this.setupWebSocketServer();
    }

    setupWebSocketServer() {
        this.wss.on('connection', (ws, req) => {
            const clientId = this.generateClientId();
            this.initializeClient(clientId, ws);
            this.setupClientHandlers(clientId, ws);
        });
    }

    generateClientId() {
        return crypto.randomBytes(16).toString('hex');
    }

    initializeClient(clientId, ws) {
        this.clients.set(clientId, {
            ws,
            lastPing: Date.now(),
            gameState: null,
            messageQueue: [],
            isAlive: true
        });

        this.sendToClient(clientId, {
            type: WS_MESSAGES.CONNECTION,
            status: 'established',
            clientId
        });
    }

    setupClientHandlers(clientId, ws) {
        ws.on('message', (message) => this.handleMessage(clientId, message));
        ws.on('close', () => this.handleClose(clientId));
        ws.on('error', (error) => this.handleError(clientId, error));
        ws.on('pong', () => this.handlePong(clientId));

        const pingInterval = setInterval(() => {
            if (this.clients.has(clientId)) {
                this.pingClient(clientId);
            } else {
                clearInterval(pingInterval);
            }
        }, 30000);
    }

    handleMessage(clientId, message) {
        try {
            const data = JSON.parse(message);
            const client = this.clients.get(clientId);
            
            if (!client) return;

            switch (data.type) {
                case WS_MESSAGES.GAME_INIT:
                    this.initializeGame(clientId, data);
                    break;
                case WS_MESSAGES.GAME_STATE:
                    this.updateGameState(clientId, data);
                    break;
                case WS_MESSAGES.GAME_ACTION:
                    this.handleGameAction(clientId, data);
                    break;
                case WS_MESSAGES.SYNC:
                    this.syncGameState(clientId);
                    break;
                default:
                    this.handleCustomMessage(clientId, data);
            }
        } catch (error) {
            DEBUG && console.error('WebSocket message handling error:', error);
            this.sendToClient(clientId, {
                type: WS_MESSAGES.ERROR,
                message: 'Invalid message format'
            });
        }
    }

    initializeGame(clientId, data) {
        const gameState = {
            id: data.gameId || this.generateClientId(),
            type: data.gameType,
            state: data.initialState || {},
            timestamp: Date.now(),
            players: new Set([clientId]),
            settings: data.settings || {}
        };
        
        this.gameStates.set(gameState.id, gameState);
        this.clients.get(clientId).gameState = gameState.id;
        
        this.sendToClient(clientId, {
            type: WS_MESSAGES.GAME_INIT,
            gameState: this.sanitizeGameState(gameState)
        });
    }

    updateGameState(clientId, data) {
        const gameId = this.clients.get(clientId)?.gameState;
        const gameState = this.gameStates.get(gameId);

        if (gameState && gameState.players.has(clientId)) {
            Object.assign(gameState.state, data.state);
            gameState.timestamp = Date.now();
            this.broadcastGameState(gameId);
        }
    }

    handleGameAction(clientId, data) {
        const gameId = this.clients.get(clientId)?.gameState;
        const gameState = this.gameStates.get(gameId);

        if (gameState && gameState.players.has(clientId)) {
            const actionResult = this.processGameAction(gameState, data.action);
            this.broadcastToGame(gameId, {
                type: 'actionProcessed',
                action: data.action,
                result: actionResult,
                timestamp: Date.now()
            });
        }
    }

    sanitizeGameState(gameState) {
        return {
            id: gameState.id,
            type: gameState.type,
            state: gameState.state,
            timestamp: gameState.timestamp,
            playerCount: gameState.players.size,
            settings: gameState.settings
        };
    }

    broadcastGameState(gameId) {
        const gameState = this.gameStates.get(gameId);
        if (!gameState) return;

        const sanitizedState = this.sanitizeGameState(gameState);
        for (const playerId of gameState.players) {
            this.sendToClient(playerId, {
                type: WS_MESSAGES.GAME_STATE,
                gameState: sanitizedState
            });
        }
    }

    sendToClient(clientId, data) {
        const client = this.clients.get(clientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(data));
        }
    }

    handleClose(clientId) {
        const client = this.clients.get(clientId);
        if (client && client.gameState) {
            const gameState = this.gameStates.get(client.gameState);
            if (gameState) {
                gameState.players.delete(clientId);
                if (gameState.players.size === 0) {
                    this.gameStates.delete(client.gameState);
                }
            }
        }
        this.clients.delete(clientId);
    }
}

class ContentTransformer {
    static transformHtml(html, baseUrl) {
        const gameSupport = `
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

                    function updateGameState(newState) {
                        gameState = newState;
                        if (gameFrame) {
                            gameFrame.contentWindow.postMessage({
                                type: 'stateUpdate',
                                state: gameState
                            }, '*');
                        }
                    }

                    function handleGameAction(data) {
                        if (gameFrame) {
                            gameFrame.contentWindow.postMessage({
                                type: 'actionUpdate',
                                action: data.action,
                                result: data.result
                            }, '*');
                        }
                    }

                    document.addEventListener('click', function(e) {
                        const link = e.target.closest('a');
                        if (link) {
                            const href = link.getAttribute('href');
                            if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
                                e.preventDefault();
                                e.stopPropagation();
                                
                                try {
                                    const baseUrl = window.location.href.split('?url=')[1];
                                    const decodedBase = decodeURIComponent(atob(baseUrl));
                                    const absoluteUrl = new URL(href, decodedBase).href;
                                    const encodedUrl = btoa(encodeURIComponent(absoluteUrl));
                                    window.location.href = '/watch?url=' + encodedUrl;
                                } catch (error) {
                                    console.error('URL processing error:', error);
                                    showError('Invalid URL format');
                                }
                            }
                        }
                    }, true);

                    if (document.readyState === 'loading') {
                        document.addEventListener('DOMContentLoaded', detectAndSetupGame);
                    } else {
                        detectAndSetupGame();
                    }
                })();
            </script>
        `;

        return html
            .replace(/<head>/i, `<head><base href="${baseUrl}">`)
            .replace('</head>', `${gameSupport}</head>`)
            .replace(/(href|src|action)=["']((?!data:|javascript:|#|mailto:|tel:).+?)["']/gi, 
                (match, attr, url) => {
                    try {
                        const absoluteUrl = new URL(url, baseUrl).href;
                        const encodedUrl = obfuscateUrl(absoluteUrl);
                        return `${attr}="/watch?url=${encodedUrl}"`;
                    } catch (e) {
                        return match;
                    }
                }
            );
    }

    static transformCss(css, baseUrl) {
        return css.replace(/url\(['"]?((?!data:).+?)['"]?\)/gi, (match, url) => {
            try {
                const absoluteUrl = new URL(url, baseUrl).href;
                const encodedUrl = obfuscateUrl(absoluteUrl);
                return `url('/watch?url=${encodedUrl}')`;
            } catch (e) {
                return match;
            }
        });
    }

    static transformJavaScript(js) {
        return `
            (function() {
                const originalXHR = window.XMLHttpRequest;
                const originalFetch = window.fetch;
                const originalWebSocket = window.WebSocket;

                window.XMLHttpRequest = function() {
                    const xhr = new originalXHR();
                    const originalOpen = xhr.open;
                    
                    xhr.open = function(method, url, ...args) {
                        try {
                            const absoluteUrl = new URL(url, window.location.href).href;
                            const encodedUrl = btoa(encodeURIComponent(absoluteUrl));
                            return originalOpen.call(this, method, '/watch?url=' + encodedUrl, ...args);
                        } catch (e) {
                            return originalOpen.call(this, method, url, ...args);
                        }
                    };
                    
                    return xhr;
                };

                window.fetch = async function(url, options = {}) {
                    try {
                        const absoluteUrl = new URL(url, window.location.href).href;
                        const encodedUrl = btoa(encodeURIComponent(absoluteUrl));
                        return originalFetch('/watch?url=' + encodedUrl, options);
                    } catch (e) {
                        return originalFetch(url, options);
                    }
                };

                window.WebSocket = function(url, protocols) {
                    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                    return new originalWebSocket(
                        wsProtocol + '//' + window.location.host,
                        protocols
                    );
                };
            })();

            ${js}
        `;
    }
}

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>BlissFly 🪰</title>
            <style>
                :root {
                    --primary-color: #2196F3;
                    --hover-color: #1976D2;
                    --background: #f5f5f5;
                    --card-background: #ffffff;
                    --error-color: #ff4444;
                    --text-color: #495057;
                    --border-color: #e9ecef;
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
                    color: var(--text-color);
                    min-height: 100vh;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                }

                .container {
                    width: 100%;
                    max-width: 600px;
                    padding: 2rem;
                }

                .proxy-card {
                    background: var(--card-background);
                    border-radius: 10px;
                    padding: 2rem;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    position: relative;
                    overflow: hidden;
                    margin-bottom: 20px;
                }

                .title {
                    text-align: center;
                    margin-bottom: 2rem;
                    color: var(--primary-color);
                    position: relative;
                    font-size: 2.5em;
                }

                .title-fly {
                    position: absolute;
                    top: 5px;
                    left: -35px;
                    font-size: 1.2em;
                    animation: flyHover 3s ease-in-out infinite;
                }

                @keyframes flyHover {
                    0%, 100% { transform: translate(0, 0) rotate(0deg); }
                    25% { transform: translate(3px, -3px) rotate(10deg); }
                    75% { transform: translate(-3px, 3px) rotate(-10deg); }
                }

                .proxy-form {
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                }

                .url-input {
                    width: 100%;
                    padding: 12px;
                    border: 2px solid var(--border-color);
                    border-radius: 6px;
                    font-size: 16px;
                    transition: all 0.3s ease;
                }

                .url-input:focus {
                    border-color: var(--primary-color);
                    outline: none;
                    box-shadow: 0 0 0 3px rgba(33, 150, 243, 0.1);
                }

                .info-section {
                    width: 100%;
                    max-width: 600px;
                    padding: 0 2rem;
                }

                .warning-trigger {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    background: #f8f9fa;
                    border: 1px solid var(--border-color);
                    padding: 12px 16px;
                    border-radius: 8px;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    width: 100%;
                }

                .warning-trigger:hover {
                    background: #e9ecef;
                }

                .warning-icon {
                    width: 20px;
                    height: 20px;
                    fill: #dc3545;
                }

                .warning-text {
                    flex-grow: 1;
                    font-weight: 500;
                }

                .arrow-icon {
                    width: 12px;
                    height: 12px;
                    transition: transform 0.3s ease;
                    fill: var(--text-color);
                }

                .warning-trigger.active .arrow-icon {
                    transform: rotate(180deg);
                }

                .info-content {
                    background: white;
                    border: 1px solid var(--border-color);
                    border-radius: 8px;
                    padding: 16px;
                    margin-top: 8px;
                    transform-origin: top;
                    transform: scaleY(0);
                    opacity: 0;
                    height: 0;
                    transition: all 0.3s ease;
                }

                .info-content.active {
                    transform: scaleY(1);
                    opacity: 1;
                    height: auto;
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
                    box-shadow: 0 4px 12px rgba(33, 150, 243, 0.2);
                }

                .submit-btn:active {
                    transform: translateY(0);
                }

                .version {
                    position: fixed;
                    bottom: 1rem;
                    right: 1rem;
                    font-size: 0.8rem;
                    color: #666;
                    padding: 4px 8px;
                    background: rgba(255, 255, 255, 0.8);
                    border-radius: 4px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="proxy-card">
                    <h1 class="title"><span class="title-fly">🪰</span>BlissFly</h1>
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
                <div class="info-section">
                    <div class="warning-trigger">
                        <svg class="warning-icon" viewBox="0 0 24 24">
                            <path d="M12 2L1 21h22L12 2zm0 3.99L19.53 19H4.47L12 5.99zM13 16h-2v2h2v-2zm0-6h-2v4h2v-4z"/>
                        </svg>
                        <span class="warning-text">Important Information</span>
                        <svg class="arrow-icon" viewBox="0 0 24 24">
                            <path d="M7 10l5 5 5-5z"/>
                        </svg>
                    </div>
                    <div class="info-content">
                        This proxy only searches with URLs please use a URL when searching (example.com)
                    </div>
                </div>
            </div>
            <div class="version">Version ${VERSION}</div>
            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    const form = document.getElementById('proxyForm');
                    const input = form.querySelector('input');
                    const warningTrigger = document.querySelector('.warning-trigger');
                    const infoContent = document.querySelector('.info-content');

                    warningTrigger.addEventListener('click', () => {
                        warningTrigger.classList.toggle('active');
                        infoContent.classList.toggle('active');
                    });

                    document.addEventListener('click', (e) => {
                        if (!warningTrigger.contains(e.target)) {
                            warningTrigger.classList.remove('active');
                            infoContent.classList.remove('active');
                        }
                    });

                    form.addEventListener('submit', async (e) => {
                        e.preventDefault();
                        let url = input.value.trim();
                        
                        if (!url) {
                            showError('Please enter a URL');
                            return;
                        }

                        if (!url.startsWith('http://') && !url.startsWith('https://')) {
                            url = 'https://' + url;
                        }

                        try {
                            const encodedUrl = btoa(encodeURIComponent(url));
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

                        setTimeout(() => {
                            errorPopup.remove();
                        }, 3000);
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

        const url = deobfuscateUrl(encodedUrl);
        const normalizedUrl = normalizeUrl(url);
        
        const cachedResponse = cache.get(normalizedUrl);
        if (cachedResponse) {
            return res.send(cachedResponse);
        }

        const response = await fetch(normalizedUrl, {
            agent: new https.Agent({
                rejectUnauthorized: false,
                secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
            })
        });

        const contentType = response.headers.get('content-type') || '';
        const isProcessableType = PROCESSABLE_TYPES.some(type => contentType.includes(type));

        if (!isProcessableType) {
            response.body.pipe(res);
            return;
        }

        let content = await response.text();

        if (contentType.includes('text/html')) {
            content = ContentTransformer.transformHtml(content, normalizedUrl);
        } else if (contentType.includes('text/css')) {
            content = ContentTransformer.transformCss(content, normalizedUrl);
        } else if (contentType.includes('javascript')) {
            content = ContentTransformer.transformJavaScript(content);
        }

        cache.set(normalizedUrl, content);
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

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        version: VERSION,
        cacheStats: cache.getStats(),
        uptime: process.uptime()
    });
});

// Security headers middleware
app.use((req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'X-XSS-Protection': '1; mode=block',
        'Referrer-Policy': 'no-referrer',
        'X-DNS-Prefetch-Control': 'on',
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'Permissions-Policy': 'interest-cohort=()',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
    });
    next();
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

// Graceful shutdown >-<
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Performing graceful shutdown...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
