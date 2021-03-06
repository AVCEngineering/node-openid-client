'use strict';

const util = require('util');
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');
const jose = require('node-jose');
const uuid = require('uuid');
const base64url = require('base64url');
const url = require('url');
const _ = require('lodash');
const got = require('got');
const tokenHash = require('oidc-token-hash');

const gotErrorHandler = require('./got_error_handler');
const expectResponse = require('./expect_response');
const TokenSet = require('./token_set');
const OpenIdConnectError = require('./open_id_connect_error');
const now = require('./unix_timestamp');

const CALLBACK_PROPERTIES = require('./consts').CALLBACK_PROPERTIES;
const CLIENT_METADATA = require('./consts').CLIENT_METADATA;
const CLIENT_DEFAULTS = require('./consts').CLIENT_DEFAULTS;
const JWT_CONTENT = require('./consts').JWT_CONTENT;

const issuerRegistry = require('./issuer_registry');

const map = new WeakMap();
const format = 'compact';

function bearer(token) {
  return `Bearer ${token}`;
}

function instance(ctx) {
  if (!map.has(ctx)) map.set(ctx, {});
  return map.get(ctx);
}

/* eslint-disable no-underscore-dangle */
function cleanUpClaims(claims) {
  if (_.isEmpty(claims._claim_names)) delete claims._claim_names;
  if (_.isEmpty(claims._claim_sources)) delete claims._claim_sources;
  return claims;
}

function assignClaim(target, source, sourceName) {
  return (inSource, claim) => {
    if (inSource === sourceName) {
      assert(source[claim] !== undefined, `expected claim "${claim}" in "${sourceName}"`);
      target[claim] = source[claim];
      delete target._claim_names[claim];
    }
  };
}
/* eslint-enable no-underscore-dangle */

function getFromJWT(jwt, position, claim) {
  assert.equal(typeof jwt, 'string', 'invalid JWT type, expected a string');
  const parts = jwt.split('.');
  assert.equal(parts.length, 3, 'invalid JWT format, expected three parts');
  const parsed = JSON.parse(base64url.decode(parts[position]));
  return typeof claim === 'undefined' ? parsed : parsed[claim];
}

function getSub(jwt) {
  return getFromJWT(jwt, 1, 'sub');
}

function getIss(jwt) {
  return getFromJWT(jwt, 1, 'iss');
}

function getHeader(jwt) {
  return getFromJWT(jwt, 0);
}

function getPayload(jwt) {
  return getFromJWT(jwt, 1);
}

function assignErrSrc(sourceName) {
  return (err) => {
    err.src = sourceName;
    throw err;
  };
}

function authorizationParams(params) {
  assert.equal(typeof params, 'object', 'you must provide an object');

  const authParams = _.chain(params).defaults({
    client_id: this.client_id,
    scope: 'openid',
    response_type: 'code',
  }).forEach((value, key, object) => {
    if (value === null || value === undefined) {
      delete object[key];
    } else if (key === 'claims' && typeof value === 'object') {
      object[key] = JSON.stringify(value);
    } else if (typeof value !== 'string') {
      object[key] = String(value);
    }
  }).value();

  assert(authParams.response_type === 'code' || authParams.nonce,
    'nonce MUST be provided for implicit and hybrid flows');

  return authParams;
}

function claimJWT(jwt) {
  try {
    const iss = getIss(jwt);
    const keyDef = getHeader(jwt);
    assert(keyDef.alg, 'claim source is missing JWT header alg property');

    if (keyDef.alg === 'none') return Promise.resolve(getPayload(jwt));

    const getKey = (() => {
      if (!iss || iss === this.issuer.issuer) {
        return this.issuer.key(keyDef);
      } else if (issuerRegistry.has(iss)) {
        return issuerRegistry.get(iss).key(keyDef);
      }
      return this.issuer.constructor.discover(iss).then(issuer => issuer.key(keyDef));
    })();

    return getKey
      .then(key => jose.JWS.createVerify(key).verify(jwt))
      .then(result => JSON.parse(result.payload));
  } catch (error) {
    return Promise.reject(error);
  }
}

const deprecatedKeystore = util.deprecate(keystore => keystore,
  'passing keystore directly is deprecated, pass an object with keystore property instead');

class Client {
  /**
   * @name constructor
   * @api public
   */
  constructor(metadata, keystore) {
    const recognized = _.chain(metadata)
      .pick(CLIENT_METADATA)
      .defaults(CLIENT_DEFAULTS)
      .value();

    _.forEach(recognized, (value, key) => { instance(this)[key] = value; });

    if (keystore !== undefined) {
      assert(jose.JWK.isKeyStore(keystore), 'keystore must be an instance of jose.JWK.KeyStore');
      instance(this).keystore = keystore;
    }

    if (this.token_endpoint_auth_method.endsWith('_jwt')) {
      assert(this.issuer.token_endpoint_auth_signing_alg_values_supported,
        'token_endpoint_auth_signing_alg_values_supported must be provided on the issuer');
    }

    this.CLOCK_TOLERANCE = 0;
  }

  /**
   * @name authorizationUrl
   * @api public
   */
  authorizationUrl(params) {
    assert(this.issuer.authorization_endpoint, 'authorization_endpoint must be configured');
    return url.format(_.defaults({
      search: null,
      query: authorizationParams.call(this, params),
    }, url.parse(this.issuer.authorization_endpoint)));
  }

  /**
   * @name authorizationPost
   * @api public
   */
  authorizationPost(params) {
    const inputs = authorizationParams.call(this, params);
    const formInputs = Object.keys(inputs)
      .map(name => `<input type="hidden" name="${name}" value="${inputs[name]}"/>`).join('\n');

    return `<!DOCTYPE html>
<head>
  <title>Requesting Authorization</title>
</head>
<body onload="javascript:document.forms[0].submit()">
  <form method="post" action="${this.issuer.authorization_endpoint}">
    ${formInputs}
  </form>
</body>
</html>`;
  }

  /**
   * @name callbackParams
   * @api public
   */
  callbackParams(input) { // eslint-disable-line
    const isIncomingMessage = input instanceof http.IncomingMessage;
    const isString = typeof input === 'string';

    assert(isString || isIncomingMessage, '#callbackParams only accepts string urls or http.IncomingMessage');

    let uri;
    if (isIncomingMessage) {
      const msg = input;

      switch (msg.method) {
        case 'GET':
          uri = msg.url;
          break;
        case 'POST':
          assert(msg.body, 'incoming message body missing, include a body parser prior to this call');
          switch (typeof msg.body) {
            case 'object':
            case 'string':
              if (Buffer.isBuffer(msg.body)) {
                return querystring.parse(msg.body.toString('utf-8'));
              } else if (typeof msg.body === 'string') {
                return querystring.parse(msg.body);
              }

              return msg.body;
            default:
              throw new Error('invalid IncomingMessage body object');
          }
        default:
          throw new Error('invalid IncomingMessage method');
      }
    } else {
      uri = input;
    }

    return _.pick(url.parse(uri, true).query, CALLBACK_PROPERTIES);
  }

  /**
   * @name authorizationCallback
   * @api public
   */
  authorizationCallback(redirectUri, parameters, checks) {
    const params = _.pick(parameters, CALLBACK_PROPERTIES);
    const toCheck = checks || {};

    if (this.default_max_age && !toCheck.max_age) toCheck.max_age = this.default_max_age;

    if (toCheck.state !== parameters.state) {
      return Promise.reject(new Error('state mismatch'));
    }

    if (params.error) {
      return Promise.reject(new OpenIdConnectError(params));
    }

    let promise;

    if (params.id_token) {
      promise = Promise.resolve(new TokenSet(params))
        .then(tokenset => this.decryptIdToken(tokenset, 'id_token'))
        .then(tokenset => this.validateIdToken(tokenset, toCheck.nonce, 'authorization', toCheck.max_age));
    }

    if (params.code) {
      const grantCall = () => this.grant({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: redirectUri,
      })
        .then(tokenset => this.decryptIdToken(tokenset, 'id_token'))
        .then(tokenset => this.validateIdToken(tokenset, toCheck.nonce, 'token', toCheck.max_age))
        .then((tokenset) => {
          if (params.session_state) tokenset.session_state = params.session_state;
          return tokenset;
        });

      if (promise) {
        promise = promise.then(grantCall);
      } else {
        return grantCall();
      }
    }

    return promise;
  }

  decryptIdToken(token, use) {
    if (
      (use === 'userinfo' && !this.userinfo_encrypted_response_alg) ||
      (use === 'id_token' && !this.id_token_encrypted_response_alg)
    ) {
      return Promise.resolve(token);
    }

    let idToken = token;

    if (idToken instanceof TokenSet) {
      /* istanbul ignore next */
      if (!idToken.id_token) {
        throw new Error('id_token not present in TokenSet');
      }

      idToken = idToken.id_token;
    }

    let expectedAlg;
    let expectedEnc;

    if (use === 'userinfo') {
      expectedAlg = this.userinfo_encrypted_response_alg;
      expectedEnc = this.userinfo_encrypted_response_enc;
    } else {
      expectedAlg = this.id_token_encrypted_response_alg;
      expectedEnc = this.id_token_encrypted_response_enc;
    }

    const header = JSON.parse(base64url.decode(idToken.split('.')[0]));

    assert.equal(header.alg, expectedAlg, 'unexpected alg received');
    assert.equal(header.enc, expectedEnc, 'unexpected enc received');

    const keystoreOrSecret = expectedAlg.match(/^(RSA|ECDH)/) ?
      Promise.resolve(instance(this).keystore) : this.joseSecret(expectedAlg);

    return keystoreOrSecret.then(keyOrStore => jose.JWE.createDecrypt(keyOrStore).decrypt(idToken)
      .then((result) => {
        if (token instanceof TokenSet) {
          token.id_token = result.payload.toString('utf8');
          return token;
        }
        return result.payload.toString('utf8');
      }));
  }

  /**
   * @name validateIdToken
   * @api private
   */
  validateIdToken(tokenSet, nonce, returnedBy, maxAge) {
    let idToken = tokenSet;

    const expectedAlg = (() => {
      if (returnedBy === 'userinfo') return this.userinfo_signed_response_alg;
      return this.id_token_signed_response_alg;
    })();

    const isTokenSet = idToken instanceof TokenSet;

    if (isTokenSet) {
      if (!idToken.id_token) {
        throw new Error('id_token not present in TokenSet');
      }

      idToken = idToken.id_token;
    }

    idToken = String(idToken);

    const timestamp = now();
    const parts = idToken.split('.');
    const header = JSON.parse(base64url.decode(parts[0]));
    const payload = JSON.parse(base64url.decode(parts[1]));

    const verifyPresence = (prop) => {
      if (payload[prop] === undefined) {
        throw new Error(`missing required JWT property ${prop}`);
      }
    };

    assert.equal(header.alg, expectedAlg, 'unexpected algorithm received');

    if (returnedBy !== 'userinfo') {
      ['iss', 'sub', 'aud', 'exp', 'iat'].forEach(verifyPresence);
    }

    if (payload.iss !== undefined) {
      assert.equal(this.issuer.issuer, payload.iss, 'unexpected iss value');
    }

    if (payload.iat !== undefined) {
      assert.equal(typeof payload.iat, 'number', 'iat is not a number');
      assert(payload.iat <= timestamp + this.CLOCK_TOLERANCE, 'id_token issued in the future');
    }

    if (payload.nbf !== undefined) {
      assert.equal(typeof payload.nbf, 'number', 'nbf is not a number');
      assert(payload.nbf <= timestamp + this.CLOCK_TOLERANCE, 'id_token not active yet');
    }

    if (maxAge || (maxAge !== null && this.require_auth_time)) {
      assert(payload.auth_time, 'missing required JWT property auth_time');
      assert.equal(typeof payload.auth_time, 'number', 'auth_time is not a number');
    }

    if (maxAge) {
      assert(payload.auth_time + maxAge >= timestamp - this.CLOCK_TOLERANCE, 'too much time has elapsed since the last End-User authentication');
    }

    if (nonce !== null && (payload.nonce || nonce !== undefined)) {
      assert.equal(payload.nonce, nonce, 'nonce mismatch');
    }

    if (payload.exp !== undefined) {
      assert.equal(typeof payload.exp, 'number', 'exp is not a number');
      assert(timestamp - this.CLOCK_TOLERANCE < payload.exp, 'id_token expired');
    }

    if (payload.aud !== undefined) {
      if (!Array.isArray(payload.aud)) {
        payload.aud = [payload.aud];
      } else if (payload.aud.length > 1 && !payload.azp) {
        throw new Error('missing required JWT property azp');
      }
    }

    if (payload.azp !== undefined) {
      assert.equal(this.client_id, payload.azp, 'azp must be the client_id');
    }

    if (payload.aud !== undefined) {
      assert(payload.aud.indexOf(this.client_id) !== -1, 'aud is missing the client_id');
    }

    if (returnedBy === 'authorization') {
      assert(payload.at_hash || !tokenSet.access_token, 'missing required property at_hash');
      assert(payload.c_hash || !tokenSet.code, 'missing required property c_hash');
    }

    if (tokenSet.access_token && payload.at_hash !== undefined) {
      assert(tokenHash(payload.at_hash, tokenSet.access_token), 'at_hash mismatch');
    }

    if (tokenSet.code && payload.c_hash !== undefined) {
      assert(tokenHash(payload.c_hash, tokenSet.code), 'c_hash mismatch');
    }

    if (header.alg === 'none') {
      return Promise.resolve(tokenSet);
    }

    return (header.alg.startsWith('HS') ? this.joseSecret() : this.issuer.key(header))
      .then(key => jose.JWS.createVerify(key).verify(idToken).catch(() => {
        throw new Error('invalid signature');
      }))
      .then(() => tokenSet);
  }

  /**
   * @name refresh
   * @api public
   */
  refresh(refreshToken) {
    let token = refreshToken;

    if (token instanceof TokenSet) {
      if (!token.refresh_token) {
        return Promise.reject(new Error('refresh_token not present in TokenSet'));
      }
      token = token.refresh_token;
    }

    return this.grant({
      grant_type: 'refresh_token',
      refresh_token: String(token),
    })
    .then((tokenset) => {
      if (!tokenset.id_token) {
        return tokenset;
      }
      return this.decryptIdToken(tokenset, 'id_token')
        .then(() => this.validateIdToken(tokenset, null, 'token', null));
    });
  }

  /**
   * @name userinfo
   * @api public
   */
  userinfo(accessToken, options) {
    let token = accessToken;
    const opts = _.merge({
      verb: 'get',
      via: 'header',
    }, options);

    if (token instanceof TokenSet) {
      if (!token.access_token) {
        return Promise.reject(new Error('access_token not present in TokenSet'));
      }
      token = token.access_token;
    }

    const verb = String(opts.verb).toLowerCase();
    let httpOptions;

    switch (opts.via) {
      case 'query':
        assert.equal(verb, 'get', 'providers should only parse query strings for GET requests');
        httpOptions = { query: { access_token: token } };
        break;
      case 'body':
        assert.equal(verb, 'post', 'can only send body on POST');
        httpOptions = { body: { access_token: token } };
        break;
      default:
        httpOptions = { headers: { Authorization: bearer(token) } };
    }

    return got[verb](this.issuer.userinfo_endpoint, this.issuer.httpOptions(httpOptions))
      .then(expectResponse(200))
      .then((response) => {
        if (JWT_CONTENT.exec(response.headers['content-type'])) {
          return Promise.resolve(response.body)
            .then(jwt => this.decryptIdToken(jwt, 'userinfo'))
            .then((jwt) => {
              if (!this.userinfo_signed_response_alg) return JSON.parse(jwt);
              return this.validateIdToken(jwt, null, 'userinfo', null)
                .then(valid => JSON.parse(base64url.decode(valid.split('.')[1])));
            });
        }

        return JSON.parse(response.body);
      }, gotErrorHandler)
      .then((parsed) => {
        if (accessToken.id_token) {
          assert.equal(getSub(accessToken.id_token), parsed.sub, 'userinfo sub mismatch');
        }

        return parsed;
      });
  }

  derivedKey(len) {
    const cacheKey = `${len}_key`;
    if (instance(this)[cacheKey]) {
      return Promise.resolve(instance(this)[cacheKey]);
    }

    const derivedBuffer = crypto.createHash('sha256')
      .update(this.client_secret)
      .digest()
      .slice(0, len / 8);

    return jose.JWK.asKey({ k: base64url(derivedBuffer), kty: 'oct' }).then((key) => {
      instance(this)[cacheKey] = key;
      return key;
    });
  }

  joseSecret(alg) {
    if (String(alg).match(/^A(128|192|256)(GCM)?KW$/)) {
      return this.derivedKey(RegExp.$1);
    }

    if (instance(this).jose_secret) {
      return Promise.resolve(instance(this).jose_secret);
    }

    return jose.JWK.asKey({ k: base64url(this.client_secret), kty: 'oct' }).then((key) => {
      instance(this).jose_secret = key;
      return key;
    });
  }

  /**
   * @name grant
   * @api public
   */
  grant(body) {
    assert(this.issuer.token_endpoint, 'issuer must be configured with token endpoint');
    return this.authenticatedPost('token', { body },
      response => new TokenSet(JSON.parse(response.body)));
  }

  /**
   * @name revoke
   * @api public
   */
  revoke(token, hint) {
    assert(this.issuer.revocation_endpoint, 'issuer must be configured with revocation endpoint');
    assert(!hint || typeof hint === 'string', 'hint must be a string');

    const body = { token };
    if (hint) body.token_type_hint = hint;
    return this.authenticatedPost('revocation', { body }, response => JSON.parse(response.body));
  }

  /**
   * @name introspect
   * @api public
   */
  introspect(token, hint) {
    assert(this.issuer.introspection_endpoint, 'issuer must be configured with introspection endpoint');
    assert(!hint || typeof hint === 'string', 'hint must be a string');

    const body = { token };
    if (hint) body.token_type_hint = hint;
    return this.authenticatedPost('introspection', { body }, response => JSON.parse(response.body));
  }

  /* eslint-disable no-underscore-dangle */
  /**
   * @name fetchDistributedClaims
   * @api public
   */
  fetchDistributedClaims(claims, accessTokens) {
    const distributedSources = _.pickBy(claims._claim_sources, def => !!def.endpoint);
    const tokens = accessTokens || {};

    return Promise.all(_.map(distributedSources, (def, sourceName) => {
      const opts = {
        headers: { Authorization: bearer(def.access_token || tokens[sourceName]) },
      };

      return got(def.endpoint, this.issuer.httpOptions(opts))
        .then(response => claimJWT.call(this, response.body), gotErrorHandler)
        .then((data) => {
          delete claims._claim_sources[sourceName];
          _.forEach(claims._claim_names, assignClaim(claims, data, sourceName));
        }).catch(assignErrSrc(sourceName));
    })).then(() => cleanUpClaims(claims));
  }

  /**
   * @name unpackAggregatedClaims
   * @api public
   */
  unpackAggregatedClaims(claims) {
    const aggregatedSources = _.pickBy(claims._claim_sources, def => !!def.JWT);

    return Promise.all(_.map(aggregatedSources, (def, sourceName) => {
      const decoded = claimJWT.call(this, def.JWT);

      return decoded.then((data) => {
        delete claims._claim_sources[sourceName];
        _.forEach(claims._claim_names, assignClaim(claims, data, sourceName));
      }).catch(assignErrSrc(sourceName));
    })).then(() => cleanUpClaims(claims));
  }
  /* eslint-enable no-underscore-dangle */

  authenticatedPost(endpoint, httpOptions, success) {
    return Promise.resolve(this.authFor(endpoint))
      .then(auth => got.post(this.issuer[`${endpoint}_endpoint`], this.issuer.httpOptions(_.merge(httpOptions, auth)))
      .then(success, gotErrorHandler));
  }

  createSign() {
    let alg = this.token_endpoint_auth_signing_alg;
    switch (this.token_endpoint_auth_method) {
      case 'client_secret_jwt':
        return this.joseSecret().then((key) => {
          if (!alg) {
            alg = _.find(this.issuer.token_endpoint_auth_signing_alg_values_supported,
              signAlg => key.algorithms('sign').indexOf(signAlg) !== -1);
          }

          return jose.JWS.createSign({
            fields: { alg, typ: 'JWT' },
            format,
          }, { key, reference: false });
        });
      case 'private_key_jwt': {
        if (!alg) {
          const algz = _.chain(instance(this).keystore.all())
            .map(key => key.algorithms('sign'))
            .flatten()
            .uniq()
            .value();

          alg = _.find(this.issuer.token_endpoint_auth_signing_alg_values_supported,
            signAlg => algz.indexOf(signAlg) !== -1);
        }

        const key = instance(this).keystore.get({ alg, use: 'sig' });
        assert(key, 'no valid key found');

        return Promise.resolve(jose.JWS.createSign({
          fields: { alg, typ: 'JWT' },
          format,
        }, { key, reference: true }));
      }
      /* istanbul ignore next */
      default:
        throw new Error('createSign only works for _jwt token auth methods');
    }
  }

  authFor(endpoint) {
    switch (this.token_endpoint_auth_method) {
      case 'none' :
        throw new Error('client not supposed to use grant authz');
      case 'client_secret_post':
        return {
          body: {
            client_id: this.client_id,
            client_secret: this.client_secret,
          },
        };
      case 'private_key_jwt' :
      case 'client_secret_jwt' : {
        const timestamp = now();
        return this.createSign().then(sign => sign.update(JSON.stringify({
          iat: timestamp,
          exp: timestamp + 60,
          jti: uuid(),
          iss: this.client_id,
          sub: this.client_id,
          aud: this.issuer[`${endpoint}_endpoint`],
        })).final().then((client_assertion) => { // eslint-disable-line camelcase, arrow-body-style
          return { body: {
            client_assertion,
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          } };
        }));
      }
      default: {
        const value = new Buffer(`${this.client_id}:${this.client_secret}`).toString('base64');
        return { headers: { Authorization: `Basic ${value}` } };
      }
    }
  }

  inspect() {
    return util.format('Client <%s>', this.client_id);
  }

  /**
   * @name register
   * @api public
   */
  static register(properties, opts) {
    const options = (() => {
      if (!opts) return {};
      if (_.isPlainObject(opts)) return opts;
      return { keystore: deprecatedKeystore(opts) };
    })();

    const keystore = options.keystore;
    const initialAccessToken = options.initialAccessToken;

    assert(this.issuer.registration_endpoint, 'issuer does not support dynamic registration');

    if (keystore !== undefined && !(properties.jwks || properties.jwks_uri)) {
      assert(jose.JWK.isKeyStore(keystore), 'keystore must be an instance of jose.JWK.KeyStore');
      assert(keystore.all().every((key) => {
        if (key.kty === 'RSA' || key.kty === 'EC') {
          try { key.toPEM(true); } catch (err) { return false; }
          return true;
        }
        return false;
      }), 'keystore must only contain private EC or RSA keys');
      properties.jwks = keystore.toJSON();
    }

    const headers = { 'Content-Type': 'application/json' };

    if (initialAccessToken) headers.Authorization = `Bearer ${initialAccessToken}`;

    return got.post(this.issuer.registration_endpoint, this.issuer.httpOptions({
      headers,
      body: JSON.stringify(properties),
    }))
    .then(expectResponse(201))
    .then(response => new this(JSON.parse(response.body), keystore), gotErrorHandler);
  }

  get metadata() {
    return _.chain(this).pick(CLIENT_METADATA).omitBy(_.isUndefined).value();
  }

  /**
   * @name fromUri
   * @api public
   */
  static fromUri(uri, token) {
    return got(uri, this.issuer.httpOptions({
      headers: { Authorization: bearer(token) },
    }))
    .then(expectResponse(200))
    .then(response => new this(JSON.parse(response.body)), gotErrorHandler);
  }

  /**
   * @name requestObject
   * @api public
   */
  requestObject(input, algorithms) {
    assert.equal(typeof input, 'object', 'pass an object as the first argument');
    const request = input || {};
    const algs = algorithms || {};

    _.defaults(algs, {
      sign: this.request_object_signing_alg,
      encrypt: {
        alg: this.request_object_encryption_alg,
        enc: this.request_object_encryption_enc,
      },
    }, {
      sign: 'none',
    });

    const signed = (() => {
      const alg = algs.sign;
      const header = { alg, typ: 'JWT' };
      const payload = JSON.stringify(_.defaults({}, request, {
        iss: this.client_id,
        aud: this.issuer.issuer,
        client_id: this.client_id,
      }));

      if (alg === 'none') {
        return Promise.resolve([
          base64url(JSON.stringify(header)),
          base64url(payload),
          '',
        ].join('.'));
      }

      const symmetrical = alg.startsWith('HS');

      const getKey = (() => {
        if (symmetrical) return this.joseSecret();
        const keystore = instance(this).keystore;

        assert(keystore, `no keystore present for client, cannot sign using ${alg}`);
        const key = keystore.get({ alg, use: 'sig' });
        assert(key, `no key to sign with found for ${alg}`);
        return Promise.resolve(key);
      })();

      return getKey
        .then(key => jose.JWS.createSign({
          fields: header,
          format,
        }, { key, reference: !symmetrical }))
        .then(sign => sign.update(payload).final());
    })();

    if (!algs.encrypt.alg) return signed;
    const fields = { alg: algs.encrypt.alg, enc: algs.encrypt.enc, cty: 'JWT' };

    /* eslint-disable arrow-body-style */
    return this.issuer.key({
      alg: algs.encrypt.alg,
      enc: algs.encrypt.enc,
      use: 'enc',
    }, true).then((key) => {
      return signed.then((cleartext) => {
        return jose.JWE.createEncrypt({ format, fields }, { key })
          .update(cleartext)
          .final();
      });
    });
    /* eslint-enable arrow-body-style */
  }
}

Object.defineProperty(Client.prototype, 'grantAuth', {
  get: util.deprecate(/* istanbul ignore next */ function grantAuth() {
    return this.authFor('token');
  }, 'client#grantAuth is deprecated'),
});

CLIENT_METADATA.forEach((prop) => {
  Object.defineProperty(Client.prototype, prop, {
    get() {
      return instance(this)[prop];
    },
  });
});

module.exports = Client;
