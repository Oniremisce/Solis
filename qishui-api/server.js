require('dotenv').config()
const fs = require('fs')
const path = require('path')
const express = require('express')
const config = require('./src/config')
const { QishuiClient } = require('./src/qishuiClient')
const { HttpError, ValidationError } = require('./src/errors')
const { ok, fail } = require('./src/response')
const { sanitizeForExternal } = require('./src/redaction')

async function getModuleDefinitions(modulesPath) {
  const files = await fs.promises.readdir(modulesPath)
  return files
    .filter((file) => file.endsWith('.js'))
    .sort()
    .map((file) => {
      const modulePath = path.join(modulesPath, file)
      const moduleHandler = require(modulePath)
      const route = moduleHandler.route || `/${file.replace(/\.js$/i, '').replace(/_/g, '/')}`
      return { file, route, moduleHandler }
    })
}

function createTraceId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function mergeInput(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  return {
    ...req.query,
    ...body,
    body,
  }
}

function resolveCors(req) {
  const origins = config.corsAllowOrigin.split(',').map((origin) => origin.trim()).filter(Boolean)
  if (origins.includes('*')) return { origin: '*', credentials: false }
  const requestOrigin = req.headers.origin
  if (requestOrigin && origins.includes(requestOrigin)) return { origin: requestOrigin, credentials: true }
  if (!requestOrigin && origins.length === 1) return { origin: origins[0], credentials: true }
  return { origin: '', credentials: false }
}

function setCorsHeaders(req, res) {
  const cors = resolveCors(req)
  const headers = {
    'Access-Control-Allow-Headers': 'X-Requested-With,Content-Type,Cookie',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  }
  if (cors.origin) headers['Access-Control-Allow-Origin'] = cors.origin
  if (cors.credentials) headers['Access-Control-Allow-Credentials'] = 'true'
  res.set(headers)
}

async function constructServer() {
  const app = express()
  const modulesPath = path.join(__dirname, 'module')
  const moduleDefs = await getModuleDefinitions(modulesPath)
  const client = new QishuiClient()

  app.set('trust proxy', true)
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: false, limit: '1mb' }))
  app.use((req, res, next) => {
    req.traceId = req.headers['x-trace-id'] || createTraceId()
    // 排障观测：/audio/info 的 Host 头决定返回给客户端的 /audio/stream 绝对地址。
    if (req.path === '/audio/info') console.log(`[audio-info] host=${req.headers.host} remote=${req.socket?.remoteAddress} ua=${String(req.headers['user-agent'] || '').slice(0, 48)} referer=${req.headers.referer || '-'} trace=${req.traceId}`)
    setCorsHeaders(req, res)
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  })

  app.get('/', (req, res) => {
    res.json(ok({
      name: 'qishui-api',
      version: require('./package.json').version,
      routes: moduleDefs.map((item) => item.route),
    }, req.traceId))
  })

  app.get('/health', (req, res) => {
    res.json(ok({ status: 'ok' }, req.traceId))
  })

  app.get('/api/list', (req, res) => {
    res.json(ok(moduleDefs.map((item) => ({ route: item.route, file: item.file })), req.traceId))
  })

  // 图片代理：App 端缓存封面时浏览器直连 CDN 会被 CORS 拦截（douyinpic 无 CORS 头），
  // 由服务端转发。白名单限定汽水封面 CDN 域，仅放行图片内容。
  const IMAGE_PROXY_HOST_SUFFIXES = ['douyinpic.com', 'douyinstatic.com', 'byteimg.com', 'zjcdn.com']
  app.get('/image/proxy', async (req, res) => {
    const target = String(req.query.url || '')
    let parsed
    try {
      parsed = new URL(target)
    } catch {
      return res.status(400).json(fail(40000, 'url 参数无效', req.traceId))
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return res.status(400).json(fail(40000, '仅支持 http/https 图片地址', req.traceId))
    }
    if (!IMAGE_PROXY_HOST_SUFFIXES.some((suffix) => parsed.hostname === suffix || parsed.hostname.endsWith(`.${suffix}`))) {
      return res.status(403).json(fail(40300, '图片域名不在白名单内', req.traceId))
    }
    try {
      const upstream = await fetch(parsed.toString(), { headers: { 'user-agent': 'Mozilla/5.0' }, redirect: 'follow' })
      if (!upstream.ok) {
        return res.status(502).json(fail(50200, `封面源站返回 ${upstream.status}`, req.traceId))
      }
      res.setHeader('content-type', upstream.headers.get('content-type') || 'image/png')
      res.setHeader('cache-control', 'public, max-age=86400')
      const buffer = Buffer.from(await upstream.arrayBuffer())
      return res.end(buffer)
    } catch (error) {
      return res.status(502).json(fail(50200, `封面拉取失败：${error.message}`, req.traceId))
    }
  })

  for (const item of moduleDefs) {
    const routeHandler = async (req, res, next) => {
      try {
        if (item.moduleHandler.bodyOnly && Object.keys(req.query || {}).length) {
          throw new ValidationError('敏感参数必须放在 POST JSON body 中')
        }
        const data = await item.moduleHandler(mergeInput(req), {
          req,
          res,
          client,
          cookie: req.headers.cookie || '',
          traceId: req.traceId,
        })
        // 二进制端点（如 /audio/stream）直接写完 res，跳过 JSON 包装
        if (res.writableEnded) return
        if (data && typeof data === 'object' && data.status && data.body) {
          return res.status(data.status).json(data.body)
        }
        return res.json(ok(data, req.traceId))
      } catch (error) {
        return next(error)
      }
    }
    const methods = Array.isArray(item.moduleHandler.methods) && item.moduleHandler.methods.length ? item.moduleHandler.methods : ['get', 'post']
    for (const method of methods) app[method.toLowerCase()](item.route, routeHandler)
  }

  app.use((req, res) => {
    res.status(404).json(fail(40400, '接口不存在', req.traceId, { path: req.path }))
  })

  app.use((error, req, res, _next) => {
    const status = error instanceof HttpError ? error.status : 500
    const code = error instanceof HttpError ? error.code : 50000
    const message = error instanceof HttpError ? error.message : '服务器内部错误'
    res.status(status).json(fail(code, message, req.traceId, sanitizeForExternal(error.details)))
  })

  return app
}

async function serveQishuiApi(options = {}) {
  const app = await constructServer()
  const port = options.port || config.port
  const host = options.host || config.host
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      console.log(`qishui-api listening on http://${host}:${port}`)
      resolve(server)
    })
  })
}

module.exports = {
  constructServer,
  serveQishuiApi,
  getModuleDefinitions,
}
