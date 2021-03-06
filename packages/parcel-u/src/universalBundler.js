import fs from 'fs'
import path from 'path'

import _ from 'lodash'

import { compose } from 'compose-middleware'
import serve from 'serve-static'

import resolve from 'resolve'

import cheerio from 'cheerio'
import findUp from 'find-up'

const dev = process.env.NODE_ENV !== 'production'
const cwd = process.cwd()

// Force-reload module for development.
const requireFresh = (moduleName) => {
  const clearModule = require('clear-module')
  clearModule(moduleName)
  const m = require(moduleName)
  return m.default || m
}

class UniversalBundler {
  constructor (opts = {}, parcelOpts = {}) {
    this.opts = {
      entryComponent: 'App.js',
      ...opts
    }

    this.parcelOpts = {
      watch: false,
      outDir: './dist',
      killWorkers: false,
      ...parcelOpts
    }

    this.clientBundle = null
    this.serverBundle = null

    this.entryAssetsPath = path.join(cwd, this.parcelOpts.outDir, './entryAssets.json')

    this.doRenderToHtml = (req, res, next) => next()
  }

  getEntryComponent () {
    // Pass-through if entryComponent looks like relative path.
    if (_.startsWith(this.opts.entryComponent, './')) return this.opts.entryComponent

    // Omit extension even if specified.
    return _.first(this.opts.entryComponent.split('.'))
  }

  findEntryComponentName (clientBundle) {
    const entryComponentName = this.getEntryComponent()

    // Resolve relative pathname if specified.
    if (_.startsWith(entryComponentName, './')) {
      return path.resolve(process.cwd(), entryComponentName)
    }

    const childBundles = Array.from(clientBundle.childBundles)

    // Find entry js file.
    const jsBundle = _.find(childBundles, { type: 'js' })
    const depAssets = Array.from(jsBundle.entryAsset.depAssets.values())

    // Find App.js file.
    const entryAppComponent = _.find(depAssets, (asset) => {
      // Ignore node_modules.
      if (/node_modules\//.test(asset.name)) return
      return _.startsWith(asset.basename, entryComponentName)
    })

    // Return found file name,
    return entryAppComponent ? entryAppComponent.name : ''
  }

  initializeApp (onInitialized = _.noop) {
    const entryAssets = require(this.entryAssetsPath)
    const clientBundleName = path.resolve(cwd, entryAssets[this.opts.entryHtml])
    const serverBundleName = path.resolve(cwd, entryAssets[this.opts.entryComponent])

    this.initializeHtmlRenderer(clientBundleName, serverBundleName)
    onInitialized()
  }

  initializeBundler (onInitialized = _.noop) {
    const Bundler = require('parcel-bundler')

    // Ensure onInitialized called once.
    onInitialized = _.once(onInitialized)

    this.clientBundler = new Bundler(
      this.opts.entryHtml,
      {
        ...this.parcelOpts,
        cacheDir: path.join(cwd, '.cache/client'),
        outDir: path.join(this.parcelOpts.outDir, './client')
      }
    )

    const initServerBundle = (clientBundle) => {
      const entryComponent = this.findEntryComponentName(clientBundle)

      this.serverBundler = new Bundler(
        entryComponent,
        {
          ...this.parcelOpts,
          target: 'node',
          cacheDir: path.join(cwd, '.cache/server'),
          outDir: path.join(this.parcelOpts.outDir, './server')
        }
      )

      this.serverBundler.on('bundled', (compiledBundle) => {
        this.serverBundle = compiledBundle
      })

      // Reload html renderer after every bundle.
      this.serverBundler.on('buildEnd', () => {
        this.initializeHtmlRenderer(this.clientBundle.name, this.serverBundle.name)
        onInitialized()
      })
    }

    // Gather client/server bundle references.
    this.clientBundler.on('bundled', (compiledBundle) => {
      this.clientBundle = compiledBundle
      initServerBundle(compiledBundle)
    })

    // Schedule server bundle after client bundle.
    this.clientBundler.once('bundled', () => {
      this.serverBundler.bundle()
    })
  }

  initializeHtmlRenderer (entryHtml, entryAppComponent) {
    const html = fs.readFileSync(entryHtml, { encoding: 'utf8' })
    const App = requireFresh(entryAppComponent)

    const pkgPath = findUp.sync('package.json', { cwd: path.dirname(entryHtml) })
    if (!pkgPath) throw new Error('Package.json not found.')

    // Fetch dependencies.
    const pkg = require(pkgPath)
    const deps = _.keys(pkg.dependencies)
    const root = path.dirname(pkgPath)

    const dependsOn = (r) => _.includes(deps, r)
    const requireProjectDeps = (r) => require(resolve.sync(r, { basedir: root }))

    const internalApi = { dependsOn, requireProjectDeps }

    let renderToHtml = this.opts.renderToHtml

    // Defaults to library preset, if no renderToHtml option passed
    if (!renderToHtml) {
      // If is react project and correct react preset found.
      if (dependsOn('react') && dependsOn('parcel-u-react')) {
        const { asyncRenderToString } = requireProjectDeps('parcel-u-react/server')
        renderToHtml = asyncRenderToString
      }
    }

    this.doRenderToHtml = async (req, res) => {
      // Instantiate cheerio instance at every request.
      const $ = cheerio.load(html)

      let body = ''

      try {
        body = await renderToHtml($, App, req, internalApi)
      } catch (err) {
        console.error('Caught error on renderToHtml, err = ', err)
      }

      res.end(body)
    }
  }

  async stop () {
    let promises = []

    if (this.clientBundler) {
      promises.push(this.clientBundler.stop())
    }

    if (this.serverBundler) {
      promises.push(this.serverBundler.stop())
    }

    await Promise.all(promises)
  }

  async bundle (dumpEntryAssets = !dev) {
    // Do bundle and await.
    await new Promise((resolve) => {
      this.initializeBundler(resolve)
      // Start client bundle immediately.
      this.clientBundler.bundle()
    })

    // Dump assets after bundle.
    if (dumpEntryAssets) {
      this.dumpEntryAssets()
    }

    await this.stop()
  }

  dumpEntryAssets () {
    // Set entryAssets.json contents.
    const entryAssets = {
      [this.opts.entryHtml]: `./${path.relative(cwd, this.clientBundle.name)}`,
      [this.opts.entryComponent]: `./${path.relative(cwd, this.serverBundle.name)}`
    }

    // Write entryAssets.json for later use.
    fs.writeFileSync(
      this.entryAssetsPath,
      JSON.stringify(entryAssets, null, 2),
      { encoding: 'utf8' }
    )
  }

  async render (urls) {
    if (dev) {
      await this.bundle()
    } else {
      // Only initialize app(without bundler) in production.
      this.initializeApp()
    }

    let doSingleRender = false

    if (!_.isArray(urls)) {
      urls = [urls]
      doSingleRender = true
    }

    const html = await Promise.all(_.map(urls, async (url) => {
      let body = ''

      // Simulate nodejs req/res.
      const req = { url }
      const res = {
        end: (_body) => {
          body = _body
        }
      }

      await this.doRenderToHtml(req, res)

      // Return generated body content.
      return body
    }))

    return doSingleRender ? _.first(html) : html
  }

  initialize () {
    // Listen for client/server bundle end if in development.
    if (dev) {
      return this.initializeBundler()
    }
    // Only initialize app(without bundler) in production.
    this.initializeApp()
  }

  middleware () {
    this.initialize()

    let middleware = []

    middleware.push((req, res, next) => {
      // Pass-through non html request.
      const ext = path.extname(req.url)
      if (ext && !(/^.html?$/.test(ext))) {
        return next()
      }
      return this.doRenderToHtml(req, res, next)
    })

    if (dev) {
      // Use parcel middleware for dev.
      middleware.push(this.clientBundler.middleware())
    } else {
      // Just serve dist/client files, under the production env.
      middleware.push(serve(path.join(this.parcelOpts.outDir, './client')))
    }

    return compose(middleware)
  }
}

export default UniversalBundler
