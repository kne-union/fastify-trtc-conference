### 配置项

插件注册时传入的配置选项：

| 属性名                                | 类型               | 必填 | 默认值                      | 说明                                                            |
|------------------------------------|------------------|----|--------------------------|---------------------------------------------------------------|
| name                               | `string`         | 否  | `trtcConference`         | 命名空间名称                                                        |
| shortenName                        | `string`         | 否  | `trtcConferenceShorten`  | shorten 插件命名空间                                                |
| shortenHeaderName                  | `string`         | 否  | `x-trtc-conference-code` | shorten 认证请求头名称                                               |
| prefix                             | `string`         | 否  | `/api/conference`        | 路由前缀                                                          |
| dbTableNamePrefix                  | `string`         | 否  | `t_conference_`          | 数据库表名前缀                                                       |
| trtcName                           | `string`         | 否  | `trtc`                   | TRTC 插件命名空间                                                   |
| appId                              | `string`         | 是  | -                        | 腾讯云 TRTC 应用 ID                                                |
| appSecret                          | `string`         | 是  | -                        | 腾讯云 TRTC 应用密钥                                                 |
| expire                             | `number`         | 否  | `10800`                  | TRTC 签名有效期（秒），默认3小时                                           |
| forceEndExpiredConferencesCronTime | `string / false` | 否  | `*/5 * * * *`            | 强制结束过期会议的 cron 表达式，设为 `false` 禁用                              |
| getOpenApiAuthenticate             | `function`       | 否  | -                        | 获取 OpenAPI 认证函数，默认使用 `fastify.signature.authenticate.openApi` |
| getUserAuthenticate                | `function`       | 否  | -                        | 获取用户认证函数，默认使用 `fastify.account.authenticate.user`             |
| getUserInfo                        | `function`       | 否  | -                        | 从请求中提取用户信息，默认返回 `request.userInfo`                            |
| getUserModel                       | `function`       | 否  | -                        | 获取用户模型，默认使用 `fastify.account.models.user`                     |
| tencentcloud                       | `object`         | 是  | -                        | 腾讯云配置，包含 credential 和 cos 子项                                  |

> **关键设计**：`getOpenApiAuthenticate` 和 `getUserAuthenticate` 支持自定义认证逻辑，当未配置时会尝试从已注册的
`fastify-signature` 和 `fastify-account` 插件获取。

### 接口

#### 用户接口（需用户认证）

| 方法   | 路径                                          | 说明         |
|------|---------------------------------------------|------------|
| GET  | `/api/conference/list`                      | 获取会议列表     |
| GET  | `/api/conference/getAiTranscriptionContent` | 获取会议AI转写内容 |
| POST | `/api/conference/create`                    | 创建会议       |
| POST | `/api/conference/save`                      | 修改会议       |
| POST | `/api/conference/delete`                    | 删除会议       |
| GET  | `/api/conference/getMemberShorten`          | 获取会议成员短链接  |
| POST | `/api/conference/inviteMemberFromUser`      | 用户邀请参会人    |

#### 参会人接口（需 shorten 码认证）

| 方法   | 路径                                      | 说明       |
|------|-----------------------------------------|----------|
| GET  | `/api/conference/detail`                | 获取会议信息   |
| POST | `/api/conference/saveMember`            | 修改参会人信息  |
| POST | `/api/conference/inviteMember`          | 邀请参会人    |
| POST | `/api/conference/join`                  | 加入会议     |
| POST | `/api/conference/removeMember`          | 移除参会人    |
| POST | `/api/conference/enter`                 | 进入会议     |
| POST | `/api/conference/startAITranscription`  | 开启AI转写   |
| POST | `/api/conference/stopAITranscription`   | 停止AI转写   |
| POST | `/api/conference/recordAITranscription` | 记录AI转写内容 |
| POST | `/api/conference/end`                   | 结束会议     |
| POST | `/api/conference/cancel`                | 取消会议     |

#### 开放API接口（需 OpenAPI 认证）

| 方法   | 路径                                                | 说明       |
|------|---------------------------------------------------|----------|
| GET  | `/api/conference/open-api/health`                 | 健康检查     |
| POST | `/api/conference/open-api/create`                 | 创建会议     |
| GET  | `/api/conference/open-api/detail`                 | 获取会议信息   |
| POST | `/api/conference/open-api/cancel`                 | 取消会议     |
| GET  | `/api/conference/open-api/aiTranscriptionContent` | 获取AI转写内容 |

#### 接口详情

##### POST `/api/conference/create`

创建新会议并添加成员。

请求体：

| 属性名                 | 类型        | 必填 | 默认值  | 说明               |
|---------------------|-----------|----|------|------------------|
| name                | `string`  | 是  | -    | 会议名称             |
| startTime           | `string`  | 否  | -    | 开始时间，ISO 8601 格式 |
| duration            | `number`  | 否  | -    | 会议时长（秒）          |
| isInvitationAllowed | `boolean` | 否  | -    | 是否允许邀请           |
| maxCount            | `number`  | 否  | -    | 最大参会人数           |
| members             | `array`   | 否  | `[]` | 成员列表             |
| options             | `object`  | 否  | -    | 会议选项             |

members 子项：

| 属性名      | 类型        | 必填 | 说明     |
|----------|-----------|----|--------|
| name     | `string`  | 否  | 用户名称   |
| nickname | `string`  | 否  | 用户昵称   |
| email    | `string`  | 否  | 用户邮箱   |
| isMaster | `boolean` | 否  | 是否是主持人 |

options 子项：

| 属性名                | 类型        | 必填 | 默认值     | 说明                         |
|--------------------|-----------|----|---------|----------------------------|
| setting            | `object`  | 否  | -       | TRTC 房间设置（record、speech 等） |
| document           | `array`   | 否  | -       | 会议输入文档                     |
| documentVisibleAll | `boolean` | 否  | `false` | 是否允许所有人查看文档                |

返回：会议对象及成员列表（含 shorten 码）

```json
{
  "id": "1",
  "name": "项目周会",
  "startTime": "2026-06-06T10:00:00.000Z",
  "duration": 3600,
  "status": 0,
  "maxCount": 10,
  "isInvitationAllowed": true,
  "options": {},
  "members": [
    {
      "id": "1",
      "nickname": "张三",
      "isMaster": true,
      "shorten": "abc123"
    }
  ]
}
```

##### POST `/api/conference/save`

修改会议信息。注意：时长和最大人数只能增大不能减小。

请求体：

| 属性名                 | 类型        | 必填 | 说明                  |
|---------------------|-----------|----|---------------------|
| id                  | `string`  | 是  | 会议 ID               |
| name                | `string`  | 是  | 会议名称                |
| duration            | `number`  | 否  | 会议时长（秒），不可小于原值      |
| isInvitationAllowed | `boolean` | 否  | 是否允许邀请              |
| maxCount            | `number`  | 否  | 最大参会人数，不可小于原值       |
| options             | `object`  | 否  | 会议选项（与原 options 合并） |

##### POST `/api/conference/enter`

参会人进入会议，获取 TRTC 用户签名。如果是主持人首次进入且会议开启了录像，将自动开始录像。

返回：

```json
{
  "member": {
    "id": "1",
    "nickname": "张三",
    "isMaster": true
  },
  "conference": {
    "id": "1",
    "name": "项目周会",
    "status": 0
  },
  "sign": "userSigString"
}
```

##### POST `/api/conference/join`

通过邀请码加入会议。

请求体：

| 属性名      | 类型       | 必填 | 说明                  |
|----------|----------|----|---------------------|
| avatar   | `string` | 否  | 头像                  |
| nickname | `string` | 否  | 昵称                  |
| name     | `string` | 否  | 名称（作为 nickname 的别名） |
| email    | `string` | 否  | 邮箱                  |

返回：

```json
{
  "shorten": "newMemberShortenCode"
}
```

##### GET `/api/conference/list`

获取当前用户的会议列表。

查询参数：

| 属性名         | 类型       | 必填 | 默认值  | 说明   |
|-------------|----------|----|------|------|
| perPage     | `number` | 否  | `20` | 每页数量 |
| currentPage | `number` | 否  | `1`  | 当前页码 |
| keyword     | `string` | 否  | -    | 会议名称关键字 |
| date        | `string` | 否  | -    | 会议开始日期，格式 `YYYY-MM-DD` |

返回：

```json
{
  "pageData": [
    {
      "id": "1",
      "name": "项目周会",
      "members": []
    }
  ],
  "totalCount": 15
}
```

### 程序化 API

通过 `fastify[options.name].services` 访问服务方法：

| 方法签名                                                                                                                            | 说明               |
|---------------------------------------------------------------------------------------------------------------------------------|------------------|
| `createConference(authenticatePayload, { name, startTime, duration, isInvitationAllowed, origin, maxCount, options, members })` | 创建会议             |
| `saveConference(authenticatePayload, { id, name, duration, isInvitationAllowed, maxCount, options })`                           | 修改会议             |
| `deleteConference(authenticatePayload, { id })`                                                                                 | 删除会议             |
| `getConferenceList(authenticatePayload, { perPage, currentPage, keyword, date })`                                                              | 获取会议列表           |
| `getConferenceDetail(authenticatePayload)`                                                                                      | 获取会议详情（含成员和邀请人）  |
| `getConferenceDetailById(authenticatePayload, { id })`                                                                          | 按 ID 获取会议详情      |
| `getAiTranscriptionContentById(authenticatePayload, { id })`                                                                    | 获取AI转写内容         |
| `enterConference(authenticatePayload)`                                                                                          | 进入会议（获取 TRTC 签名） |
| `saveMember(authenticatePayload, data)`                                                                                         | 修改参会人信息          |
| `inviteMember(authenticatePayload)`                                                                                             | 主持人邀请参会人         |
| `inviteMemberFromUser(authenticatePayload, { id })`                                                                             | 创建者邀请参会人         |
| `getMemberShorten(authenticatePayload, { id })`                                                                                 | 获取成员短链接          |
| `joinConference(authenticatePayload, data)`                                                                                     | 加入会议             |
| `removeMember(authenticatePayload, { id })`                                                                                     | 移除参会人            |
| `endConference(authenticatePayload, { id })`                                                                                    | 结束会议             |
| `cancelConference(authenticatePayload, { id })`                                                                                 | 取消会议             |
| `forceEndExpiredConferences()`                                                                                                  | 强制结束所有过期会议       |
| `startAITranscription(authenticatePayload)`                                                                                     | 开启AI转写           |
| `stopAITranscription(authenticatePayload)`                                                                                      | 停止AI转写           |
| `recordAITranscription(authenticatePayload, { records, messages })`                                                             | 记录AI转写内容         |
| `saveRecordVideo({ conferenceId, roomId, results })`                                                                            | 保存录像文件信息         |

### 数据模型

#### Conference（会议）

| 属性名                 | 类型        | 说明                                 |
|---------------------|-----------|------------------------------------|
| id                  | `number`  | 主键，自增                              |
| name                | `string`  | 会议名称                               |
| startTime           | `Date`    | 开始时间                               |
| duration            | `number`  | 会议时长（秒）                            |
| isInvitationAllowed | `boolean` | 是否允许邀请                             |
| origin              | `string`  | 来源标识，默认 `system-created`           |
| maxCount            | `number`  | 最大参会人数，默认 `2`                      |
| status              | `number`  | 会议状态：`0` 正常，`1` 已结束，`2` 已取消，默认 `0` |
| options             | `object`  | 扩展信息（录像、AI转写、文档等配置）                |
| userId              | `number`  | 创建者 ID（外键关联 User 模型）               |

关联关系：`Conference.hasMany(Member)`、`Conference.belongsTo(User)`

#### Member（参会人）

| 属性名          | 类型        | 说明          |
|--------------|-----------|-------------|
| id           | `number`  | 主键，自增       |
| email        | `string`  | 邮箱          |
| nickname     | `string`  | 昵称          |
| avatar       | `string`  | 头像          |
| isMaster     | `boolean` | 是否是会议主持人    |
| shorten      | `string`  | 进入系统的邀请码    |
| conferenceId | `number`  | 所属会议 ID（外键） |

关联关系：`Member.belongsTo(Conference)`

#### AiTranscriptionContent（AI转写内容）

| 属性名          | 类型       | 说明                |
|--------------|----------|-------------------|
| id           | `number` | 主键，自增             |
| content      | `array`  | 语音转文字内容数据，默认 `[]` |
| result       | `object` | 语音转文字内容处理结果       |
| status       | `number` | 语音转文字状态，默认 `0`    |
| options      | `object` | 附属信息，默认 `{}`      |
| conferenceId | `number` | 所属会议 ID（外键）       |

关联关系：`AiTranscriptionContent.belongsTo(Conference)`

### 机制说明

#### 认证机制

系统采用双认证体系：

| 认证类型        | 适用接口         | 认证方式                                     | 说明      |
|-------------|--------------|------------------------------------------|---------|
| 用户认证        | 创建、修改、删除、列表等 | `fastify.account.authenticate.user`      | 面向会议创建者 |
| shorten 码认证 | 进入、邀请、加入等    | `fastify-shorten` 通过请求头认证                | 面向参会人   |
| OpenAPI 认证  | 开放API接口      | `fastify.signature.authenticate.openApi` | 面向第三方系统 |

#### 会议过期自动结束机制

插件注册后，会通过 `fastify-cron` 创建定时任务，默认每5分钟执行一次：

1. 查询所有状态为正常（`status=0`）的会议
2. 判断是否已过结束时间（`startTime + duration < now`）
3. 依次调用 `forceEndConference` 结束过期会议
4. 结束流程：停止 AI 转写 → 解散 TRTC 房间 → 停止录像 → 创建录像获取任务 → 更新状态为已结束

#### 录像异步处理机制

```
会议结束 → 停止录像任务 → 创建 record-video 异步任务
                                      ↓
                         轮询检查录像文件（polling机制）
                                      ↓
                         录像文件就绪 → 获取文件信息
                                      ↓
                         按参会人分类保存到 conference.options.recordFiles
```

录像文件名格式为 `{前缀}_{RoomId}_UserId_s_{UserId}_UserId_e_{结尾}`，通过 base64 解码获取参会人 ID 进行分类。
