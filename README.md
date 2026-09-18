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
- **App 模式**：用“模拟 Loon 中间层 + 模拟 ijkplayer 式播放器 / 分段式播放器”验证了：交给播放器的字节与原文件逐字节一致、预读缓存命中、缓存不超上限、存储失效时自动降级、坏节点会被绕开、任何失败都会原样放行、保险丝会跳。
- **真机上跑过一轮（1.0.0）**：MITM、脚本、多线程取回都能工作，字节没出过错。但真机统计也说明了 1.0 的思路不对——官方 App 的播放器是**一小段一小段（约 1 MB）地要，上一段到手才要下一段**；只把这一小段拆开并行去取，每个连接都要重新握手、慢启动，反而比 App 自己那条热连接更慢（平均 323 KB/s，比不装还卡）。1.1 改成了“预读”（见下文原理），这一版在真机上的效果还等验证：**装上以后看一会儿视频，把统计页截图发回来。**

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

统计页上能看到：App 实际用的请求方式和大小、缓存命中了多少次、没命中时各阶段花了多久、每一批取回的速度、每个节点的速度、哪些节点被停用、保险丝有没有跳、存储自检结果，以及最下面给作者看的三个小实验。

**参数（插件页面里点开即可调）**

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 并发线程 | 32 | 每一批同时开几条连接。到大陆节点单条连接很慢（1.0 的统计里每条只有约 40 KB/s），靠的是数量：理论上 32 条 ≈ 1.2 MB/s；发热明显就调到 16，缓冲还跟不上可以试 64 |
| 预读大小 | 4MB | App 要一小段时顺便多取多少放进缓存，接下来的几段就直接命中。实际每次预读多少会按测得的速度自动调整（目标是一批 2.5 秒左右），这里是上限。“关闭”＝只取 App 要的那一段（1.0 的行为） |
| 缓存上限 | 8MB | 预读数据最多占多少存储；播放位置之前的、超过 10 分钟的自动淘汰。如果 Loon 变得不稳定（VPN 自己断开），先把它调到 4MB |
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
| 手机发热、耗电明显 | 线程调回 8；这是 MITM 解密视频流量的固有开销 |
| 统计页“缓存”一行显示“已停用” | 存储自检没通过或写不进去：Loon 的持久化存储装不下这么多数据。把缓存上限调小再看；实在不行就“关闭”，退回 1.0 的行为 |
| Loon 的 VPN 自己断开 | 很可能是内存超了（网络扩展的内存有限）：缓存上限调到 4MB、预读调到 2MB、线程调到 8 |

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

Loon 只能站在 App 和 CDN **中间**，而且脚本**不能边下边给**：必须把一个完整的响应攒齐，一次交给 App；一次脚本运行答复完就结束，下一次请求是全新的一次运行，两次运行之间只有 Loon 的持久化存储（`$persistentStore`，存字符串）可以传东西。

真机上看到的官方 App（`Bilibili Freedoooooom/MarkII`，ijkplayer）取流方式是：`Range: bytes=a-b`，约 1 MB 一段，上一段到手才要下一段。于是：

```text
App：Range: bytes=a-b（约 1 MB）
   1.0  → 把 [a,b] 切成 8 块 → 8 个节点各要一块 → 拼好答复
          每块都要重新握手、慢启动，到大陆 200 ms 往返 → 一段要 3 秒，比 App 自己的热连接还慢 ✗

   1.1  → 缓存里有 [a,b]？有 → 直接答复（几毫秒）
          没有 → 把 [a,b] 和后面的几 MB（预读）一起切成 ≤线程数 块，一批并行取回
               → [a,b] 答复给 App；多取的部分 base64 后存进 $persistentStore，记在索引里
          预读多少按“上一批的速度 × 2.5 秒”算，上限是参数里的预读大小；文件长度还不知道时先取 1 MB
          节点按测得的速度排序，App 要的那部分只交给证明过的节点，没测过的节点只用来预读

App：Range: bytes=a-（从 a 一直读到文件末尾）
      → 只答复前 1～2 MB（缓存里有连续数据时可以更多，最多 8 MB）：206 + Content-Range + Connection: close
      → 播放器读完这一块，从下一个位置重新连上来 → 重复；同一位置被反复重要 → 保险丝跳闸，改回原样放行
```

缓存：每条记录是一段连续字节；超过上限时先淘汰播放位置之前 512 KB 以外的、再淘汰最旧的；10 分钟没用也淘汰。第一次用会做一次存储自检（写 1 MB 再读回来），没通过就自动不用缓存（只做多线程，等于把预读关掉）。

其他安全网：App 要的每个子块最多换 3 个节点；剩下一两个慢块时会向刚证明可用的节点再要一份（对冲）；预读子块只等一小会儿，没到的丢掉，迟迟不答的节点记一次失败；连续两次失败的节点停用 5 → 15 → 60 分钟；14 秒内拼不齐就原样放行；同一来源连续 4 次失败就整体放行 5 分钟；网页发出的请求（带 Origin）一律不碰。

统计页最下面的“实验”是给作者看的：Loon 在脚本 `$done` 之后还会不会执行定时器和网络回调、脚本自己发的请求会不会再触发一次脚本运行。哪一个成立，下一版就能把预读放到后台去做（答复不必等预读）。

### Safari 播放器

BTR 0.9 的做法是接管 B 站网页播放器底层的 `<video>`；手机网页上没有那个播放器，iPhone 也没有标准的 MediaSource，所以这里是一个独立播放器：

- 下载内核（Range 拆分、CDN 轮换与竞速、节点停用）**原样使用 BTR 的源文件**（`src/vendor-btr/`）；
- 播放内核按 BTR 的 `native-mse-player.js` 改写，增加了：iPhone 的 ManagedMediaSource（必须禁用 AirPlay、通过 `<source>` 挂载、听从 startstreaming/endstreaming、缓冲被系统回收后自愈）、缓冲区配额溢出处理、小空隙跳过、解码失败/卡死时自动换编码、HEVC 的 `hev1 → hvc1` 改标（苹果的解码器只认 hvc1）；
- iOS 不允许网页自己播放有声视频，所以第一次需要点一下；整个页面只用一个 `<video>` 元素，点过一次之后换 P、换视频都能自动播；
- 播放器页面由 Loon 脚本直接“应答”出来（`www.bilibili.com/__btr__/` 在 B 站服务器上并不存在），因为只有在 bilibili.com 的页面里，浏览器才会带上你的登录 Cookie 去要播放地址，CDN 也才允许跨域读取。**视频数据本身不经过 MITM**，只有 `www` / `m.bilibili.com` 两个域名需要解密。

---

## 反馈时请带上

- App 模式：统计页（`https://www.bilibili.com/__btr_app__/`）截图（看完一会儿视频之后的）；Loon、iOS、B 站 App 的版本；所在地区和网络；
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

## 更新记录

- **1.1.0**（2026-09-18）App 模式改成预读缓存：一批并行多取几 MB 存进持久化存储，后面的小段直接命中；节点按测得速度排序；去掉首块两阶段；统计页增加请求大小分布、命中率、各阶段耗时、节点速度、存储自检和实验结果；插件规则里拦掉 `www.bilibili.com` 的 QUIC，统计页才打得开。
- **1.0.0**（2026-09-18）首个版本：App 模式、Safari 播放器、油猴版。

## 许可与致谢

MIT。下载内核与整体思路来自 [MrTangLuyao/Bilibili-thread-ripper](https://github.com/MrTangLuyao/Bilibili-thread-ripper)（MIT，© 2026 Bilibili-thread-ripper contributors），`src/vendor-btr/` 保留了原始许可文件。
