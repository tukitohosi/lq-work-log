import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from './app.mjs';

function openDefaultBrowser(url) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/d', '/s', '/c', `start "" "${url}"`];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

export async function run(argv = process.argv.slice(2)) {
  const shouldOpen = argv.includes('--open');
  const result = await startServer({ port: 8765, endPort: 8775, reuseExisting: true });
  if (result.reused) {
    console.log(`[记工本] 已检测到正在运行的本机服务：${result.url}`);
    if (shouldOpen) openDefaultBrowser(result.url);
    return result;
  }

  console.log(`[记工本] 本机服务已启动：${result.url}`);
  console.log('[记工本] 数据仅保存在本机 data 文件夹；关闭此窗口将停止服务。');
  if (shouldOpen) openDefaultBrowser(result.url);

  const shutdown = () => {
    console.log('\n[记工本] 正在安全关闭……');
    result.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return result;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`));
if (isMain) {
  run().catch((error) => {
    if (error?.code === 'EADDRINUSE') {
      console.error('[记工本] 8765 至 8775 端口均被占用，请关闭占用程序后重试。');
    } else {
      console.error('[记工本] 启动失败：', error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  });
}
