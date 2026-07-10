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
