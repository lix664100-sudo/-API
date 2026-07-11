# ShareAI 多渠道生图 API

这个服务把生图能力封装成本地 API，并带一个管理后台。

第一版内置两个渠道：

- A渠道：聊天生图，默认优先使用。
- B渠道：绘图站，作为备用通道，也可以单独指定。

## 启动

```bash
npm install
npm start
```

打开后台：

```text
http://127.0.0.1:3210/admin/
```

## 后台怎么用

1. 进入“渠道账号”。
2. 给 A渠道、B渠道分别添加账号。
3. 点“检测”查看额度。
4. 在“文生图”里选择“自动选择”或指定 A/B 渠道。

旧版本保存过的账号会自动变成：

- 聊天账号1
- 绘图账号1

## API 调用

自动选择渠道：

```bash
curl http://127.0.0.1:3210/v1/images/generations \
  -H "Authorization: Bearer 你的API密钥" \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"一张真实的海边日落照片\",\"channel\":\"auto\",\"wait\":true}"
```

只用 A渠道：

```bash
curl http://127.0.0.1:3210/v1/images/generations \
  -H "Authorization: Bearer 你的API密钥" \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"一张真实的海边日落照片\",\"channel\":\"chatplus\",\"wait\":true}"
```

只用 B渠道：

```bash
curl http://127.0.0.1:3210/v1/images/generations \
  -H "Authorization: Bearer 你的API密钥" \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"一张真实的海边日落照片\",\"channel\":\"drawing\",\"wait\":true}"
```

图生图：

```bash
curl "http://127.0.0.1:3210/v1/images/edits?wait=1" \
  -H "Authorization: Bearer 你的API密钥" \
  -F "image=@source.png" \
  -F "prompt=沙滩中间加一个人物" \
  -F "channel=auto"
```

任务和账号配置保存在本地 `data` 目录。

## 每个账号单独代理 IP

在后台编辑账号时，可以给每个账号填一条代理：

```text
socks5://用户名:密码@IP:端口
```

也支持 HTTP 代理：

```text
http://用户名:密码@IP:端口
```

不填代理时，这个账号默认走服务器自己的 IP。填了代理后，这个账号的检测、登录、聊天、生图站、图生图都会走这条代理。建议一个账号固定一条独享静态 SOCKS5，不要用轮换 IP。

## 任务统计

后台任务记录会显示今日和最近 7 天的处理情况：

- 任务数：按任务记录条数统计。
- 成功图片：按成功任务里实际返回的图片链接数量统计。
- 失败任务：按失败任务条数统计。

任务记录支持按账号筛选，也支持按实际通道筛选：绘图站 / 聊天。为了保证 7 天统计准确，任务记录默认保留最近 7 天，最多 2000 条。

## 图片存储

后台“API 设置”里有“图片存储”区域，可以看到当前已转存图片数量、占用空间和服务器剩余磁盘空间。

图片返回策略有 3 种：

- 智能转存：推荐。普通公开图片直接返回；遇到 ChatPlus 这类临时链接，会先保存到本服务器，再返回本服务器链接。
- 全部转存：所有上游图片都保存到本服务器后再返回。
- 不转存：永远返回上游原链接。

自动清理可以设置“只保留最近几天”。服务启动后会定时清理旧图片；每次新转存图片时，也会顺手检查是否该清理。你也可以在后台手动点“清理过期图片”或“清空全部”。

默认图片保存在：

```text
outputs/results
```

如果线上要换目录，可以在 `.env` 里设置：

```env
RESULT_IMAGE_DIR=/data/shareai-results
RESULT_IMAGE_CLEANUP_INTERVAL_MIN=60
PUBLIC_BASE_URL=http://154.21.194.147:3210
```

## 后台登录

后台现在需要先登录才能查看渠道、账号、任务和 API 密钥。

默认后台账号：

```text
lixiang
```

默认后台密码：

```text
999999
```

线上部署时在 `.env` 里配置：

```env
ADMIN_USERNAME=lixiang
ADMIN_PASSWORD=999999
ADMIN_SESSION_SECRET=换成一串很长的随机字符
ADMIN_SESSION_HOURS=12
```

## 更新线上代码按钮

后台右上角有“更新线上代码”按钮。这个按钮会先检查 git 仓库有没有新代码：

- 没有新代码：直接提示“已经是最新版”，不会安装依赖，也不会重启服务。
- 有新代码：执行服务器 `.env` 里配置好的更新命令。

按钮不会在网页里保存服务器密码，也不会把命令从浏览器传给服务器。

如果部署在 `154.21.194.147:3210` 这台服务器，可以这样填 `.env`：

```env
PORT=3210
HOST=0.0.0.0
ADMIN_USERNAME=lixiang
ADMIN_PASSWORD=999999
ADMIN_SESSION_SECRET=换成一串很长的随机字符
ADMIN_UPDATE_CWD=/opt/ikun-aishare-api
ADMIN_UPDATE_COMMAND=git pull --ff-only && npm ci --omit=dev && (nohup sh -c 'sleep 1; pm2 restart ikun-aishare-api --update-env' >/tmp/ikun-aishare-api-update-restart.log 2>&1 &)
ADMIN_UPDATE_TIMEOUT_SEC=180
```

第一次部署时建议用 pm2 启动：

```bash
pm2 start src/server.js --name ikun-aishare-api
pm2 save
```

以后你点后台的“更新线上代码”，服务器会进入 `ADMIN_UPDATE_CWD`，先检查 GitHub 是否有新代码；只有发现新代码时，才会执行 `ADMIN_UPDATE_COMMAND`。代码需要先放进 git 仓库，更新按钮才知道从哪里拉新代码。
