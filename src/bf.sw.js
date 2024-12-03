// Service Worker implementation
const BlissFlyServiceWorker = class extends EventEmitter {
    constructor(config = __bf$config) {
        super();
        if (!config.prefix) config.prefix = '/service/';
        this.config = config;
        this.bareClient = new BareClient();
    }

    async handleRequest(event) {
        try {
            const request = event.request;
            const url = new URL(request.url);
            
            if (url.pathname.startsWith(this.config.prefix)) {
                const bareResponse = await this.bareClient.fetch(request);
                return this.processResponse(bareResponse);
            }
            
            return fetch(request);
        } catch (error) {
            return new Response('Error processing request', { status: 500 });
        }
    }
}
