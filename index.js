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

// Consts and Cfgs
const PORT = process.env.PORT || 10000;
const VERSION = 'v1.20';
const DEBUG = process.env.DEBUG === 'true';
const MAX_RETRIES = 3;
const TIMEOUT = 30000;
const MAX_CACHE_SIZE = 1000;
const CACHE_TTL = 600000;

// content handling cfgs
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

// WS message types
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
            return value.length * 2; // Approximate UTF-16 string size
        }
        return 512; // Default size for other types
    }

    _evictBatch() {
        const itemsToEvict = Math.ceil(this.storage.size * 0.1); // Evict 10% of items
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
        if (now - this.lastCleanup > 300000) { // 5 minutes
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

        // ping interval
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
            
            // Broadcast to all players
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

    processGameAction(gameState, action) {
        switch (gameState.type) {
            case 'html5':
                return this.processHtml5GameAction(gameState, action);
            case 'unity':
                return this.processUnityGameAction(gameState, action);
            default:
                return this.processDefaultGameAction(gameState, action);
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

    handleClose(clientId) {
        const client = this.clients.get(clientId);
        if (client?.gameState) {
            const gameState = this.gameStates.get(client.gameState);
            if (gameState) {
                gameState.players.delete(clientId);
                if (gameState.players.size === 0) {
                    this.gameStates.delete(client.gameState);
                } else {
                    this.broadcastGameState(client.gameState);
                }
            }
        }
        this.clients.delete(clientId);
    }

    handleError(clientId, error) {
        DEBUG && console.error(`WebSocket error for client ${clientId}:`, error);
        this.sendToClient(clientId, {
            type: WS_MESSAGES.ERROR,
            message: 'Connection error occurred'
        });
    }

    pingClient(clientId) {
        const client = this.clients.get(clientId);
        if (!client) return;

        if (!client.isAlive) {
            this.handleClose(clientId);
            return;
        }

        client.isAlive = false;
        client.ws.ping();
    }

    handlePong(clientId) {
        const client = this.clients.get(clientId);
        if (client) {
            client.isAlive = true;
            client.lastPing = Date.now();
        }
    }

    sendToClient(clientId, data) {
        const client = this.clients.get(clientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(data));
        }
    }

    broadcastToGame(gameId, data) {
        const gameState = this.gameStates.get(gameId);
        if (gameState) {
            for (const playerId of gameState.players) {
                this.sendToClient(playerId, data);
            }
        }
    }
}

// Initialize main application components
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const cache = new AdvancedCache({
    maxSize: MAX_CACHE_SIZE,
    maxAge: CACHE_TTL
});


// URL utilities
const normalizeUrl = (url) => {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return `https://${url}`;
    }
    return url;
};

const obfuscateUrl = (url) => Buffer.from(url).toString('base64');
const deobfuscateUrl = (encoded) => Buffer.from(encoded, 'base64').toString('utf8');

// Middleware setup
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

// Initialize WebSocket manager
const wsManager = new WebSocketManager(wss);

// Content transformer for different types
class ContentTransformer {
    static transformHtml(html, baseUrl) {
        const gameSupport = `
            <script>
                (function() {
                    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                    const ws = new WebSocket(wsProtocol + '//' + window.location.host);
                    
                    // Game state management
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

                    // WebSocket event handlers
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

                    // Enhanced link handling
                    document.addEventListener('click', function(e) {
                        const link = e.target.closest('a');
                        if (link) {
                            const href = link.getAttribute('href');
                            if (href && !href.startsWith('javascript:') && !href.startsWith('#') && 
                                !href.startsWith('mailto:') && !href.startsWith('tel:')) {
                                e.preventDefault();
                                e.stopPropagation();
                                
                                try {
                                    const absoluteUrl = new URL(href, window.location.href).href;
                                    const encodedUrl = btoa(encodeURIComponent(absoluteUrl));
                                    window.location.href = '/watch?url=' + encodedUrl;
                                } catch (error) {
                                    console.error('URL processing error:', error);
                                }
                            }
                        }
                    }, true);

                    // Initialize after DOM is ready
                    if (document.readyState === 'loading') {
                        document.addEventListener('DOMContentLoaded', detectAndSetupGame);
                    } else {
                        detectAndSetupGame();
                    }

                    // Loading animation
                    const loadingAnimation = document.createElement('div');
                    loadingAnimation.innerHTML = \`
                        <div class="loading-animation">
                            <span class="fly">🪰</span>
                            <span class="poop">💩</span>
                        </div>
                    \`;
                    document.body.appendChild(loadingAnimation);
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

                // Override XMLHttpRequest
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

                // Override fetch
                window.fetch = async function(url, options = {}) {
                    try {
                        const absoluteUrl = new URL(url, window.location.href).href;
                        const encodedUrl = btoa(encodeURIComponent(absoluteUrl));
                        return originalFetch('/watch?url=' + encodedUrl, options);
                    } catch (e) {
                        return originalFetch(url, options);
                    }
                };

                // Override WebSocket
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

// Main route handler
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
                }

                * {
                    box-sizing: border-box;
                    margin: 0;
                    padding: 0;
                }

                @keyframes flyAnimation {
                    0% { transform: translate(0, 0) rotate(0deg); }
                    25% { transform: translate(100px, -50px) rotate(45deg); }
                    50% { transform: translate(0, -100px) rotate(90deg); }
                    75% { transform: translate(-100px, -50px) rotate(135deg); }
                    100% { transform: translate(0, 0) rotate(360deg); }
                }

                @keyframes poopBounce {
                    0%, 100% { transform: translateY(0); }
                    50% { transform: translateY(-10px); }
                }

                .loading-animation {
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    display: none;
                    z-index: 1000;
                }

                .fly {
                    font-size: 24px;
                    position: absolute;
                    animation: flyAnimation 2s infinite;
                }

                .poop {
                    font-size: 24px;
                    animation: poopBounce 1s infinite;
                }

                .notification {
                    position: fixed;
                    top: -50px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: #663399;
                    color: white;
                    padding: 12px 24px;
                    border-radius: 8px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                    z-index: 1000;
                    transition: top 0.5s ease;
                    font-family: Arial, sans-serif;
                }

                .notification.show {
                    top: 20px;
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
                }

                .proxy-card::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    height: 4px;
                    background: linear-gradient(90deg, var(--primary-color), var(--hover-color));
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
                    top: 0;
                    right: -30px;
                    font-size: 0.8em;
                    animation: flyHover 2s infinite;
                }

                @keyframes flyHover {
                    0%, 100% { transform: translate(0, 0); }
                    50% { transform: translate(5px, -5px); }
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
                    position: relative;
                    overflow: hidden;
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
            <div class="notification">
                Enter any URL to begin browsing
            </div>
            <div class="loading-animation">
                <span class="fly">🪰</span>
                <span class="poop">💩</span>
            </div>
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
            </div>
            <div class="version">Version ${VERSION}</div>
            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    const notification = document.querySelector('.notification');
                    notification.classList.add('show');
                    setTimeout(() => {
                        notification.classList.remove('show');
                    }, 5000);

                    const loadingAnimation = document.querySelector('.loading-animation');
                    const form = document.getElementById('proxyForm');
                    const input = form.querySelector('input');

                    form.addEventListener('submit', async (e) => {
                        e.preventDefault();
                        let url = input.value.trim();
                        
                        // Add https:// if no protocol specified
                        if (!url.startsWith('http://') && !url.startsWith('https://')) {
                            url = 'https://' + url;
                        }

                        loadingAnimation.style.display = 'block';
                        
                        try {
                            const encodedUrl = btoa(encodeURIComponent(url));
                            window.location.href = '/watch?url=' + encodedUrl;
                        } catch (error) {
                            notification.textContent = 'Invalid URL format';
                            notification.classList.add('show');
                            setTimeout(() => {
                                notification.classList.remove('show');
                            }, 3000);
                            loadingAnimation.style.display = 'none';
                        }
                    });

                    // Auto-focus input on page load
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
            return res.redirect('/');
        }

        const targetUrl = normalizeUrl(decodeURIComponent(atob(encodedUrl)));
        
        // Check cache
        const cachedResponse = cache.get(targetUrl);
        if (cachedResponse) {
            return res.send(cachedResponse);
        }

        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            }
        });

        const contentType = response.headers.get('content-type') || '';

        // Handle different content types
        if (contentType.includes('html')) {
            const html = await response.text();
            const transformedHtml = ContentTransformer.transformHtml(html, targetUrl);
            cache.set(targetUrl, transformedHtml);
            res.send(transformedHtml);
        } 
        else if (contentType.includes('javascript')) {
            const js = await response.text();
            const transformedJs = ContentTransformer.transformJavaScript(js);
            res.set('Content-Type', 'application/javascript');
            res.send(transformedJs);
        } 
        else if (contentType.includes('css')) {
            const css = await response.text();
            const transformedCss = ContentTransformer.transformCss(css, targetUrl);
            res.set('Content-Type', 'text/css');
            res.send(transformedCss);
        } 
        else {
            // Direct proxy for other content types
            res.set('Content-Type', contentType);
            response.body.pipe(res);
        }
    } catch (error) {
        DEBUG && console.error('Proxy error:', error);
        res.status(503).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>BlissFly Error</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                        background: #f5f5f5;
                    }
                    .error-container {
                        background: white;
                        padding: 2rem;
                        border-radius: 10px;
                        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                        text-align: center;
                        max-width: 500px;
                        width: 90%;
                    }
                    .error-title {
                        color: #2196F3;
                        margin-bottom: 1rem;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 0.5rem;
                    }
                    .error-message {
                        color: #ff4444;
                        margin: 1rem 0;
                    }
                    .button {
                        background: #2196F3;
                        color: white;
                        border: none;
                        padding: 10px 20px;
                        border-radius: 5px;
                        cursor: pointer;
                        transition: background 0.3s ease;
                        text-decoration: none;
                        display: inline-block;
                        margin: 5px;
                    }
                    .button:hover {
                        background: #1976D2;
                    }
                    .fly-animation {
                        animation: fly 2s infinite;
                    }
                    @keyframes fly {
                        0%, 100% { transform: translate(0, 0); }
                        50% { transform: translate(5px, -5px); }
                    }
                </style>
            </head>
            <body>
                <div class="error-container">
                    <h2 class="error-title">BlissFly <span class="fly-animation">🪰</span></h2>
                    <p class="error-message">${error.message}</p>
                    <button class="button" onclick="window.location.reload()">Try Again</button>
                    <a href="/" class="button">Return Home</a>
                </div>
            </body>
            </html>
        `);
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    DEBUG && console.error('Global error:', err);
    res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>BlissFly Error</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                    background: #f5f5f5;
                }
                .error-container {
                    background: white;
                    padding: 2rem;
                    border-radius: 10px;
                    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                    text-align: center;
                    max-width: 500px;
                    width: 90%;
                }
                .error-title {
                    color: #2196F3;
                    margin-bottom: 1rem;
                }
                .button {
                    background: #2196F3;
                    color: white;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 5px;
                    cursor: pointer;
                    transition: background 0.3s ease;
                    text-decoration: none;
                    display: inline-block;
                    margin: 5px;
                }
                .button:hover {
                    background: #1976D2;
                }
            </style>
        </head>
        <body>
            <div class="error-container">
                <h2 class="error-title">BlissFly 🪰</h2>
                <p>An unexpected error occurred</p>
                <button class="button" onclick="window.location.reload()">Try Again</button>
                <a href="/" class="button">Return Home</a>
            </div>
        </body>
        </html>
    `);
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`BlissFly 🪰 proxy running on port ${PORT}`);
    console.log(`Version: ${VERSION}`);
    console.log(`WebSocket server active`);
    DEBUG && console.log('Debug mode enabled');
});

// Maintenance tasks
setInterval(() => {
    cache.clear();
    DEBUG && console.log('Cache cleared');
}, 3600000); // Clear cache every hour

module.exports = app;
