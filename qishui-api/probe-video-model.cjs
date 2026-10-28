// 一次性诊断：打印 track_v2 video_model 的真实档位结构
const { QishuiClient } = require('./src/qishuiClient')
const fs = require('fs')
const path = require('path')

const client = new QishuiClient()
const cookie = fs.readFileSync(path.join(__dirname, '.data', 'last-login-cookie.txt'), 'utf8').trim()

;(async () => {
  const bodyJson = JSON.stringify({
    track_id: '7501674235158431760',
    media_type: 'track',
    queue_type: 'favorite_track_playlist',
    scene_name: 'library',
  })
  const { requestJson } = require('./src/http')
  const config = require('./src/config')
  const mssdkSigner = require('./src/mssdkSigner')
  const url = `${client.pcApiHost}/luna/pc/track_v2?${new URLSearchParams(client.pcAppParams()).toString()}`
  const headers = {
    'User-Agent': 'LunaPC/3.3.0(359450208)',
    'x-luna-background-type': 'foreground',
    'x-luna-is-background-req': '0',
    'x-luna-is-local-user': '1',
    'Content-Type': 'application/json; charset=utf-8',
    'X-SS-STUB': require('./src/signerBridge').md5HexUpper(bodyJson),
    Cookie: cookie,
  }
  const signed = await mssdkSigner.signRequest({ url, method: 'POST', body: bodyJson, headers })
  Object.assign(headers, { 'x-helios': signed['x-helios'], 'x-medusa': signed['x-medusa'] })
  const response = await requestJson(url, { method: 'POST', body: bodyJson, headers, timeoutMs: 15000 })
  const vm = response.body?.track_player?.video_model
  let value = vm
  for (let i = 0; i < 3; i += 1) {
    if (typeof value !== 'string') break
    value = JSON.parse(value)
  }
  console.log('video_model top keys:', Object.keys(value || {}))
  console.log(JSON.stringify(value, null, 1).slice(0, 3000))
})().catch((error) => {
  console.error('FAIL:', error.message)
  process.exit(1)
})
