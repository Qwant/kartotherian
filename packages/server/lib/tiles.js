const util = require('util');
const Promise = require('bluebird');
const _ = require('underscore');
const qidx = require('quadtile-index');
const checkType = require('@kartotherian/input-validator');
const Err = require('@kartotherian/err');

const langCodeRe = /^[-_a-zA-Z]+$/;

let core;

/* eslint no-param-reassign: ["error", {props: true,
          ignorePropertyModificationsFor: ["val", "memo"]}] */

function filterJson(query, data) {
  let newData = data;

  if ('summary' in query) {
    newData = _(data).reduce((memo, layer) => {
      memo[layer.name] = {
        features: layer.features.length,
        jsonsize: JSON.stringify(layer).length,
      };
      return memo;
    }, {});
  } else if ('nogeo' in query) {
    // Recursively remove all "geometry" fields, replacing them with geometry's size
    const filter = (val, key) => {
      if (key === 'geometry') {
        return val.length;
      } else if (_.isArray(val)) {
        return _.map(val, filter);
      } else if (_.isObject(val)) {
        _.each(val, (v, k) => {
          val[k] = filter(v, k);
        });
      }
      return val;
    };
    newData = _.map(data, filter);
  }
  return newData;
}

/**
 * Web server (express) route handler to get requested tile
 *
 * @param {Object} req request object
 * @param {Object} res response object
 * @param {Promise} next will be called if request is not handled
 */
function requestHandler(req, res, next) {
  const params = req && req.params;
  const start = Date.now();
  let source;
  let opts;

  return Promise.try(() => {
    let p = Promise.resolve();
    if (core.getConfiguration().reloadSourcesOnGetTile) {
      const sources = core.getSources();
      const src = sources.getSourceById(params.src, true, true);
      if (src && src.isDisabled) {
        // Reload all sources
        p = p.then(() => sources.loadSourcesAsync(sources.getSourceConfigs()));
      }
    }
    return p.then(() => {
      source = core.getPublicSource(params.src);
    });
  }).then(() => {
    if (!_.contains(source.formats, params.format)) {
      throw new Err('Format %s is not known', params.format).metrics('err.req.format');
    }

    params.z = core.validateZoom(params.z, source);
    params.scale = core.validateScale(params.scale, source);

    params.x = checkType.strToInt(params.x);
    params.y = checkType.strToInt(params.y);
    if (
      !qidx.isValidCoordinate(params.x, params.z) || !qidx.isValidCoordinate(params.y, params.z)
    ) {
      throw new Err('x,y coordinates are not valid, or not allowed for this zoom').metrics('err.req.coords');
    }

    opts = {
      z: params.z,
      x: params.x,
      y: params.y,
    };
    if (params.format !== 'pbf') {
      // Ensure that PNGs are not 32bit
      // TODO: this should be source-configurable
      opts.format = params.format === 'png' ? 'png8:m=h' : params.format;
      if (params.scale) {
        opts.scale = params.scale;
      }
    }
    if (req.query && req.query.lang) {
      if (!langCodeRe.test(req.query.lang)) {
        throw new Err('lang param is not valid').metrics('err.req.lang');
      }
      opts.lang = req.query.lang;
    }

    // fixme: Force all tiles to be treated as vector
    opts.treatAsVector = true;
    return source.getHandler();
  })
    .catch(err => core.reportRequestError(err, res))
    .then((handler) => {
      if (handler === undefined) {
        return undefined;
      }

      return handler.getAsync(opts).then((result) => {
        core.setResponseHeaders(res, source, result.headers);

        if (params.format === 'json') {
        // Allow JSON to be shortened to simplify debugging
          res.json(filterJson(req.query, result.data));
        } else {
          res.send(result.data);
        }

        let mx = util.format('req.%s.%s.%s', params.src, params.z, params.format);
        if (params.scale) {
        // replace '.' with ',' -- otherwise grafana treats it as a divider
          mx += `.${params.scale.toString().replace('.', ',')}`;
        }
        core.metrics.endTiming(mx, start);
      });
    })
    .catch((err) => {
      if (core.isNoTileError(err)) {
        /* eslint-disable-next-line no-throw-literal */
        throw {
          /* This object will be caught by kartotherian
            custom error handler to log and build
            a proper HTTP error */
          status: 404,
          message: err.message,
          type: err.name,
        };
      }
      if (
        core.getConfiguration().disableSourceOnError
        && shouldDisableSource(err)
      ) {
        core.log('warn', `Disabling source ${params.src} because of ${err}`)
        source.isDisabled = true
      }
      throw err;
    })
    .catch(next);
}

function shouldDisableSource(error){
  const cassandra = require('cassandra-driver')
  return error instanceof cassandra.errors.NoHostAvailableError
}

module.exports = function tiles(cor, router) {
  core = cor;

  // get tile
  router.get(`/:src(${core.Sources.sourceIdReStr})/:z(\\d+)/:x(\\d+)/:y(\\d+).:format([\\w]+)`, requestHandler);
  router.get(`/:src(${core.Sources.sourceIdReStr})/:z(\\d+)/:x(\\d+)/:y(\\d+)@:scale([\\.\\d]+)x.:format([\\w]+)`, requestHandler);
};
