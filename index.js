const fp = require('fastify-plugin');
const path = require('node:path');
const get = require('lodash/get');

module.exports = fp(
  async (fastify, options) => {
    options = Object.assign(
      {},
      {
        name: 'trtcConference',
        shortenName: 'trtcConferenceShorten',
        shortenHeaderName: 'x-trtc-conference-code',
        prefix: '/api/conference',
        dbTableNamePrefix: 't_conference_',
        trtcName: 'trtc',
        appId: '',
        appSecret: '',
        expire: 3 * 60 * 60,
        forceEndExpiredConferencesCronTime: '*/5 * * * *',
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

    fastify.register(require('@kne/fastify-tencent'), {
      oss: {
        accessKeyId: get(options, 'tencentcloud.credential.secretId'),
        accessKeySecret: get(options, 'tencentcloud.credential.secretKey'),
        region: get(options, 'tencentcloud.cos.region'),
        bucket: get(options, 'tencentcloud.cos.bucket')
      }
    });

    fastify.register(
      require('@kne/fastify-trtc'),
      Object.assign(
        {
          name: options.trtcName,
          dbTableNamePrefix: options.dbTableNamePrefix,
          appId: options.appId,
          appSecret: options.appSecret,
          expire: options.expire,
          getParams: options.getParams,
          cos: {
            region: get(options, 'tencentcloud.cos.region'),
            bucket: get(options, 'tencentcloud.cos.bucket'),
            accessKeyId: get(options, 'tencentcloud.credential.secretId'),
            accessKeySecret: get(options, 'tencentcloud.credential.secretKey')
          }
        },
        options.tencentcloud
      )
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

    fastify.after(() => {
      if (options.forceEndExpiredConferencesCronTime !== false) {
        fastify.cron.createJob({
          name: `${options.name}:forceEndExpiredConferences`,
          cronTime: options.forceEndExpiredConferencesCronTime,
          startWhenReady: true,
          onTick: async server => {
            await server[options.name].services.forceEndExpiredConferences();
          }
        });
      }
      // 注册录像获取任务类型
      fastify.task.services.append({
        dirs: [path.resolve(__dirname, './libs/tasks')],
        task: {
          recordVideo: target => {
            return fastify[options.name].services.saveRecordVideo(target);
          }
        }
      });
    });
  },
  {
    name: 'fastify-trtc-conference',
    dependencies: ['fastify-task', 'fastify-file-manager', 'fastify-tencent', 'fastify-trtc', 'fastify-cron']
  }
);
