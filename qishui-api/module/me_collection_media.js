// 收藏单曲（加入官方歌单「我喜欢的音乐」）：POST /me/collection/media { track_id }
async function meCollectionMedia(query, { client, cookie }) {
  return client.collectMedia(query, { cookie })
}

meCollectionMedia.methods = ['post']
meCollectionMedia.bodyOnly = true

module.exports = meCollectionMedia
