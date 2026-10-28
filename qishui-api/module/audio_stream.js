// 整曲解密代理流：GET /audio/stream?t=<ticket>
// 票据由 /audio/info 签发（内含 CDN 加密流地址与 spade_a），本端点负责：
//   1. 命中明文缓存直接出流；2. 未命中则全量拉取 → cenc 解密 → 入缓存；
//   3. 支持 Range 请求（seek），206 返回切片。
const { getTicket, getCachedBuffer, putBuffer } = require('../src/streamTicket')
const { resolveAudioKey, decryptAudioBuffer } = require('../src/audioDecryptor')
const { UpstreamError, ValidationError } = require('../src/errors')

module.exports.methods = ['get']

module.exports = async function audioStream(query = {}, { req, res }) {
  const ticket = String(query.t || query.ticket || '').trim()
  console.log(`[audio-stream] req ticket=${ticket.slice(0, 8)}… host=${req.headers.host} remote=${req.socket?.remoteAddress} range=${String(req.headers.range || '').slice(0, 32)}`)
  const item = getTicket(ticket)
  if (!item) {
    res.status(404).json({ code: 40400, message: '播放票据无效或已过期，请重新获取播放地址', data: null })
    return
  }

  let buffer
  let contentType
  const cached = getCachedBuffer(ticket)
  if (cached) {
    buffer = cached.buffer
    contentType = cached.content_type
  } else {
    const url = item.main_url || item.backup_url
    if (!url) throw new ValidationError('票据缺少播放地址')
    let response
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': 'LunaPC/3.3.0(359450208)' },
        signal: AbortSignal.timeout(120000),
        redirect: 'follow',
      })
    } catch (error) {
      throw new UpstreamError('拉取加密音频流失败', { reason: error instanceof Error ? error.message : String(error) })
    }
    if (!response.ok) throw new UpstreamError('加密音频流上游响应异常', { status: response.status })
    const input = Buffer.from(await response.arrayBuffer())
    const hexKey = resolveAudioKey({ spade_a: item.spade_a })
    const decrypted = decryptAudioBuffer(input, hexKey)
    buffer = decrypted.buffer
    contentType = decrypted.content_type
    putBuffer(ticket, buffer, contentType, decrypted.extension)
    console.log(`[audio-stream] decrypted ticket=${ticket.slice(0, 8)}… bytes=${buffer.length} type=${contentType}`)
  }

  const total = buffer.length
  res.set({
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=600',
  })

  const rangeMatch = /^bytes=(\d*)-(\d*)$/i.exec(String(req.headers.range || '').trim())
  if (rangeMatch) {
    let start = rangeMatch[1] === '' ? NaN : Number.parseInt(rangeMatch[1], 10)
    let end = rangeMatch[2] === '' ? NaN : Number.parseInt(rangeMatch[2], 10)
    if (Number.isNaN(start)) {
      // suffix 形式 bytes=-N：取末尾 N 字节
      const suffix = Number.isNaN(end) ? 0 : end
      start = Math.max(0, total - suffix)
      end = total - 1
    } else if (Number.isNaN(end) || end >= total) {
      end = total - 1
    }
    if (start >= total || start > end) {
      res.status(416).set('Content-Range', `bytes */${total}`).end()
      return
    }
    const chunk = buffer.subarray(start, end + 1)
    res.status(206).set({
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(chunk.length),
    }).end(chunk)
    return
  }

  res.status(200).set('Content-Length', String(total)).end(buffer)
}
