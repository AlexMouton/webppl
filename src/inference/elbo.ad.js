// Estimates the gradient of the ELBO.

// The estimator used is a combination of the
// likelihood-ratio/REINFORCE estimator and the "reparameterization
// trick" based estimator.

// Note that not all parameters are passed explicitly. Parameters are
// created lazily, and the guide program specifies how they should be
// initialized.

// Only the gradients of parameters seen during sampling are returned.
// All other gradients are taken to be zero.

'use strict';

var _ = require('underscore');
var assert = require('assert');
var util = require('../util');
var ad = require('../ad');
var paramStruct = require('../paramStruct');
var guide = require('../guide');

module.exports = function(env) {

  function ELBO(wpplFn, s, a, options, params, step, cont) {
    this.opts = util.mergeDefaults(options, {
      samples: 1
    });

    // The current values of all initialized parameters.
    // (Scalars/tensors, not their AD nodes.)
    this.params = params;

    this.step = step;
    this.cont = cont;

    this.wpplFn = wpplFn;
    this.s = s;
    this.a = a;

    this.coroutine = env.coroutine;
    env.coroutine = this;
  }

  ELBO.prototype = {

    run: function() {

      var elbo = 0;
      var grad = {};

      return util.cpsLoop(
        this.opts.samples,

        // Loop body.
        function(i, next) {
          this.iter = i;
          return this.estimateGradient(function(g, elbo_i) {
            paramStruct.addEq(grad, g); // Accumulate gradient estimates.
            elbo += elbo_i;
            return next();
          });
        }.bind(this),

        // Loop continuation.
        function() {
          paramStruct.divEq(grad, this.opts.samples);
          elbo /= this.opts.samples;
          env.coroutine = this.coroutine;
          return this.cont(grad, elbo);
        }.bind(this));

    },

    // Compute a single sample estimate of the gradient.

    estimateGradient: function(cont) {
      'use ad';

      // paramsSeen tracks the AD nodes of all parameters seen during
      // a single execution. These are the parameters for which
      // gradients will be computed.
      this.paramsSeen = {};
      this.logp = this.logq = this.logr = 0;

      return this.wpplFn(_.clone(this.s), function() {

        var scoreDiff = ad.value(this.logq) - ad.value(this.logp);
        assert.ok(typeof scoreDiff === 'number');
        assert.ok(_.isFinite(scoreDiff), 'ELBO: scoreDiff is not finite.');

        // Objective.

        // We could use the hybrid objective in all situations, but
        // for statistical efficiency we drop terms with zero
        // expectation where possible.

        var useLR = sameAdNode(this.logq, this.logr);

        // Sanity check.

        if (useLR) {
          // log p isn't expected to depend on the parameters unless
          // we use reparameterization.
          assert.ok(typeof this.logp === 'number');
        }

        // The objective used could change across steps, but for
        // simplicity only report on the first step.

        if (this.opts.verbose && this.iter === 0 && this.step === 0) {
          // Here PW stands for "path-wise" estimator, aka the reparam
          // trick.
          var estName =
                useLR ? 'LR' :
                (typeof this.logr === 'number') ? 'PW' :
                'hybrid';

          console.log('ELBO: Using ' + estName + ' estimator.');
        }

        var objective = useLR ?
              this.logq * scoreDiff :
              this.logr * scoreDiff + this.logq - this.logp;

        if (ad.isLifted(objective)) { // handle guides with zero parameters
          objective.backprop();
        }

        var grads = _.mapObject(this.paramsSeen, function(params) {
          return params.map(ad.derivative);
        });

        return cont(grads, -scoreDiff);

      }.bind(this), this.a);

    },

    sample: function(s, k, a, dist, options) {
      options = options || {};
      var guideDist;
      if (options.guide) {
        guideDist = options.guide;
      } else {
        guideDist = guide.independent(dist, a, env);
        if (this.step === 0 &&
            this.opts.verbose &&
            !this.mfWarningIssued) {
          this.mfWarningIssued = true;
          console.log('ELBO: Defaulting to mean-field for one or more choices.');
        }
      }
      var guideVal = this.sampleGuide(guideDist, options);
      this.sampleTarget(dist, guideVal);
      return k(s, guideVal);
    },

    sampleGuide: function(dist, options) {
      'use ad';

      var val;

      if ((!_.has(options, 'reparam') || options.reparam) &&
          dist.base && dist.transform) {
        // Use the reparameterization trick.

        var baseDist = dist.base();
        var z = baseDist.sample();
        this.logr += baseDist.score(z);
        val = dist.transform(z);
        this.logq += dist.score(val);

      } else if (options.reparam && !(dist.base && dist.transform)) {
        // Warn when reparameterization is explicitly requested but
        // isn't supported by the distribution.
        throw dist + ' does not support reparameterization.';
      } else {
        val = dist.sample();
        var score = dist.score(val);

        if (sameAdNode(this.logq, this.logr)) {
          // The reparameterization trick has not been used yet.
          // Continue representing logq and loqr with the same ad
          // node.
          this.logr += score;
          this.logq = this.logr;
        } else {
          // The reparameterization trick has been used earlier in the
          // execution. Update logq and logr independently.
          this.logr += score;
          this.logq += score;
        }
      }

      return val;
    },

    sampleTarget: function(dist, guideVal) {
      'use ad';
      this.logp += dist.score(guideVal);
    },

    factor: function(s, k, a, score) {
      'use ad';
      this.logp += score;
      return k(s);
    },

    mapDataFetch: function(data, options, address) {

      assert.strictEqual(this.mapDataMultiplier, undefined);
      assert.strictEqual(this.logp0, undefined);
      assert.strictEqual(this.logq0, undefined);
      assert.strictEqual(this.logr0, undefined);

      var ix;

      if (options.batchSize === data.length) {
        // Use all the data, in order.
        ix = [];
      } else {
        ix = _.times(options.batchSize, function() {
          return Math.floor(util.random() * data.length);
        });
      }

      // Store the info needed to compute the correction to account
      // for the fact we only looked as a subset of the data.

      // This assumes we don't have nested calls to `mapData`. Once we
      // do we can use `address` (the relative address of the mapData
      // call) for book-keeping?

      this.mapDataMultiplier = data.length / options.batchSize;
      this.logp0 = this.logp;
      this.logq0 = this.logq;
      this.logr0 = this.logr;

      return ix;
    },

    mapDataFinal: function() {
      'use ad';
      assert.notStrictEqual(this.mapDataMultiplier, undefined);
      assert.notStrictEqual(this.logp0, undefined);
      assert.notStrictEqual(this.logq0, undefined);
      assert.notStrictEqual(this.logr0, undefined);

      var noreparam = sameAdNode(this.logq, this.logr);
      var m = this.mapDataMultiplier - 1;

      this.logp += m * (this.logp - this.logp0);
      this.logq += m * (this.logq - this.logq0);
      if (noreparam) {
        // The reparameterization trick has not been used yet.
        // Continue representing logq and loqr with the same ad node.
        this.logr = this.logq;
      } else {
        this.logr += m * (this.logr - this.logr0);
      }

      this.mapDataMultiplier = this.logp0 = this.logq0 = this.logr0 = undefined;
    },

    incrementalize: env.defaultCoroutine.incrementalize,
    constructor: ELBO

  };

  function sameAdNode(a, b) {
    // We can't use === directly within an ad transformed function as
    // doing so checks the equality of the values stored at the nodes
    // rather than the nodes themselves.
    return a === b;
  }

  return function() {
    var coroutine = Object.create(ELBO.prototype);
    ELBO.apply(coroutine, arguments);
    return coroutine.run();
  };

};
