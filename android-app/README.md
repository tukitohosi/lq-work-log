# L.Q记工本 Android 2.2.2

Android 版的包名为 `com.lq.jigongben`，`versionCode` 为 `2020103`，`versionName` 为 `2.2.2`。最低支持 Android 7.0（API 24），目标版本为 API 36。它沿用 2.2.1 的正式签名证书，证书 SHA-256 为 `8E8CBA83DB37D590E372A86B26D520C103AF0606779982CF1BB90D258CBB7144`。Windows 正式版仍为 2.2.1。

本版针对手机屏幕加入完整的七列月历、点选日期后的当日编辑和自动保存、明确开启的批量记工、当日工人卡片、年度与工地明细，以及在工人资料中新增工地。数据格式仍是 schema v8；应用不申请互联网权限。桌面版原有的备份、Excel 和打印流程保持独立。

## 安装与升级

从本仓库的 [Android 2.2.2 Release](https://github.com/tukitohosi/lq-work-log/releases/tag/v2.2.2-android) 下载 `LQ-Work-Log-2.2.2-Android.apk`。手机可直接安装 APK；AAB 只用于应用商店上传，不能直接点击安装。升级前先在旧版导出完整 JSON 并复制到手机之外保存，然后直接覆盖安装，不要先卸载。卸载会删除应用私有目录中的本地数据。

安装后可在设置中导入 Windows 导出的完整 JSON；导入前先核对预览统计。Excel 是报表，不是恢复数据的备份文件。

## 源码与重建

公开源码在本仓库的 [`android-app/`](https://github.com/tukitohosi/lq-work-log/tree/main/android-app) 目录。`package.json`、`package-lock.json`、`vendor/xlsx-0.20.3.tgz`、Gradle wrapper、Capacitor 原生工程和全部测试一起保留；构建缓存、真实账本与签名密钥不在源码中。需要 Node.js 22.12 及以上、JDK 21、Android SDK 和工程外的原正式签名凭据。

在 `android-app/` 中依次运行 `npm ci`、`npm test`、`npm run typecheck`、`npm run build`、`npm run test:mobile`，再运行 `npm run android:release`。构建脚本默认输出 Android 2.2.2 / 2020103 的签名 APK 和 AAB，并生成 `SHA256SUMS.txt`。构建前将 `JAVA_HOME` 指向 JDK 21，将 `ANDROID_HOME` 指向 Android SDK；签名凭据应保存在源码目录之外，路径规则见 `scripts/build-android-release.ps1`。

## 已验证与待验收

发布前全套自动测试为 35 个文件、290 项通过；最后新增测试后的相关两个文件为 75 项通过。生产构建、类型检查、39 项手机布局与交互检查、Chrome/Edge 备份、Excel 和打印回归，以及 Android `lintVitalRelease`、APK v2 签名和 AAB 签名已通过。

本次未连接真实 Android 手机。目标手机上的键盘、系统返回、分享、打印及 2.2.1 → 2.2.2 覆盖安装后的数据保留仍需设备验收；本机构建和浏览器模拟不代表这些项目已通过。
