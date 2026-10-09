// The locked webpack-cli 4 uses the old dev-server constructor signature.
// Start dev-server 5 through its API without changing project dependencies.
const { createRequire } = require('node:module');
const requireFromViewer = createRequire('/usr/src/app/package.json');
const webpack = requireFromViewer('webpack');
const DevServer = requireFromViewer('webpack-dev-server');
const config = require('./frontend.webpack.cjs')({}, { mode: 'development' });
const compiler = webpack(config);
const server = new DevServer(config.devServer, compiler);
server.start().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
