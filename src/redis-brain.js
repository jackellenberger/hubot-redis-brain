'use strict'

// Description:
//   Persist hubot's brain to redis
//
// Configuration:
//   REDISTOGO_URL or REDISCLOUD_URL or BOXEN_REDIS_URL or REDIS_URL.
//     URL format: redis://<host>:<port>[/<brain_prefix>]
//     URL format (UNIX socket): redis://<socketpath>[?<brain_prefix>]
//     If not provided, '<brain_prefix>' will default to 'hubot'.
//   REDIS_NO_CHECK - set this to avoid ready check (for exampel when using Twemproxy)
//
// Commands:
//   None

const Url = require('url')
const Redis = require('redis')

module.exports = function (robot) {
  let client, prefix
  const redisUrlEnv = getRedisEnv()
  const redisUrl = process.env[redisUrlEnv] || 'redis://localhost:6379'
  const redisRetryStrategy = (options) => {
    if (options.error && options.error.code === 'ECONNREFUSED') {
      // End reconnecting on a specific error and flush all commands with
      // a individual error
      robot.logger.error('The server refused the connection');
      return new Error('The server refused the connection');
    }
    if (options.total_retry_time > 1000 * 60 * 60) {
      // End reconnecting after a specific timeout and flush all commands
      // with a individual error
      robot.logger.error('Retry time exhausted');
      return new Error('Retry time exhausted');
    }
    if (options.attempt > 10) {
      // End reconnecting with built in error
      robot.logger.error('Too many retry attempts');
      return undefined;
    }
    // reconnect after
    robot.logger.error('Retrying in', options.attempt * 100);
    return Math.min(options.attempt * 100, 3000);
  }

  if (redisUrlEnv) {
    robot.logger.info(`hubot-redis-brain: Discovered redis from ${redisUrlEnv} environment variable`)
  } else {
    robot.logger.info('hubot-redis-brain: Using default redis on localhost:6379')
  }

  if (process.env.REDIS_NO_CHECK) {
    robot.logger.info('Turning off redis ready checks')
  }

  const info = Url.parse(redisUrl)

  if (info.hostname === '') {
    client = Redis.createClient(info.pathname, {
      retry_strategy: redisRetryStrategy
    })
    prefix = (info.query ? info.query.toString() : undefined) || 'hubot'
  } else {
    if (info.auth || process.env.REDIS_NO_CHECK) {
      client = Redis.createClient(info.port, info.hostname, {
        no_ready_check: true,
        retry_strategy: redisRetryStrategy
      });
    } else {
      client = Redis.createClient(info.port, info.hostname, {
        retry_strategy: redisRetryStrategy
      });
    }
    prefix = (info.path ? info.path.replace('/', '') : undefined) || 'hubot'
  }

  robot.brain.setAutoSave(false)

  const getData = (cb) => {
    robot.logger.info('hubot-redis-brain getData');
    client.get(`${prefix}:storage`, function (err, reply) {
      if (err) {
        robot.logger.error(`unable to get ${prefix}:storage: `, err);
        cb(err, null)
      } else if (reply) {
        robot.brain.data._private["brainGetTimestamp"] = Date.now()
        robot.logger.info(`hubot-redis-brain: Data for ${prefix} brain retrieved from Redis ${reply.toString().length}`)
        robot.brain.mergeData(JSON.parse(reply.toString()))
        robot.logger.info(`keys from redis: ${Object.keys(JSON.parse(reply.toString()))}`)
        robot.logger.info(`_private from redis: ${Object.keys(JSON.parse(reply.toString())._private)}`)
        cb(null, robot.brain.data)
      } else {
        robot.logger.info(`hubot-redis-brain: Unable to get brain from redis`)
        cb(null, robot.brain.data)
      }
      robot.brain.emit('connected')
      robot.brain.setAutoSave(true)
    })
  }

  if (info.auth) {
    client.auth(info.auth.split(':')[1], function (err) {
      if (err) {
        return robot.logger.error('hubot-redis-brain: Failed to authenticate to Redis')
      }

      robot.logger.info('hubot-redis-brain: Successfully authenticated to Redis')
      getData((err, data) => {
        if (err)
          robot.logger.error(err)
      })
    })
  }

  client.on('error', function (err) {
    robot.logger.error(`hubot-redis-brain ERROR ${err}`)
    if (/ECONNREFUSED/.test(err.message)) {

    } else {
      robot.logger.error(err.stack)
    }
  })

  client.on('connect', function () {
    robot.logger.debug('hubot-redis-brain: Successfully connected to Redis')
    if (!info.auth) { 
      getData((err, data) => {
        if (err)
          robot.logger.error(err)
      })
    }
  })

  robot.brain.on('loaded', (data) => {
    robot.logger.info(`LOADED DATA ${data.toString()}`)
  })

  robot.brain.on('save', (data) => {
    getData((err, data) => {
      if (err) {
        robot.logger.error(`Not saving brain cause of: ${err}`)
      } else {
        robot.logger.info(`hubot-redis-brain: privates: ${robot.brain.data._private.toString().length}`)
        client.set(`${prefix}:storage`, JSON.stringify(data))
      }
    })
  })

  robot.brain.on('close', () => client.quit())
}

function getRedisEnv () {
  if (process.env.REDISTOGO_URL) {
    return 'REDISTOGO_URL'
  }

  if (process.env.REDISCLOUD_URL) {
    return 'REDISCLOUD_URL'
  }

  if (process.env.BOXEN_REDIS_URL) {
    return 'BOXEN_REDIS_URL'
  }

  if (process.env.REDIS_URL) {
    return 'REDIS_URL'
  }
}
