/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
module.exports = {
  mutate: ["prompt-vault@alex/pv_core.js"],
  testRunner: "command",
  commandRunner: {
    command: "node --test test/unit/*.test.js test/integration/*.test.js test/e2e/*.test.js",
  },
  coverageAnalysis: "off",
  timeoutMS: 10000,
  reporters: ["clear-text", "progress", "html"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  thresholds: { high: 90, low: 85, break: 85 },
  concurrency: 4,
};
