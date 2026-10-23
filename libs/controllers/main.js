const fp = require('fastify-plugin');
const createBodySchema = require('../schemas/create-body.json');
const { str, num, any, list, obj, success, empty, member, conference, conferenceDetail, transcription, shorten, inviter, instanceEventList, roomEventsSummary } = require('../schemas/response');

const MEMBER_TAG = '会议-参会人';
const USER_TAG = '会议-会议管理';

const conferenceOptionsSchema = {
  type: 'object',
  description: '会议选项，与原有选项合并保存',
  properties: {
    document: { type: 'array', description: '会议输入文档', items: { type: 'object' } },
    documentVisibleAll: { type: 'boolean', description: '是否允许所有人查看文档', default: false },
    allowEarlyEnter: { type: 'boolean', description: '是否允许提前进入房间', default: false },
    forceExitGrace: { type: 'number', minimum: 0, description: '计划结束时间之后再等待的分钟数，到时强制结束会议。0 表示到点立即结束' },
    allowExtend: { description: '是否允许主持人在会中延长会议时长' },
    setting: { description: 'TRTC 设置：record（录制类型 audio / video）、speech（是否开启 AI 语音转写）、language、hotWordList 等' }
  }
};

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const { authenticate } = fastify[options.shortenName];
  const userAuthenticate = options.getUserAuthenticate();
  fastify.get(
    `${options.prefix}/detail`,
    {
      schema: {
        tags: [MEMBER_TAG],
        description: `用邀请码获取会议信息，邀请码从 query.code 或请求头 ${options.shortenHeaderName} 读取。非主持人且会议未开启 documentVisibleAll 时，会议文档列表返回为空`,
        summary: '获取会议信息',
        query: {
          type: 'object',
          properties: {
            code: { type: 'string', description: `邀请码，不传时读取请求头 ${options.shortenHeaderName}` }
          }
        },
        headers: {
          type: 'object',
          properties: {
            [options.shortenHeaderName]: { type: 'string', description: '邀请码，query.code 未传时使用' }
          }
        },
        response: success(
          '会议信息',
          obj('会议信息', {
            conference: conference(),
            member: member('邀请码对应的参会人；邀请他人用的邀请码没有参会人'),
            inviter
          })
        )
      }
    },
    async request => {
      return services.getConferenceDetailByShorten(request.query.code || request.headers[options.shortenHeaderName]);
    }
  );

  fastify.post(
    `${options.prefix}/saveMember`,
    {
      onRequest: [authenticate.code],
      schema: {
        tags: [MEMBER_TAG],
        description: '修改当前邀请码对应参会人的信息，只更新请求中传入的字段；只传 name 时作为昵称保存',
        summary: '修改参会人信息',
        body: {
          type: 'object',
          properties: {
            avatar: { type: 'string', description: '头像' },
            nickname: { type: 'string', description: '昵称' },
            name: { type: 'string', description: '名称，未传 nickname 时作为昵称保存' },
            email: { type: 'string', description: '邮箱' }
          }
        },
        response: empty('保存成功')
      }
    },
    async request => {
      await services.saveMember(request.authenticatePayload, request.body);
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/inviteMember`,
    {
      onRequest: [authenticate.code],
      schema: {
        tags: [MEMBER_TAG],
        description: '主持人生成邀请他人入会的邀请码，仅主持人可用，会议需未结束',
        summary: '邀请参会人',
        response: success(
          '邀请码及会议信息',
          obj('邀请结果', {
            shorten: str('邀请他人用的邀请码，有效期一个月，被邀请人用它调用 join 加入会议'),
            inviter: member('邀请人（当前主持人）'),
            conference: conference()
          })
        )
      }
    },
    async request => {
      return services.inviteMember(request.authenticatePayload);
    }
  );

  fastify.post(
    `${options.prefix}/join`,
    {
      onRequest: [authenticate.code],
      schema: {
        tags: [MEMBER_TAG],
        description: '被邀请人用邀请他人的邀请码加入会议，创建参会人记录并返回该参会人自己的邀请码。会议已结束、已满员或邀请人不是主持人时报错',
        summary: '加入会议',
        body: {
          type: 'object',
          properties: {
            avatar: { type: 'string', description: '头像' },
            nickname: { type: 'string', description: '昵称' },
            name: { type: 'string', description: '名称，未传 nickname 时作为昵称' },
            email: { type: 'string', description: '邮箱' }
          }
        },
        response: success('加入成功', shorten)
      }
    },
    async request => {
      return services.joinConference(request.authenticatePayload, request.body);
    }
  );

  fastify.post(
    `${options.prefix}/removeMember`,
    {
      onRequest: [authenticate.code],
      schema: {
        tags: [MEMBER_TAG],
        description: '主持人移除参会人：删除参会人记录和其邀请码，并把该用户踢出 TRTC 房间',
        summary: '移除参会人',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '要移除的参会人 ID' }
          }
        },
        response: empty('移除成功')
      }
    },
    async request => {
      await services.removeMember(request.authenticatePayload, request.body);
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/enter`,
    {
      onRequest: [authenticate.code],
      schema: {
        tags: [MEMBER_TAG],
        description: '进入会议并获取 TRTC 进房签名。会议未开始（且不允许提前进入）或已结束时报错；首次进入标记为已参会；主持人进入时按会议设置自动开始录制和 AI 转写',
        summary: '进入会议',
        response: success(
          '进房信息',
          obj('进房信息', {
            member: member('当前参会人'),
            conference: conference(),
            sign: any('TRTC 进房签名信息（fastify-trtc join 返回的 userSig，含 sdkAppId、userId、userSig 等）')
          })
        )
      }
    },
    async request => {
      return services.enterConference(request.authenticatePayload);
    }
  );

  fastify.post(
    `${options.prefix}/extendDuration`,
    {
      onRequest: [authenticate.code],
      schema: {
        tags: [MEMBER_TAG],
        description: '主持人在会中延长会议时长，会议选项需开启 allowExtend',
        summary: '延长会议时长',
        body: {
          type: 'object',
          properties: {
            extendSeconds: { type: 'number', description: '延长的秒数，不传默认 900' }
          }
        },
        response: success('延长后的会议详情', conferenceDetail())
      }
    },
    async request => {
      return services.extendConferenceDurationByMember(request.authenticatePayload, request.body);
    }
  );

  fastify.post(
    `${options.prefix}/startAITranscription`,
    {
      onRequest: [authenticate.code],
      schema: {
        tags: [MEMBER_TAG],
        description: '主持人开启 TRTC AI 转写；会议未开启语音识别（setting.speech）时不做任何操作',
        summary: '开启AI转写',
        response: empty('操作成功')
      }
    },
    async request => {
      await services.startAITranscription(request.authenticatePayload);
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/stopAITranscription`,
    {
      onRequest: [authenticate.code],
      schema: {
        tags: [MEMBER_TAG],
        description: '主持人停止 TRTC AI 转写；会议未开启语音识别时不做任何操作',
        summary: '停止AI转写',
        response: empty('操作成功')
      }
    },
    async request => {
      await services.stopAITranscription(request.authenticatePayload);
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/recordAITranscription`,
    {
      onRequest: [authenticate.code],
      schema: {
        tags: [MEMBER_TAG],
        description: '客户端上报 AI 转写记录，追加保存到会议转写内容；优先使用 records，未传时取 messages 中各项的 records。会议未开启语音识别或无记录时不保存',
        summary: '记录AI转写内容',
        body: {
          type: 'object',
          properties: {
            records: {
              type: 'array',
              description: '转写记录列表，原样追加保存',
              items: { type: 'object' }
            },
            messages: {
              type: 'array',
              description: '转写消息列表，records 未传时使用，取每项的 records 合并',
              items: { type: 'object', properties: { records: { type: 'array', description: '该消息包含的转写记录' } } }
            }
          }
        },
        response: empty('记录成功')
      }
    },
    async request => {
      await services.recordAITranscription(request.authenticatePayload, request.body);
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/recordClientEvents`,
    {
      onRequest: [authenticate.code],
      schema: {
        tags: [MEMBER_TAG],
        description: '客户端上报 TRTC SDK 事件和指标，去重后写入 fastify-trtc 的房间事件，enter / exit 事件同时更新房间用户状态。开启 enableRestApiQuery 或房间实例不存在时忽略',
        summary: '记录客户端TRTC事件和指标',
        body: {
          type: 'object',
          properties: {
            events: {
              type: 'array',
              description: '事件列表',
              items: {
                type: 'object',
                properties: {
                  type: { description: '事件类型，如 enter、exit、camera-open、network-quality、statistics，默认 client' },
                  time: { description: '事件发生时间，默认当前时间' },
                  userId: { description: '事件对应的用户（参会人）ID，默认当前参会人' },
                  data: { description: '事件数据' }
                }
              }
            }
          }
        },
        response: empty('记录成功')
      }
    },
    async request => {
      await services.recordClientEvents(request.authenticatePayload, request.body);
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/end`,
    {
      onRequest: [authenticate.code],
      schema: {
        tags: [MEMBER_TAG],
        description: '主持人结束会议：停止 AI 转写、解散 TRTC 房间，开启录制时停止录制并创建获取录像任务',
        summary: '结束会议',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '会议 ID，传入时须与邀请码所属会议一致，用于防止同时打开多个会议时误操作' }
          }
        },
        response: empty('会议已结束')
      }
    },
    async request => {
      await services.endConference(request.authenticatePayload, request.body);
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/cancel`,
    {
      onRequest: [authenticate.code],
      schema: {
        tags: [MEMBER_TAG],
        description: '主持人取消会议；会议已开始时按结束流程处理并标记为已取消',
        summary: '取消会议',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '会议 ID，传入时须与邀请码所属会议一致' }
          }
        },
        response: empty('会议已取消')
      }
    },
    async request => {
      await services.cancelConference(request.authenticatePayload, request.body);
      return {};
    }
  );

  fastify.get(
    `${options.prefix}/list`,
    {
      onRequest: [userAuthenticate],
      schema: {
        tags: [USER_TAG],
        summary: '获取会议列表',
        description: '分页获取当前用户创建的会议（含参会人），按开始时间倒序；查询前会先结束当前用户已过期的会议',
        query: {
          type: 'object',
          properties: {
            perPage: { type: 'number', description: '每页数量', default: 20 },
            currentPage: { type: 'number', description: '当前页', default: 1 },
            keyword: { type: 'string', description: '会议名称关键字' },
            date: { type: 'string', description: '会议开始日期，格式 YYYY-MM-DD' },
            record: { type: 'string', enum: ['audio', 'video'], description: '会议录制类型' },
            speech: { type: 'boolean', description: '是否开启语言识别' }
          }
        },
        response: success(
          '会议分页列表',
          obj('会议分页列表', {
            pageData: list('当前页会议列表', conference()),
            totalCount: num('符合条件的会议总数')
          })
        )
      }
    },
    async request => {
      return services.getConferenceList(request.authenticatePayload, request.query);
    }
  );

  fastify.get(
    `${options.prefix}/getAiTranscriptionContent`,
    {
      onRequest: [userAuthenticate],
      schema: {
        tags: [USER_TAG],
        summary: '获取会议AI语音转写内容',
        description: '会议创建者获取会议的 AI 转写内容',
        query: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '会议 ID' }
          }
        },
        response: success('AI 转写内容；未开启语音识别或没有内容时为空对象', transcription)
      }
    },
    async request => {
      return services.getAiTranscriptionContentById(request.authenticatePayload, request.query);
    }
  );

  fastify.get(
    `${options.prefix}/getTrtcInstanceEvents`,
    {
      onRequest: [userAuthenticate],
      schema: {
        tags: [USER_TAG],
        summary: '获取会议TRTC房间事件',
        description: '会议创建者或主持人（按账号邮箱匹配）分页获取会议 TRTC 房间事件；本地无事件时会先尝试从 TRTC 同步',
        query: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '会议 ID' },
            perPage: { type: 'number', default: 200, description: '每页数量' },
            currentPage: { type: 'number', default: 1, description: '当前页' }
          },
          required: ['id']
        },
        response: success('TRTC 房间事件分页列表', instanceEventList('TRTC 房间事件分页列表'))
      }
    },
    async request => {
      return services.getTrtcInstanceEventsById(options.getUserInfo(request), request.query);
    }
  );

  fastify.get(
    `${options.prefix}/getTrtcRoomEventsSummary`,
    {
      onRequest: [userAuthenticate],
      schema: {
        tags: [USER_TAG],
        summary: '获取会议TRTC房间事件聚合摘要',
        description: '会议创建者或主持人获取按成员聚合的房间事件摘要（整体情况、人数统计、质量分析与降采样图表），不含原始高频事件',
        query: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '会议 ID' }
          },
          required: ['id']
        },
        response: success('房间事件聚合摘要', roomEventsSummary('房间事件聚合摘要'))
      }
    },
    async request => {
      return services.getTrtcRoomEventsSummaryById(options.getUserInfo(request), request.query);
    }
  );

  fastify.post(
    `${options.prefix}/create`,
    {
      onRequest: [userAuthenticate],
      schema: {
        tags: [USER_TAG],
        summary: '创建会议',
        description: '创建会议和参会人，并为每个参会人签发有效期一个月的邀请码。至少需要一个主持人，参会人数不能超过 maxCount，结束时间须晚于当前时间',
        body: createBodySchema,
        response: success('创建的会议，members 中的 shorten 为各参会人的邀请码', conference())
      }
    },
    async request => {
      return services.createConference(options.getUserInfo(request), request.body);
    }
  );

  fastify.post(
    `${options.prefix}/save`,
    {
      onRequest: [userAuthenticate],
      schema: {
        tags: [USER_TAG],
        summary: '修改会议',
        description: '会议创建者修改会议；时长和最大人数只能增加，不能减少',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '会议 ID' },
            name: { type: 'string', description: '会议名称' },
            startTime: {
              type: 'string',
              format: 'date-time',
              description: '会议开始时间,格式:YYYY-MM-DDTHH:mm:ss.sssZ；当前不会被保存'
            },
            duration: { type: 'number', description: '会议时长,单位:秒' },
            isInvitationAllowed: { type: 'boolean', description: '是否允许邀请' },
            maxCount: { type: 'number', description: '最大人数' },
            options: conferenceOptionsSchema
          },
          required: ['id', 'name']
        },
        response: success('修改后的会议', conference())
      }
    },
    async request => {
      return services.saveConference(options.getUserInfo(request), request.body);
    }
  );

  fastify.post(
    `${options.prefix}/delete`,
    {
      onRequest: [userAuthenticate],
      schema: {
        tags: [USER_TAG],
        summary: '删除会议',
        description: '会议创建者删除会议',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '会议 ID' }
          },
          required: ['id']
        },
        response: empty('删除成功')
      }
    },
    async request => {
      return services.deleteConference(options.getUserInfo(request), request.body);
    }
  );

  fastify.get(
    `${options.prefix}/getMemberShorten`,
    {
      onRequest: [userAuthenticate],
      schema: {
        tags: [USER_TAG],
        summary: '获取会议成员短链接',
        description: '会议创建者为指定参会人重新签发邀请码（有效期一个月）并保存到参会人记录，会议需未结束',
        query: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '参会人 ID' }
          },
          required: ['id']
        },
        response: success('参会人邀请码', shorten)
      }
    },
    async request => {
      return services.getMemberShorten(options.getUserInfo(request), request.query);
    }
  );

  fastify.post(
    `${options.prefix}/inviteMemberFromUser`,
    {
      onRequest: [userAuthenticate],
      schema: {
        tags: [USER_TAG],
        description: '会议创建者生成邀请他人入会的邀请码，被邀请人用它调用 join 加入会议',
        summary: '用户邀请参会人',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '会议 ID' }
          },
          required: ['id']
        },
        response: success(
          '邀请码及会议信息',
          obj('邀请结果', {
            shorten: str('邀请他人用的邀请码，有效期一个月'),
            inviter,
            conference: conference()
          })
        )
      }
    },
    async request => {
      return services.inviteMemberFromUser(options.getUserInfo(request), request.body);
    }
  );
});
