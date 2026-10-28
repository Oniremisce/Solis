async function authMe(query, { client, cookie }) {
  return client.authMe(query, { cookie })
}

// GET（query 带 cookie 参数）与 POST（body 带 cookie）都收：App 端 transport 对登录态
// 路由按 query 注入 cookie，浏览器插件/脚本多用 POST body。
authMe.methods = ['get', 'post']

module.exports = authMe
