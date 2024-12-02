// Part 1: Imports and Initial Setup
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
const VERSION = '1.1.14';
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

// Middleware
app.use(cors());

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
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
        'Cache-Control': 'public, max-age=300'
    });
    next();
});

// Part 2: Advanced Cache Implementation
class AdvancedCache {
    constructor(options = {}) {
        this.storage = new Map();
        this.maxSize = options.maxSize || MAX_CACHE_SIZE;
        this.maxAge = options.maxAge || CACHE_TTL;
        this.memoryUsage = 0;
        this.maxMemory = options.maxMemory || 100 * 1024 * 1024; // 100MB default
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0,
            totalRequests: 0
        };
        this.lastCleanup = Date.now();
    }

    set(key, value, customTTL) {
        const itemSize = this._calculateSize(value);
        
        if (this.memoryUsage + itemSize > this.maxMemory || 
            this.storage.size >= this.maxSize) {
            this._evictBatch();
        }

        const ttl = customTTL || this.maxAge;
        const item = {
            value,
            expires: Date.now() + ttl,
            lastAccessed: Date.now(),
            accessCount: 0,
            size: itemSize
        };

        this.storage.set(key, item);
        this.memoryUsage += itemSize;
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
            this.memoryUsage -= item.size;
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
            return Buffer.byteLength(value, 'utf8');
        }
        return JSON.stringify(value).length;
    }

    _evictBatch() {
        const itemsToEvict = Math.ceil(this.storage.size * 0.1);
        const sortedItems = Array.from(this.storage.entries())
            .sort((a, b) => (a[1].lastAccessed - b[1].lastAccessed));

        for (let i = 0; i < itemsToEvict; i++) {
            if (sortedItems[i]) {
                const [key, item] = sortedItems[i];
                this.storage.delete(key);
                this.memoryUsage -= item.size;
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
                this.memoryUsage -= item.size;
                this.stats.evictions++;
            }
        }
    }

    getStats() {
        return {
            ...this.stats,
            size: this.storage.size,
            maxSize: this.maxSize,
            memoryUsage: this.memoryUsage,
            maxMemory: this.maxMemory,
            hitRate: (this.stats.hits / this.stats.totalRequests) || 0,
            evictionRate: (this.stats.evictions / this.stats.totalRequests) || 0
        };
    }
}

// Initialize cache
const cache = new AdvancedCache();

// Part 3: WebSocket Manager Implementation
class WebSocketManager {
    constructor(wss) {
        this.wss = wss;
        this.clients = new Map();
        this.gameStates = new Map();
        this.setupWebSocketServer();
        this.pingInterval = this.startPingInterval();
    }

    setupWebSocketServer() {
        this.wss.on('connection', (ws, req) => {
            const clientId = this.generateClientId();
            this.initializeClient(clientId, ws);
            this.setupClientHandlers(clientId, ws);
        });

        this.wss.on('error', (error) => {
            DEBUG && console.error('WebSocket Server Error:', error);
        });
    }

    startPingInterval() {
        return setInterval(() => {
            this.wss.clients.forEach(client => {
                if (client.isAlive === false) {
                    return client.terminate();
                }
                client.isAlive = false;
                client.ping();
            });
        }, TIMEOUT);
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

    handleError(clientId, error) {
        DEBUG && console.error(`Client ${clientId} error:`, error);
        this.handleClose(clientId);
    }

    handlePong(clientId) {
        const client = this.clients.get(clientId);
        if (client) {
            client.isAlive = true;
            client.lastPing = Date.now();
        }
    }
}

// Initialize WebSocket Manager
const wsManager = new WebSocketManager(wss);

// Part 4: Content Transformer and URL Handlers
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
                        const encodedUrl = Buffer.from(absoluteUrl).toString('base64');
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
                const encodedUrl = Buffer.from(absoluteUrl).toString('base64');
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

// Part 5: Routes, Error Handlers, and Server Startup
// URL validation utility
const validateUrl = (url) => {
    const urlPattern = /^https?:\/\/.+/i;
    return urlPattern.test(url);
};

// Watch route handler
app.get('/watch', async (req, res) => {
    try {
        const encodedUrl = req.query.url;
        if (!encodedUrl) {
            return res.status(400).send('URL parameter is required');
        }

        const url = Buffer.from(encodedUrl, 'base64').toString();
        if (!validateUrl(url)) {
            return res.status(400).send('Invalid URL format');
        }

        const cachedResponse = cache.get(url);
        if (cachedResponse) {
            return res.send(cachedResponse);
        }

        const response = await fetch(url, {
            agent: new https.Agent({
                rejectUnauthorized: false,
                secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
            }),
            timeout: TIMEOUT
        });

        const contentType = response.headers.get('content-type') || '';
        const isProcessableType = PROCESSABLE_TYPES.some(type => contentType.includes(type));

        if (!isProcessableType) {
            response.body.pipe(res);
            return;
        }

        let content = await response.text();

        if (contentType.includes('text/html')) {
            content = ContentTransformer.transformHtml(content, url);
        } else if (contentType.includes('text/css')) {
            content = ContentTransformer.transformCss(content, url);
        } else if (contentType.includes('javascript')) {
            content = ContentTransformer.transformJavaScript(content);
        }

        cache.set(url, content);
        res.send(content);

    } catch (error) {
        DEBUG && console.error('Proxy error:', error);
        res.status(500).send('Error processing request');
    }
});

// Monitoring endpoint
app.get('/metrics', (req, res) => {
    res.json({
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        activeConnections: wss.clients.size,
        startTime: process.hrtime()[0],
        cacheStats: cache.getStats(),
        version: VERSION
    });
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

// Error handlers
server.on('error', (error) => {
    console.error('HTTP Server Error:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (!DEBUG) process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (!DEBUG) process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Performing graceful shutdown...');
    
    // Close WebSocket connections
    wss.clients.forEach(client => {
        client.terminate();
    });

    // Clear intervals
    if (wsManager.pingInterval) {
        clearInterval(wsManager.pingInterval);
    }

    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
        console.error('Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
});

// Start server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Version: ${VERSION}`);
    if (DEBUG) console.log('Debug mode enabled');
});

module.exports = { app, server, cache, wsManager };
