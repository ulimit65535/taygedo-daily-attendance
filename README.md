# 塔吉多本地自动签到

一个可本地运行、也可部署到 Cloudflare Workers 的 Web 项目，用来管理塔吉多 APP 多账号登录、定时签到、每账号游戏配置和签到日志。

## 参考

- 签到逻辑参考了 [zzstar101/taygedo-auto-attendance](https://github.com/zzstar101/taygedo-auto-attendance)。
- Cloudflare Workers 部署方式参考了 [AEtherside/skland-daily-attendance](https://github.com/AEtherside/skland-daily-attendance)。

## 功能

- Web 管理界面带管理员登录校验
- 支持短信验证码登录塔吉多 APP 账号
- 支持多账号保存和删除
- 支持为每个账号单独选择签到游戏
- 支持立即执行全部账号或单账号签到
- 支持配置每天本机时间自动签到
- 支持查看本地签到日志
- 支持 Cloudflare Workers + KV 部署，不需要配置环境变量

默认支持的游戏：

| 游戏 ID | 名称 |
| --- | --- |
| `1256` | 幻塔 |
| `1257` | 未知游戏 |
| `1289` | 异环 |

## 运行

首次打开页面时需要创建管理员账号。管理员密码至少 12 位，服务端只保存 PBKDF2 哈希，不保存明文密码。

```bash
npm start
```

默认地址：

```text
http://localhost:3000
```

## Cloudflare Workers 一键部署

本项目参考 [AEtherside/skland-daily-attendance](https://github.com/AEtherside/skland-daily-attendance) 的 Workers 部署方式，已包含 `wrangler.jsonc`、Workers 入口和 KV 持久化存储。

点击下面按钮后，Cloudflare 会从本仓库读取代码，并在你的 GitHub/GitLab 账号下克隆出一份新仓库，再创建 Worker。

1. 点击 Deploy to Cloudflare。
2. 按 Cloudflare 页面提示完成 GitHub/GitLab 授权和部署。
3. 如果你想从自己的 Fork 部署，把页面里的 Git 存储库 URL 手动改成你的公开 Fork 仓库地址。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ulimit65535/taygedo-daily-attendance)

部署后第一次访问 Worker 域名，会进入管理员账号初始化页。这个项目不使用 Cloudflare 环境变量或 Secrets：账号数据、登录配置、日志和定时状态都保存在绑定名为 `TAYGEDO_KV` 的 Cloudflare KV 中。

### 手动部署

```bash
npm install
npm run deploy
```

如果不是通过 Deploy to Cloudflare 按钮部署，需要先创建 KV namespace，并把 `wrangler.jsonc` 里的 `kv_namespaces[0].id` 替换成实际 ID。

```bash
npx wrangler kv namespace create TAYGEDO_KV
```

Workers 定时触发器每分钟唤醒一次，代码会按页面里配置的时间在 `Asia/Shanghai` 时区每天最多执行一次签到。这样可以继续通过页面修改时间，同时避免在 Workers 里使用长驻定时器。

## 数据文件

默认数据目录是当前项目下的 `data/`：

- `data/state.json`：账号、签到时间和重试次数
- `data/logs.jsonl`：每次签到日志
- `data/auth.json`：本地管理员登录配置

这些文件只保存在本机，不会上传到远端。

## 安全说明

- 公开部署后，所有业务 API 都需要管理员会话。
- 登录会话使用 HttpOnly Cookie；HTTPS 下会自动带 `Secure`，并设置 `SameSite=Lax`。
- 写操作 API 需要前端自带的安全请求头，降低跨站表单触发风险。
- 登录失败会按访问 IP 短暂锁定，降低暴力猜测风险。
- 不要把本地 `data/` 目录提交到公开仓库，里面包含塔吉多账号 token。
- 第一次部署完成后请尽快打开 Worker 域名完成初始化，避免未初始化窗口长期暴露。

## 使用流程

1. 打开页面并创建管理员账号。
2. 使用管理员账号登录。
3. 输入手机号，点击发送验证码。
4. 收到短信后填写验证码、账号 ID 和账号名称。
5. 选择这个账号需要签到的游戏，完成登录。
6. 在账号列表里可以随时修改每个账号的游戏配置。
7. 在定时设置里开启每天自动签到。

账号 ID 是本地唯一标识，例如 `main`、`alt`，不是塔吉多返回的字段。
