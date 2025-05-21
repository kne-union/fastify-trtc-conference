const fp = require('fastify-plugin');
const path = require('node:path');

module.exports = fp(async (fastify, options) => {
  options = Object.assign(
    {},
    {
      name: 'trtcConference',
      shortenName: 'trtcConferenceShorten',
      shortenHeaderName: 'x-trtc-conference-code',
      prefix: '/api/conference',
      dbTableNamePrefix: 't_conference_',
      appId: '',
      appSecret: '',
      expire: 3 * 60 * 60,
      getUserAuthenticate: () => {
        if (!fastify.account) {
          throw new Error('fastify-account plugin must be registered before fastify-trtc-conference,or set options.getUserAuthenticate');
        }
        return fastify.account.authenticate.user;
      },
      getUserModel: () => {
        if (!fastify.account) {
          throw new Error('fastify-account plugin must be registered before fastify-trtc-conference,or set options.getUserModel');
        }
        return fastify.account.models.user;
      }
    },
    options
  );

  fastify.register(require('@kne/fastify-shorten'), {
    name: options.shortenName,
    dbTableNamePrefix: options.dbTableNamePrefix,
    headerName: options.shortenHeaderName
  });

  fastify.register(require('@kne/fastify-namespace'), {
    options,
    name: options.name,
    modules: [
      ['controllers', path.resolve(__dirname, './libs/controllers')],
      [
        'models',
        await fastify.sequelize.addModels(path.resolve(__dirname, './libs/models'), {
          prefix: options.dbTableNamePrefix,
          getUserModel: options.getUserModel
        })
      ],
      ['services', path.resolve(__dirname, './libs/services')]
    ]
  });
});
