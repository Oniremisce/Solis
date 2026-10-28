// req 必须透传：代理形态 audio_url 依赖请求 Host（见 audio_info.js）。
module.exports = async (query, { client, cookie, req }) => client.downloadUrl(query, { cookie, req })
