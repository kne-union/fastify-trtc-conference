const fp = require('fastify-plugin');
const createBodySchema = require('../schemas/create-body.json');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const openApiAuthenticate = options.getOpenApiAuthenticate();
  fastify.get(
    `${options.prefix}/open-api/health`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        summary: 'openApi健康检查'
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
        summary: 'openApi创建会议',
        body: createBodySchema
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
        summary: '获取会议信息',
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
      return services.getConferenceDetailById(request.openApiPayload, request.query);
    }
  );

  fastify.get(
    `${options.prefix}/open-api/aiTranscriptionContent`,
    {
      onRequest: [openApiAuthenticate],
      schema: {
        summary: '获取会议AI语音转写内容',
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
      return services.getAiTranscriptionContentById(request.openApiPayload, request.query);
    }
  );
});
