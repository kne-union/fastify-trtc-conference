const fp = require('fastify-plugin');
const createBodySchema = require('../schemas/create-body.json');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const { authenticate } = fastify[options.shortenName];
  const userAuthenticate = options.getUserAuthenticate();
  fastify.get(
    `${options.prefix}/detail`,
    {
      onRequest: [authenticate.code],
      schema: {
        description: '获取会议信息',
        summary: '获取会议信息',
        query: {}
      }
    },
    async request => {
      return services.getConferenceDetail(request.authenticatePayload);
    }
  );

  fastify.post(
    `${options.prefix}/saveMember`,
    {
      onRequest: [authenticate.code],
      schema: {
        description: '修改参会人信息',
        summary: '修改参会人信息',
        body: {
          type: 'object',
          properties: {
            avatar: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string' }
          }
        }
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
        description: '邀请参会人',
        summary: '邀请参会人'
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
        description: '加入会议',
        summary: '加入会议',
        body: {
          type: 'object',
          properties: {
            avatar: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string' }
          }
        }
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
        description: '移除参会人',
        summary: '移除参会人',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string' }
          }
        }
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
        description: '进入会议',
        summary: '进入会议'
      }
    },
    async request => {
      return services.enterConference(request.authenticatePayload);
    }
  );

  fastify.post(
    `${options.prefix}/startAITranscription`,
    {
      onRequest: [authenticate.code],
      schema: {
        description: '开启AI转写',
        summary: '开启AI转写'
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
        description: '停止AI转写',
        summary: '停止AI转写'
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
        description: '记录AI转写内容',
        summary: '记录AI转写内容',
        body: {
          type: 'object',
          properties: {
            messages: {
              type: 'array',
              items: { type: 'object', properties: { records: { type: 'array' } } }
            }
          }
        }
      }
    },
    async request => {
      await services.recordAITranscription(request.authenticatePayload, request.body);
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/end`,
    {
      onRequest: [authenticate.code],
      schema: {
        description: '结束会议',
        summary: '结束会议',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string' }
          }
        }
      }
    },
    async request => {
      await services.endConference(request.authenticatePayload, request.body);
      return {};
    }
  );

  fastify.get(
    `${options.prefix}/list`,
    {
      onRequest: [userAuthenticate],
      schema: {
        summary: '获取会议列表',
        query: {
          type: 'object',
          properties: {
            perPage: { type: 'number', description: '每页数量', default: 20 },
            currentPage: { type: 'number', description: '当前页', default: 1 }
          }
        }
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
        summary: '获取会议AI语音转写内容',
        query: {
          type: 'object',
          properties: {
            id: { type: 'string' }
          }
        }
      }
    },
    async request => {
      return services.getAiTranscriptionContentById(request.authenticatePayload, request.query);
    }
  );

  fastify.post(
    `${options.prefix}/create`,
    {
      onRequest: [userAuthenticate],
      schema: {
        summary: '创建会议',
        body: createBodySchema
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
        summary: '修改会议',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            startTime: {
              type: 'string',
              format: 'date-time',
              description: '会议开始时间,格式:YYYY-MM-DDTHH:mm:ss.sssZ'
            },
            duration: { type: 'number', description: '会议时长,单位:秒' },
            isInvitationAllowed: { type: 'boolean', description: '是否允许邀请' },
            maxCount: { type: 'number', description: '最大人数' },
            options: {
              type: 'object',
              description: '会议选项',
              properties: {
                document: { type: 'array', description: '会议输入文档', items: { type: 'object' } },
                documentVisibleAll: { type: 'boolean', description: '是否允许所有人查看文档', default: false }
              }
            }
          },
          required: ['id', 'name']
        }
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
        summary: '删除会议',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string' }
          },
          required: ['id']
        }
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
        summary: '获取会议成员短链接',
        query: {
          type: 'object',
          properties: {
            id: { type: 'string' }
          },
          required: ['id']
        }
      }
    },
    async request => {
      return services.getMemberShorten(options.getUserInfo(request), request.query);
    }
  );

  fastify.post(
    `${options.prefix}/inviteMemberFormUser`,
    {
      onRequest: [userAuthenticate],
      schema: {
        description: '用户邀请参会人',
        summary: '用户邀请参会人',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string' }
          },
          required: ['id']
        }
      }
    },
    async request => {
      return services.inviteMemberFormUser(options.getUserInfo(request), request.body);
    }
  );
});
