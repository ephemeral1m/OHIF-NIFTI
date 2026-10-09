const base = require('../../jest.config.base.js');
module.exports = { ...base, displayName: '@ohif/extension-nifti',
  moduleFileExtensions: [...base.moduleFileExtensions, 'mjs'],
  transform: { '^.+\\.(?:mjs|[jt]sx?)$': ['babel-jest', { plugins: ['@babel/plugin-transform-modules-commonjs'] }] },
  moduleNameMapper: { ...base.moduleNameMapper, '@ohif/(.*)': '<rootDir>/../../platform/$1/src' } };
