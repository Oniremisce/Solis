// req 必须透传：pcProxyAudioInfo 用请求 Host 拼回 /audio/stream 绝对地址，
// 丢失时回退 127.0.0.1，局域网设备（TV）将拿到不可达的播放地址。
module.exports = async (query, { client, cookie, req }) => client.audioInfo(query, { cookie, req })
