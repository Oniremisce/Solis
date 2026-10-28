const fs = require('fs')
const path = require('path')
const config = require('./config')
const { requestJson } = require('./http')
const mssdkSigner = require('./mssdkSigner')
const { ValidationError, UpstreamError } = require('./errors')
const { requireString, optionalInt, optionalPositiveInt, boundedPositiveInt: boundedIdPositiveInt, extractTrackId, extractVideoId, extractPlaylistId, extractResourceIds } = require('./ids')
const {
  extractPlaylistsFromDiscoverMix,
  extractRadiosFromDiscover,
  extractRadiosFromRadioList,
  normalizePlaylistDetail,
  normalizeFeedItem,
  normalizeSearchGroups,
  normalizePlaylist,
  normalizeProfile,
  normalizeTrack,
  normalizeMixedCollections,
  normalizeVideo,
} = require('./normalizers')
const { fetchAllowedText, extractRouterData, findAudioOption, formatSongFromAudioOption } = require('./routerData')
const { assertAllowedDownloadUrl, downloadBinary } = require('./download')
const { decryptAudioBuffer, decryptSpadeA, resolveAudioKey } = require('./audioDecryptor')
const streamTicket = require('./streamTicket')
const { collectCookieSecrets, redactSensitiveString, safeUrlForOutput, sanitizeForExternal } = require('./redaction')
const signerBridge = require('./signerBridge')

function boundedPositiveInt(value, fallback, name) {
  return boundedIdPositiveInt(value, fallback, config.maxPageSize, name)
}

function boundedDownloadBytes(value) {
  return Math.min(optionalPositiveInt(value, config.downloadMaxBytes, 'max_bytes'), config.downloadMaxBytes)
}

function optionalBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function nonEmptyPlainObject(value) {
  return isPlainObject(value) && Object.keys(value).length > 0
}

function feedPayloadSource(query = {}) {
  return nonEmptyPlainObject(query.body) ? query.body : query
}

function normalizeMediaFeedItem(item) {
  const normalized = normalizeFeedItem(item)
  if (!normalized) return null
  const video = normalizeVideo(item?.entity?.video || item?.entity?.ugc_video || item?.video || item?.ugc_video)
  if (video && video.id) {
    normalized.video = video
    if (!normalized.type) normalized.type = 'video'
  }
  return normalized
}

function stringValue(value) {
  return value === undefined || value === null ? '' : String(value)
}

function numberValue(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function redactedStringValue(value, secrets = []) {
  return redactSensitiveString(stringValue(value), secrets)
}

function firstHttpUrl(value, depth = 0) {
  if (!value || depth > 6) return ''
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedUrl = firstHttpUrl(item, depth + 1)
      if (nestedUrl) return nestedUrl
    }
    return ''
  }
  if (typeof value !== 'object') return ''
  for (const item of Object.values(value)) {
    const nestedUrl = firstHttpUrl(item, depth + 1)
    if (nestedUrl) return nestedUrl
  }
  return ''
}

function redactCommentTree(value, query = {}, context = {}) {
  return sanitizeForExternal(value, { secrets: accountCredentialSecrets(query, context, String(context.cookie || '').trim()) })
}

function normalizeCommentUser(item = {}, secrets = []) {
  const user = item.user || item.user_info || item.userInfo || item.author || item.comment_user || {}
  const avatar = firstHttpUrl(user.avatar_url || user.avatarUrl || user.avatar || user.avatar_thumb || user.avatarThumb || user.user_avatar || item.user_avatar || item.userAvatar || item.avatar_url)
  return {
    user_id: redactedStringValue(user.id ?? user.user_id ?? user.userId ?? user.uid ?? item.user_id ?? item.userId ?? item.uid, secrets),
    user_name: redactedStringValue(user.nickname ?? user.name ?? user.user_name ?? user.userName ?? item.user_name ?? item.userName ?? item.nickname, secrets),
    user_avatar: avatar ? safeUrlForOutput(redactSensitiveString(avatar, secrets)) : '',
  }
}

function normalizeComment(item = {}, groupId = '', secrets = []) {
  const user = normalizeCommentUser(item, secrets)
  return {
    id: redactedStringValue(item.id ?? item.comment_id ?? item.commentId ?? item.cid, secrets),
    group_id: redactedStringValue(item.group_id ?? item.groupId ?? item.item_id ?? item.itemId ?? groupId, secrets),
    user_id: user.user_id,
    user_name: user.user_name,
    user_avatar: user.user_avatar,
    content: redactedStringValue(item.content ?? item.text ?? item.comment_text ?? item.commentText, secrets),
    like_count: numberValue(item.like_count ?? item.likeCount ?? item.digg_count ?? item.diggCount ?? item.favorite_count),
    reply_count: numberValue(item.reply_count ?? item.replyCount ?? item.comment_count ?? item.commentCount),
    timestamp: numberValue(item.timestamp ?? item.create_time ?? item.createTime ?? item.create_timestamp ?? item.createAt),
    is_liked: optionalBoolean(item.is_liked ?? item.isLiked ?? item.liked ?? item.user_liked, false),
    raw: sanitizeForExternal(item, { secrets }),
  }
}

const PLAYBACK_SENSITIVE_NAME_RE = /(cookie|session|token|authorization|auth|passport|sid|uid|user_id|device_id|install_id|openudid|spade|play_auth|playauth|key|secret|url_player_info|urlPlayerInfo|video_model|videoModel|videoModelString|video_model_string|main_url|backup_url|play_url|audio_url|download_url)/i

const PASSPORT_FIXED = {
  aid: '386088',
  passport_jssdk_version: '2.4.13',
  passport_jssdk_type: 'normal',
  is_from_ttaccountsdk: '1',
  next: 'https://api.qishui.com',
  need_logo: 'false',
  need_short_url: 'false',
  is_frontier: 'true',
  is_new_login: '1',
  iid: '27960026095955',
  version_code: '30020100',
}

function authQrData(body = {}) {
  return isPlainObject(body.data) ? body.data : body
}

function normalizeAuthQrcodeBody(body = {}) {
  const data = authQrData(body)
  const copywriting = stringValue(data.copywriting)
  return {
    ...body,
    token: stringValue(data.token),
    qrcode: stringValue(data.qrcode),
    qrcode_index_url: stringValue(data.qrcode_index_url),
    expire_time: numberValue(data.expire_time),
    web_name: stringValue(data.web_name),
    copywriting,
    scan_app: copywriting.includes('抖音') ? 'douyin' : '',
  }
}

// 二次验证决策的 biz_params 归一化（对齐 qr_login.rs normalize_biz_params）：
// JSON 字符串 / k=v&k2=v2 查询串 / 对象都归成字符串键值对，null 丢弃。
function normalizeBizParams(value) {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return {}
    try {
      return normalizeBizParams(JSON.parse(text))
    } catch {
      const out = {}
      for (const pair of text.split('&')) {
        const eq = pair.indexOf('=')
        if (eq <= 0) continue
        let key = pair.slice(0, eq)
        let val = pair.slice(eq + 1)
        try { key = decodeURIComponent(key) } catch { /* 原样 */ }
        try { val = decodeURIComponent(val) } catch { /* 原样 */ }
        if (key) out[key] = val
      }
      return out
    }
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || item === null) continue
      out[key] = typeof item === 'string' ? item : JSON.stringify(item)
    }
    return out
  }
  return {}
}

// check_qrconnect 回包的统一解析（形态对齐 qr_login.rs）
function parseCheckPayload(payload) {
  const data = payload ? authQrData(payload) : {}
  const errorCode = numberValue(data.error_code)
  const rawStatus = stringValue(data.status).trim().toLowerCase()
  const description = stringValue(data.description).trim()
  // 确认判定只认服务端状态
  const confirmed = ['3', 'confirmed', 'success'].includes(rawStatus)
    || data.logged_in === true
    || data.session_cookie !== undefined
  return { data, errorCode, rawStatus, description, confirmed }
}

function sessionCookie(query = {}, context = {}) {
  // 完整 cookie 串（签名页登录态收割产物）优先；兼容旧的单值 sessionid。
  const rawCookie = query.cookie ?? query.session_cookie
  if (rawCookie !== undefined && rawCookie !== null && String(rawCookie).trim()) {
    const rawCookieString = String(rawCookie).trim()
    if (/[\x00-\x1F\x7F]/.test(rawCookieString)) throw new ValidationError('cookie 无效')
    return rawCookieString
  }
  const rawSessionid = query.sessionid ?? query.session_id
  if (rawSessionid !== undefined && rawSessionid !== null) {
    const rawSessionidString = String(rawSessionid)
    if (!rawSessionidString.trim()) throw new ValidationError('Cookie 或 sessionid 不能为空')
    if (/[;\s\x00-\x1F\x7F]/.test(rawSessionidString)) throw new ValidationError('sessionid 无效')
    return `sessionid=${rawSessionidString};`
  }
  return String(context.cookie || '').trim()
}

function extractSessionIdFromCookie(cookie) {
  const match = String(cookie || '').match(/(?:^|;\s*)sessionid=([^;]+)/i)
  return match ? match[1].trim() : ''
}

// 无 cookie 请求的兜底：读取最近一次扫码登录落盘的完整 cookie 串（本机单用户自用）。
function loadPersistedLoginCookie() {
  try {
    return fs.readFileSync(path.join(__dirname, '..', '.data', 'last-login-cookie.txt'), 'utf8').trim() || ''
  } catch {
    return ''
  }
}

// 请求未携带登录态时注入落盘 cookie（旧版 App 部分路由不传 cookie；本机单用户）。
function withPersistedCookie(query = {}, context = {}) {
  if (context.cookie || query.sessionid || query.session_id || query.cookie) return context
  const persisted = loadPersistedLoginCookie()
  return persisted ? { ...context, cookie: persisted } : context
}

function isAccountSensitiveKey(key) {
  const normalized = String(key || '').replace(/[-_]/g, '').toLowerCase()
  const exactSensitive = ['cookie', 'cookies', 'sessionid', 'session', 'requestheaders', 'authorization', 'auth', 'token', 'passport', 'sid', 'sidguard', 'sidtt', 'uidtt', 'odintt', 'passportcsrftoken', 'csrftoken']
  return exactSensitive.includes(normalized)
    || normalized.includes('cookie')
    || normalized.includes('session')
    || normalized.includes('token')
    || normalized.includes('authorization')
    || normalized.includes('passport')
    || normalized.startsWith('sid')
}

function accountCredentialSecrets(query = {}, context = {}, cookie = '') {
  const secrets = new Set()
  const body = isPlainObject(query.body) ? query.body : {}
  const rawSessionid = query.sessionid ?? query.session_id ?? body.sessionid ?? body.session_id
  if (rawSessionid !== undefined && rawSessionid !== null) {
    const sessionid = String(rawSessionid).trim()
    if (sessionid) secrets.add(sessionid)
  }
  const contextCookie = String(context.cookie || '').trim()
  for (const secret of collectCookieSecrets(contextCookie)) secrets.add(secret)
  for (const secret of collectCookieSecrets(cookie)) secrets.add(secret)
  if (contextCookie) secrets.add(contextCookie)
  if (cookie) secrets.add(cookie)
  const cookieSessionid = extractSessionIdFromCookie(cookie)
  if (cookieSessionid) secrets.add(cookieSessionid)
  return [...secrets].filter(Boolean)
}

function redactAccountString(value, secrets) {
  let output = value
  const sortedSecrets = [...new Set(secrets.map((secret) => String(secret || '')).filter((secret) => secret.length >= 4))]
    .sort((left, right) => right.length - left.length)
  for (const secret of sortedSecrets) output = output.split(secret).join('<redacted>')
  return output
}

function redactAccountCredentials(value, secrets, key = '', depth = 0) {
  if (isAccountSensitiveKey(key)) return '<redacted>'
  if (value === null || value === undefined) return value
  if (depth > 8) return '<truncated>'
  if (typeof value === 'string') return redactAccountString(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactAccountCredentials(item, secrets, key, depth + 1))
  if (typeof value !== 'object') return value

  const output = {}
  for (const [propertyName, propertyValue] of Object.entries(value)) {
    output[propertyName] = redactAccountCredentials(propertyValue, secrets, propertyName, depth + 1)
  }
  return output
}

function redactInboundCredentials(value, query = {}, context = {}) {
  const cookie = String(context.cookie || '').trim()
  return redactAccountCredentials(value, accountCredentialSecrets(query, context, cookie))
}

function redactPlaybackTree(value, key = '', depth = 0) {
  if (PLAYBACK_SENSITIVE_NAME_RE.test(key)) return '<redacted>'
  if (value === null || value === undefined) return value
  if (depth > 8) return '<truncated>'
  if (Array.isArray(value)) return value.map((item) => redactPlaybackTree(item, key, depth + 1))
  if (typeof value !== 'object') return value

  const output = {}
  for (const [propertyName, propertyValue] of Object.entries(value)) {
    output[propertyName] = redactPlaybackTree(propertyValue, propertyName, depth + 1)
  }
  return output
}

function normalizeLookupKey(key) {
  return String(key).replace(/[_-]/g, '').toLowerCase()
}

function findFirstByKeys(value, keys, depth = 0) {
  if (!value || depth > 8) return null
  const normalizedKeys = new Set(keys.map(normalizeLookupKey))
  if (Array.isArray(value)) {
    for (const element of value) {
      const nestedValue = findFirstByKeys(element, keys, depth + 1)
      if (nestedValue !== null && nestedValue !== undefined && nestedValue !== '') return nestedValue
    }
    return null
  }
  if (typeof value !== 'object') return null

  for (const [propertyName, propertyValue] of Object.entries(value)) {
    if (normalizedKeys.has(normalizeLookupKey(propertyName))) return propertyValue
  }
  for (const propertyValue of Object.values(value)) {
    const nestedValue = findFirstByKeys(propertyValue, keys, depth + 1)
    if (nestedValue !== null && nestedValue !== undefined && nestedValue !== '') return nestedValue
  }
  return null
}

function firstUrlFromValue(value) {
  if (!value) return ''
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : ''
  if (Array.isArray(value)) {
    for (const element of value) {
      const nestedUrl = firstUrlFromValue(element)
      if (nestedUrl) return nestedUrl
    }
    return ''
  }
  if (typeof value === 'object') {
    const urlValue = findFirstByKeys(value, ['main_url', 'backup_url', 'audio_url', 'play_url'])
    return firstUrlFromValue(urlValue)
  }
  return ''
}

function formatAudioInfo(song, includeRaw = false) {
  const raw = song.raw || {}
  const playAuth = findFirstByKeys(raw, ['play_auth', 'playAuth', 'PlayAuth'])
  const spadeA = findFirstByKeys({ playAuth, raw }, ['spade_a', 'spadeA'])
  const audioUrl = song.audio_url || firstUrlFromValue(findFirstByKeys(raw, ['video_list', 'play_info', 'audio_info', 'play_url']))
  const output = {
    track_id: String(song.track_id || ''),
    name: song.name || '',
    artists: Array.isArray(song.artists) ? song.artists : [],
    album: song.album || null,
    audio_url: audioUrl || '',
    has_audio_url: Boolean(audioUrl),
    spade_a: typeof spadeA === 'string' ? spadeA : '',
    has_spade_a: typeof spadeA === 'string' && Boolean(spadeA),
    play_auth: playAuth || null,
  }
  if (includeRaw) output.raw = raw
  return output
}

// ─── PC 整曲 track_v2：video_model 解析与选档（对齐 libresoda track.rs / quality.rs） ───

// 档位分值（越大越好）；flac 无损另有加成，同级比码率。
const STREAM_QUALITY_RANK = { lossless: 50, hi_res: 45, highest: 40, higher: 30, medium: 20, lower: 10 }

// video_model 可能是「被再编码成字符串的 JSON」，连续解最多 3 层（对齐 libresoda）。
function unwrapVideoModel(raw) {
  let value = raw
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof value !== 'string') break
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' ? value : null
}

function streamScore(entry) {
  return (STREAM_QUALITY_RANK[String(entry.quality || '').toLowerCase()] || 0) + (String(entry.format || '').toLowerCase() === 'flac' ? 5 : 0)
}

// 递归收集带播放地址的候选（档位参数在 video_meta，加密凭据在 encrypt_info）。
function collectStreamEntries(value, out = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return out
  if (Array.isArray(value)) {
    for (const item of value) collectStreamEntries(item, out, depth + 1)
    return out
  }
  const main = String(value.main_url || value.main_play_url || '').trim()
  const backup = String(value.backup_url || value.backup_play_url || '').trim()
  if (main || backup) {
    const meta = value.video_meta && typeof value.video_meta === 'object' ? value.video_meta : {}
    const encryptInfo = value.encrypt_info && typeof value.encrypt_info === 'object' ? value.encrypt_info : {}
    out.push({
      quality: String(meta.quality || value.gear || value.quality || ''),
      format: String(meta.vtype || meta.codec_type || value.format || ''),
      codec: String(meta.codec_type || ''),
      bitrate: Number(meta.bitrate || meta.real_bitrate || value.bitrate || 0) || 0,
      size: Number(meta.size || value.size || 0) || 0,
      duration: Number(value.video_duration || value.duration || 0) || 0,
      main_url: main,
      backup_url: backup,
      encrypt: Boolean(encryptInfo.encrypt),
      encryption_method: String(encryptInfo.encryption_method || ''),
      spade_a: String(encryptInfo.spade_a || ''),
    })
  }
  for (const item of Object.values(value)) {
    if (item && typeof item === 'object') collectStreamEntries(item, out, depth + 1)
  }
  return out
}

// 偏好档位：只在「不超过偏好档」的候选里挑最优，该档没有候选回退整体最优。
function pickBestEntry(entries, preference = '') {
  const usable = entries.filter((entry) => entry.main_url || entry.backup_url)
  if (!usable.length) return null
  const preferenceRank = STREAM_QUALITY_RANK[String(preference || '').toLowerCase()]
  const candidates = preferenceRank
    ? usable.filter((entry) => streamScore(entry) <= preferenceRank && (STREAM_QUALITY_RANK[String(entry.quality || '').toLowerCase()] || 0) > 0)
  : []
  const pool = candidates.length ? candidates : usable
  return pool.reduce((best, entry) => {
    if (!best) return entry
    const byScore = streamScore(entry) - streamScore(best)
    if (byScore !== 0) return byScore > 0 ? entry : best
    return (entry.bitrate || 0) >= (best.bitrate || 0) ? entry : best
  }, null)
}

function bestStreamEntry(videoModel, preference = '') {
  const value = unwrapVideoModel(videoModel)
  if (!value) return null
  return pickBestEntry(collectStreamEntries(value), preference)
}

function formatMediaPlayerResponse(body) {
  const rawPlayerInfos = Array.isArray(body?.player_infos) ? body.player_infos : Array.isArray(body?.playerInfos) ? body.player_infos : []
  return {
    player_infos: rawPlayerInfos.map((info) => {
      const audioEffects = info?.audio_effects || info?.audioEffects || null
      return {
        media_id: String(info?.media_id || info?.mediaId || ''),
        expire_at: Number(info?.expire_at ?? info?.expireAt ?? 0) || 0,
        video_model_type: info?.video_model_type ?? info?.videoModelType ?? null,
        has_url_player_info: Boolean(findFirstByKeys(info, ['url_player_info', 'urlPlayerInfo'])),
        has_video_model: Boolean(findFirstByKeys(info, ['video_model', 'video_model_string', 'videoModel', 'videoModelString'])),
        audio_effect_keys: audioEffects && typeof audioEffects === 'object' ? Object.keys(audioEffects) : [],
      }
    }),
    upstream: redactPlaybackTree(body || {}),
  }
}

function base64ToBuffer(value, name, maxBytes) {
  const raw = requireString(value, name)
  const buffer = Buffer.from(raw, 'base64')
  if (!buffer.length) throw new ValidationError(`${name} 不是有效 base64 数据`)
  if (buffer.length > maxBytes) throw new ValidationError(`${name} 超过大小限制`, { max_bytes: maxBytes })
  return buffer
}

function shouldResolveTrackUrl(query) {
  return Boolean(query.track_id || query.id || query.share_url || extractTrackId(query.url))
}

class QishuiClient {
  constructor(options = {}) {
    this.lunaApiHost = options.lunaApiHost || config.lunaApiHost
    this.pcApiHost = options.pcApiHost || config.pcApiHost
    this.musicShareHost = options.musicShareHost || config.musicShareHost
    this.timeoutMs = options.timeoutMs || config.requestTimeoutMs
  }

  appHeaders(cookie) {
    return {
      'User-Agent': 'Luna/19.1.0 Android',
      'Content-Type': 'application/json; charset=utf-8',
      ...(cookie ? { Cookie: cookie } : {}),
    }
  }

  pcHeaders(cookie) {
    return {
      'User-Agent': 'LunaPC/3.0.0(290101097)',
      'Content-Type': 'application/json; charset=utf-8',
      ...(config.xHelios ? { 'X-Helios': config.xHelios } : {}),
      ...(config.xMedusa ? { 'X-Medusa': config.xMedusa } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    }
  }

  webHeaders(cookie) {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      ...(cookie ? { Cookie: cookie } : {}),
    }
  }

  downloadHeaders() {
    return {
      'User-Agent': this.webHeaders()['User-Agent'],
    }
  }

  postLuna(path, payload = {}, context = {}) {
    return requestJson(`${this.lunaApiHost}${path}`, {
      method: 'POST',
      body: payload,
      headers: this.appHeaders(context.cookie),
      timeoutMs: this.timeoutMs,
    })
  }

  getLuna(path, query = {}, context = {}) {
    return requestJson(`${this.lunaApiHost}${path}`, {
      method: 'GET',
      query,
      headers: this.webHeaders(context.cookie),
      timeoutMs: this.timeoutMs,
    })
  }

  getPc(path, query = {}, context = {}) {
    return requestJson(`${this.pcApiHost}${path}`, {
      method: 'GET',
      query,
      headers: this.pcHeaders(context.cookie),
      timeoutMs: this.timeoutMs,
    })
  }

  postPc(path, payload = {}, context = {}, query = {}) {
    return requestJson(`${this.pcApiHost}${path}`, {
      method: 'POST',
      query,
      body: payload,
      headers: this.pcHeaders(context.cookie),
      timeoutMs: this.timeoutMs,
    })
  }

  // 扫码登录走签名页代发（qishui-signer：真实 Chromium + 官方 bdms.js 补 a_bogus 签名），
  // 纯 HTTP 直连会被 passport 风控拒绝。请求组装对齐 libresoda/src/soda/qr_login.rs。
  async authQrcode() {
    const session = signerBridge.createQrSession()
    const response = await signerBridge.requestPassport(session, 'GET', '/passport/web/get_qrcode/', {
      next: signerBridge.PASSPORT_API_BASE,
      need_logo: 'false',
      need_short_url: 'false',
      is_new_login: '1',
    }, null)

    let payload = null
    try {
      payload = JSON.parse(response.body || '')
    } catch {
      throw new UpstreamError('汽水二维码接口返回无效数据', { raw: String(response.body || '').slice(0, 200) })
    }
    const normalized = normalizeAuthQrcodeBody(payload)
    if (!normalized.token) {
      const data = authQrData(payload)
      throw new UpstreamError(stringValue(data.description).trim() || '汽水二维码生成失败', {
        error_code: numberValue(data.error_code),
        message: stringValue(payload.message),
      })
    }
    signerBridge.setQrSession(normalized.token, session)
    session.contextCreatedAt = Number(response.contextCreatedAt || 0)
    return normalized
  }

  // 二次验证（2046）：在签名页可见窗口里跑官方验证组件；完成后由轮询触发重发确认
  triggerSecondVerify(session, decision) {
    if (!decision || session.verifyInFlight) return
    session.verifyInFlight = true
    signerBridge.signerSecondVerify({
      sessionKey: session.sessionKey,
      decision,
      generalParams: signerBridge.generalParamsObject(session),
    }).then((result) => {
      session.verifyInFlight = false
      if (result && result.status === true) {
        session.secondVerifyDone = true
      } else {
        console.log('[auth-qr-verify]', JSON.stringify({ done: false, message: result?.message || '验证未完成' }))
      }
    }).catch((error) => {
      session.verifyInFlight = false
      console.log('[auth-qr-verify]', JSON.stringify({ done: false, error: error instanceof Error ? error.message : String(error) }))
    })
  }

  // 统一状态回包（带当前会话 cookie 快照，前端按需取用）
  qrStatusEnvelope(session, payload, parsed, status, extra = {}) {
    return {
      ...(payload || {}),
      status,
      error_code: parsed.errorCode,
      ...(parsed.description ? { description: parsed.description } : {}),
      ...extra,
      auth: {
        aid: PASSPORT_FIXED.aid,
        sessionid: signerBridge.extractSessionIdFromCookie(session.cookie),
        cookie: session.cookie,
      },
    }
  }

  // 确认收尾：响应体收集登录态 → jar 兜底 → 必要时跟 redirect_url 一跳收割
  async finishConfirmedBody(session, token, payload, parsed) {
    const parts = []
    for (const key of ['session_cookie', 'cookie']) {
      if (typeof parsed.data[key] === 'string' && parsed.data[key]) parts.push(parsed.data[key])
      if (payload && typeof payload[key] === 'string' && payload[key]) parts.push(payload[key])
    }
    for (const key of ['sessionid', 'session_id']) {
      if (typeof parsed.data[key] === 'string' && parsed.data[key]) parts.push(`sessionid=${parsed.data[key]}`)
      const auth = parsed.data.auth && typeof parsed.data.auth === 'object' ? parsed.data.auth : {}
      if (typeof auth[key] === 'string' && auth[key]) parts.push(`sessionid=${auth[key]}`)
    }
    session.cookie = signerBridge.mergeCookie(session.cookie, parts)
    if (!signerBridge.hasLoginState(session.cookie)) {
      console.log('[auth-qr-confirm]', JSON.stringify({
        stage: 'no_login_state',
        body_snippet: JSON.stringify(payload || {}).slice(0, 400),
        cookie_names: session.cookie.split(';').map((item) => item.trim().split('=')[0]).filter(Boolean),
        has_redirect: Boolean(stringValue(parsed.data.redirect_url).trim()),
      }))
      const redirect = stringValue(parsed.data.redirect_url).trim()
      if (redirect) await signerBridge.harvestCookies(session, redirect)
    }
    if (signerBridge.hasLoginState(session.cookie)) {
      const result = this.qrStatusEnvelope(session, payload, { ...parsed, errorCode: numberValue(parsed.data.error_code) || 0, description: '' }, 'confirmed')
      session.lastResult = null
      signerBridge.removeQrSession(token)
      void signerBridge.signerCloseSession(session.sessionKey)
      return result
    }
    return this.qrStatusEnvelope(session, payload, parsed, '', {
      description: parsed.description || '扫码确认成功但未取得登录态，请重新扫码',
    })
  }

  // 二次验证完成后的重发确认（isResend=true + 决策 biz_params，对齐 complete_second_verify）
  async completeSecondVerify(session, token) {
    const decision = session.secondVerify || {}
    const bodyValues = {
      need_logo: 'false',
      need_short_url: 'false',
      is_frontier: 'true',
      token,
      is_new_login: '1',
      next: signerBridge.PASSPORT_API_BASE,
      ...normalizeBizParams(decision.biz_params),
    }
    let response
    try {
      response = await signerBridge.requestPassport(session, 'POST', '/passport/web/check_qrconnect/', { isResend: 'true' }, bodyValues)
    } catch (error) {
      console.log('[auth-qr-resend]', JSON.stringify({ stage: 'request_failed', error: error instanceof Error ? error.message : String(error) }))
      throw error
    }
    console.log('[auth-qr-resend]', JSON.stringify({
      http_status: response.status,
      body_snippet: String(response.body || '').slice(0, 400),
      cookie_names: session.cookie.split(';').map((item) => item.trim().split('=')[0]).filter(Boolean),
    }))
    let payload = null
    try {
      payload = JSON.parse(response.body || '')
    } catch {
      payload = null
    }
    const parsed = parseCheckPayload(payload)
    if (parsed.errorCode === 2046) {
      // 服务端仍要求验证：刷新决策，重新拉起验证窗口
      session.secondVerify = parsed.data
      this.triggerSecondVerify(session, parsed.data)
      return this.qrStatusEnvelope(session, payload, parsed, 'scanned', { need_second_verify: true })
    }
    if (parsed.confirmed) {
      return this.finishConfirmedBody(session, token, payload, parsed)
    }
    if (parsed.errorCode !== 0) {
      return this.qrStatusEnvelope(session, payload, parsed, '')
    }
    return this.qrStatusEnvelope(session, payload, parsed, parsed.rawStatus === 'scanned' || parsed.rawStatus === '2' ? 'scanned' : 'waiting')
  }

  async authQrcodeStatus(query = {}) {
    const token = requireString(query.token, 'token')
    const session = signerBridge.getQrSession(token)
    if (!session) {
      // 服务重启或会话过期：让前端重新要码
      return {
        status: 'expired',
        error_code: 2,
        description: '二维码会话已过期，请重新获取',
        auth: { aid: PASSPORT_FIXED.aid, sessionid: '', cookie: '' },
      }
    }

    // 节流与限流冷却：错误码 7 是临时限流不是失败，冷却期内直接回上次结果
    const now = Date.now()
    if (session.cooldownUntilMs > now && session.lastResult) return session.lastResult
    // 二次验证窗口已回执完成：立即带决策重发确认，不走常规节流（越快领越好）
    if (session.secondVerify && session.secondVerifyDone) {
      session.secondVerifyDone = false
      return this.completeSecondVerify(session, token)
    }
    if (session.lastResult && now - session.lastCheckMs < signerBridge.MIN_CHECK_INTERVAL_MS) return session.lastResult

    const response = await signerBridge.requestPassport(session, 'POST', '/passport/web/check_qrconnect/', {}, {
      need_logo: 'false',
      need_short_url: 'false',
      is_frontier: 'true',
      token,
      is_new_login: '1',
      next: signerBridge.PASSPORT_API_BASE,
    })

    // 僵尸会话检测：签名服务重启后上下文被懒重建（没有本 token 的 get_qrcode 历史），
    // 轮询永远 waiting 且看不到扫码状态，必须作废让前端重新要码
    if (session.contextCreatedAt && response.contextCreatedAt && Number(response.contextCreatedAt) !== session.contextCreatedAt) {
      signerBridge.removeQrSession(token)
      void signerBridge.signerCloseSession(session.sessionKey)
      return {
        status: 'expired',
        error_code: 2,
        description: '签名会话已重建，请重新获取二维码',
        auth: { aid: PASSPORT_FIXED.aid, sessionid: '', cookie: '' },
      }
    }

    let payload = null
    try {
      payload = JSON.parse(response.body || '')
    } catch {
      payload = null
    }
    const parsed = parseCheckPayload(payload)

    let result
    if (parsed.confirmed) {
      result = await this.finishConfirmedBody(session, token, payload, parsed)
    } else if (parsed.errorCode === 2046) {
      // 服务端要求二次验证：登记决策并拉起验证窗口（PC 端完成），状态保持已扫码
      session.secondVerify = parsed.data
      this.triggerSecondVerify(session, parsed.data)
      result = this.qrStatusEnvelope(session, payload, parsed, 'scanned', { need_second_verify: true })
    } else if (parsed.errorCode === 2 || ['expired', 'expire', 'timeout'].includes(parsed.rawStatus)) {
      result = this.qrStatusEnvelope(session, payload, parsed, 'expired')
      signerBridge.removeQrSession(token)
      void signerBridge.signerCloseSession(session.sessionKey)
    } else if (parsed.errorCode === 7) {
      session.cooldownUntilMs = Date.now() + signerBridge.RATE_LIMIT_COOLDOWN_MS
      session.lastCheckMs = Date.now()
      session.lastResult = this.qrStatusEnvelope(session, payload, parsed, parsed.rawStatus === 'scanned' || parsed.rawStatus === '2' ? 'scanned' : 'waiting', { rate_limited: true })
      return session.lastResult
    } else if (parsed.errorCode !== 0 && !parsed.description.includes('频繁')) {
      // 其余错误码原样上抛（前端按登录错误展示）
      result = this.qrStatusEnvelope(session, payload, parsed, '')
    } else {
      result = this.qrStatusEnvelope(session, payload, parsed, parsed.rawStatus === 'scanned' || parsed.rawStatus === '2' ? 'scanned' : 'waiting')
    }

    if (result.status === 'waiting' || result.status === 'scanned') {
      session.lastCheckMs = Date.now()
      session.lastResult = result
    } else {
      session.lastResult = null
    }
    if (result.status === 'confirmed' && session.cookie) {
      // 诊断留痕：最近一次成功登录的完整 cookie 串落盘（仅本机自用，服务端重启不丢测试态）
      try {
        const dataDir = path.join(__dirname, '..', '.data')
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(path.join(dataDir, 'last-login-cookie.txt'), session.cookie)
      } catch (error) {
        console.log('[auth-qr-status] cookie persist failed:', error instanceof Error ? error.message : String(error))
      }
    }
    console.log('[auth-qr-status]', JSON.stringify({
      status: result.status,
      error_code: result.error_code,
      description: result.description || '',
      need_second_verify: Boolean(result.need_second_verify),
      verify_in_flight: session.verifyInFlight,
      cookie_names: session.cookie.split(';').map((item) => item.trim().split('=')[0]).filter(Boolean),
      has_session: Boolean(result.auth?.sessionid),
    }))
    return result
  }

  // PC 端点公共参数（对齐 libresoda pc_app_params：缺这些会被上游拒绝或回空）
  pcAppParams(extra = {}) {
    return {
      aid: PASSPORT_FIXED.aid,
      app_name: 'luna_pc',
      region: 'cn',
      geo_region: 'cn',
      os_region: 'cn',
      sim_region: '',
      device_id: config.deviceId,
      cdid: '',
      iid: config.installId,
      version_name: '3.3.0',
      version_code: '30030000',
      channel: 'official',
      build_mode: 'master',
      network_carrier: '',
      ac: 'wifi',
      tz_name: 'Asia/Shanghai',
      resolution: '',
      device_platform: 'windows',
      device_type: 'Windows',
      os_version: 'Windows 11',
      fp: config.fp || config.deviceId,
      ...extra,
    }
  }

  async authMe(query = {}, context = {}) {
    const cookie = sessionCookie(query, context)
    if (!cookie) throw new ValidationError('Cookie 或 sessionid 不能为空')
    const response = await this.getPc('/luna/pc/me', this.pcAppParams(query.aid ? { aid: query.aid } : {}), { cookie })
    const body = redactAccountCredentials(response.body || {}, accountCredentialSecrets(query, context, cookie))
    const profile = normalizeProfile(body)
    if (profile?.id) {
      // 诊断留痕：登录态有效时把本次使用的 cookie 串落盘（本机自用）
      try {
        const dataDir = path.join(__dirname, '..', '.data')
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(path.join(dataDir, 'last-login-cookie.txt'), cookie)
      } catch (_) { /* 尽力而为 */ }
    }
    if (!profile?.id) {
      // 诊断：登录态已到手但 me 接口没认，记录脱敏后的上游形态
      console.log('[auth-me]', JSON.stringify({
        http_status: response.status,
        body_keys: Object.keys(body || {}),
        status_code: body?.status_code ?? body?.status ?? '',
        snippet: JSON.stringify(body).slice(0, 300),
      }))
    }
    return {
      profile,
      upstream: body,
    }
  }

  async mePlaylists(query = {}, context = {}) {
    const cookie = sessionCookie(query, context)
    if (!cookie) throw new ValidationError('Cookie 或 sessionid 不能为空')
    const response = await this.getPc('/luna/pc/me/playlist', this.pcAppParams(query.aid || query.iid || query.version_code ? {
      ...(query.aid ? { aid: query.aid } : {}),
      ...(query.iid ? { iid: query.iid } : {}),
      ...(query.version_code ? { version_code: query.version_code } : {}),
    } : {}), { cookie })
    const body = redactAccountCredentials(response.body || {}, accountCredentialSecrets(query, context, cookie))
    return {
      playlists: Array.isArray(body.playlists) ? body.playlists.map(normalizePlaylist).filter(Boolean) : [],
      total_num: body.total_num || 0,
      upstream: body,
    }
  }

  async meCollectionMixed(query = {}, context = {}) {
    const cookie = sessionCookie(query, context)
    if (!cookie) throw new ValidationError('Cookie 或 sessionid 不能为空')
    const response = await this.getPc('/luna/pc/me/collection/mixed', { aid: query.aid || PASSPORT_FIXED.aid }, { cookie })
    const body = redactAccountCredentials(response.body || {}, accountCredentialSecrets(query, context, cookie))
    return {
      mixed_collections: normalizeMixedCollections(body),
      total_num: body.total_num || 0,
      upstream: body,
    }
  }

  // ─── 收藏（我喜欢）写操作 + 已收藏单曲列表（对齐 libresoda collection.rs） ───
  // 喜欢一首歌 → 官方歌单「我喜欢的音乐」：POST /luna/pc/me/collection/media，
  // body {scene:'', media:[{type:'track', id}]}（scene 客户端固定空串）。
  // ⚠️ 该路径在客户端零信任加签名单（bd-ticket-guard），libresoda 实测仅应用级签名可用。
  // cookie 解析与 /me/playlists 同构：请求携带（App 走 POST body）优先，落盘 cookie 兜底。
  async collectMedia(query = {}, context = {}) {
    const cookie = sessionCookie(query, context) || loadPersistedLoginCookie()
    if (!cookie) throw new ValidationError('Cookie 或 sessionid 不能为空')
    const trackId = extractTrackId(query.track_id || query.id)
    if (!trackId) throw new ValidationError('track_id 不能为空')
    const response = await this.postPc('/luna/pc/me/collection/media', {
      scene: '',
      media: [{ type: 'track', id: trackId }],
    }, { cookie }, { aid: PASSPORT_FIXED.aid })
    return response.body
  }

  // 取消喜欢：POST /luna/pc/me/collection/media/delete，body 无 scene 字段。
  async uncollectMedia(query = {}, context = {}) {
    const cookie = sessionCookie(query, context) || loadPersistedLoginCookie()
    if (!cookie) throw new ValidationError('Cookie 或 sessionid 不能为空')
    const trackId = extractTrackId(query.track_id || query.id)
    if (!trackId) throw new ValidationError('track_id 不能为空')
    const response = await this.postPc('/luna/pc/me/collection/media/delete', {
      media: [{ type: 'track', id: trackId }],
    }, { cookie }, { aid: PASSPORT_FIXED.aid })
    return response.body
  }

  // 已收藏单曲列表：/luna/pc/me/collection/mixed 实测只回空信封（libresoda 2026-09-15），
  // 走非 PC 路径 /luna/me/collection/mixed + item_types=playable（单曲）过滤。
  // 对齐 libresoda pc_get_json：api.qishui.com host + PC 设备公共参数（缺这些 1000006 FORBIDDEN）。
  async collectedTracks(query = {}, context = {}) {
    const cookie = sessionCookie(query, context) || loadPersistedLoginCookie()
    if (!cookie) throw new ValidationError('Cookie 或 sessionid 不能为空')
    const count = Math.min(Math.max(Number.parseInt(query.count, 10) || 100, 1), 100)
    const params = this.pcAppParams()
    params.cursor = String(query.cursor || '')
    params.count = String(count)
    params.item_types = 'playable'
    const response = await this.getPc('/luna/me/collection/mixed', params, { cookie })
    const body = response.body || {}
    const items = Array.isArray(body.mixed_collections) ? body.mixed_collections : []
    const tracks = items
      .map((item) => item.playable)
      .filter(Boolean)
      .map((payload) => ({
        id: String(payload.id ?? ''),
        name: payload.public_title || payload.title || payload.name || '',
        artist: payload.artist_list?.map((a) => a.name).filter(Boolean).join(' / ')
          || (Array.isArray(payload.artists) ? payload.artists.map((a) => a.name).filter(Boolean).join(' / ') : '')
          || '',
        upstream: payload,
      }))
      .filter((item) => item.id)
    return {
      tracks,
      cursor: body.next_cursor || body.cursor || '',
      has_more: Boolean(body.has_more ?? (body.next_cursor || body.cursor)),
      total_num: body.total_num || 0,
      upstream: body,
    }
  }

  async discover(query = {}, context = {}) {
    const payload = {
      ...(query.first_request !== undefined ? { first_request: Boolean(query.first_request) } : {}),
      ...(query.ab_param ? { ab_param: query.ab_param } : {}),
    }
    const response = await this.postLuna('/luna/discover', payload, context)
    return response.body
  }

  async discoverMix(query = {}, context = {}) {
    const payload = {
      ...(query.block_type ? { block_type: String(query.block_type) } : {}),
      ...(query.sub_channel_id !== undefined ? { sub_channel_id: Number(query.sub_channel_id) || 0 } : {}),
      ...(query.cursor ? { cursor: String(query.cursor) } : {}),
      ...(query.count !== undefined ? { count: boundedPositiveInt(query.count, 10, 'count') } : {}),
      ...(query.session_id ? { session_id: String(query.session_id) } : {}),
      ...(query.feed_discover_extra && typeof query.feed_discover_extra === 'object' ? { feed_discover_extra: query.feed_discover_extra } : {}),
      ...(query.ab_param ? { ab_param: String(query.ab_param) } : {}),
    }
    const response = await this.postLuna('/luna/discover/mix', payload, context)
    return response.body
  }

  async recommendPlaylists(query = {}, context = {}) {
    const data = await this.discoverMix(query, context)
    return {
      playlists: extractPlaylistsFromDiscoverMix(data),
      has_more: Boolean(data?.has_more),
      next_cursor: data?.next_cursor || '',
      session_id: data?.session_id || '',
      upstream: data,
    }
  }

  async playlistDetail(query = {}, context = {}) {
    const playlistId = extractPlaylistId(query.id || query.playlist_id || query.url)
    if (!playlistId) throw new ValidationError('playlist_id 不能为空')
    const payload = {
      playlist_id: playlistId,
      ...(query.playlist_type !== undefined ? { playlist_type: Number(query.playlist_type) || 0 } : {}),
      ...(query.cursor ? { cursor: String(query.cursor) } : {}),
      ...(query.count !== undefined ? { count: optionalPositiveInt(query.count, 20, 'count') } : {}),
    }
    const response = await this.postLuna('/luna/playlist/detail', payload, context)
    return normalizePlaylistDetail(response.body)
  }

  async comment(query = {}, context = {}) {
    const groupId = requireString(firstPresent(query.group_id, query.track_id, query.id), 'group_id、track_id 或 id')
    const response = await this.getLuna('/luna/comments', {
      group_id: groupId,
      cursor: query.cursor ? String(query.cursor) : '',
      count: boundedPositiveInt(firstPresent(query.count, query.page_size, query.pagesize), 20, 'count'),
      group_type: query.group_type || 'track',
      image_strategy: query.image_strategy || 'tplv-luna-shrink:200:200',
      sort_type: query.sort_type || query.sortType || 'hot',
    }, context)
    const rawBody = response.body || {}
    const secrets = accountCredentialSecrets(query, context, String(context.cookie || '').trim())
    const body = redactCommentTree(rawBody, query, context)
    const source = Array.isArray(rawBody.comments)
      ? rawBody.comments
      : Array.isArray(rawBody.data)
        ? rawBody.data
        : Array.isArray(rawBody.comment_list)
          ? rawBody.comment_list
          : []
    const comments = source.map((item) => normalizeComment(item, groupId, secrets)).filter((item) => item.id || item.content)
    return {
      comments,
      total: Number(rawBody.total || rawBody.total_count || rawBody.count || comments.length) || comments.length,
      cursor: rawBody.cursor || rawBody.next_cursor || '',
      has_more: optionalBoolean(rawBody.has_more ?? rawBody.hasMore, false),
      upstream: body,
    }
  }

  async radioList(query = {}, context = {}) {
    const data = await this.discover(query, context)
    // /radio/list 的电台在 discover_playlist_mix 块里；为空时回退 discover 的 radio 块
    const radios = extractRadiosFromRadioList(data)
    return {
      radios: radios.length ? radios : extractRadiosFromDiscover(data),
      upstream: data,
    }
  }

  async radioTracks(query = {}, context = {}) {
    const radioId = requireString(query.radio_id || query.id, 'radio_id')
    const payload = {
      radio_id: radioId,
      count: boundedPositiveInt(query.count, 10, 'count'),
      cursor: query.cursor ? String(query.cursor) : '',
    }
    const response = await this.postLuna('/luna/feed/radio/tracks', payload, context)
    const body = response.body || {}
    const items = Array.isArray(body.items) ? body.items.map(normalizeFeedItem).filter(Boolean) : []
    return {
      items,
      tracks: items.map((item) => item.track).filter(Boolean),
      has_more: Boolean(body.has_more),
      upstream: body,
    }
  }

  async feedMode(query = {}, context = {}) {
    const response = await this.postLuna('/luna/feed/mode', {}, context)
    return response.body
  }

  async feedModeGuidance(query = {}, context = {}) {
    const response = await this.postLuna('/luna/feed/mode/guidance', {}, context)
    return response.body
  }

  async dailyMix(query = {}, context = {}) {
    const payload = query.body && typeof query.body === 'object' ? query.body : {}
    const response = await this.postLuna('/luna/feed/song-tab', payload, context)
    return {
      supported_without_app_context: response.body?.status_code !== 1000006,
      upstream: response.body,
    }
  }

  async playlistRelatedMedia(query = {}, context = {}) {
    const playlistId = extractPlaylistId(query.id || query.playlist_id || query.url)
    if (!playlistId) throw new ValidationError('playlist_id 不能为空')
    const payload = {
      playlist_id: playlistId,
      playlist_type: Number(query.playlist_type ?? 0) || 0,
      req_count: boundedPositiveInt(query.req_count || query.count, 10, 'count'),
      first_req_time: query.first_req_time ? Number(query.first_req_time) : Math.floor(Date.now() / 1000),
      played_media: Array.isArray(query.played_media) ? query.played_media : [],
      feed_extra: query.feed_extra && typeof query.feed_extra === 'object' ? query.feed_extra : {},
      limited_free_scene: query.limited_free_scene || '',
      selected_boost: query.selected_boost || '',
    }
    const response = await this.postLuna('/luna/playlist/related_media', payload, context)
    return response.body
  }

  async playlistFeedMedia(query = {}, context = {}) {
    const source = feedPayloadSource(query)
    const playlistId = extractPlaylistId(source.id || source.playlist_id || source.url || query.id || query.playlist_id || query.url)
    if (!playlistId) throw new ValidationError('playlist_id 不能为空')
    const payload = {
      ...(source === query ? {} : source),
      playlist_id: playlistId,
      playlist_type: Number(source.playlist_type ?? 0) || 0,
      count: boundedPositiveInt(source.count, 10, 'count'),
      cursor: source.cursor ? String(source.cursor) : '',
      feed_session_id: source.feed_session_id || '',
      server_session_id: source.server_session_id || '',
      played_media: Array.isArray(source.played_media) ? source.played_media : [],
      feed_extra: source.feed_extra && typeof source.feed_extra === 'object' ? source.feed_extra : {},
    }
    const response = await this.postLuna('/luna/feed/playlist-media', payload, context)
    const body = redactInboundCredentials(response.body || {}, query, context)
    return {
      items: Array.isArray(body.items) ? body.items.map(normalizeMediaFeedItem).filter(Boolean) : [],
      has_more: Boolean(body.has_more),
      feed_session_id: body.feed_session_id || '',
      server_session_id: body.server_session_id || '',
      upstream: body,
    }
  }

  async feedListenVideo(query = {}, context = {}) {
    const source = feedPayloadSource(query)
    const payload = {
      ...(source === query ? {} : source),
      count: boundedPositiveInt(source.count, 10, 'count'),
      cursor: source.cursor ? String(source.cursor) : '',
      played_media: Array.isArray(source.played_media) ? source.played_media : [],
      feed_extra: source.feed_extra && typeof source.feed_extra === 'object' ? source.feed_extra : {},
    }
    const response = await this.postLuna('/luna/feed/listen-video', payload, context)
    const body = redactInboundCredentials(response.body || {}, query, context)
    return {
      items: Array.isArray(body.items) ? body.items.map(normalizeMediaFeedItem).filter(Boolean) : [],
      has_more: Boolean(body.has_more),
      upstream: body,
    }
  }

  pcSearchParams(query = {}, keyword) {
    const searchKeyword = keyword !== undefined ? keyword : requireString(query.keywords || query.keyword || query.q, 'keywords')
    const cursor = optionalInt(query.cursor || query.offset, 0, 'cursor')
    return {
      aid: '386088',
      app_name: 'luna_pc',
      region: 'cn',
      geo_region: 'cn',
      os_region: 'cn',
      sim_region: '',
      device_id: query.device_id || config.deviceId,
      cdid: '',
      iid: query.iid || config.installId,
      version_name: '3.0.0',
      version_code: '30000000',
      channel: 'official',
      build_mode: 'master',
      network_carrier: '',
      ac: 'wifi',
      tz_name: 'Asia/Shanghai',
      resolution: '',
      device_platform: 'windows',
      device_type: 'Windows',
      os_version: 'Windows 11',
      fp: query.fp || config.fp || query.device_id || config.deviceId,
      q: searchKeyword,
      cursor,
      search_id: query.search_id || '',
      search_method: query.search_method || 'input',
      debug_params: '',
      from_search_id: query.from_search_id || '',
      search_scene: query.search_scene || '',
    }
  }

  // 安卓搜索参数（对齐 libresoda/src/soda/search.rs android_search_params）。
  androidSearchParams() {
    return {
      device_platform: 'android',
      os: 'android',
      ssmix: 'a',
      cdid: '46556f98-1720-4248-83da-62b74b60b46a',
      channel: 'xiaomi_8478_64',
      aid: '8478',
      app_name: 'luna',
      version_code: '100198030',
      version_name: '19.8.0',
      manifest_version_code: '100198030',
      update_version_code: '100198030',
      resolution: '1080*1920',
      dpi: '480',
      device_type: 'ABR-AL80',
      device_brand: 'HUAWEI',
      language: 'zh',
      os_api: '35',
      os_version: '15',
      ac: 'wifi',
      device_model: 'ABR-AL80',
      save_power: '0',
      font_size: '1.00',
      luna_first_launch_apk_type: 'normal_apk',
      diversion_channel_name: 'xiaomi_8478_64',
      is_car_play: '0',
      battery: '0.99',
      network_speed: '10156',
      hybrid_version_code: '100198030',
      tz_name: 'Asia/Shanghai',
      tz_offset: '28800',
      luna_register_time: '1784311292',
      diversion_category_level_two: 'Xiaomi商店-自然',
      package: 'com.luna.music',
      charge: '0',
      luna_apk_type: 'normal_apk',
      output_device_type: 'Phone',
      volume: '1.00',
      brightness: '0.08',
      need_personal_recommend: '1',
      is_teen_mode: '0',
      sim_region: 'cn',
      diversion_category_level_one: '厂商店-自然',
      android_device_type: 'default',
      iid: '2204957404569386',
      device_id: '2204957404565290',
      _rticket: String(Date.now()),
    }
  }

  // 安卓搜索（对齐 libresoda fetch_android_search）：官方 App 实际走安卓端点，
  // PC search 接口对参数校验极严（未登录/参数稍异即 ERR_INVALID_PARAM）。
  async androidSearch(searchType, keyword, cursor, count, cookie) {
    const params = this.androidSearchParams()
    params.aid = '386088'
    params.q = keyword
    params.cursor = String(cursor)
    params.count = String(count)
    const url = `https://api.qishui.com/luna/search/${searchType}?${new URLSearchParams(params).toString()}`
    const headers = {
      'User-Agent': 'com.luna.music/100198030 (Linux; U; Android 15; zh_CN_#Hans; ABR-AL80; Build/V417IR;tt-ok/3.12.13.19)',
      'Content-Type': 'application/json; charset=UTF-8',
    }
    if (cookie) headers.Cookie = cookie
    return requestJson(url, { headers, timeoutMs: this.timeoutMs })
  }

  async search(query = {}, context = {}) {
    const keyword = requireString(query.keywords || query.keyword || query.q, 'keywords')
    const response = await this.getPc('/luna/pc/search/track', this.pcSearchParams(query, keyword), withPersistedCookie(query, context))
    return response.body
  }

  async searchMixed(query = {}, context = {}) {
    const keyword = requireString(query.keywords || query.keyword || query.q, 'keywords')
    const cursor = optionalInt(query.cursor || query.offset, 0, 'cursor')
    const count = optionalPositiveInt(query.count || query.limit, 20, 'count')
    const cookie = sessionCookie(query, withPersistedCookie(query, context))
    let body
    let strategy
    try {
      body = (await this.androidSearch('track', keyword, cursor, count, cookie)).body || {}
      strategy = 'android_search_track'
    } catch (error) {
      // 安卓搜索失败回退 PC mixed（未登录时上游常拒绝或返回空列表）
      console.log('[search-mixed] android search failed, fallback to pc:', error instanceof Error ? error.message : String(error))
      const response = await this.getPc('/luna/pc/search/mixed', this.pcSearchParams(query, keyword), withPersistedCookie(query, context))
      body = response.body || {}
      strategy = 'pc_search_mixed'
    }
    if (strategy === 'pc_search_mixed') {
      return {
        ...normalizeSearchGroups(body),
        source_strategy: strategy,
        upstream: body,
      }
    }
    const tracks = []
    const seen = new Set()
    for (const group of (Array.isArray(body.result_groups) ? body.result_groups : [])) {
      for (const item of (Array.isArray(group.data) ? group.data : [])) {
        const track = item?.entity?.track
        if (track && track.id && !seen.has(String(track.id))) {
          seen.add(String(track.id))
          // 安卓搜索的专辑封面是结构化 url_cover（Image），App 端只认 album.cover_url，
          // 统一过 normalizeTrack 拼出可访问地址（对齐 feed/详情链路）
          tracks.push(normalizeTrack(track) || track)
        }
      }
    }
    return {
      tracks,
      playlists: [],
      videos: [],
      mixed: [],
      source_strategy: strategy,
      upstream: body,
    }
  }

  async searchPlaylists(query = {}, context = {}) {
    const keyword = requireString(query.keywords || query.keyword || query.q, 'keywords')
    try {
      const response = await this.getPc('/luna/pc/search/playlist', this.pcSearchParams(query, keyword), withPersistedCookie(query, context))
      const body = response.body || {}
      const { playlists } = normalizeSearchGroups(body)
      return {
        playlists,
        source_strategy: 'pc_search_playlist',
        upstream: body,
      }
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error
      const mixed = await this.searchMixed(query, context)
      return {
        playlists: mixed.playlists,
        source_strategy: 'pc_search_mixed_playlist_extract',
        upstream: mixed.upstream,
      }
    }
  }

  async trackDetail(query = {}, context = {}) {
    const trackId = extractTrackId(query.id || query.track_id || query.url)
    if (!trackId) throw new ValidationError('track_id 不能为空')
    const response = await this.getPc('/luna/pc/track_v2', {
      track_id: trackId,
      media_type: query.media_type || 'track',
      queue_type: query.queue_type || '',
    }, context)
    return response.body
  }

  async videoDetail(query = {}, context = {}) {
    const videoId = extractVideoId(query.video_id || query.id || query.url)
    if (!videoId) throw new ValidationError('video_id 不能为空')
    const cookie = sessionCookie(query, context)
    if (!cookie) throw new ValidationError('Cookie 或 sessionid 不能为空')
    const response = await this.postPc('/luna/pc/video_v2', {
      video_id: videoId,
      type: query.type || 'ugc_video',
      scene_name: query.scene_name || 'library',
      queue_type: query.queue_type || 'favorite_track_playlist',
    }, { cookie }, { aid: query.aid || PASSPORT_FIXED.aid })
    const body = redactAccountCredentials(response.body || {}, accountCredentialSecrets(query, context, cookie))
    return {
      video: normalizeVideo(body.video || body.ugc_video || body),
      upstream: body,
    }
  }

  shareResolve(query = {}) {
    const emptyIds = { track_id: '', video_id: '', playlist_id: '' }
    if (query.track_id !== undefined && query.track_id !== null && query.track_id !== '') {
      const input = requireString(query.track_id, 'track_id')
      return {
        input,
        ids: { ...emptyIds, track_id: extractTrackId(input) },
        resource_types: ['track'],
        primary_type: 'track',
      }
    }
    if (query.playlist_id !== undefined && query.playlist_id !== null && query.playlist_id !== '') {
      const input = requireString(query.playlist_id, 'playlist_id')
      return {
        input,
        ids: { ...emptyIds, playlist_id: extractPlaylistId(input) },
        resource_types: ['playlist'],
        primary_type: 'playlist',
      }
    }
    if (query.video_id !== undefined && query.video_id !== null && query.video_id !== '') {
      const input = requireString(query.video_id, 'video_id')
      return {
        input,
        ids: { ...emptyIds, video_id: extractVideoId(input) },
        resource_types: ['video'],
        primary_type: 'video',
      }
    }

    const input = requireString(query.url || query.id, 'url 或 id')
    const ids = extractResourceIds(input)
    const resourceTypes = []
    if (ids.track_id) resourceTypes.push('track')
    if (ids.playlist_id) resourceTypes.push('playlist')
    if (ids.video_id) resourceTypes.push('video')
    return {
      input,
      ids,
      resource_types: resourceTypes,
      primary_type: resourceTypes.length > 1 ? 'ambiguous' : resourceTypes[0] || '',
    }
  }

  async mediaPlayer(query = {}, context = {}) {
    const payload = query.body && typeof query.body === 'object'
      ? query.body
      : {
          media_id: extractTrackId(query.media_id || query.track_id || query.id || query.url),
          media_type: query.media_type || 'track',
          queue_type: query.queue_type || '',
          enable_refresh_api: optionalBoolean(query.enable_refresh_api, false),
          enable_dash: optionalBoolean(query.enable_dash, true),
          ...(query.scene_name ? { scene_name: String(query.scene_name) } : {}),
          ...(query.limited_free_param && typeof query.limited_free_param === 'object' ? { limited_free_param: query.limited_free_param } : {}),
        }
    if (!payload.media_id) throw new ValidationError('media_id 或 track_id 不能为空')
    const response = await this.postLuna('/luna/media-player', payload, context)
    return {
      request: redactPlaybackTree(payload),
      ...formatMediaPlayerResponse(response.body),
    }
  }

  async h5SeoTrack(query = {}, context = {}) {
    const trackId = extractTrackId(query.id || query.track_id || query.url)
    if (!trackId) throw new ValidationError('track_id 不能为空')
    const response = await this.getLuna('/luna/h5/seo_track', {
      track_id: trackId,
      device_platform: query.device_platform || 'web',
    }, context)
    return response.body
  }

  async songDetail(query = {}, context = {}) {
    const input = requireString(query.url || query.id || query.track_id, 'url 或 track_id')
    const trackId = extractTrackId(input)
    if (trackId) {
      const h5 = await this.h5SeoTrack({ track_id: trackId }, context)
      return this.formatH5SeoTrack(h5, trackId)
    }

    const html = await fetchAllowedText(input, { headers: this.webHeaders(context.cookie), timeoutMs: this.timeoutMs })
    const routerData = extractRouterData(html)
    return formatSongFromAudioOption(findAudioOption(routerData), routerData)
  }

  formatH5SeoTrack(data, trackId) {
    const track = data?.seo_track?.track || {}
    const lyricContent = data?.lyric?.content || ''
    let videoModel = null
    if (data?.track_player?.video_model) {
      try {
        videoModel = JSON.parse(data.track_player.video_model)
      } catch (_) {
        videoModel = null
      }
    }
    const playInfo = videoModel?.video_list?.[0] || null
    return {
      track_id: String(trackId || track.id || ''),
      name: track.name || '',
      artists: Array.isArray(track.artists) ? track.artists.map((artist) => ({ id: String(artist.id || artist.user_info?.id || ''), name: artist.name || artist.user_info?.nickname || '' })) : [],
      album: track.album ? { id: String(track.album.id || ''), name: track.album.name || '' } : null,
      audio_url: playInfo?.main_url || playInfo?.backup_url || '',
      lyric: lyricContent,
      raw: data,
    }
  }

  // 私人 FM 官方推荐队列（POST /luna/pc/feed/song-tab）：三模式（默认/熟悉/新鲜）+ 翻页。
  // 请求组装对齐 libresoda feed.rs fetch_feed_song_tab + sodam library.rs recommended_page：
  // PC 公共参数 + X-SS-STUB + 逐请求 mssdk 签名 + 登录 Cookie；feed_preference 选模式
  // （熟悉=familiar、新鲜=fresh，默认模式不带该字段）。回包 items[].type=track 的
  // entity.track_wrapper.track 与 track_v2 同构，直接走 normalizeTrack。
  async pcFeedSongTab(query = {}, context = {}) {
    const cookie = sessionCookie(query, withPersistedCookie(query, context))
    if (!cookie) throw new ValidationError('私人 FM 推荐流需要登录 Cookie')

    const mode = String(query.mode || 'default').toLowerCase()
    const feedPreference = mode === 'familiar' || mode === 'fresh' ? { preference_mode: mode } : undefined
    const body = {
      played_media: Array.isArray(query.played_media) ? query.played_media : [],
      did_first_use_time: Number(query.did_first_use_time) || Math.floor(Date.now() / 1000),
      is_first_request: optionalBoolean(query.first_request, false),
      is_did_first_request: optionalBoolean(query.first_request, false),
      feed_counts: { mix_session_count: boundedPositiveInt(query.session_count, 1, 'session_count') },
      ...(feedPreference ? { feed_preference: feedPreference } : {}),
    }
    const bodyJson = JSON.stringify(body)
    const url = `${this.pcApiHost}/luna/pc/feed/song-tab?${new URLSearchParams(this.pcAppParams()).toString()}`
    const headers = {
      'User-Agent': 'LunaPC/3.3.0(359450208)',
      'x-luna-background-type': 'foreground',
      'x-luna-is-background-req': '0',
      'x-luna-is-local-user': '1',
      'Content-Type': 'application/json; charset=utf-8',
      'X-SS-STUB': signerBridge.md5HexUpper(bodyJson),
      Cookie: cookie,
    }

    const signed = await mssdkSigner.signRequest({ url, method: 'POST', body: bodyJson, headers })
    if (!signed) {
      throw new UpstreamError('mssdk 签名服务不可用，无法取私人 FM 推荐流', { signer_url: mssdkSigner.MSSDK_SIGNER_URL })
    }
    Object.assign(headers, {
      'x-helios': signed['x-helios'],
      'x-medusa': signed['x-medusa'],
    })

    const response = await requestJson(url, {
      method: 'POST',
      body: bodyJson,
      headers,
      timeoutMs: this.timeoutMs,
    })
    const data = response.body
    if (!data || typeof data !== 'object') {
      throw new UpstreamError('feed/song-tab 返回空 body（签名或登录态被上游拒绝）', { status: response.status })
    }
    if (Number(data.status_code || 0) !== 0) {
      throw new UpstreamError(data?.status_info?.status_msg || `feed/song-tab status_code=${data.status_code}`, {
        status_code: data.status_code,
      })
    }

    const items = Array.isArray(data.items) ? data.items : []
    const tracks = items
      .filter((item) => item && item.type === 'track')
      .map((item) => normalizeTrack(item?.entity?.track_wrapper?.track))
      .filter((track) => track && track.id)
    return { tracks, has_more: Boolean(data.has_more), upstream: data }
  }

  // PC 整曲端点核心请求（POST /luna/pc/track_v2）：带 SVIP 登录态 + 逐请求 mssdk 应用签名
  // 时返回完整曲目（多档音质）；无签名/无登录态时上游回 HTTP 200 + 空 body。
  // 请求组装对齐 libresoda/src/soda/track.rs fetch_pc_track_v2 + mod.rs pc_app_params。
  async pcTrackCandidates(query = {}, context = {}) {
    const trackId = extractTrackId(query.id || query.track_id || query.url)
    if (!trackId) throw new ValidationError('track_id 不能为空')
    const cookie = sessionCookie(query, context)
    if (!cookie) throw new ValidationError('整曲取流需要登录 Cookie')

    const bodyJson = JSON.stringify({
      track_id: trackId,
      media_type: 'track',
      queue_type: 'favorite_track_playlist',
      scene_name: 'library',
    })
    const url = `${this.pcApiHost}/luna/pc/track_v2?${new URLSearchParams(this.pcAppParams()).toString()}`
    const headers = {
      'User-Agent': 'LunaPC/3.3.0(359450208)',
      'x-luna-background-type': 'foreground',
      'x-luna-is-background-req': '0',
      'x-luna-is-local-user': '1',
      'Content-Type': 'application/json; charset=utf-8',
      'X-SS-STUB': signerBridge.md5HexUpper(bodyJson),
      Cookie: cookie,
    }

    const signed = await mssdkSigner.signRequest({ url, method: 'POST', body: bodyJson, headers })
    if (!signed) {
      throw new UpstreamError('mssdk 签名服务不可用，无法走整曲端点', { signer_url: mssdkSigner.MSSDK_SIGNER_URL })
    }
    Object.assign(headers, {
      'x-helios': signed['x-helios'],
      'x-medusa': signed['x-medusa'],
    })

    const response = await requestJson(url, {
      method: 'POST',
      body: bodyJson,
      headers,
      timeoutMs: this.timeoutMs,
    })
    const body = response.body
    if (!body || typeof body !== 'object') {
      throw new UpstreamError('pc/track_v2 返回空 body（签名或登录态被上游拒绝）', { status: response.status })
    }
    if (Number(body.status_code || 0) !== 0) {
      throw new UpstreamError(body?.status_info?.status_msg || `pc/track_v2 status_code=${body.status_code}`, {
        status_code: body.status_code,
      })
    }

    const track = body.track || body.track_info || {}
    const trackPlayer = body.track_player || {}
    const entries = collectStreamEntries(unwrapVideoModel(trackPlayer.video_model))
    if (!entries.length) {
      throw new UpstreamError('pc/track_v2 未解析到播放地址', { status_code: body.status_code })
    }
    return {
      track_id: String(trackId),
      name: track.name || '',
      artists: Array.isArray(track.artists)
        ? track.artists.map((artist) => ({ id: String(artist.id || artist.user_info?.id || ''), name: artist.name || artist.user_info?.nickname || '' }))
        : [],
      album: track.album ? { id: String(track.album.id || ''), name: track.album.name || '' } : null,
      duration: Number(track.duration || 0) || 0,
      lyric: body.lyric?.content || '',
      entries,
    }
  }

  // 直连形态：返回上游 CDN 原始地址（整曲流均为 cenc 加密，仅供下载/调试用）。
  async pcTrackAudioInfo(query = {}, context = {}) {
    const info = await this.pcTrackCandidates(query, context)
    const entry = pickBestEntry(info.entries, query.quality || '')
    if (!entry || (!entry.main_url && !entry.backup_url)) {
      throw new UpstreamError('pc/track_v2 未解析到播放地址')
    }
    return {
      track_id: info.track_id,
      name: info.name,
      artists: info.artists,
      album: info.album,
      audio_url: entry.main_url || entry.backup_url,
      quality: entry.quality,
      format: entry.format,
      bitrate: entry.bitrate,
      size: entry.size,
      duration: info.duration || entry.duration || 0,
      lyric: info.lyric,
      source: 'pc_track_v2',
    }
  }

  // 代理形态（默认）：audio_url 指向本服务 /audio/stream 短时票据。
  // 整曲流全部是 cenc-aes-ctr 加密，客户端无法直接播放 CDN 地址，由服务端解密后明文出流；
  // 播放 URL 不携带任何登录凭据（票据 15 分钟有效）。
  async pcProxyAudioInfo(query = {}, context = {}) {
    const info = await this.pcTrackCandidates(query, context)
    const entry = pickBestEntry(info.entries, query.quality || '')
    if (!entry || (!entry.main_url && !entry.backup_url)) {
      throw new UpstreamError('pc/track_v2 未解析到播放地址')
    }
    const ticket = streamTicket.createTicket({
      track_id: info.track_id,
      name: info.name,
      quality: entry.quality,
      format: entry.format,
      bitrate: entry.bitrate,
      size: entry.size,
      duration: info.duration || entry.duration || 0,
      main_url: entry.main_url,
      backup_url: entry.backup_url,
      spade_a: entry.spade_a,
      encryption_method: entry.encryption_method,
    })
    const req = context.req
    const host = (req && req.headers && req.headers.host) || `127.0.0.1:${config.port}`
    const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || 'http').split(',')[0].trim() || 'http'
    return {
      track_id: info.track_id,
      name: info.name,
      artists: info.artists,
      album: info.album,
      audio_url: `${proto}://${host}/audio/stream?t=${ticket}`,
      quality: entry.quality,
      format: entry.format,
      bitrate: entry.bitrate,
      size: entry.size,
      duration: info.duration || entry.duration || 0,
      lyric: info.lyric,
      source: 'pc_track_v2_proxy',
    }
  }

  async audioInfo(query = {}, context = {}) {
    // 已登录且 mssdk 签名服务可用时优先整曲端点：默认走解密代理流（proxy_stream=false 返回加密原始地址）；
    // 任何失败回退 Web 链路（30 秒试听）。
    // App 未随请求携带登录态时（旧版 App /audio/info 不注入 cookie），兜底用最近一次扫码登录落盘的 cookie。
    let effectiveContext = withPersistedCookie(query, context)
    if (effectiveContext.cookie || query.sessionid || query.session_id || query.cookie) {
      try {
        if (optionalBoolean(query.proxy_stream, true)) {
          return await this.pcProxyAudioInfo(query, effectiveContext)
        }
        return await this.pcTrackAudioInfo(query, effectiveContext)
      } catch (error) {
        if (query.allow_fallback === false) throw error
        console.log('[audio-info] pc_track_v2 fallback:', error instanceof Error ? error.message : String(error))
      }
    }
    const song = await this.songDetail(query, context)
    return formatAudioInfo(song, optionalBoolean(query.include_raw, false))
  }

  async downloadUrl(query = {}, context = {}) {
    const hasSessionId = query.sessionid !== undefined && query.sessionid !== null
      || query.session_id !== undefined && query.session_id !== null
    const playbackContext = hasSessionId
      ? { ...context, cookie: sessionCookie(query, context) }
      : context
    const audioInfo = await this.audioInfo(query, playbackContext)
    if (!audioInfo.audio_url) throw new ValidationError('未解析到音频下载地址')
    // 本服务 /audio/stream 代理票据 URL 不是 CDN 直链（http + 本机 host），直接透传
    if (/\/audio\/stream\?t=/.test(audioInfo.audio_url)) {
      return { ...audioInfo }
    }
    const url = assertAllowedDownloadUrl(audioInfo.audio_url)
    return {
      ...audioInfo,
      audio_url: url.toString(),
    }
  }

  async decryptSpade(query = {}) {
    const hexKey = resolveAudioKey({
      spade_a: query.spade_a || query.spadeA,
      hex_key: query.hex_key || query.key,
    })
    return {
      hex_key: hexKey,
      key_byte_length: hexKey.length / 2,
      decrypted_from_spade_a: Boolean(query.spade_a || query.spadeA),
    }
  }

  async downloadFile(query = {}, context = {}) {
    let audioUrl = query.audio_url || query.download_url || ''
    if (!audioUrl && shouldResolveTrackUrl(query)) {
      const resolved = await this.downloadUrl({
        ...query,
        url: query.share_url || query.url,
      }, context)
      audioUrl = resolved.audio_url
    }
    if (!audioUrl && query.url) audioUrl = query.url
    const downloaded = await downloadBinary(requireString(audioUrl, 'url'), {
      headers: this.downloadHeaders(),
      timeoutMs: this.timeoutMs,
      maxBytes: query.max_bytes,
    })
    return {
      url: downloaded.url,
      filename: downloaded.filename,
      content_type: downloaded.content_type,
      size: downloaded.content_length,
      audio_base64: downloaded.buffer.toString('base64'),
    }
  }

  async audioDecrypt(query = {}, context = {}) {
    if (!config.enableDecrypt) throw new ValidationError('本地解密接口未启用')
    const hexKey = resolveAudioKey({
      spade_a: query.spade_a || query.spadeA,
      hex_key: query.hex_key || query.key,
    })

    let encryptedBuffer = null
    let sourceUrl = ''
    let filename = query.filename || 'audio.enc'
    if (query.audio_base64 || query.file_base64) {
      encryptedBuffer = base64ToBuffer(query.audio_base64 || query.file_base64, 'audio_base64', boundedDownloadBytes(query.max_bytes))
    } else {
      let audioUrl = query.audio_url || query.download_url || ''
      if (!audioUrl && shouldResolveTrackUrl(query)) {
        const resolved = await this.downloadUrl({
          ...query,
          url: query.share_url || query.url,
        }, context)
        audioUrl = resolved.audio_url
      }
      if (!audioUrl && query.url) audioUrl = query.url
      const downloaded = await downloadBinary(requireString(audioUrl, 'url'), {
        headers: this.downloadHeaders(),
        timeoutMs: this.timeoutMs,
        maxBytes: query.max_bytes,
      })
      encryptedBuffer = downloaded.buffer
      sourceUrl = downloaded.url
      filename = downloaded.filename
    }

    const decrypted = decryptAudioBuffer(encryptedBuffer, hexKey)
    const returnBase64 = optionalBoolean(query.return_base64, true)
    return {
      source_url: sourceUrl,
      filename: filename.replace(/\.(mp4|m4a|encv|enca|bin)$/i, '') + decrypted.extension,
      content_type: decrypted.content_type,
      codec: decrypted.codec,
      sample_count: decrypted.sample_count,
      size: decrypted.buffer.length,
      audio_base64: returnBase64 ? decrypted.buffer.toString('base64') : '',
    }
  }

  async lyric(query = {}, context = {}) {
    const song = await this.songDetail(query, context)
    if (song.lyrics) return song.lyrics
    const content = song.lyric || song.raw?.lyric?.content || ''
    return {
      lrc: content,
      lines: [],
      raw: song.raw || {},
    }
  }
}

module.exports = {
  QishuiClient,
}
