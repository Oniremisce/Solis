const { QishuiClient } = require('./src/qishuiClient')
const client = new QishuiClient()
const cookie = require('fs').readFileSync('.data/last-login-cookie.txt', 'utf8').trim()
;(async () => {
  const bodyJson = JSON.stringify({ track_id: '7501674235158431760', media_type: 'track', queue_type: 'favorite_track_playlist', scene_name: 'library' })
  const { requestJson } = require('./src/http')
  const mssdkSigner = require('./src/mssdkSigner')
  const url = `${client.pcApiHost}/luna/pc/track_v2?${new URLSearchParams(client.pcAppParams()).toString()}`
  const headers = { 'User-Agent': 'LunaPC/3.3.0(359450208)', 'x-luna-background-type': 'foreground', 'x-luna-is-background-req': '0', 'x-luna-is-local-user': '1', 'Content-Type': 'application/json; charset=utf-8', 'X-SS-STUB': require('./src/signerBridge').md5HexUpper(bodyJson), Cookie: cookie }
  const signed = await mssdkSigner.signRequest({ url, method: 'POST', body: bodyJson, headers })
  Object.assign(headers, { 'x-helios': signed['x-helios'], 'x-medusa': signed['x-medusa'] })
  const response = await requestJson(url, { method: 'POST', body: bodyJson, headers, timeoutMs: 15000 })
  let vm = response.body?.track_player?.video_model
  for (let i = 0; i < 3 && typeof vm === 'string'; i += 1) vm = JSON.parse(vm)
  for (const [i, item] of (vm?.video_list || []).entries()) {
    const m = item.video_meta || {}
    console.log(`[${i}] quality=${m.quality} vtype=${m.vtype} bitrate=${m.bitrate} size=${m.size} codec=${m.codec_type} encrypt=${item.encrypt_info?.encrypt} method=${item.encrypt_info?.encryption_method}`)
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
