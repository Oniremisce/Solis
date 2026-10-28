// 探测 bdms.node 导出面与签名调用行为（一次性诊断脚本）
const path = 'D:\\Program Files\\Soda Music\\3.7.0\\resources\\app.asar.unpacked\\bdms.node'
let bdms
try {
  bdms = require(path)
} catch (error) {
  console.log('LOAD_FAIL:', error.message)
  process.exit(1)
}
console.log('exports type:', typeof bdms)
console.log('exports keys:', Object.keys(bdms))
for (const [name, value] of Object.entries(bdms)) {
  console.log(`  ${name}: ${typeof value}${typeof value === 'function' ? `(${value.length} args)` : ''}`)
}

const deviceId = '4280016293570216'
try {
  const initResult = bdms.init({ deviceId })
  console.log('init() returned:', typeof initResult, initResult === undefined ? 'undefined' : String(initResult).slice(0, 200))
} catch (error) {
  console.log('init() threw:', error.message)
}

const url = 'https://api.qishui.com/luna/pc/track_v2?aid=386088&device_id=4280016293570216'
const headerLines = [
  'user-agent\r\nLunaPC/3.3.0(359450208)',
  'content-type\r\napplication/json; charset=utf-8',
  'x-ss-stub\r\n' + require('crypto').createHash('md5').update('{"track_id":"1"}').digest('hex').toUpperCase(),
].join('\r\n')

for (const attempt of ['call-1', 'call-2 (after 500ms)']) {
  let raw = ''
  try {
    raw = bdms.generateHttpSignatureHeaders(url, headerLines)
  } catch (error) {
    console.log(`${attempt} threw:`, error.message)
    continue
  }
  console.log(`${attempt} type=${typeof raw} len=${String(raw).length}`)
  console.log(`${attempt} raw:`, String(raw).slice(0, 300))
  if (attempt.startsWith('call-1')) {
    const syncWait = Date.now() + 500
    while (Date.now() < syncWait) { /* 占位：无法真正异步等待 */ }
    break
  }
}

setTimeout(() => {
  try {
    const raw = bdms.generateHttpSignatureHeaders(url, headerLines)
    console.log('call-2 (setTimeout 1s) type=' + typeof raw + ' len=' + String(raw || '').length)
    console.log('call-2 raw:', String(raw || '').slice(0, 300))
  } catch (error) {
    console.log('call-2 threw:', error.message)
  }
  if (typeof bdms.report === 'function') {
    try {
      const rep = bdms.report()
      console.log('report() returned:', String(rep).slice(0, 200))
    } catch (error) {
      console.log('report() threw:', error.message)
    }
  }
}, 1000)
