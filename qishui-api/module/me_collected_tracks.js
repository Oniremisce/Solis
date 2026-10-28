// 已收藏单曲（「我喜欢」）分页列表：POST /me/collected/tracks { cursor?, count? }
async function meCollectedTracks(query, { client, cookie }) {
  return client.collectedTracks(query, { cookie })
}

meCollectedTracks.methods = ['post']
meCollectedTracks.bodyOnly = true

module.exports = meCollectedTracks
