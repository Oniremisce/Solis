const crypto = require('crypto')
const { UpstreamError } = require('./errors')

// 汽水扫码登录签名桥。
//
// 背景：passport 扫码接口（get_qrcode / check_qrconnect）必须由真实 Chromium 里的
// 官方安全组件（bdms.js）补 a_bogus / X-Helios / X-Medusa 签名，纯 HTTP 直连会被
// 风控拒绝（error_code=7 限流、1049 无效请求）。这里把请求交给 qishui-signer
// （signer/ 目录，playwright-core + 本机 Edge/Chromium）代发，登录态 cookie 落在
// 签名页浏览器上下文的 jar 里，确认后按上下文收割。
//
// 请求组装权威参考：libresoda/src/soda/qr_login.rs（公共参数、设备身份、
// x-ss-stub = MD5(body) 大写、x-tt-passport-* 头）。

const SIGNER_URL = (process.env.QISHUI_SIGNER_URL || 'http://127.0.0.1:8799').replace(/\/$/, '')

const PASSPORT_API_BASE = 'https://api.qishui.com'
const AID = '386088'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.2.1 Chrome/136.0.7103.59 Electron/36.4.0 Safari/537.36'

const MIN_CHECK_INTERVAL_MS = 2500
const RATE_LIMIT_COOLDOWN_MS = 5000
const SESSION_TTL_MS = 10 * 60 * 1000

// ─── 随机身份 ───

function randomDigits(count) {
  let out = ''
  while (out.length < count) out += String(crypto.randomInt(0, 10))
  return out
}

function randomHex(count) {
  return crypto.randomBytes(Math.ceil(count / 2)).toString('hex').slice(0, count)
}

function randomUuid() {
  return crypto.randomUUID()
}

// `msToken = ${randomBase64Url(88)}==`（88 字节 → base64url 无填充 + "=="，总长 120）
function randomMsToken() {
  return `${crypto.randomBytes(88).toString('base64url')}==`
}

function md5HexUpper(input) {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex').toUpperCase()
}

// ─── 公共参数（对齐 qr_login.rs common_params，勿增删） ───

function commonParams(session, bizTraceId) {
  return new URLSearchParams({
    passport_jssdk_version: '2.4.13',
    passport_jssdk_type: 'normal',
    is_from_ttaccountsdk: '1',
    aid: AID,
    language: 'zh',
    account_sdk_source: 'web',
    p_js_v: '2.4.13',
    p_js_t: 'pro',
    p_zt: '3.3.5',
    p_ver: '1.0.29',
    request_host: 'app%3A%2F%2Fresources',
    p_bd: '1.0.0.41',
    is_new_login: '1',
    is_from_iesaccountsaas: '1',
    device_platform: 'PC',
    version_code: '3.5.2',
    account_sdk_source_info: '00',
    biz_trace_id: bizTraceId,
    device_id: session.deviceId,
    install_id: session.installId,
    did: session.deviceId,
    iid: session.installId,
    msToken: session.msToken,
  })
}

function buildUrl(path, params) {
  return `${PASSPORT_API_BASE}${path}?${params.toString()}`
}

// ─── 签名服务 HTTP 客户端 ───

async function signerRequest(spec) {
  let response
  try {
    response = await fetch(`${SIGNER_URL}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(200000),
    })
  } catch (error) {
    throw new UpstreamError('汽水签名服务不可用（qishui-signer 未启动或不可达）', {
      signer_url: SIGNER_URL,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new UpstreamError(`汽水签名服务返回无效数据（HTTP ${response.status}）`, { raw: text.slice(0, 200) })
  }
  if (!response.ok || !body || body.ok === false) {
    throw new UpstreamError(body?.error || `汽水签名服务请求失败（HTTP ${response.status}）`, { signer_status: response.status })
  }
  return body
}

async function signerCloseSession(sessionKey) {
  try {
    await fetch(`${SIGNER_URL}/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey }),
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    // 尽力而为：签名服务有 5 分钟空闲回收兜底
  }
}

// 二次验证（error_code=2046）：在签名页跑官方验证组件，用户在可见窗口完成后才返回。
async function signerSecondVerify({ sessionKey, decision, generalParams }) {
  let response
  try {
    response = await fetch(`${SIGNER_URL}/second_verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey, decision, generalParams }),
      signal: AbortSignal.timeout(300000),
    })
  } catch (error) {
    throw new UpstreamError('汽水二次验证服务不可用', {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  const body = await response.json().catch(() => null)
  if (!response.ok || !body || body.ok === false) {
    throw new UpstreamError(body?.error || `汽水二次验证请求失败（HTTP ${response.status}）`, { signer_status: response.status })
  }
  return body.result
}

// 公共参数快照（对象形态），交给验证页里的官方组件
function generalParamsObject(session) {
  const params = commonParams(session, randomHex(8))
  const out = {}
  for (const [key, value] of params.entries()) out[key] = value
  return out
}

// ─── cookie 会话工具 ───

// 合并 cookie 片段（对齐 qr_login.rs merge_cookies：同名覆盖、丢弃属性位）
function mergeCookie(current, values) {
  const pairs = []
  const push = (name, value) => {
    if (!name || !value) return
    const existing = pairs.find((item) => item[0] === name)
    if (existing) existing[1] = value
    else pairs.push([name, value])
  }
  for (const raw of [current, ...(values || [])]) {
    for (const part of String(raw || '').split(/[;,]/)) {
      const eq = part.indexOf('=')
      if (eq <= 0) continue
      const name = part.slice(0, eq).trim()
      const value = part.slice(eq + 1).trim().split(';')[0].trim()
      if (['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly'].includes(name.toLowerCase())) continue
      push(name, value)
    }
  }
  return pairs.map(([name, value]) => `${name}=${value}`).join('; ')
}

// signer 返回的上下文 jar → cookie 片段数组
function cookiePairsFromJar(cookies) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((item) => item && item.name && item.value !== undefined)
    .map((item) => `${item.name}=${item.value}`)
}

// 登录态判定：按 cookie 名精确匹配（sessionid 不能按子串匹配）
function hasLoginState(cookie) {
  const names = ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt']
  return String(cookie || '').split(';').some((pair) => {
    const eq = pair.indexOf('=')
    if (eq <= 0) return false
    return names.includes(pair.slice(0, eq).trim()) && pair.slice(eq + 1).trim() !== ''
  })
}

function extractSessionIdFromCookie(cookie) {
  const match = String(cookie || '').match(/(?:^|;\s*)sessionid=([^;]+)/i)
  return match ? match[1].trim() : ''
}

// ─── 二维码会话存储 ───

const sessions = new Map()

function createQrSession() {
  const session = {
    sessionKey: `qr-${randomHex(16)}`,
    deviceId: randomDigits(16),
    installId: randomDigits(15),
    msToken: randomMsToken(),
    verifyPortraitId: `${randomUuid()}.login`,
    cookie: '',
    createdAt: Date.now(),
    lastCheckMs: 0,
    cooldownUntilMs: 0,
    lastResult: null,
    secondVerify: null,
    secondVerifyDone: false,
    verifyInFlight: false,
    // 签名上下文出生戳：签名服务重启后上下文会被懒重建（丢失 get_qrcode 历史），
    // 轮询时对比此值可识别僵尸会话并强制前端重新要码
    contextCreatedAt: 0,
  }
  cleanupSessions()
  return session
}

function getQrSession(token) {
  const session = sessions.get(String(token || ''))
  if (!session) return null
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(String(token))
    void signerCloseSession(session.sessionKey)
    return null
  }
  return session
}

function setQrSession(token, session) {
  sessions.set(String(token), session)
}

function removeQrSession(token) {
  sessions.delete(String(token))
}

function cleanupSessions() {
  const now = Date.now()
  for (const [token, session] of [...sessions]) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(token)
      void signerCloseSession(session.sessionKey)
    }
  }
}

// ─── passport 请求（经签名页代发） ───

// 经签名页发请求：headers 不能带 Cookie（浏览器禁止 & jar 自管理），
// 响应后把签名上下文 jar 合并回 session.cookie。
async function sendViaSigner(session, method, url, headers, bodyString) {
  const response = await signerRequest({
    sessionKey: session.sessionKey,
    method,
    url,
    headers,
    body: bodyString == null || bodyString === '' ? null : bodyString,
    msToken: session.msToken,
  })
  session.cookie = mergeCookie(session.cookie, cookiePairsFromJar(response.cookies))
  return response
}

// passport 接口请求：公共参数 + x-tt-passport-* 头（+ POST 的 x-ss-stub）
async function requestPassport(session, method, path, extraParams, bodyValues) {
  const bizTraceId = randomHex(8)
  const params = commonParams(session, bizTraceId)
  for (const [key, value] of Object.entries(extraParams || {})) {
    params.set(key, String(value))
  }
  const url = buildUrl(path, params)

  const bodyString = bodyValues ? new URLSearchParams(bodyValues).toString() : ''
  const headers = {
    Accept: 'application/json, text/javascript',
    'User-Agent': UA,
    'x-tt-passport-verify-portrait': session.verifyPortraitId,
    'x-tt-passport-trace-id': bizTraceId,
  }
  if (bodyValues) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    headers['x-ss-stub'] = md5HexUpper(bodyString)
  }

  return sendViaSigner(session, method, url, headers, bodyString)
}

// 跟着 redirect_url（完整 URL）走一跳，把签名页浏览器会话里的登录 cookie 引出来
async function harvestCookies(session, url) {
  if (!url) return
  await sendViaSigner(session, 'GET', String(url), {
    Accept: 'application/json, text/javascript',
    'User-Agent': UA,
  }, '')
}

module.exports = {
  PASSPORT_API_BASE,
  AID,
  UA,
  MIN_CHECK_INTERVAL_MS,
  RATE_LIMIT_COOLDOWN_MS,
  createQrSession,
  getQrSession,
  setQrSession,
  removeQrSession,
  requestPassport,
  harvestCookies,
  signerCloseSession,
  signerSecondVerify,
  generalParamsObject,
  mergeCookie,
  hasLoginState,
  extractSessionIdFromCookie,
  md5HexUpper,
}
