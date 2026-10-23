const fp = require('fastify-plugin');
const createBodySchema = require('../schemas/create-body.json');
const { str, bool, any, list, obj, success, empty, member, conference, conferenceDetail, transcription, conferenceSummaryFields, instanceEventList, roomEventsSummary } = require('../schemas/response');

const TAG = '会议-开放接口';

const idQuery = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '会议 ID' }
  },
  required: ['id']
};

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const openApiAuthenticate = options.getOpenApiAuthenticate();
  fastify.get(
    `${options.prefix}/open-api/health`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: 'openApi健康检查',
        description: '校验开放接口签名并返回调用方信息',
        response: success(
          '签名校验通过',
          obj('健康检查结果', {
            success: bool('固定为 true'),
            userInfo: any('开放接口签名解析出的调用方信息'),
            message: str('提示信息')
          })
        )
      }
    },
    async request => {
      return { success: true, userInfo: request.openApiPayload, message: 'openApi服务正常' };
    }
  );
  fastify.post(
    `${options.prefix}/open-api/create`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: 'openApi创建会议',
        description: '以开放接口调用方身份创建会议和参会人，并为每个参会人签发有效期一个月的邀请码。至少需要一个主持人，参会人数不能超过 maxCount，结束时间须晚于当前时间',
        body: createBodySchema,
        response: success('创建的会议，members 中的 shorten 为各参会人的邀请码', conference())
      }
    },
    async request => {
      return services.createConference(request.openApiPayload, request.body);
    }
  );

  fastify.get(
    `${options.prefix}/open-api/detail`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: '获取会议信息',
        description: '获取调用方创建的会议详情，含录像文件和 AI 转写内容（如有）',
        query: idQuery,
        response: success('会议详情', conferenceDetail())
      }
    },
    async request => {
      return services.getConferenceDetailById(request.openApiPayload, request.query);
    }
  );

  fastify.post(
    `${options.prefix}/open-api/cancel`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: 'openApi取消会议',
        description: '取消调用方创建的会议；会议已开始时按结束流程处理并标记为已取消',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '会议 ID' }
          },
          required: ['id']
        },
        response: empty('会议已取消')
      }
    },
    async request => {
      await services.cancelConference(request.openApiPayload, request.body);
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/open-api/extendDuration`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: '延长会议时长',
        description: '修改调用方创建的未结束会议的时长；传 extendSeconds 时在原时长上累加，否则把时长设置为 duration',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '会议 ID' },
            duration: { type: 'number', description: '新的会议总时长，单位：秒；同时传 extendSeconds 时忽略' },
            extendSeconds: { type: 'number', description: '在原时长基础上延长的秒数' }
          },
          required: ['id']
        },
        response: success('修改后的会议详情', conferenceDetail())
      }
    },
    async request => {
      return services.updateConferenceDuration(request.openApiPayload, request.body);
    }
  );

  fastify.get(
    `${options.prefix}/open-api/roomStatus`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: '获取会议房间实时状态',
        description: '获取调用方创建的会议的 TRTC 房间快照：各用户在线状态、音视频开关、网络质量和设备信息，并关联参会人记录',
        query: idQuery,
        response: success(
          '房间实时状态',
          obj(
            '房间实时状态',
            Object.assign(
              {
                roomId: str('TRTC 房间号'),
                endTime: any('房间实际结束时间'),
                updatedAt: any('快照生成时间'),
                members: list(
                  '房间内用户状态',
                  obj('用户状态', {
                    userId: str('TRTC 用户 ID（参会人 ID）'),
                    status: any('用户状态：0 在房间内，1 已离开'),
                    startTime: any('进入房间时间'),
                    exitTime: any('离开房间时间'),
                    online: bool('是否在线'),
                    cameraOpen: bool('摄像头是否打开'),
                    microphoneOpen: bool('麦克风是否打开'),
                    networkQuality: any('最近一次网络质量数据'),
                    statistics: any('最近一次统计数据'),
                    deviceInfo: any('设备信息'),
                    lastEventAt: any('最近一次事件时间戳（毫秒）'),
                    member: member('对应的参会人记录，找不到时为 null')
                  })
                )
              },
              conferenceSummaryFields()
            )
          )
        )
      }
    },
    async request => {
      return services.getConferenceRoomStatusById(request.openApiPayload, request.query);
    }
  );

  fastify.get(
    `${options.prefix}/open-api/instanceEvents`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: '获取会议TRTC房间事件',
        description: '分页获取调用方创建的会议的 TRTC 房间事件；本地无事件时会先尝试从 TRTC 同步',
        query: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '会议 ID' },
            perPage: { type: 'number', default: 200, description: '每页数量' },
            currentPage: { type: 'number', default: 1, description: '当前页' }
          },
          required: ['id']
        },
        response: success('TRTC 房间事件分页列表及会议信息', instanceEventList('TRTC 房间事件分页列表', Object.assign(conferenceSummaryFields(), { members: list('参会人列表', member()) })))
      }
    },
    async request => {
      return services.getTrtcInstanceEventsForOpenApi(request.openApiPayload, request.query);
    }
  );

  fastify.get(
    `${options.prefix}/open-api/roomEventsSummary`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: '获取会议TRTC房间事件聚合摘要',
        description: '获取调用方创建的会议按成员聚合的房间事件摘要，不含原始高频事件',
        query: idQuery,
        response: success('房间事件聚合摘要及会议信息', roomEventsSummary('房间事件聚合摘要', Object.assign(conferenceSummaryFields(), { conferenceMembers: list('参会人列表', member()) })))
      }
    },
    async request => {
      return services.getTrtcRoomEventsSummaryForOpenApi(request.openApiPayload, request.query);
    }
  );

  fastify.get(
    `${options.prefix}/open-api/aiTranscriptionContent`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        tags: [TAG],
        summary: '获取会议AI语音转写内容',
        description: '获取调用方创建的会议的 AI 转写内容',
        query: idQuery,
        response: success('AI 转写内容；未开启语音识别或没有内容时为空对象', transcription)
      }
    },
    async request => {
      return services.getAiTranscriptionContentById(request.openApiPayload, request.query);
    }
  );
});
