### 项目概述

`fastify-trtc-conference` 是一个基于 Fastify 框架的腾讯云 TRTC 视频会议插件。它封装了会议生命周期管理、成员邀请与控制、云端录像、AI 语音转写等核心功能，通过 Fastify 插件机制提供开箱即用的视频会议后端服务。

### 核心架构与流程

```
Fastify 应用
  ↓
fastify-trtc-conference（插件注册）
  ↓
  ├─→ @kne/fastify-trtc（TRTC 房间管理、录像、AI转写）
  ├─→ @kne/fastify-shorten（短链接/邀请码签名）
  ├─→ @kne/fastify-namespace（模块命名空间组织）
  └─→ fastify-cron（定时任务：强制结束过期会议）
        ↓
  Controllers（路由层）
    ├─ main.js（用户接口）
    └─ open-api.js（开放API接口）
        ↓
  Services（业务逻辑层）
    └─ main.js
        ↓
  Models（数据模型层）
    ├─ conference（会议）
    ├─ member（参会人）
    └─ ai-transcription-content（AI转写内容）
```

**会议生命周期**：

```
创建会议 → 邀请成员 → 加入会议 → 进入会议（获取TRTC签名）
                                      ↓
                              会议进行中（录像/AI转写）
                                      ↓
                    结束会议 ←── 到期自动结束（cron定时检查）
                        ↓
              录像文件回调处理（异步任务轮询）
```

### 核心概念详解

#### 会议（Conference）

会议是系统的核心实体，包含名称、开始时间、时长、最大人数等基础信息，以及通过 `options` 字段存储的扩展配置（录像设置、AI转写、文档等）。

| 属性         | 说明                                                           |
| ------------ | -------------------------------------------------------------- |
| **会议状态** | `0` 正常、`1` 已结束、`2` 已取消                               |
| **主持人**   | 会议创建者自动成为主持人，拥有邀请、移除、结束会议等特权       |
| **邀请机制** | 支持主持人邀请和创建者邀请两种方式，通过 shorten 签名实现      |
| **来源标识** | `origin` 字段区分会议来源，如 `system-created`、`co-interview` |

> **关键设计**：会议使用 shorten（短链接签名）机制进行身份认证，而非传统的 token 认证。成员加入会议后会获得一个包含其身份信息的 shorten 码，用于后续接口认证。

#### 参会人（Member）

参会人隶属于某个会议，包含邮箱、昵称、头像等个人信息。

| 属性         | 说明                    |
| ------------ | ----------------------- |
| **isMaster** | 标识是否为会议主持人    |
| **shorten**  | 参会人的邀请码/身份凭证 |

#### AI 语音转写（AI Transcription）

基于腾讯云 TRTC 的 AI 语音转写能力，将会议中的语音实时转为文字内容。

| 属性         | 说明                                                   |
| ------------ | ------------------------------------------------------ |
| **触发条件** | 需在会议 `options.setting.speech` 中启用               |
| **记录方式** | 通过 `recordAITranscription` 接口逐步追加转写记录      |
| **内容存储** | 独立的 `aiTranscriptionContent` 模型，与会议一对一关联 |

> **关键设计**：AI 转写的启动和停止由主持人控制，转写内容由客户端实时上报并持久化存储。

#### 云端录像

会议支持自动云端录像，录像文件在会议结束后异步获取。

| 属性         | 说明                                               |
| ------------ | -------------------------------------------------- |
| **触发方式** | 主持人进入会议时自动开始录像                       |
| **结束处理** | 会议结束后创建 `record-video` 异步任务轮询录像结果 |
| **文件分类** | 录像文件按参会人 ID 分类存储，同时保留全量文件列表 |

### 主要特性

| 特性                   | 说明                                               |
| ---------------------- | -------------------------------------------------- |
| **会议全生命周期管理** | 创建、修改、取消、结束，以及过期自动强制结束       |
| **双认证体系**         | 用户认证（用户系统）+ shorten 码认证（会议参会人） |
| **成员管理**           | 邀请、加入、移除，区分主持人与普通成员权限         |
| **云端录像**           | 自动录像 + 异步任务获取录像文件                    |
| **AI 语音转写**        | 实时语音转文字，支持自定义热词和语言               |
| **开放 API**           | 提供独立的 OpenAPI 接口，支持第三方系统集成        |
| **定时任务**           | 自动检测并结束过期会议，防止资源泄漏               |

### 使用方法

#### 插件注册

```js
// 在 Fastify 应用中注册插件
await fastify.register(require('@kne/fastify-trtc-conference'), {
  appId: 'your-trtc-appId',
  appSecret: 'your-trtc-appSecret',
  tencentcloud: {
    credential: {
      secretId: 'your-secret-id',
      secretKey: 'your-secret-key'
    },
    cos: {
      region: 'ap-guangzhou',
      bucket: 'your-bucket'
    }
  }
});
```

#### 基本流程

```js
// 1. 创建会议
const conference = await fetch('/api/conference/create', {
  method: 'POST',
  body: JSON.stringify({
    name: '项目周会',
    startTime: '2026-06-06T10:00:00.000Z',
    duration: 3600,
    maxCount: 10,
    isInvitationAllowed: true,
    members: [{ nickname: '张三', isMaster: true }]
  })
});

// 2. 邀请参会人（主持人邀请）
const invite = await fetch('/api/conference/inviteMember', {
  method: 'POST',
  headers: { 'x-trtc-conference-code': '<shorten>' }
});
// 返回邀请链接 shorten

// 3. 参会人加入会议
const join = await fetch('/api/conference/join', {
  method: 'POST',
  headers: { 'x-trtc-conference-code': '<invite-shorten>' },
  body: JSON.stringify({ nickname: '李四' })
});

// 4. 进入会议（获取 TRTC 签名）
const enter = await fetch('/api/conference/enter', {
  method: 'POST',
  headers: { 'x-trtc-conference-code': '<member-shorten>' }
});
// 返回 { member, conference, sign } - sign 为 TRTC 用户签名
```

#### 高级配置

```js
// 创建支持录像和AI转写的会议
await fetch('/api/conference/create', {
  method: 'POST',
  body: JSON.stringify({
    name: '面试会议',
    maxCount: 5,
    options: {
      setting: {
        record: true, // 开启云端录像
        speech: true // 开启AI语音转写
      },
      document: [{ url: 'https://example.com/resume.pdf' }],
      documentVisibleAll: true
    }
  })
});
```
