const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const { URL } = require('url');

// Constants and configurations
const PORT = process.env.PORT || 10000;
const VERSION = 'v1.18';
const DEBUG = process.env.DEBUG === 'true';
const MAX_RETRIES = 3;
const TIMEOUT = 30000;

// Gaming domains that get special handling
const GAMING_DOMAINS = [
    'crazygames.com',
    'poki.com',
    'y8.com',
    'kizi.com',
    'kongregate.com',
    'addictinggames.com',
    'armor.ag',
    'iogames.space',
    'coolmathgames.com'
];

// Content types that need special processing
const PROCESSABLE_TYPES = [
    'text/html',
    'text/css',
    'application/javascript',
    'application/x-javascript',
    'text/javascript',
    'application/json'
];

class AdvancedCache {
    constructor(options = {}) {
        this.storage = new Map();
        this.maxSize = options.maxSize || 500;
        this.maxAge = options.maxAge || 300000; // 5 minutes
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0
        };
    }

    set(key, value, customTTL) {
        if (this.storage.size >= this.maxSize) {
            this._evictOldest();
        }

        const ttl = customTTL || this.maxAge;
        this.storage.set(key, {
            value,
            expires: Date.now() + ttl,
            lastAccessed: Date.now(),
            accessCount: 0
        });
    }

    get(key) {
        const item = this.storage.get(key);
        if (!item) {
            this.stats.misses++;
            return null;
        }

        if (Date.now() > item.expires) {
            this.storage.delete(key);
            this.stats.misses++;
            return null;
        }

        item.lastAccessed = Date.now();
        item.accessCount++;
        this.stats.hits++;
        return item.value;
    }

    _evictOldest() {
        let oldest = Infinity;
        let oldestKey = null;

        for (const [key, item] of this.storage.entries()) {
            if (item.lastAccessed < oldest) {
                oldest = item.lastAccessed;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.storage.delete(oldestKey);
            this.stats.evictions++;
        }
    }

    clear() {
        this.storage.clear();
        this.stats = { hits: 0, misses: 0, evictions: 0 };
    }

    getStats() {
        return {
            ...this.stats,
            size: this.storage.size,
            maxSize: this.maxSize
        };
    }
}

// initialize main app
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const cache = new AdvancedCache({
    maxSize: 1000,
    maxAge: 600000 // 10 mins
});

// Advanced WebSocket Manager for game support
class WebSocketManager {
    constructor(wss) {
        this.wss = wss;
        this.clients = new Map();
        this.gameStates = new Map();
        this.setupWebSocketServer();
    }

    setupWebSocketServer() {
        this.wss.on('connection', (ws, req) => {
            const clientId = crypto.randomBytes(16).toString('hex');
            this.clients.set(clientId, {
                ws,
                lastPing: Date.now(),
                gameState: null
            });

            ws.on('message', (message) => this.handleMessage(clientId, message));
            ws.on('close', () => this.handleClose(clientId));
            ws.on('error', (error) => this.handleError(clientId, error));

            // Send initial connection success
            this.sendToClient(clientId, {
                type: 'connection',
                status: 'established',
                clientId
            });

            // Setup ping interval
            const pingInterval = setInterval(() => {
                if (this.clients.has(clientId)) {
                    ws.ping();
                } else {
                    clearInterval(pingInterval);
                }
            }, 30000);
        });
    }

    handleMessage(clientId, message) {
        try {
            const data = JSON.parse(message);
            const client = this.clients.get(clientId);
            
            if (!client) return;

            switch (data.type) {
                case 'gameInit':
                    this.initializeGame(clientId, data);
                    break;
                case 'gameState':
                    this.updateGameState(clientId, data);
                    break;
                case 'gameAction':
                    this.handleGameAction(clientId, data);
                    break;
                case 'sync':
                    this.syncGameState(clientId);
                    break;
                default:
                    this.handleCustomMessage(clientId, data);
            }
        } catch (error) {
            DEBUG && console.error('WebSocket message handling error:', error);
            this.sendToClient(clientId, {
                type: 'error',
                message: 'Invalid message format'
            });
        }
    }

    initializeGame(clientId, data) {
        const gameState = {
            id: data.gameId,
            type: data.gameType,
            state: data.initialState || {},
            timestamp: Date.now()
        };
        
        this.gameStates.set(clientId, gameState);
        this.sendToClient(clientId, {
            type: 'gameInitialized',
            gameState
        });
    }

    updateGameState(clientId, data) {
        const currentState = this.gameStates.get(clientId);
        if (currentState) {
            Object.assign(currentState.state, data.state);
            currentState.timestamp = Date.now();
            
            this.sendToClient(clientId, {
                type: 'gameStateUpdated',
                gameState: currentState
            });
        }
    }

    handleGameAction(clientId, data) {
        const currentState = this.gameStates.get(clientId);
        if (currentState) {
            // Process game action and update state
            const actionResult = this.processGameAction(currentState, data.action);
            
            this.sendToClient(clientId, {
                type: 'actionProcessed',
                result: actionResult
            });
        }
    }

    processGameAction(gameState, action) {
        // Implement game-specific action processing
        switch (gameState.type) {
            case 'html5':
                return this.processHtml5GameAction(gameState, action);
            case 'flash':
                return this.processFlashGameAction(gameState, action);
            case 'unity':
                return this.processUnityGameAction(gameState, action);
            default:
                return this.processDefaultGameAction(gameState, action);
        }
    }

    handleClose(clientId) {
        this.gameStates.delete(clientId);
        this.clients.delete(clientId);
    }

    handleError(clientId, error) {
        DEBUG && console.error(`WebSocket error for client ${clientId}:`, error);
        this.sendToClient(clientId, {
            type: 'error',
            message: 'Connection error occurred'
        });
    }

    sendToClient(clientId, data) {
        const client = this.clients.get(clientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(data));
        }
    }

    broadcastToGame(gameId, data) {
        for (const [clientId, state] of this.gameStates.entries()) {
            if (state.id === gameId) {
                this.sendToClient(clientId, data);
            }
        }
    }
}

// Advanced content transformation and security handling
class ContentTransformer {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
        this.transformations = new Map();
        this.setupTransformations();
    }

    setupTransformations() {
        // HTML transformations
        this.transformations.set('text/html', (content) => {
            return this.transformHtml(content);
        });

        // CSS transformations
        this.transformations.set('text/css', (content) => {
            return this.transformCss(content);
        });

        // JavaScript transformations
        this.transformations.set('application/javascript', (content) => {
            return this.transformJavaScript(content);
        });
    }

    transformHtml(html) {
        const gameSupport = `
            <script>
                (function() {
                    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                    const ws = new WebSocket(wsProtocol + '//' + window.location.host);
                    let gameFrame = null;
                    let gameType = null;

                    // Game frame detection and setup
                    function detectAndSetupGame() {
                        const frames = Array.from(document.getElementsByTagName('iframe'));
                        const possibleGameFrames = frames.filter(frame => {
                            const src = frame.src.toLowerCase();
                            return src.includes('game') || 
                                   src.includes('play') || 
                                   frame.id.includes('game') || 
                                   frame.className.includes('game');
                        });

                        if (possibleGameFrames.length > 0) {
                            gameFrame = possibleGameFrames[0];
                            setupGameFrame();
                        }
                    }

                    function setupGameFrame() {
                        if (!gameFrame) return;

                        // Determine game type
                        const src = gameFrame.src.toLowerCase();
                        if (src.includes('unity')) gameType = 'unity';
                        else if (src.includes('html5')) gameType = 'html5';
                        else gameType = 'default';

                        // Initialize game communication
                        ws.send(JSON.stringify({
                            type: 'gameInit',
                            gameType: gameType,
                            gameId: crypto.randomUUID()
                        }));

                        // Setup message handling for game frame
                        window.addEventListener('message', function(event) {
                            if (event.source === gameFrame.contentWindow) {
                                ws.send(JSON.stringify({
                                    type: 'gameAction',
                                    action: event.data
                                }));
                            }
                        });
                    }

                    // WebSocket message handling
                    ws.onmessage = function(event) {
                        try {
                            const data = JSON.parse(event.data);
                            if (data.type === 'gameStateUpdated' && gameFrame) {
                                gameFrame.contentWindow.postMessage(data.gameState, '*');
                            }
                        } catch (error) {
                            console.error('Game message handling error:', error);
                        }
                    };

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
                                    window.location.href = '/watch?url=' + encodeURIComponent(absoluteUrl);
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

                    // Expose game proxy API
                    window.gameProxy = {
                        sendMessage: function(data) {
                            ws.send(JSON.stringify({
                                type: 'gameAction',
                                action: data
                            }));
                        },
                        getState: function() {
                            ws.send(JSON.stringify({
                                type: 'sync'
                            }));
                        }
                    };
                })();
            </script>
        `;

        return html
            .replace(/<head>/i, `<head><base href="${this.baseUrl}">`)
            .replace(/<\/head>/i, `${gameSupport}</head>`)
            .replace(/(href|src|action)=["']((?!data:|javascript:|#|mailto:|tel:).+?)["']/gi, 
                (match, attr, url) => {
                    try {
                        const absoluteUrl = new URL(url, this.baseUrl).href;
                        return `${attr}="/watch?url=${encodeURIComponent(absoluteUrl)}"`;
                    } catch (e) {
                        return match;
                    }
                }
            );
    }

    transformCss(css) {
        return css.replace(/url\(['"]?((?!data:).+?)['"]?\)/gi, (match, url) => {
            try {
                const absoluteUrl = new URL(url, this.baseUrl).href;
                return `url('/watch?url=${encodeURIComponent(absoluteUrl)}')`;
            } catch (e) {
                return match;
            }
        });
    }

    transformJavaScript(js) {
        // Add game support and proxy compatibility
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
                            return originalOpen.call(this, method, '/watch?url=' + encodeURIComponent(absoluteUrl), ...args);
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
                        return originalFetch('/watch?url=' + encodeURIComponent(absoluteUrl), options);
                    } catch (e) {
                        return originalFetch(url, options);
                    }
                };

                // Override WebSocket for game support
                window.WebSocket = function(url, protocols) {
                    if (url.includes('game') || url.includes('play')) {
                        return new originalWebSocket(
                            (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + 
                            '//' + window.location.host,
                            protocols
                        );
                    }
                    return new originalWebSocket(url, protocols);
                };
            })();

            ${js}
        `;
    }
}

// Request handling and middleware setup
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Security and performance middleware
app.use((req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'X-XSS-Protection': '1; mode=block',
        'Referrer-Policy': 'no-referrer',
        'X-DNS-Prefetch-Control': 'on',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
        'Access-Control-Max-Age': '86400'
    });
    next();
});

// Initialize WebSocket manager
const wsManager = new WebSocketManager(wss);

// Main proxy route handler
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Web Proxy ${VERSION}</title>
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
                }

                .title {
                    text-align: center;
                    margin-bottom: 2rem;
                    color: var(--primary-color);
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
                    transition: background 0.3s ease;
                }

                .submit-btn:hover {
                    background: var(--hover-color);
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
                }

                .notification .must {
                    color: #ff4444;
                    font-weight: bold;
                }

                .notification .links {
                    color: #00ff00;
                    font-weight: bold;
                }

                .version {
                    position: fixed;
                    bottom: 1rem;
                    right: 1rem;
                    font-size: 0.8rem;
                    color: #666;
                }
            </style>
        </head>
        <body>
            <div class="notification">
                Searches <span class="must">MUST</span> be <span class="links">Links</span>
            </div>
            <div class="container">
                <div class="proxy-card">
                    <h1 class="title">Web Proxy</h1>
                    <form id="proxyForm" class="proxy-form">
                        <input type="text" 
                               class="url-input" 
                               placeholder="Enter website URL" 
                               required>
                        <button type="submit" class="submit-btn">Browse</button>
                    </form>
                </div>
            </div>
            <div class="version">Version ${VERSION}</div>
            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    const notification = document.querySelector('.notification');
                    
                    setTimeout(() => {
                        notification.classList.add('show');
                        setTimeout(() => {
                            notification.classList.remove('show');
                        }, 5000);
                    }, 500);
                });

                document.getElementById('proxyForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    let url = e.target.querySelector('input').value.trim();
                    
                    if (!url.startsWith('http://') && !url.startsWith('https://')) {
                        if (${JSON.stringify(GAMING_DOMAINS)}.some(domain => url.includes(domain))) {
                            url = 'https://' + url;
                        } else {
                            const notification = document.querySelector('.notification');
                            notification.classList.add('show');
                            setTimeout(() => {
                                notification.classList.remove('show');
                            }, 5000);
                            return;
                        }
                    }
                    
                    window.location.href = '/watch?url=' + encodeURIComponent(url);
                });
            </script>
        </body>
        </html>
    `);
});

// Advanced request handling and content processing
async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
    let lastError;
    
    for (let i = 0; i < retries; i++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), TIMEOUT);
            
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    ...options.headers
                }
            });
            
            clearTimeout(timeout);
            return response;
        } catch (error) {
            lastError = error;
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
    }
    
    throw lastError;
}

app.get('/watch', async (req, res) => {
    try {
        let targetUrl = req.query.url;
        if (!targetUrl) {
            return res.redirect('/');
        }

        // Check cache first
        const cachedResponse = cache.get(targetUrl);
        if (cachedResponse) {
            return res.send(cachedResponse);
        }

        const response = await fetchWithRetry(targetUrl);
        const contentType = response.headers.get('content-type') || '';
        
        // Process different content types
        if (contentType.includes('html')) {
            const html = await response.text();
            const transformer = new ContentTransformer(targetUrl);
            const modifiedHtml = transformer.transformHtml(html);
            
            // Cache the transformed HTML
            cache.set(targetUrl, modifiedHtml);
            res.send(modifiedHtml);
        } else if (contentType.includes('javascript')) {
            const js = await response.text();
            const transformer = new ContentTransformer(targetUrl);
            const modifiedJs = transformer.transformJavaScript(js);
            res.set('Content-Type', 'application/javascript');
            res.send(modifiedJs);
        } else if (contentType.includes('css')) {
            const css = await response.text();
            const transformer = new ContentTransformer(targetUrl);
            const modifiedCss = transformer.transformCss(css);
            res.set('Content-Type', 'text/css');
            res.send(modifiedCss);
        } else {
            // Direct proxy for other content
            response.body.pipe(res);
        }
    } catch (error) {
        DEBUG && console.error('Proxy error:', error);
        res.status(503).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Error</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        padding: 20px;
                        text-align: center;
                    }
                    .error-container {
                        max-width: 600px;
                        margin: 0 auto;
                        background: #fff;
                        padding: 20px;
                        border-radius: 8px;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    }
                    .error-message {
                        color: #ff4444;
                        margin: 20px 0;
                    }
                    .button {
                        display: inline-block;
                        padding: 10px 20px;
                        margin: 10px;
                        background: #2196F3;
                        color: white;
                        border-radius: 4px;
                        text-decoration: none;
                        cursor: pointer;
                    }
                    .button:hover {
                        background: #1976D2;
                    }
                </style>
            </head>
            <body>
                <div class="error-container">
                    <h2>Resource Loading Error</h2>
                    <p class="error-message">${error.message}</p>
                    <button class="button" onclick="window.location.reload()">Retry</button>
                    <button class="button" onclick="window.location.href='/'">Return Home</button>
                </div>
            </body>
            </html>
        `);
    }
});

// middleware error
app.use((err, req, res, next) => {
    DEBUG && console.error('Global error:', err);
    res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Error</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    padding: 20px;
                    text-align: center;
                }
                .error-container {
                    max-width: 600px;
                    margin: 0 auto;
                    background: #fff;
                    padding: 20px;
                    border-radius: 8px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                }
                .error-message {
                    color: #ff4444;
                    margin: 20px 0;
                }
                .button {
                    display: inline-block;
                    padding: 10px 20px;
                    margin: 10px;
                    background: #2196F3;
                    color: white;
                    border-radius: 4px;
                    text-decoration: none;
                    cursor: pointer;
                }
                .button:hover {
                    background: #1976D2;
                }
            </style>
        </head>
        <body>
            <div class="error-container">
                <h2>Server Error</h2>
                <p class="error-message">An unexpected error occurred</p>
                <button class="button" onclick="window.location.reload()">Retry</button>
                <button class="button" onclick="window.location.href='/'">Return Home</button>
            </div>
        </body>
        </html>
    `);
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy server running on port ${PORT}`);
    console.log(`Version: ${VERSION}`);
    console.log(`WebSocket server active`);
    DEBUG && console.log('Debug mode enabled');
});

// Maintenance tasks
setInterval(() => {
    cache.clear();
    DEBUG && console.log('Cache cleared');
}, 3600000); // Clear cache every hr

module.exports = app;
