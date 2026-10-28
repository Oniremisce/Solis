// mssdk 应用签名服务 HTTP 客户端。
//
// 汽水整曲端点（POST /luna/pc/track_v2）要求逐请求的 x-helios / x-medusa 应用签名，
// 该签名只能由官方客户端自带的 bdms.node（Windows 原生组件）生成。签名由独立的
// signer-service（libresoda/tools/qishui-signer-host，默认 127.0.0.1:8899）提供：
//
//   POST /sign { url, method, body, headers, ts_ms }
//   ← { ok: true, headers: { "X-Helios": "...", "X-Medusa": "..." } }
//
// 签名覆盖「URL + 全部请求头 + body」，因此 headers 必须与实际发送的一致
// （尤其 cookie 和 x-ss-stub = body 的 MD5 大写）。
//
// 环境变量：
//   QISHUI_MSSDK_SIGNER_URL  签名服务地址（默认 http://127.0.0.1:8899）

const MSSDK_SIGNER_URL = (process.env.QISHUI_MSSDK_SIGNER_URL || 'http://127.0.0.1:8899').replace(/\/$/, '')

let lastUnavailableLogMs = 0

function normalizeSignedHeaders(signed) {
  const out = {}
  for (const [name, value] of Object.entries(signed || {})) {
    if (!name || !value) continue
    const normalized = name.toLowerCase()
    if (normalized === 'x-helios' || normalized === 'x-medusa') out[normalized] = String(value)
  }
  return out
}

/**
 * 请求一次应用签名。签名服务不可用或返回失败时返回 null（调用方回退到
 * Web 链路的 30 秒试听），而不是把播放整体打断。
 */
async function signRequest({ url, method, body, headers }) {
  let response
  try {
    response = await fetch(`${MSSDK_SIGNER_URL}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        method: method || 'POST',
        body: body || '',
        ts_ms: Date.now(),
        headers: headers || {},
      }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (error) {
    const now = Date.now()
    if (now - lastUnavailableLogMs > 60000) {
      lastUnavailableLogMs = now
      console.log('[mssdk-signer] unavailable:', error instanceof Error ? error.message : String(error))
    }
    return null
  }
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!response.ok || !payload || payload.ok === false) {
    const now = Date.now()
    if (now - lastUnavailableLogMs > 60000) {
      lastUnavailableLogMs = now
      console.log('[mssdk-signer] sign failed:', payload?.error || `HTTP ${response.status}`)
    }
    return null
  }
  const signed = normalizeSignedHeaders(payload.headers || payload)
  if (!signed['x-helios'] || !signed['x-medusa']) return null
  return signed
}

module.exports = {
  MSSDK_SIGNER_URL,
  signRequest,
}
