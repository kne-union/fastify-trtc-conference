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
      syncCron: '*/10 * * * *',
      getOpenApiAuthenticate: () => {
        if (!fastify.signature) {
          throw new Error('fastify-signature plugin must be registered before fastify-trtc-conference,or set options.getUserAuthenticate');
        }
        return fastify.signature.authenticate.openApi;
      },
      getUserAuthenticate: () => {
        if (!fastify.account) {
          throw new Error('fastify-account plugin must be registered before fastify-trtc-conference,or set options.getUserAuthenticate');
        }
        return fastify.account.authenticate.user;
      },
      getUserInfo: request => {
        return request.userInfo;
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

  fastify.register(
    require('fastify-plugin')(async fastify => {
      options.syncCron &&
        fastify.register(require('fastify-cron'), {
          jobs: [
            {
              cronTime: options.syncCron,
              onTick: async () => {
                console.log('sync record files');
                const { syncRecordFiles } = fastify[options.name].services;
                await syncRecordFiles();
              },
              start: true
            }
          ]
        });
    })
  );
});
