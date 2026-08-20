const autoprefixer = require('autoprefixer');
const postcssPresetEnv = require('postcss-preset-env');

/** @type {import('postcss-load-config').Config} */
module.exports = {
  plugins: [
    postcssPresetEnv({ stage: 2 }),
    autoprefixer,
  ],
};
