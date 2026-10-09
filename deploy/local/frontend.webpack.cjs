const fs = require('node:fs');
const { createRequire } = require('node:module');
const requireFromViewer = createRequire('/usr/src/app/package.json');
const makeConfig = requireFromViewer('./platform/app/.webpack/webpack.pwa.js');
module.exports = (env, argv) => {
  const config = makeConfig(env, argv);
  const tailnetPath = '/local/tailnet.json';
  const tailnetHost = fs.existsSync(tailnetPath)
    ? JSON.parse(fs.readFileSync(tailnetPath, 'utf8').replace(/^\uFEFF/, '')).hostname
    : null;
  if (tailnetHost && !/^[a-z0-9][a-z0-9.-]+\.ts\.net$/.test(tailnetHost)) {
    throw new Error('Invalid local Tailscale hostname. Run Publish-Tailnet.ps1 again.');
  }
  config.devServer = {
    ...config.devServer,
    host: '0.0.0.0', port: 3000, open: false,
    allowedHosts: ['localhost', '127.0.0.1', 'frontend', ...(tailnetHost ? [tailnetHost] : [])],
    proxy: [],
    devMiddleware: { ...config.devServer.devMiddleware, writeToDisk: false },
    client: { ...config.devServer.client, webSocketURL: 'auto://0.0.0.0:0/ws' },
    setupMiddlewares(middlewares, server) {
      server.app.get('/app-config.js', (_req, res) => {
        const source = fs.readFileSync('/usr/src/app/platform/app/public/config/nifti.js', 'utf8');
        res.type('application/javascript').set('Cache-Control', 'no-store').send(
          source + '\nwindow.config.enableNiftiStreaming = true;\n'
        );
      });
      return middlewares;
    },
  };
  config.watchOptions = { ...config.watchOptions, poll: 1000, aggregateTimeout: 300 };
  return config;
};
