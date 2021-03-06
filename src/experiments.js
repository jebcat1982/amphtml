/**
 * Copyright 2015 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Experiments system allows a developer to opt-in to test
 * features that are not yet fully tested.
 *
 * Experiments page: https://cdn.ampproject.org/experiments.html *
 */

import {bytesToUInt32, stringToBytes, utf8DecodeSync} from './utils/bytes';
import {getCookie, setCookie} from './cookies';
import {getServicePromise} from './service';
import {getSourceOrigin, parseQueryString, parseUrl} from './url';
import {user} from './log';
import {parseJson} from './json';

/** @const {string} */
const TAG = 'experiments';

/** @const {string} */
const COOKIE_NAME = 'AMP_EXP';

/** @const {number} */
const COOKIE_MAX_AGE_DAYS = 180;  // 6 month

/** @const {time} */
const COOKIE_EXPIRATION_INTERVAL = COOKIE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** @const {string} */
const TOGGLES_WINDOW_PROPERTY = '__AMP__EXPERIMENT_TOGGLES';

//TODO(kmh287, #8331) Uncomment and replace empty object literal with real
// experiment public key jwk.
/** @type {!Promise<undefined>} */
const originTrialsPromise = Promise.resolve();
// const originTrialsPromise = enableExperimentsForOriginTrials(self, {});

/**
 * @typedef {{
 *   isTrafficEligible: !function(!Window):boolean,
 *   branches: !Array<string>
 * }}
 */
export let ExperimentInfo;

/**
 * Whether we are in canary.
 * @param {!Window} win
 * @return {boolean}
 */
export function isCanary(win) {
  return !!(win.AMP_CONFIG && win.AMP_CONFIG.canary);
}


/**
 * Enable experiments detailed in an origin trials token iff the token is
 * valid. A token is invalid if *
 *   1. The token is malformed (e.g. non-existant version number)
 *   2. The token is not for this origin
 *   3. The experiments data was not signed with our private key
 * @param {!Window} win
 * @param {string} token
 * @param {!./service/crypto-impl.Crypto} crypto Crypto service
 * @param {!webCrypto.CryptoKey} key Public key used to verify the token's
 *    signature.
 * @return {!Promise<undefined>}
 */
function enableExperimentsFromToken(win, token, crypto, key) {
  if (!crypto.isPkcsAvailable()) {
    user().warn(TAG, 'Crypto is unavailable');
    return Promise.resolve();
  }
  /**
   * token = encode64(version + length + config +
   *    sign(version + length + config, private_key))
   * version = 1 byte version of the token format (starting at 0x0)
   */
  let current = 0;
  const bytes = stringToBytes(atob(token));
  const version = bytes[current];
  if (version !== 0) {
    // Unrecognized version number
    return Promise.reject(
        new Error(`Unrecognized experiments token version: ${version}`));
  }
  current++;
  /**
   * Version 0:
   * length = 4 bytes representing number of bytes in config
   * config = string containing the experiment ID, origin URL, etc.
   */
  const bytesForConfigSize = 4;
  const configSize =
      bytesToUInt32(bytes.subarray(current, current + bytesForConfigSize));
  current += bytesForConfigSize;
  if (configSize > bytes.length - current) {
    return Promise.reject(
        new Error('Specified len extends past end of buffer'));
  }
  const configBytes = bytes.subarray(current, current + configSize);
  current += configSize;
  const signedBytes = bytes.subarray(0, current);
  const signatureBytes = bytes.subarray(current);

  return crypto.verifyPkcs(key, signatureBytes, signedBytes)
      .then(verified => {
        if (!verified) {
          throw new Error('Failed to verify config signature');
        }
        const configStr = utf8DecodeSync(configBytes);
        const config = parseJson(configStr);

        const approvedOrigin = parseUrl(config['origin']).origin;
        const sourceOrigin = getSourceOrigin(win.location);
        if (approvedOrigin !== sourceOrigin) {
          throw new Error('Config does not match current origin');
        }

        const experimentId = config['experiment'];
        const expiration = config['expiration'];
        const now = Date.now();
        if (expiration >= now) {
          toggleExperiment(win,
              experimentId,
              /* opt_on */ true,
              /* opt_transientExperiment */ true);
        } else {
          throw new Error(`Experiment ${experimentId} has expired`);
        }
      });
}


/**
 * Scan the page for origin trial tokens. Enable experiments detailed in the
 * tokens iff the token is well-formed. A token
 * @param {!Window} win
  *@param {!Object} publicJwk Used for testing only.
 * @return {!Promise<undefined>}
 */
export function enableExperimentsForOriginTrials(win, publicJwk) {
  const metas =
      win.document.head.querySelectorAll('meta[name="amp-experiment-token"]');
  if (metas.length == 0 || Object.keys(publicJwk).length == 0) {
    return Promise.resolve();
  }
  let crypto;
  return getServicePromise(win, 'crypto').then(c => {
    crypto = /** @type {!./service/crypto-impl.Crypto} */ (c);
    return crypto.importPkcsKey(publicJwk);
  }).then(key => {
    const tokenPromises = [];
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      const token = meta.getAttribute('content');
      if (token) {
        const tokenPromise =
            enableExperimentsFromToken(win, token, crypto, key)
                .catch(err => {
                  // Log message but do not prevent scans of other tokens.
                  user().warn(TAG, err);
                });
        tokenPromises.push(tokenPromise);
      } else {
        user().warn(TAG, 'Unable to read experiments token');
      }
    }
    return Promise.all(tokenPromises);
  });
}

/**
 * Determines if the specified experiment is on or off for origin trials.
 * Callers should check if the experiment is already enabled before calling this
 * function.
 *
 * @param {!Window} win
 * @param {string} experimentId
 * @return {!Promise<boolean>}
 */
export function isExperimentOnForOriginTrial(win, experimentId) {
  return originTrialsPromise.then(() => isExperimentOn(win, experimentId));
}

/**
 * Whether the specified experiment is on or off.
 * @param {!Window} win
 * @param {string} experimentId
 * @return {boolean}
 */
export function isExperimentOn(win, experimentId) {
  const toggles = experimentToggles(win);
  return !!toggles[experimentId];
}

/**
 * Toggles the experiment on or off. Returns the actual value of the experiment
 * after toggling is done.
 * @param {!Window} win
 * @param {string} experimentId
 * @param {boolean=} opt_on
 * @param {boolean=} opt_transientExperiment  Whether to toggle the
 *     experiment state "transiently" (i.e., for this page load only) or
 *     durably (by saving the experiment IDs to the cookie after toggling).
 *     Default: false (save durably).
 * @return {boolean} New state for experimentId.
 */
export function toggleExperiment(win, experimentId, opt_on,
    opt_transientExperiment) {
  const currentlyOn = isExperimentOn(win, experimentId);
  const on = !!(opt_on !== undefined ? opt_on : !currentlyOn);
  if (on != currentlyOn) {
    const toggles = experimentToggles(win);
    toggles[experimentId] = on;

    if (!opt_transientExperiment) {
      const cookieToggles = getExperimentTogglesFromCookie(win);
      cookieToggles[experimentId] = on;
      saveExperimentTogglesToCookie(win, cookieToggles);
    }
  }
  return on;
}

/**
 * Calculate whether the experiment is on or off based off of the
 * cookieFlag or the global config frequency given.
 * @param {!Window} win
 * @return {!Object<string, boolean>}
 */
export function experimentToggles(win) {
  if (win[TOGGLES_WINDOW_PROPERTY]) {
    return win[TOGGLES_WINDOW_PROPERTY];
  }
  win[TOGGLES_WINDOW_PROPERTY] = Object.create(null);
  const toggles = win[TOGGLES_WINDOW_PROPERTY];

  // Read the default config of this build.
  if (win.AMP_CONFIG) {
    for (const experimentId in win.AMP_CONFIG) {
      const frequency = win.AMP_CONFIG[experimentId];
      if (typeof frequency === 'number' && frequency >= 0 && frequency <= 1) {
        toggles[experimentId] = Math.random() < frequency;
      }
    }
  }
  // Read document level override from meta tag.
  if (win.AMP_CONFIG
      && Array.isArray(win.AMP_CONFIG['allow-doc-opt-in'])
      && win.AMP_CONFIG['allow-doc-opt-in'].length > 0) {
    const allowed = win.AMP_CONFIG['allow-doc-opt-in'];
    const meta =
        win.document.head.querySelector('meta[name="amp-experiments-opt-in"]');
    if (meta) {
      const optedInExperiments = meta.getAttribute('content').split(',');
      for (let i = 0; i < optedInExperiments.length; i++) {
        if (allowed.indexOf(optedInExperiments[i]) != -1) {
          toggles[optedInExperiments[i]] = true;
        }
      }
    }
  }

  Object.assign(toggles, getExperimentTogglesFromCookie(win));

  if (win.AMP_CONFIG
      && Array.isArray(win.AMP_CONFIG['allow-url-opt-in'])
      && win.AMP_CONFIG['allow-url-opt-in'].length > 0) {
    const allowed = win.AMP_CONFIG['allow-url-opt-in'];
    const hash = win.location.originalHash || win.location.hash;
    const params = parseQueryString(hash);
    for (let i = 0; i < allowed.length; i++) {
      const param = params[`e-${allowed[i]}`];
      if (param == '1') {
        toggles[allowed[i]] = true;
      }
      if (param == '0') {
        toggles[allowed[i]] = false;
      }
    }
  }
  return toggles;
}

/**
 * Returns the cached experiments toggles, or null if they have not been
 * computed yet.
 * @param {!Window} win
 * @return {Object<string, boolean>}
 */
export function experimentTogglesOrNull(win) {
  return win[TOGGLES_WINDOW_PROPERTY] || null;
}

/**
 * Returns a set of experiment IDs currently on.
 * @param {!Window} win
 * @return {!Object<string, boolean>}
 */
function getExperimentTogglesFromCookie(win) {
  const experimentCookie = getCookie(win, COOKIE_NAME);
  const tokens = experimentCookie ? experimentCookie.split(/\s*,\s*/g) : [];

  const toggles = Object.create(null);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].length == 0) {
      continue;
    }
    if (tokens[i][0] == '-') {
      toggles[tokens[i].substr(1)] = false;
    } else {
      toggles[tokens[i]] = true;
    }
  }

  return toggles;
}

/**
 * Saves a set of experiment IDs currently on.
 * @param {!Window} win
 * @param {!Object<string, boolean>} toggles
 */
function saveExperimentTogglesToCookie(win, toggles) {
  const experimentIds = [];
  for (const experiment in toggles) {
    experimentIds.push((toggles[experiment] === false ? '-' : '') + experiment);
  }

  setCookie(win, COOKIE_NAME, experimentIds.join(','),
      Date.now() + COOKIE_EXPIRATION_INTERVAL, {
        // Set explicit domain, so the cookie gets send to sub domains.
        domain: win.location.hostname,
        allowOnProxyOrigin: true,
      });
}

/**
 * See getExperimentTogglesFromCookie().
 * @param {!Window} win
 * @return {!Object<string, boolean>}
 * @visibleForTesting
 */
export function getExperimentToglesFromCookieForTesting(win) {
  return getExperimentTogglesFromCookie(win);
}

/**
 * Resets the experimentsToggle cache for testing purposes.
 * @param {!Window} win
 * @visibleForTesting
 */
export function resetExperimentTogglesForTesting(win) {
  setCookie(win, COOKIE_NAME, '', 0, {
    domain: win.location.hostname,
  });
  win[TOGGLES_WINDOW_PROPERTY] = null;
}

/**
 * In some browser implementations of Math.random(), sequential calls of
 * Math.random() are correlated and can cause a bias.  In particular,
 * if the previous random() call was < 0.001 (as it will be if we select
 * into an experiment), the next value could be less than 0.5 more than
 * 50.7% of the time.  This provides an implementation that roots down into
 * the crypto API, when available, to produce less biased samples.
 *
 * @return {number} Pseudo-random floating-point value on the range [0, 1).
 */
function slowButAccuratePrng() {
  // TODO(tdrl): Implement.
  return Math.random();
}

/**
 * Container for alternate random number generator implementations.  This
 * allows us to set an "accurate" PRNG for branch selection, but to mock it
 * out easily in tests.
 *
 * @visibleForTesting
 * @const {!{accuratePrng: function():number}}
 */
export const RANDOM_NUMBER_GENERATORS = {
  accuratePrng: slowButAccuratePrng,
};

/**
 * Selects, uniformly at random, a single item from the array.
 * @param {!Array<string>} arr Object to select from.
 * @return {?string} Single item from arr or null if arr was empty.
 */
function selectRandomItem(arr) {
  const rn = RANDOM_NUMBER_GENERATORS.accuratePrng();
  return arr[Math.floor(rn * arr.length)] || null;
}

/**
 * Selects which page-level experiment branches are enabled. If a given
 * experiment name is already set (including to the null / no branches selected
 * state), this won't alter its state.
 *
 * Check whether a given experiment is set using isExperimentOn(win,
 * experimentName) and, if it is on, look for which branch is selected in
 * win.experimentBranches[experimentName].
 *
 * @param {!Window} win Window context on which to save experiment
 *     selection state.
 * @param {!Object<string, !ExperimentInfo>} experiments  Set of experiments to
 *     configure for this page load.
 * @visibleForTesting
 */
export function randomlySelectUnsetExperiments(win, experiments) {
  win.experimentBranches = win.experimentBranches || {};
  for (const experimentName in experiments) {
    // Skip experimentName if it is not a key of experiments object or if it
    // has already been populated by some other property.
    if (!experiments.hasOwnProperty(experimentName) ||
        win.experimentBranches.hasOwnProperty(experimentName)) {
      continue;
    }

    if (!experiments[experimentName].isTrafficEligible ||
        !experiments[experimentName].isTrafficEligible(win)) {
      win.experimentBranches[experimentName] = null;
      continue;
    }

    // If we're in the experiment, but we haven't already forced a specific
    // experiment branch (e.g., via a test setup), then randomize the branch
    // choice.
    if (!win.experimentBranches[experimentName] &&
        isExperimentOn(win, experimentName)) {
      const branches = experiments[experimentName].branches;
      win.experimentBranches[experimentName] = selectRandomItem(branches);
    }
  }
}

/**
 * Returns the experiment branch enabled for the given experiment ID.
 * For example, 'control' or 'experiment'.
 *
 * @param {!Window} win Window context to check for experiment state.
 * @param {!string} experimentName Name of the experiment to check.
 * @return {?string} Active experiment branch ID for experimentName (possibly
 *     null if experimentName has been tested but no branch was enabled).
 */
export function getExperimentBranch(win, experimentName) {
  return win.experimentBranches ? win.experimentBranches[experimentName] : null;
}

/**
 * Force enable (or disable) a specific branch of a given experiment name.
 * Disables the experiment name altogether if branchId is falseish.
 *
 * @param {!Window} win Window context to check for experiment state.
 * @param {!string} experimentName Name of the experiment to check.
 * @param {?string} branchId ID of branch to force or null to disable
 *     altogether.
 * @visibleForTesting
 */
export function forceExperimentBranch(win, experimentName, branchId) {
  win.experimentBranches = win.experimentBranches || {};
  toggleExperiment(win, experimentName, !!branchId, true);
  win.experimentBranches[experimentName] = branchId;
}
