'use strict';

var _ = require('underscore');
var fs = require('fs');
var webppl = require('../src/main');
var erp = require('../src/erp');

var examplesDir = './examples/';

// TODO: Update examples to work with new ERP.

var examples = [
  'binomial',
  'geometric',
  'hmm',
  'hmmIncremental',
  // 'lda',
  // 'ldaCollapsed',
  'linearRegression',
  'logisticRegression',
  // 'multivariateRegression',
  // 'pcfg',
  // 'pcfgIncremental',
  'scalarImplicature',
  'semanticParsing',
  'pragmaticsWithSemanticParsing'
];

var loadExample = function(example) {
  var filename = examplesDir + example + '.wppl';
  return fs.readFileSync(filename, 'utf-8');
};

var generateTestCases = function() {
  _.each(examples, function(example) {
    exports[example] = function(test) {
      test.doesNotThrow(function() {
        webppl.run(loadExample(example), function(s, val) {
          test.ok(erp.isErp(val));
        });
      });
      test.done();
    };
  });
};

generateTestCases();
