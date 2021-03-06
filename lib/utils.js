'use strict'

const Cache = require('./cache')
const Mustache = require('mustache')
const Needle = require('needle')
const Logger = require('./logger')
const CronJob = require('cron').CronJob
const Routes = require('./routes')
const URL = require('url')

const template = '{"title":"{{title}}","headers":{{{headers}}},"rows":[{{{row}}}],"width":{{width}},"height":1}'
Mustache.parse(template)

// Fetch all data and add it to the cache
function populateCache (url) {
  // Change from DHIS 2.30. SQL views no longer return all data by default therefore
  // API calls now need to specify what size data they want
  url += '?paging=false'

  Logger.info('Populating cache')

  // Fetch the facility data
  Needle.get(url, function (err, res) {
    if (err) {
      return Logger.error('Fetching facility data failed: ', { message: err.message })
    }

    if (res.statusCode !== 200) {
      return Logger.error('Non-200 status code: ', { message: res.statusCode })
    }

    const title = res.body.listGrid.title
    const headers = res.body.listGrid.headers

    const parsedURL = URL.parse(url)
    const levelKey = parsedURL.pathname

    const subLevelCacheDB = Cache.sublevel(levelKey)
    const batch = []

    // Add each facility to the cache
    res.body.listGrid.rows.forEach(function (row) {
      const key = row[0]
      if (!key) {
        return Logger.error('Facility missing value: ', { message: row })
      }
      const body = Mustache.render(template, {
        title: title,
        headers: JSON.stringify(headers),
        row: JSON.stringify(row),
        width: headers.length
      })
      batch.push({key: key, value: body, type: 'put'})
    })

    subLevelCacheDB.batch(batch, function (err) {
      if (err) {
        return Logger.error('Storing facility data failed: ', { message: err.message })
      }
      Logger.info('Finished populating cache')
    })
  })
}

const cronJobs = {}

function addCronJob (pattern, timezone, url) {
  cronJobs[url] = new CronJob(pattern, populateCache.bind(null, url), true, timezone)
}

function removeCronJob (url) {
  if (cronJobs[url]) {
    cronJobs[url].stop()
    delete cronJobs[url]
  }
}

function addRoute (app, path) {
  app.get(path, Routes.facilityCodeLookup)
}

// express 4.14.1 specific
function removeRoute (app, path) {
  let counter = 0
  const stack = app._router.stack
  stack.forEach((layer) => {
    if(layer && layer.route && layer.route.path === path) {
      stack.splice(counter, 1)
    }
    counter++
  })
}

function updateConfig (app, oldConf, newConf) {
  const newConfRoutes = {}

  newConf.forEach((route) => {
    const url = URL.resolve(route.dhisUrl, route.dhisPath)
    newConfRoutes[url] = true
    // if the route already exists reset cron job, else add new route and cron job
    if (cronJobs[url]) {
      removeCronJob(url)
      addCronJob(route.cronPattern, route.cronTimezone, url)
    } else {
      addRoute(app, route.dhisPath)
      addCronJob(route.cronPattern, route.cronTimezone, url)
      populateCache(url)
    }
  })

  oldConf.forEach((route) => {
    const url = URL.resolve(route.dhisUrl, route.dhisPath)
    // remove routes and crons that are not in the new config
    if (!newConfRoutes[url]) {
      removeRoute(app, route.dhisPath)
      removeCronJob(url)
    }
  })
}

function resetCronJobs () {
  Object.keys(cronJobs).forEach(k => delete cronJobs[k])
}

exports.populateCache = populateCache
exports.addCronJob = addCronJob
exports.addRoute = addRoute
exports.updateConfig = updateConfig

if (process.env.NODE_ENV === 'test') {
  exports.cronJobs = cronJobs
  exports.resetCronJobs = resetCronJobs
}
