const fp = require('fastify-plugin');
const createBodySchema = require('../schemas/create-body.json');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  const openApiAuthenticate = options.getOpenApiAuthenticate();
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
      return services.createConference(options.getUserInfo(request), request.body);
    }
  );
});
