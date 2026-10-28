import path from 'path';
import { fileURLToPath } from 'url';
import { type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'crypto';
import fs from 'fs';

// vite.config.ts — Solis TV 精简壳构建配置。
// 只保留 react 转译与 @ 别名：TV 壳不引 tailwind/PWA/dev 插件/多入口，
// 目标是给 A73 四核输出最小的 JS/CSS 资产。

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 构建号由 android/build-number.txt 驱动 gradle 侧 versionName；这里注入前端展示用。
const buildNumber = fs.readFileSync(path.resolve(__dirname, 'android/build-number.txt'), 'utf-8').trim();
const appVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')).version;
// 存在性哨兵：PWA cover worker 等遗留文件不再被引用，但保留 hash 校验结构以备后用。
const skeletonTag = createHash('sha256').update(buildNumber + appVersion).digest('hex').slice(0, 12);

export default function viteConfig(): UserConfig {
  return {
    base: '/',
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { main: 'index.html' },
      },
      // TV WebView 116 基线：Chrome 116 支持的语法，不做更低目标。
      target: 'chrome116',
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __TV_BUILD_NUMBER__: JSON.stringify(buildNumber),
      __TV_SKELETON_TAG__: JSON.stringify(skeletonTag),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
  };
}
