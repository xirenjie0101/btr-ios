# BTR-iOS：Bilibili 线程撕裂者的 iOS / Loon 移植

海外看 B 站，冷门视频、4K、高码率视频经常转圈。原因不是“离得远”，而是海外 CDN 只缓存热门视频，冷门视频要回源；单纯换一个 CDN 节点也没用，因为换完还是**一条连接**在下载。桌面端的开源插件 [Bilibili 线程撕裂者（BTR）](https://github.com/MrTangLuyao/Bilibili-thread-ripper) 的解法是：把视频继续切成很多字节块，**同时向多个大陆 CDN 节点要，谁先到用谁**，按顺序交给播放器。

这个项目把同一套办法搬到 iPhone / iPad 上，包含三样东西：

| 文件 | 作用 | 需要 |
| --- | --- | --- |
| `BTR-iOS-App.plugin` + `btr-app.js` | **App 模式（主角）**：Loon 里开着，哔哩哔哩 App（国内版、国际版）取视频时自动变成多线程、多 CDN | Loon + MITM |
| `BTR-iOS.plugin` + `btr-loon.js` | **Safari 播放器（备用）**：在 Safari 里打开 `https://www.bilibili.com/__btr__/`，粘贴链接就能多线程播放，带弹幕、清晰度、分 P、历史进度 | Loon + MITM，iPhone 需 iOS 17.1+ |
| `btr-ios.user.js` | 同一个播放器的油猴版，不需要 Loon | Safari 的 Userscripts / Stay / Tampermonkey |

> 非官方工具，与哔哩哔哩无关。它只优化“你本来就有权看的视频”的下载方式，不绕过登录、会员、地区、审核或版权限制；不收集、不上传任何数据。下载内核直接来自 BTR（MIT 协议）。

---

## 先说清楚：哪些验证过，哪些还没有

- **Safari 播放器**：测试环境是一个假的 B 站（接口 + 8 个限速、高延迟、会挂掉的 CDN 节点 + 短链 + 模拟 Loon 运行环境），用真实浏览器跑了端到端测试，全部通过；iPhone 专属的部分（ManagedMediaSource、系统回收缓冲、缓冲区配额、hev1→hvc1）用模拟和单元测试覆盖。
- **App 模式**：用“模拟 Loon 中间层 + 模拟 ijkplayer 式播放器 / 分段式播放器”验证了：交给播放器的字节与原文件逐字节一致、速度是单连接的数倍、坏节点会被绕开、任何失败都会原样放行、保险丝会跳。
- **都还没有在真机上跑过**（开发环境里没有 iPhone 真机）。App 模式能否生效，取决于 B 站 App 的播放器接不接受“分块答复”（见下文原理）。所以 App 模式自带统计页和保险丝：**装上以后请看一眼统计页，把截图发回来，就能知道下一步怎么调。**

---

## 安装

### 0. 插件地址

文件都托管在这个仓库的 `dist/` 里，Loon 直接用下面的链接加载，不需要自己下载或改任何东西。

| 插件 | 链接（复制到 Loon → 配置 → 插件 → `+`） | 在 iPhone 上一键导入 |
| --- | --- | --- |
| **App 模式**（主角） | `https://raw.githubusercontent.com/xirenjie0101/btr-ios/main/dist/BTR-iOS-App.plugin` | [导入到 Loon](https://www.nsloon.com/openloon/import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2Fxirenjie0101%2Fbtr-ios%2Fmain%2Fdist%2FBTR-iOS-App.plugin) |
| Safari 播放器（备用） | `https://raw.githubusercontent.com/xirenjie0101/btr-ios/main/dist/BTR-iOS.plugin` | [导入到 Loon](https://www.nsloon.com/openloon/import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2Fxirenjie0101%2Fbtr-ios%2Fmain%2Fdist%2FBTR-iOS.plugin) |
| 探针（只做诊断，平时不用装） | `https://raw.githubusercontent.com/xirenjie0101/btr-ios/main/dist/extras/BTR-App-Probe.plugin` | [导入到 Loon](https://www.nsloon.com/openloon/import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2Fxirenjie0101%2Fbtr-ios%2Fmain%2Fdist%2Fextras%2FBTR-App-Probe.plugin) |

油猴版脚本：`https://raw.githubusercontent.com/xirenjie0101/btr-ios/main/dist/btr-ios.user.js`

> “一键导入”用的是 Loon 官方的统一链接（`nsloon.com/openloon/import?plugin=…`），要在装了 Loon 的 iPhone / iPad 上用 Safari 点开才有效。
>
> 如果你 fork 了这个仓库，或者想把 `dist/` 放到别的地方：`node build.js --base https://raw.githubusercontent.com/<用户名>/<仓库>/main/dist` 重新生成，插件里的脚本地址就会指向你自己的文件。

### 1. Loon 基本要求

- Loon 3.2.1（build 733）以上（插件用到了 `[Argument]` 参数界面）；
- 已安装并**信任** Loon 的 MITM 证书，MITM 总开关打开；
- 视频 CDN（`bilivideo.com`）最好走**直连**。如果你的分流规则会把 B 站 CDN 送去代理节点，速度会被节点卡住——把插件 `[Rule]` 里那两行 `DIRECT` 规则前面的 `#` 去掉即可。

### 2. App 模式（你要的“开了就生效”）

1. Loon → 配置 → 插件 → 右上角 `+` → 粘贴 `BTR-iOS-App.plugin` 的链接 → 保存并启用；
2. 如果装了 **BiliUniverse Redirect** 之类“改 B 站 CDN”的插件，先关掉（两者会抢同一批请求）；
3. 打开哔哩哔哩 App 看一个视频（最好挑一个平时会卡的冷门/高码率视频）；
4. 正常的话会收到一条通知“BTR App 模式正在加速”。随时可以在 Safari 打开统计页：

```
https://www.bilibili.com/__btr_app__/
```

统计页上能看到：App 实际用的请求方式（小段 / 开放式）、多线程完成了多少次、平均速度、哪些节点被停用、保险丝有没有跳。

**参数（插件页面里点开即可调）**

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 并发线程 | 8 | 先用 8；缓冲跟不上再试 16。不是越多越快，太多会更耗电、也可能被节点限制 |
| 每次答复的块大小 | 2MB | App 发“一直读到底”的请求时，每次先答复这么多。大一点省往返，但每块等得更久、更吃内存 |
| CDN 模式 | 大陆CDN | 海外看冷门视频就用大陆 CDN；到大陆线路特别差时再试海外 CDN |
| 大范围取流请求 | 分块答复 | **如果开着插件 App 放不了视频，把它改成“原样放行”** |
| 通知 | 开 | 开始加速、保险丝跳闸时各提醒一次 |

**如果出现问题**

| 现象 | 处理 |
| --- | --- |
| App 视频打不开 / 一直转圈，关掉插件就好 | 把“大范围取流请求”改成“原样放行”再试；并把统计页截图发回来 |
| 没有任何变化，统计页“看到的取流请求”是 0 | MITM 没生效：检查证书是否信任、MITM 总开关、插件是否启用；或者 App 走了插件没覆盖的域名（把 Loon 的请求记录里视频请求的域名发回来） |
| 统计页显示大多是“失败后放行” | 你的网络到大陆节点不通或很差：试试“海外CDN”；或检查 `bilivideo.com` 是否被分流到了代理 |
| 保险丝提示“App 播放器不接受分块答复” | 说明这个版本的 App 播放器不会在短答复后续传。插件已自动放行，不影响观看；请把统计页截图发回来 |
| 手机发热、耗电明显 | 线程调回 4～8；这是 MITM 解密视频流量的固有开销 |

### 3. Safari 播放器（备用，也适合 iPad）

1. 同样的方式添加 `BTR-iOS.plugin`；
2. Safari 打开 `https://www.bilibili.com/__btr__/`（可以“添加到主屏幕”，像 App 一样用）；
3. 第一次使用前，先在 Safari 里正常登录一次哔哩哔哩（未登录只有低清晰度）；
4. 粘贴视频链接、b23.tv 短链或 BV 号 → 播放。也可以在 Safari 里打开任意 B 站视频页，点右下角的“⚡ BTR 加速播放”。

iPhone 上看弹幕：保持内嵌播放（竖屏或把手机横过来都行）；系统自带的全屏播放器只显示视频本身，弹幕层进不去。

iPhone 需要 iOS 17.1 以上（更早的系统没有任何 MediaSource）。iPad 上 iPadOS 13 以上即可。

### 4. 油猴版（不想用 MITM 时）

在 App Store 装 **Userscripts**（免费开源）或 Stay / Tampermonkey，导入 `btr-ios.user.js`，然后在 Safari 打开 B 站视频页，点右下角按钮。
如果在 `m.bilibili.com` 下所有节点都报错，用 Safari 地址栏的“大小”菜单选“请求桌面网站”，在 `www.bilibili.com` 下再试（CDN 对 www 域名的跨域许可是确定的）。

---

## 原理

### App 模式

Loon 只能站在 App 和 CDN **中间**，而且脚本**不能边下边给**：必须把一个完整的响应攒齐，一次交给 App。所以分两种情况：

```text
App：Range: bytes=a-b（要一小段）
      → 脚本把 [a,b] 切成 N 块 → 同时向 N 个大陆节点要 → 校验每块的位置/长度/总长
      → 拼好 → 206 原样答复                                  （对 App 完全透明）

App：Range: bytes=a-（从 a 一直读到文件末尾，ffmpeg / ijkplayer 的典型写法）
      → 只答复前 1～2 MB：206 + Content-Range: bytes a-(a+2MB-1)/总长 + Connection: close
      → 播放器读完这一块，发现文件还没完，从 a+2MB 重新连上来要下一块 → 重复
```

第二种依赖播放器“读到一半断了就从断点续传”的能力。B 站 App 的播放器基于自家的 ijkplayer，它的网络层（ijkhttphook）正是这么设计的，所以有较大把握可行——但没有真机验证，因此加了保险丝：同一位置被反复重要（说明播放器没有往下走）就自动对大范围请求放行 10 分钟并通知你。

其他安全网：每个子块最多换 3 个节点；剩下一两个慢块时会向刚证明可用的节点再要一份（对冲）；连续两次失败的节点停用 5 → 15 → 60 分钟；整个请求 14 秒内拼不齐就原样放行；同一来源连续 4 次失败就整体放行 5 分钟；网页发出的请求（带 Origin）一律不碰。

### Safari 播放器

BTR 0.9 的做法是接管 B 站网页播放器底层的 `<video>`；手机网页上没有那个播放器，iPhone 也没有标准的 MediaSource，所以这里是一个独立播放器：

- 下载内核（Range 拆分、CDN 轮换与竞速、节点停用）**原样使用 BTR 的源文件**（`src/vendor-btr/`）；
- 播放内核按 BTR 的 `native-mse-player.js` 改写，增加了：iPhone 的 ManagedMediaSource（必须禁用 AirPlay、通过 `<source>` 挂载、听从 startstreaming/endstreaming、缓冲被系统回收后自愈）、缓冲区配额溢出处理、小空隙跳过、解码失败/卡死时自动换编码、HEVC 的 `hev1 → hvc1` 改标（苹果的解码器只认 hvc1）；
- iOS 不允许网页自己播放有声视频，所以第一次需要点一下；整个页面只用一个 `<video>` 元素，点过一次之后换 P、换视频都能自动播；
- 播放器页面由 Loon 脚本直接“应答”出来（`www.bilibili.com/__btr__/` 在 B 站服务器上并不存在），因为只有在 bilibili.com 的页面里，浏览器才会带上你的登录 Cookie 去要播放地址，CDN 也才允许跨域读取。**视频数据本身不经过 MITM**，只有 `www` / `m.bilibili.com` 两个域名需要解密。

---

## 反馈时请带上

- App 模式：统计页（`https://www.bilibili.com/__btr_app__/`）截图；Loon、iOS、B 站 App 的版本；所在地区和网络；
- Safari 播放器：页面最下面“调试日志 → 复制日志”的内容；
- 视频 BV 号、清晰度，是起播慢、播放中卡，还是拖动后卡。

请不要公开 Cookie、完整的视频地址（里面有签名）。

---

## 开发

```text
src/vendor-btr/   BTR 的下载内核（原样，MIT）
src/app/          Safari 播放器：engine / api / store / danmaku / ui / boot
src/loon/         Loon 脚本模板与插件模板（App 模式、播放器页面、视频页按钮）
extras/app-probe  只做诊断的探针插件（只记录 App 的请求方式，全部放行）
test/             假 B 站、模拟 Loon 运行环境、模拟 App 播放器、端到端测试
build.js          生成 dist/（无依赖）
```

```bash
node build.js                     # 生成 dist/
bash test/setup.sh                # 第一次：生成测试用的彩条视频和自签证书（需要 ffmpeg、openssl）
node test/run-all.js              # 全部测试（需要 playwright + chromium）
```

测试素材（`test/media/*.m4s`）是用 ffmpeg 生成的彩条，和 B 站的 DASH 文件同样的结构（ftyp + moov + sidx + moof/mdat…）。

## 许可与致谢

MIT。下载内核与整体思路来自 [MrTangLuyao/Bilibili-thread-ripper](https://github.com/MrTangLuyao/Bilibili-thread-ripper)（MIT，© 2026 Bilibili-thread-ripper contributors），`src/vendor-btr/` 保留了原始许可文件。
