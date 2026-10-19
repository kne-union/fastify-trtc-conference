const fp = require('fastify-plugin');
const path = require('node:path');
const get = require('lodash/get');
const { assertActiveMember } = require('./libs/im');

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
        appId: '',
        appSecret: '',
        enableRestApiQuery: false,
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

    fastify.register(
      require('@kne/fastify-trtc'),
      Object.assign(
        {
          name: 'trtc',
          dbTableNamePrefix: options.dbTableNamePrefix,
          appId: options.appId,
          appSecret: options.appSecret,
          enableRestApiQuery: options.enableRestApiQuery,
          expire: options.expire,
          getParams: options.getParams
        },
        options.tencentcloud,
        {
          cos: Object.assign({}, get(options, 'tencentcloud.cos'), {
            region: get(options, 'tencentcloud.cos.region'),
            bucket: get(options, 'tencentcloud.cos.bucket'),
            accessKeyId: get(options, 'tencentcloud.credential.secretId'),
            accessKeySecret: get(options, 'tencentcloud.credential.secretKey')
          })
        }
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

    const imPrefix = options.imPrefix || String(options.prefix).replace(/\/conference\/?$/, '/im');

    fastify.after(() => {
      const codeAuthenticate = fastify[options.shortenName].authenticate.code;
      fastify.register(require('@fastify/websocket'));
      fastify.register(require('@kne/fastify-im'), {
        prefix: imPrefix,
        dbTableNamePrefix: options.dbTableNamePrefix,
        verifyToken: async token => {
          try {
            const decoded = JSON.parse(await fastify[options.shortenName].services.decode(token));
            if (!decoded || decoded.target !== 'im' || !decoded.conversationId || !decoded.memberId) {
              return null;
            }
            const member = await fastify.im.services.conversation.getMemberById(decoded.memberId);
            if (!member || String(member.conversationId) !== String(decoded.conversationId) || member.leftAt) {
              return null;
            }
            return {
              userId: `guest_${member.id}`,
              memberId: member.id,
              conversationId: String(member.conversationId),
              role: member.role,
              nickname: member.nickname,
              avatar: member.avatar || '',
              isGuest: true
            };
          } catch (error) {
            return null;
          }
        },
        trtc: {
          authenticate: [codeAuthenticate],
          resolveUser: async request => {
            const { memberId } = await assertActiveMember(fastify, options, request);
            return `im_${memberId}`;
          }
        }
      });
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
        tasks: {
          'record-video': ({ task, result }) => {
            return fastify[options.name].services.saveRecordVideo(result || task.input);
          }
        }
      });
    });
  },
  {
    name: 'fastify-trtc-conference',
    dependencies: ['fastify-task', 'fastify-file-manager', 'fastify-cron']
  }
);
