self.__bf$config = {
    prefix: '/service/',
    encodeUrl: BlissFly.codec.xor.encode,
    decodeUrl: BlissFly.codec.xor.decode,
    handler: '/bf.handler.js',
    client: '/bf.client.js',
    bundle: '/bf.bundle.js',
    config: '/bf.config.js',
    sw: '/bf.sw.js',
};
