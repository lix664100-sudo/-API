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
