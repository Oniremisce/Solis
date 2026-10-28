// 取消收藏单曲：POST /me/collection/media/delete { track_id }
async function meCollectionMediaDelete(query, { client, cookie }) {
  return client.uncollectMedia(query, { cookie })
}

meCollectionMediaDelete.methods = ['post']
meCollectionMediaDelete.bodyOnly = true

module.exports = meCollectionMediaDelete
