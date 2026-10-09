const base = require('../../babel.config.js');
module.exports = { ...base, env: { ...base.env, test: {
  // Jest runs on Node; native async/for-of avoids the legacy regenerator ordering bug.
  presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }], '@babel/preset-react', '@babel/preset-typescript'],
  // Jest uses CommonJS; worker entry URLs are not exercised by these service tests.
  plugins: [({ types: t }) => ({ visitor: { MetaProperty(path) {
    if (path.node.meta.name === 'import' && path.node.property.name === 'meta') {
      path.replaceWith(t.objectExpression([t.objectProperty(t.identifier('url'), t.stringLiteral('file:///nifti-test/'))]));
    }
  } } })],
} } };
