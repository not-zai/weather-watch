# weather-watch · 把气象台预警变成一条"待说"队列

> 给不想错过"该提醒他一句"的 agent 用。
> 脚本只负责**存**，说不说、怎么说，由 agent 自己决定。

## 它做什么

```
中央气象台预警  →  按区/市/周边分三档  →  state/weather-pending.json（还没说过的）
open-meteo     →  当下天气            →  state/weather-latest.json（最新一次全量）
```

两个文件，两种用法：

| 文件 | 谁读 | 用途 |
|---|---|---|
| `weather-latest.json` | 人 / 诊断 | 最新一次抓到的全部预警 + 此刻天气 |
| `weather-pending.json` | **agent** | **还没说过的**预警；说完调 `--ack` 清空 |

## 为什么分三档

一条"暴雨蓝色预警"到底跟你有没关系，取决于它在哪个区发的：

| 档 | 例子 | 进不进 pending |
|---|---|---|
| `local` | 你所在的区 | ✅ |
| `city` | 你所在市的本级（非周边县市） | ✅ |
| `nearby` | 隔壁县市 | ❌ 只记在 latest 里当参考 |

**周边县市不进队列**是刻意的：它们每天都有，进队列就变成噪音，agent 会学会忽略它。

## 跑

```bash
# 需要 Node >= 20（用内置 fetch），无第三方依赖
node weather-watch.mjs            # 跑一次：更新 latest，新预警追加进 pending
node weather-watch.mjs --check    # 只看不写
node weather-watch.mjs --ack      # 清空 pending（这些我已经说过了）
```

示例输出（默认配置指向北京海淀）：

```
新增预警 1 条
  2026/11/05 12:45 北京市海淀区气象台发布大风蓝色预警信号
此刻 北京海淀 10.2℃ 晴 体感6.1℃
```

## 数据源

```
中央气象台  https://www.nmc.cn/rest/findAlarm?province=<省>
open-meteo  https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..
```

两个都**不需要 API key**。

> ⚠️ `province` 是塞进 URL 的中文参数，必须 `encodeURIComponent`，否则带空格/特殊字的省名会 400。

## 配置

```bash
cp config.example.json config.json
```

| 键 | 默认 | 说明 |
|---|---|---|
| `place.city` | 北京 | 城市名（用于匹配预警标题） |
| `place.district` | 海淀 | 区县名（`local` 档判据） |
| `place.province` | 北京市 | 省名（拼进气象台 URL） |
| `place.lat` / `place.lon` | 39.96 / 116.30 | open-meteo 用 |
| `nearby` | 北京各区县 | `nearby` 档名单，只在 latest 里出现 |
| `stateDir` | `./state` | 两个 json 落哪儿（也可用环境变量 `WEATHER_STATE_DIR`） |

不想改源码就换城市：改 `config.json` 就行；也可以双击 `config.html` 填完导出。

## 接进 agent 的循环

```js
// 每 10 分钟跑一次脚本（它自己会去毛）
execFile(process.execPath, [path.join(__dirname, 'weather-watch.mjs')])

// agent 醒来时读 pending
const pending = JSON.parse(fs.readFileSync('state/weather-pending.json', 'utf8'))
if (pending.items?.length) {
  // 交给模型决定说不说；说完再 ack
}
```

**脚本里没有任何"自动发送"的代码**——它不调任何聊天接口。
这是设计上的边界：预警是信息，不是派给 agent 的汇报任务。

## 已知问题

- **气象台没有公开文档**：接口是网页前端在用的，随时可能变。变了改 `fetchAlarms()` 里那一处
- **只盯一个地点**：多地点请复制一份配置、跑两个实例（状态目录分开）
- **`--ack` 是全清**：想做"逐条确认"就自己读 pending 后手写回去
- **时间**：预警时间用的是气象台给的字面时间（北京时间），不转 UTC

## 许可

MIT，见 [LICENSE](LICENSE)。
