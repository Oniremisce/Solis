const crypto = require('crypto')

// 整曲代理播放票据：把「track + 档位 + 登录 cookie」换成一个短时随机票据，
// 播放 URL（/audio/stream?t=<ticket>）不携带任何凭据，避免登录态泄进 URL/日志。
// 票据对应的解密明文流在内存里做 LRU 缓存：切歌/seek 时不重复下载与解密。

const TICKET_TTL_MS = 15 * 60 * 1000
const CACHE_TTL_MS = 15 * 60 * 1000
const CACHE_MAX_BYTES = 256 * 1024 * 1024

const tickets = new Map()
const buffers = new Map() // ticket -> { buffer, content_type, extension, expireAt, lastUsedAt }
let cacheBytes = 0

function cleanup(now = Date.now()) {
  for (const [ticket, item] of tickets) {
    if (item.expireAt <= now) tickets.delete(ticket)
  }
  for (const [ticket, item] of buffers) {
    if (item.expireAt <= now) {
      cacheBytes -= item.buffer.length
      buffers.delete(ticket)
    }
  }
}

function createTicket(payload) {
  cleanup()
  const ticket = crypto.randomBytes(16).toString('hex')
  tickets.set(ticket, { ...payload, createdAt: Date.now(), expireAt: Date.now() + TICKET_TTL_MS })
  // 只保留最近 64 张票据
  while (tickets.size > 64) {
    const oldest = tickets.keys().next().value
    if (oldest === undefined) break
    const dropped = tickets.get(oldest)
    tickets.delete(oldest)
    dropBuffer(oldest, dropped)
  }
  return ticket
}

function dropBuffer(ticket, ticketItem) {
  const cached = buffers.get(ticket)
  if (cached) {
    cacheBytes -= cached.buffer.length
    buffers.delete(ticket)
    return
  }
  // 票据还没解过密，不占缓存
  if (ticketItem?.buffer?.length) {
    cacheBytes -= ticketItem.buffer.length
  }
}

function getTicket(ticket) {
  cleanup()
  const item = tickets.get(String(ticket || ''))
  if (!item) return null
  item.expireAt = Date.now() + TICKET_TTL_MS
  return item
}

function getCachedBuffer(ticket) {
  const cached = buffers.get(String(ticket || ''))
  if (!cached) return null
  if (cached.expireAt <= Date.now()) {
    cacheBytes -= cached.buffer.length
    buffers.delete(ticket)
    return null
  }
  cached.lastUsedAt = Date.now()
  cached.expireAt = Date.now() + CACHE_TTL_MS
  return cached
}

function putBuffer(ticket, buffer, contentType, extension) {
  if (buffers.has(ticket)) cacheBytes -= buffers.get(ticket).buffer.length
  buffers.set(ticket, { buffer, content_type: contentType, extension, expireAt: Date.now() + CACHE_TTL_MS, lastUsedAt: Date.now() })
  cacheBytes += buffer.length
  // 超限时按最久未用淘汰
  while (cacheBytes > CACHE_MAX_BYTES && buffers.size > 1) {
    let oldestKey = ''
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, item] of buffers) {
      if (item.lastUsedAt < oldestAt) {
        oldestAt = item.lastUsedAt
        oldestKey = key
      }
    }
    if (!oldestKey) break
    cacheBytes -= buffers.get(oldestKey).buffer.length
    buffers.delete(oldestKey)
  }
}

function stats() {
  cleanup()
  return { tickets: tickets.size, cached_streams: buffers.size, cache_bytes: cacheBytes }
}

module.exports = {
  createTicket,
  getTicket,
  getCachedBuffer,
  putBuffer,
  stats,
}
