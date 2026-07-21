const path = require('node:path');
const Module = require('node:module');
const { Op } = require('sequelize');

let expect;

const loadChai = async () => {
  if (!expect) {
    ({ expect } = await import('chai'));
  }
};

const createEntity = data => {
  const entity = Object.assign(
    {
      saveCount: 0,
      destroyCount: 0,
      async save() {
        this.saveCount += 1;
        return this;
      },
      async update(data) {
        Object.assign(this, data);
        return this;
      },
      async destroy() {
        this.destroyCount += 1;
        this.destroyed = true;
      },
      toJSON() {
        return Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function'));
      }
    },
    data
  );
  return entity;
};

const createMockModels = () => {
  let conferenceId = 1;
  let memberId = 1;
  let aiContentId = 1;
  const conferences = new Map();
  const members = new Map();
  const aiContents = new Map();

  const attachMembers = conference => {
    if (!conference) {
      return conference;
    }
    conference.members = Array.from(members.values()).filter(member => String(member.conferenceId) === String(conference.id));
    return conference;
  };

  const matchConferenceWhere = (conference, where = {}) => {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'userId') {
        return conference.userId === value;
      }
      if (key === 'status') {
        return conference.status === value;
      }
      if (key === 'name' && value && value[Op.like]) {
        const keyword = String(value[Op.like]).replace(/^%|%$/g, '');
        return String(conference.name || '').includes(keyword);
      }
      if (key === 'startTime' && value && typeof value === 'object') {
        const start = conference.startTime ? new Date(conference.startTime).getTime() : NaN;
        if (value[Op.gte] && start < new Date(value[Op.gte]).getTime()) {
          return false;
        }
        if (value[Op.lt] && start >= new Date(value[Op.lt]).getTime()) {
          return false;
        }
        return true;
      }
      if (key === 'options.setting.record') {
        return conference.options?.setting?.record === value;
      }
      if (key === 'options.setting.speech') {
        return conference.options?.setting?.speech === value;
      }
      return conference[key] === value;
    });
  };

  const filterConferences = ({ where, offset = 0, limit = Infinity, order }) => {
    let rows = Array.from(conferences.values()).filter(conference => matchConferenceWhere(conference, where));
    if (order?.[0]?.[0] === 'startTime') {
      const direction = order[0][1] === 'DESC' ? -1 : 1;
      rows = rows.sort((a, b) => {
        const aTime = a.startTime ? new Date(a.startTime).getTime() : 0;
        const bTime = b.startTime ? new Date(b.startTime).getTime() : 0;
        return (aTime - bTime) * direction;
      });
    }
    return rows.slice(offset, offset + limit).map(attachMembers);
  };

  const models = {
    conference: {
      async create(data) {
        const conference = createEntity({ id: String(conferenceId++), status: 0, options: {}, ...data });
        conferences.set(String(conference.id), conference);
        return conference;
      },
      async findByPk(id) {
        return attachMembers(conferences.get(String(id)));
      },
      async count({ where }) {
        return Array.from(conferences.values()).filter(conference => matchConferenceWhere(conference, where)).length;
      },
      async findAll({ where, offset = 0, limit = Infinity, order }) {
        return filterConferences({ where, offset, limit, order });
      },
      async update(data, { where }) {
        where.id.forEach(id => Object.assign(conferences.get(String(id)), data));
      }
    },
    member: {
      async create(data) {
        const member = createEntity({ id: String(memberId++), ...data });
        members.set(String(member.id), member);
        return member;
      },
      async bulkCreate(items) {
        return Promise.all(items.map(item => this.create(item)));
      },
      async findByPk(id, query = {}) {
        const member = members.get(String(id));
        if (!member || (query.where?.conferenceId && String(member.conferenceId) !== String(query.where.conferenceId))) {
          return null;
        }
        return member;
      }
    },
    aiTranscriptionContent: {
      async findOne({ where }) {
        return Array.from(aiContents.values()).find(item => String(item.conferenceId) === String(where.conferenceId)) || null;
      },
      async create(data) {
        const item = createEntity({ id: String(aiContentId++), ...data });
        aiContents.set(String(item.id), item);
        return item;
      }
    }
  };

  return { models, conferences, members, aiContents };
};

const createServiceContext = async (optionOverrides = {}) => {
  const { models, conferences, members, aiContents } = createMockModels();
  const signedPayloads = new Map();
  let signCount = 1;
  const calls = {
    removedShortens: [],
    taskCreates: [],
    trtc: {
      joins: [],
      startRecords: [],
      startAITranscriptions: [],
      stopAITranscriptions: [],
      dismisses: [],
      stopRecords: [],
      removeMembers: [],
      instanceEventLists: []
    }
  };

  const trtcServices = {
    async join(payload) {
      calls.trtc.joins.push(payload);
      return { userSig: { sdkAppId: 1400000000, userId: payload.userId, userSig: 'mock-user-sig' }, id: 'trtc-instance-id', roomId: payload.roomId };
    },
    async startRecord(payload) {
      calls.trtc.startRecords.push(payload);
      return { id: 'record-task-id' };
    },
    async startAITranscription(payload) {
      calls.trtc.startAITranscriptions.push(payload);
      return {
        id: payload.taskId || 'ai-task-id',
        toJSON() {
          return { id: this.id };
        }
      };
    },
    async stopAITranscription(payload) {
      calls.trtc.stopAITranscriptions.push(payload);
    },
    async dismiss(payload) {
      calls.trtc.dismisses.push(payload);
    },
    async stopRecord(payload) {
      calls.trtc.stopRecords.push(payload);
    },
    async removeMember(payload) {
      calls.trtc.removeMembers.push(payload);
    },
    instanceEvent: {
      async list(authenticatePayload, payload) {
        calls.trtc.instanceEventLists.push({ authenticatePayload, payload });
        return { pageData: [{ id: 'event-1' }], totalCount: 1 };
      }
    }
  };

  const fastify = {
    conference: { models, services: {} },
    trtc: { services: trtcServices },
    shorten: {
      services: {
        async sign(payload) {
          const shorten = `shorten-${signCount++}`;
          signedPayloads.set(shorten, payload);
          return shorten;
        },
        async decode(shorten) {
          return signedPayloads.get(shorten) || shorten;
        },
        async remove(shorten) {
          calls.removedShortens.push(shorten);
        }
      }
    },
    fileManager: {
      services: {
        async getFileInfo({ id }) {
          return { filename: id };
        }
      }
    },
    task: {
      services: {
        async create(payload) {
          calls.taskCreates.push(payload);
        }
      }
    }
  };

  const options = {
    name: 'conference',
    shortenName: 'shorten',
    language: 'zh',
    hotWordList: ['Fastify'],
    ...optionOverrides
  };
  await require('../libs/services/main')(fastify, options);
  return { fastify, services: fastify.conference.services, models, conferences, members, aiContents, signedPayloads, calls };
};

const expectReject = async (promise, message) => {
  try {
    await promise;
  } catch (error) {
    expect(error.message).to.equal(message);
    return;
  }
  throw new Error(`Expected rejection: ${message}`);
};

describe('@kne/fastify-trtc-conference', function () {
  before(loadChai);

  describe('模型定义测试', () => {
    it('should expose conference, member and ai transcription model definitions', () => {
      const DataTypes = { STRING: 'STRING', DATE: 'DATE', INTEGER: 'INTEGER', BOOLEAN: 'BOOLEAN', JSON: 'JSON' };
      const conference = require('../libs/models/conference')({ DataTypes, options: { getUserModel: () => 'userModel' } });
      const member = require('../libs/models/member')({ DataTypes });
      const aiTranscriptionContent = require('../libs/models/ai-transcription-content')({ DataTypes });

      expect(conference.model.name.type).to.equal('STRING');
      expect(conference.model.status.defaultValue).to.equal(0);
      expect(member.model.shorten.type).to.equal('STRING');
      expect(aiTranscriptionContent.model.content.defaultValue).to.deep.equal([]);
    });

    it('should register model associations', () => {
      const associationCalls = [];
      const conferenceModel = { hasMany: model => associationCalls.push(['hasMany', model]), belongsTo: (model, options) => associationCalls.push(['conferenceBelongsTo', model, options]) };
      const memberModel = { belongsTo: model => associationCalls.push(['memberBelongsTo', model]) };
      const aiModel = { belongsTo: model => associationCalls.push(['aiBelongsTo', model]) };

      require('../libs/models/conference')({ DataTypes: {}, options: { getUserModel: () => 'userModel' } }).associate({ conference: conferenceModel, member: memberModel });
      require('../libs/models/member')({ DataTypes: {} }).associate({ conference: conferenceModel, member: memberModel });
      require('../libs/models/ai-transcription-content')({ DataTypes: {}, options: {} }).associate({ aiTranscriptionContent: aiModel, conference: conferenceModel });

      expect(associationCalls).to.deep.equal([
        ['hasMany', memberModel],
        ['conferenceBelongsTo', 'userModel', { foreignKey: 'userId' }],
        ['memberBelongsTo', conferenceModel],
        ['aiBelongsTo', conferenceModel]
      ]);
    });
  });

  describe('插件注册测试', () => {
    it('should register dependency plugins and append record task', async () => {
      const pluginPath = path.resolve(__dirname, '../index.js');
      const originalLoad = Module._load;
      const dependencyStubs = new Map([
        ['@kne/fastify-trtc', async () => {}],
        ['@kne/fastify-shorten', async () => {}],
        ['@kne/fastify-namespace', async () => {}]
      ]);
      Module._load = (request, parent, isMain) => dependencyStubs.get(request) || originalLoad(request, parent, isMain);
      delete require.cache[pluginPath];
      const plugin = require(pluginPath);
      Module._load = originalLoad;

      const registrations = [];
      const appendedTasks = [];
      const cronJobs = [];
      let forceEndCallCount = 0;
      const fastify = {
        register: (target, options) => registrations.push({ target, options }),
        cron: { createJob: job => cronJobs.push(job) },
        sequelize: { addModels: async (modelsPath, options) => ({ modelsPath, options }) },
        task: { services: { append: payload => appendedTasks.push(payload) } },
        conference: {
          services: {
            saveRecordVideo: target => ({ saved: target }),
            forceEndExpiredConferences: async () => {
              forceEndCallCount += 1;
            }
          }
        },
        signature: { authenticate: { openApi: 'open-api-authenticate' } },
        account: { authenticate: { user: 'user-authenticate' }, models: { user: 'user-model' } }
      };
      fastify.after = callback => callback();

      await plugin(fastify, { name: 'conference', tencentcloud: { credential: { secretId: 'sid', secretKey: 'skey' }, cos: { region: 'ap', bucket: 'bucket' } } });

      const namespaceOptions = registrations[2].options.options;
      expect(registrations).to.have.length(3);
      expect(registrations[0].options.name).to.equal('trtc');
      expect(registrations[0].options.credential).to.deep.equal({ secretId: 'sid', secretKey: 'skey' });
      expect(registrations[0].options.cos).to.deep.equal({ accessKeyId: 'sid', accessKeySecret: 'skey', region: 'ap', bucket: 'bucket' });
      expect(registrations[1].options.name).to.equal('trtcConferenceShorten');
      expect(registrations[2].options.name).to.equal('conference');
      expect(cronJobs[0]).to.include({ name: 'conference:forceEndExpiredConferences', cronTime: '*/5 * * * *', startWhenReady: true });
      expect(namespaceOptions.getOpenApiAuthenticate()).to.equal('open-api-authenticate');
      expect(namespaceOptions.getUserAuthenticate()).to.equal('user-authenticate');
      expect(namespaceOptions.getUserInfo({ userInfo: { id: 'user-1' } })).to.deep.equal({ id: 'user-1' });
      expect(namespaceOptions.getUserModel()).to.equal('user-model');
      await cronJobs[0].onTick(fastify);
      expect(forceEndCallCount).to.equal(1);
      expect(appendedTasks[0].tasks['record-video']({ task: { input: { id: 1 } } })).to.deep.equal({ saved: { id: 1 } });
      expect(appendedTasks[0].tasks['record-video']({ task: { input: { id: 1 } }, result: { id: 2 } })).to.deep.equal({ saved: { id: 2 } });
    });

    it('should throw default authenticate dependency errors when required plugins are absent', async () => {
      const pluginPath = path.resolve(__dirname, '../index.js');
      const originalLoad = Module._load;
      const dependencyStubs = new Map([
        ['@kne/fastify-trtc', async () => {}],
        ['@kne/fastify-shorten', async () => {}],
        ['@kne/fastify-namespace', async () => {}]
      ]);
      Module._load = (request, parent, isMain) => dependencyStubs.get(request) || originalLoad(request, parent, isMain);
      delete require.cache[pluginPath];
      const plugin = require(pluginPath);
      Module._load = originalLoad;

      let namespaceOptions;
      const fastify = {
        register: (target, options) => {
          namespaceOptions = options.options || namespaceOptions;
        },
        sequelize: { addModels: async () => [] },
        cron: { createJob: () => {} },
        task: { services: { append: () => {} } },
        after: callback => callback()
      };
      await plugin(fastify, {});

      expect(() => namespaceOptions.getOpenApiAuthenticate()).to.throw('fastify-signature plugin must be registered before fastify-trtc-conference,or set options.getUserAuthenticate');
      expect(() => namespaceOptions.getUserAuthenticate()).to.throw('fastify-account plugin must be registered before fastify-trtc-conference,or set options.getUserAuthenticate');
      expect(() => namespaceOptions.getUserModel()).to.throw('fastify-account plugin must be registered before fastify-trtc-conference,or set options.getUserModel');
    });
  });

  describe('控制器路由测试', () => {
    const createControllerFastify = () => {
      const routes = [];
      const serviceCalls = [];
      const services = {};
      [
        'getConferenceDetail',
        'saveMember',
        'inviteMember',
        'joinConference',
        'removeMember',
        'enterConference',
        'startAITranscription',
        'stopAITranscription',
        'recordAITranscription',
        'recordClientEvents',
        'endConference',
        'cancelConference',
        'getConferenceList',
        'getAiTranscriptionContentById',
        'getTrtcInstanceEventsById',
        'createConference',
        'saveConference',
        'deleteConference',
        'getMemberShorten',
        'inviteMemberFromUser',
        'getConferenceDetailByShorten',
        'getConferenceDetailById',
        'extendConferenceDurationByMember',
        'updateConferenceDuration',
        'getConferenceRoomStatusById'
      ].forEach(name => {
        services[name] = async (...args) => {
          serviceCalls.push({ name, args });
          return { name, args };
        };
      });
      return {
        routes,
        serviceCalls,
        fastify: {
          conference: { services },
          shorten: { authenticate: { code: async () => {} } },
          get: (url, config, handler) => routes.push({ method: 'GET', url, config, handler }),
          post: (url, config, handler) => routes.push({ method: 'POST', url, config, handler })
        }
      };
    };

    it('should register user routes and forward requests to services', async () => {
      const { fastify, routes, serviceCalls } = createControllerFastify();
      const userAuthenticate = async () => {};
      await require('../libs/controllers/main')(fastify, {
        name: 'conference',
        shortenName: 'shorten',
        prefix: '/api/conference',
        getUserAuthenticate: () => userAuthenticate,
        getUserInfo: request => request.userInfo
      });

      expect(routes.map(route => route.url)).to.include.members(['/api/conference/detail', '/api/conference/create', '/api/conference/inviteMemberFromUser']);
      const detailRoute = routes.find(route => route.url === '/api/conference/detail');
      expect(detailRoute.config.onRequest).to.equal(undefined);
      await detailRoute.handler({ query: { code: 'invite-code' }, headers: {} });
      await routes.find(route => route.url === '/api/conference/saveMember').handler({ authenticatePayload: { id: '1' }, body: { nickname: 'New' } });
      await routes.find(route => route.url === '/api/conference/create').handler({ userInfo: { id: 'user-1' }, body: { name: 'Daily' } });
      const listRoute = routes.find(route => route.url === '/api/conference/list');
      await listRoute.handler({ authenticatePayload: { id: 'user-1' }, query: { perPage: 20, currentPage: 1, record: 'video', speech: true } });

      expect(listRoute.config.onRequest[0]).to.equal(userAuthenticate);
      expect(listRoute.config.schema.query.properties.record.enum).to.deep.equal(['audio', 'video']);
      expect(listRoute.config.schema.query.properties.speech.type).to.equal('boolean');
      expect(serviceCalls.map(call => call.name)).to.deep.equal(['getConferenceDetailByShorten', 'saveMember', 'createConference', 'getConferenceList']);
      expect(serviceCalls[0].args).to.deep.equal(['invite-code']);
      expect(serviceCalls[3].args[1]).to.include({ record: 'video', speech: true });
    });

    it('should forward every user route to the expected service', async () => {
      const { fastify, routes, serviceCalls } = createControllerFastify();
      await require('../libs/controllers/main')(fastify, {
        name: 'conference',
        shortenName: 'shorten',
        prefix: '/api/conference',
        getUserAuthenticate: () => async () => {},
        getUserInfo: request => request.userInfo
      });
      const expectedServices = {
        '/api/conference/detail': 'getConferenceDetailByShorten',
        '/api/conference/saveMember': 'saveMember',
        '/api/conference/inviteMember': 'inviteMember',
        '/api/conference/join': 'joinConference',
        '/api/conference/removeMember': 'removeMember',
        '/api/conference/enter': 'enterConference',
        '/api/conference/extendDuration': 'extendConferenceDurationByMember',
        '/api/conference/startAITranscription': 'startAITranscription',
        '/api/conference/stopAITranscription': 'stopAITranscription',
        '/api/conference/recordAITranscription': 'recordAITranscription',
        '/api/conference/recordClientEvents': 'recordClientEvents',
        '/api/conference/end': 'endConference',
        '/api/conference/cancel': 'cancelConference',
        '/api/conference/list': 'getConferenceList',
        '/api/conference/getAiTranscriptionContent': 'getAiTranscriptionContentById',
        '/api/conference/getTrtcInstanceEvents': 'getTrtcInstanceEventsById',
        '/api/conference/create': 'createConference',
        '/api/conference/save': 'saveConference',
        '/api/conference/delete': 'deleteConference',
        '/api/conference/getMemberShorten': 'getMemberShorten',
        '/api/conference/inviteMemberFromUser': 'inviteMemberFromUser'
      };

      for (const route of routes) {
        await route.handler({
          authenticatePayload: { id: 'member-1', conferenceId: 'conference-1' },
          userInfo: { id: 'user-1' },
          body: { id: 'conference-1', name: 'Daily' },
          query: { id: 'conference-1', code: 'invite-code', perPage: 20, currentPage: 1 },
          headers: {}
        });
      }

      expect(serviceCalls.map(call => call.name)).to.deep.equal(routes.map(route => expectedServices[route.url]));
    });

    it('should register open api routes and forward requests to services', async () => {
      const { fastify, routes, serviceCalls } = createControllerFastify();
      const openApiAuthenticate = async () => {};
      await require('../libs/controllers/open-api')(fastify, {
        name: 'conference',
        prefix: '/api/conference',
        getOpenApiAuthenticate: () => openApiAuthenticate
      });

      const health = await routes.find(route => route.url === '/api/conference/open-api/health').handler({ openApiPayload: { id: 'open-api-user' } });
      await routes.find(route => route.url === '/api/conference/open-api/create').handler({ openApiPayload: { id: 'open-api-user' }, body: { name: 'Open API' } });
      await routes.find(route => route.url === '/api/conference/open-api/detail').handler({ openApiPayload: { id: 'open-api-user' }, query: { id: '1' } });
      await routes.find(route => route.url === '/api/conference/open-api/cancel').handler({ openApiPayload: { id: 'open-api-user' }, body: { id: '1' } });
      await routes.find(route => route.url === '/api/conference/open-api/aiTranscriptionContent').handler({ openApiPayload: { id: 'open-api-user' }, query: { id: '1' } });
      await routes.find(route => route.url === '/api/conference/open-api/roomStatus').handler({ openApiPayload: { id: 'open-api-user' }, query: { id: '1' } });

      expect(health).to.deep.equal({ success: true, userInfo: { id: 'open-api-user' }, message: 'openApi服务正常' });
      expect(routes.every(route => route.config.onRequest[0] === openApiAuthenticate)).to.be.true;
      expect(serviceCalls.map(call => call.name)).to.deep.equal([
        'createConference',
        'getConferenceDetailById',
        'cancelConference',
        'getAiTranscriptionContentById',
        'getConferenceRoomStatusById'
      ]);
    });
  });

  describe('服务层会议测试', () => {
    it('should create conference, include current user and sign members', async () => {
      const { services, members, signedPayloads } = await createServiceContext();
      const result = await services.createConference(
        { id: 'user-1', nickname: 'Owner', email: 'owner@test.com', avatar: 'avatar.png' },
        {
          includingMe: true,
          name: 'Daily',
          duration: 30,
          maxCount: 3,
          members: [{ nickname: 'Guest', email: 'guest@test.com', isMaster: false }],
          options: { setting: { record: true } }
        }
      );

      expect(result.members).to.have.length(2);
      expect(Array.from(members.values()).every(member => member.shorten)).to.be.true;
      expect(JSON.parse(signedPayloads.get(result.members[0].shorten))).to.include({ conferenceId: result.id });
    });

    it('should reject create requests without a master or with too many members', async () => {
      const { services } = await createServiceContext();
      await expectReject(services.createConference({ id: 'user-1' }, { includingMe: false, members: [] }), 'At least one master is needed');
      await expectReject(services.createConference({ id: 'user-1' }, { includingMe: true, maxCount: 1, members: [{ isMaster: false }] }), 'Members exceed the limit');
    });

    it('should reject creating conferences whose end time is in the past', async () => {
      const { services, conferences } = await createServiceContext();

      await expectReject(
        services.createConference(
          { id: 'user-1' },
          {
            includingMe: true,
            startTime: new Date(Date.now() - 60 * 60 * 1000),
            duration: 1,
            members: []
          }
        ),
        'Conference end time must be in the future'
      );
      expect(conferences.size).to.equal(0);
    });

    it('should save and delete conference only for owner', async () => {
      const { services, conferences } = await createServiceContext();
      const conference = await services.createConference({ id: 'user-1' }, { includingMe: true, name: 'Daily', duration: 30, maxCount: 3, members: [] });

      const saved = await services.saveConference({ id: 'user-1' }, { id: conference.id, name: 'Updated', duration: 45, maxCount: 4, options: { setting: { speech: true } } });
      expect(saved).to.include({ name: 'Updated', duration: 45, maxCount: 4 });
      await expectReject(services.saveConference({ id: 'user-2' }, { id: conference.id, name: 'Updated', duration: 45, maxCount: 4 }), 'Data has expired, please refresh the page and try again');
      await expectReject(services.saveConference({ id: 'user-1' }, { id: conference.id, name: 'Updated', duration: 10, maxCount: 4 }), 'Duration cannot be less than before');
      await expectReject(services.saveConference({ id: 'user-1' }, { id: conference.id, name: 'Updated', duration: 45, maxCount: 2 }), 'MaxCount cannot be less than before');

      await services.deleteConference({ id: 'user-1' }, { id: conference.id });
      expect(conferences.get(conference.id).destroyed).to.be.true;
    });

    it('should list conferences and force end expired ones with cleanup', async () => {
      const { services, conferences, calls } = await createServiceContext();
      const oldConference = createEntity({ id: 'old', userId: 'user-1', status: 0, startTime: new Date(Date.now() - 60 * 60 * 1000), duration: 1, options: {} });
      const activeConference = createEntity({ id: 'active', userId: 'user-1', status: 0, startTime: new Date(Date.now() + 60 * 60 * 1000), duration: 30 });
      conferences.set(oldConference.id, oldConference);
      conferences.set(activeConference.id, activeConference);

      const result = await services.getConferenceList({ id: 'user-1' }, { perPage: 20, currentPage: 1 });

      expect(result.totalCount).to.equal(2);
      expect(conferences.get('old').status).to.equal(1);
      expect(conferences.get('active').status).to.equal(0);
      expect(calls.trtc.dismisses[0]).to.deep.equal({ roomId: 'old', options: undefined });
    });

    it('should force end expired conferences outside the current list page', async () => {
      const { services, conferences, calls } = await createServiceContext();
      const activeConference = createEntity({ id: 'active', userId: 'user-1', status: 0, startTime: new Date(Date.now() + 60 * 60 * 1000), duration: 30, options: {} });
      const oldConference = createEntity({ id: 'old', userId: 'user-1', status: 0, startTime: new Date(Date.now() - 60 * 60 * 1000), duration: 1, options: {} });
      conferences.set(activeConference.id, activeConference);
      conferences.set(oldConference.id, oldConference);

      const result = await services.getConferenceList({ id: 'user-1' }, { perPage: 1, currentPage: 1 });

      expect(result.pageData).to.deep.equal([activeConference]);
      expect(oldConference.status).to.equal(1);
      expect(calls.trtc.dismisses[0]).to.deep.equal({ roomId: 'old', options: undefined });
    });

    it('should mark expired list conferences ended when cleanup fails', async () => {
      const { fastify, services, conferences } = await createServiceContext();
      const oldConference = createEntity({ id: 'old', userId: 'user-1', status: 0, startTime: new Date(Date.now() - 60 * 60 * 1000), duration: 1, options: {} });
      conferences.set(oldConference.id, oldConference);
      fastify.trtc.services.dismiss = async () => {
        throw new Error('TRTC service unavailable');
      };

      const result = await services.getConferenceList({ id: 'user-1' }, { perPage: 20, currentPage: 1 });

      expect(oldConference.status).to.equal(1);
      expect(result.pageData[0].status).to.equal(1);
    });

    it('should filter conference list by keyword, date, recording and speech recognition', async () => {
      const { services, conferences } = await createServiceContext();
      conferences.set(
        'match',
        createEntity({
          id: 'match',
          userId: 'user-1',
          name: '产品需求评审',
          status: 0,
          startTime: new Date('2026-06-05T10:00:00.000Z'),
          duration: 30,
          options: { setting: { record: 'video', speech: true } }
        })
      );
      conferences.set(
        'other-name',
        createEntity({
          id: 'other-name',
          userId: 'user-1',
          name: '技术架构讨论',
          status: 0,
          startTime: new Date('2026-06-05T14:00:00.000Z'),
          duration: 30,
          options: { setting: { record: 'audio', speech: false } }
        })
      );
      conferences.set(
        'other-date',
        createEntity({
          id: 'other-date',
          userId: 'user-1',
          name: '产品需求评审复盘',
          status: 0,
          startTime: new Date('2026-06-06T10:00:00.000Z'),
          duration: 30,
          options: { setting: { record: 'video', speech: false } }
        })
      );

      const keywordResult = await services.getConferenceList({ id: 'user-1' }, { perPage: 20, currentPage: 1, keyword: '产品' });
      expect(keywordResult.totalCount).to.equal(2);
      expect(keywordResult.pageData.map(item => item.id)).to.deep.equal(['other-date', 'match']);

      const dateResult = await services.getConferenceList({ id: 'user-1' }, { perPage: 20, currentPage: 1, date: '2026-06-05' });
      expect(dateResult.totalCount).to.equal(2);
      expect(dateResult.pageData.map(item => item.id)).to.deep.equal(['other-name', 'match']);

      const combinedResult = await services.getConferenceList(
        { id: 'user-1' },
        { perPage: 20, currentPage: 1, keyword: '产品', date: '2026-06-05' }
      );
      expect(combinedResult.totalCount).to.equal(1);
      expect(combinedResult.pageData[0].id).to.equal('match');

      const recordResult = await services.getConferenceList({ id: 'user-1' }, { perPage: 20, currentPage: 1, record: 'video' });
      expect(recordResult.totalCount).to.equal(2);
      expect(recordResult.pageData.map(item => item.id)).to.deep.equal(['other-date', 'match']);

      const speechResult = await services.getConferenceList({ id: 'user-1' }, { perPage: 20, currentPage: 1, speech: false });
      expect(speechResult.totalCount).to.equal(2);
      expect(speechResult.pageData.map(item => item.id)).to.deep.equal(['other-date', 'other-name']);

      const settingResult = await services.getConferenceList(
        { id: 'user-1' },
        { perPage: 20, currentPage: 1, record: 'video', speech: true }
      );
      expect(settingResult.totalCount).to.equal(1);
      expect(settingResult.pageData[0].id).to.equal('match');
    });

    it('should force end expired conferences with conference cleanup actions', async () => {
      const { services, conferences, calls } = await createServiceContext();
      const expiredConference = createEntity({
        id: 'expired',
        name: 'Expired Meeting',
        userId: 'user-1',
        status: 0,
        startTime: new Date(Date.now() - 60 * 60 * 1000),
        duration: 1,
        options: { setting: { record: true, speech: true }, recordTaskId: 'record-task-id', aiTranscription: { id: 'ai-task-id' } }
      });
      const activeConference = createEntity({ id: 'active', userId: 'user-1', status: 0, startTime: new Date(Date.now() + 60 * 60 * 1000), duration: 30, options: {} });
      const endedConference = createEntity({ id: 'ended', userId: 'user-1', status: 1, startTime: new Date(Date.now() - 60 * 60 * 1000), duration: 1, options: {} });
      conferences.set(expiredConference.id, expiredConference);
      conferences.set(activeConference.id, activeConference);
      conferences.set(endedConference.id, endedConference);

      const result = await services.forceEndExpiredConferences();

      expect(result).to.deep.equal([{ id: 'expired', success: true }]);
      expect(expiredConference.status).to.equal(1);
      expect(activeConference.status).to.equal(0);
      expect(calls.trtc.stopAITranscriptions[0]).to.deep.equal({ id: 'ai-task-id', roomId: 'expired', options: expiredConference.options.setting });
      expect(calls.trtc.dismisses[0]).to.deep.equal({ roomId: 'expired', options: expiredConference.options.setting });
      expect(calls.trtc.stopRecords[0]).to.deep.equal({ id: 'record-task-id', roomId: 'expired', options: expiredConference.options.setting });
      expect(calls.taskCreates[0]).to.include({ type: 'record-video', targetId: 'expired', targetType: 'conference', targetName: 'Expired Meeting' });
    });

    it('should finish expired conference when trtc room no longer exists', async () => {
      const { fastify, services, conferences } = await createServiceContext();
      const expiredConference = createEntity({
        id: 'missing-room',
        name: 'Missing Room Meeting',
        userId: 'user-1',
        status: 0,
        startTime: new Date(Date.now() - 60 * 60 * 1000),
        duration: 1,
        options: {}
      });
      conferences.set(expiredConference.id, expiredConference);
      fastify.trtc.services.dismiss = async () => {
        throw new Error('room not exist');
      };

      const result = await services.forceEndExpiredConferences();

      expect(result).to.deep.equal([{ id: 'missing-room', success: true }]);
      expect(expiredConference.status).to.equal(1);
    });

    it('should use seconds when checking conference expiration', async () => {
      const { services, conferences } = await createServiceContext();
      const notExpired = createEntity({ id: 'not-expired', userId: 'user-1', status: 0, startTime: new Date(Date.now() - 30 * 1000), duration: 60, options: {} });
      conferences.set(notExpired.id, notExpired);

      const result = await services.forceEndExpiredConferences();

      expect(result).to.deep.equal([]);
      expect(notExpired.status).to.equal(0);
    });

    it('should get conference detail with inviter and expire stale conference', async () => {
      const { services, conferences, members } = await createServiceContext();
      const conference = createEntity({ id: 'conference-1', userId: 'user-1', status: 0, startTime: new Date(Date.now() - 60 * 60 * 1000), duration: 1 });
      const member = createEntity({ id: 'member-1', conferenceId: 'conference-1', isMaster: true });
      const inviter = createEntity({ id: 'member-2', conferenceId: 'conference-1', isMaster: false });
      conferences.set(conference.id, conference);
      members.set(member.id, member);
      members.set(inviter.id, inviter);

      const result = await services.getConferenceDetail({ id: 'member-1', conferenceId: 'conference-1', inviterId: 'member-2' });

      expect(result.member).to.equal(member);
      expect(result.inviter).to.equal(inviter);
      expect(conference.status).to.equal(1);
    });

    it('should force end expired conference during lookup and return it', async () => {
      const { services, conferences, calls } = await createServiceContext();
      const conference = createEntity({ id: 'conference-1', userId: 'user-1', status: 0, startTime: new Date(Date.now() - 60 * 60 * 1000), duration: 1, options: {} });
      conferences.set(conference.id, conference);

      const result = await services.getConference({ id: conference.id });

      expect(result).to.equal(conference);
      expect(result.status).to.equal(1);
      expect(calls.trtc.dismisses[0]).to.deep.equal({ roomId: conference.id, options: undefined });
    });

    it('should reject missing, ended or canceled conference lookups', async () => {
      const { services, conferences } = await createServiceContext();
      conferences.set('ended', createEntity({ id: 'ended', status: 1 }));
      conferences.set('canceled', createEntity({ id: 'canceled', status: 2 }));

      await expectReject(services.getConference({}), 'Conference does not exist or has ended');
      await expectReject(services.getConference({ id: 'missing' }), 'Conference does not exist');
      await expectReject(services.getConference({ id: 'ended', status: 0 }), 'Conference has ended');
      await expectReject(services.getConference({ id: 'canceled', status: 0 }), 'Conference has been canceled');
    });
  });

  describe('服务层成员和会议操作测试', () => {
    it('should save member fields and handle invite flows', async () => {
      const { services, conferences, members } = await createServiceContext();
      const conference = createEntity({ id: 'conference-1', userId: 'user-1', status: 0, options: {} });
      const master = createEntity({ id: 'master-1', conferenceId: conference.id, isMaster: true, nickname: 'Master' });
      const guest = createEntity({ id: 'guest-1', conferenceId: conference.id, isMaster: false });
      conferences.set(conference.id, conference);
      members.set(master.id, master);
      members.set(guest.id, guest);

      await services.saveMember({ id: guest.id }, { email: 'new@test.com', name: 'Guest', ignored: true });
      const invited = await services.inviteMember({ id: master.id, conferenceId: conference.id, isMaster: true });
      const userInvited = await services.inviteMemberFromUser({ id: 'user-1', nickname: 'Owner' }, { id: conference.id });

      expect(guest).to.include({ email: 'new@test.com', nickname: 'Guest' });
      expect(invited).to.include({ inviter: master, conference });
      expect(userInvited.inviter).to.deep.equal({ fromUser: true, nickname: 'Owner' });
      await expectReject(services.inviteMember({ id: guest.id, conferenceId: conference.id, isMaster: false }), 'Only the master can invite members');
      await expectReject(services.inviteMemberFromUser({ id: 'other-user' }, { id: conference.id }), 'Only the conference creator can perform this operation');
    });

    it('should join conference after validating inviter, status and capacity', async () => {
      const { services, conferences, members } = await createServiceContext();
      const conference = createEntity({ id: 'conference-1', userId: 'user-1', status: 0, maxCount: 2, options: {} });
      const master = createEntity({ id: 'master-1', conferenceId: conference.id, isMaster: true });
      const guest = createEntity({ id: 'guest-1', conferenceId: conference.id, isMaster: false });
      conferences.set(conference.id, conference);
      members.set(master.id, master);

      const result = await services.joinConference({ inviterId: master.id, conferenceId: conference.id }, { name: 'New Guest', email: 'new@test.com' });
      expect(result.shorten).to.equal('shorten-1');
      expect(Array.from(members.values()).find(member => member.email === 'new@test.com').nickname).to.equal('New Guest');
      members.set(guest.id, guest);

      await expectReject(services.joinConference({ inviterId: guest.id, conferenceId: conference.id }, {}), 'Only the master can invite members');
      await expectReject(services.joinConference({ fromUser: true, conferenceId: conference.id }, {}), 'The conference is full');
    });

    it('should enter conference, join trtc and start record once for master', async () => {
      const { services, conferences, members, calls } = await createServiceContext();
      const conference = createEntity({ id: 'conference-1', userId: 'user-1', status: 0, startTime: new Date(Date.now() - 1000), duration: 30, options: { setting: { record: true } } });
      const member = createEntity({ id: 'master-1', conferenceId: conference.id, isMaster: true });
      conferences.set(conference.id, conference);
      members.set(member.id, member);

      const result = await services.enterConference({ id: member.id, conferenceId: conference.id, isMaster: true });

      expect(result.sign).to.deep.equal({ sdkAppId: 1400000000, userId: member.id, userSig: 'mock-user-sig' });
      expect(conference.options.recordTaskId).to.equal('record-task-id');
      expect(calls.trtc.startRecords[0]).to.deep.equal({ roomId: conference.id, roomIdType: 0, options: conference.options.setting, recordParams: { StreamType: 0 } });

      conference.startTime = new Date(Date.now() + 60 * 1000);
      await expectReject(services.enterConference({ id: member.id, conferenceId: conference.id }), 'The conference has not yet started');
    });

    it('should set audio or video stream type when starting record', async () => {
      const { services, conferences, members, calls } = await createServiceContext();
      const audioConference = createEntity({ id: 'audio-conference', userId: 'user-1', status: 0, startTime: new Date(Date.now() - 1000), duration: 30, options: { setting: { record: 'audio' } } });
      const videoConference = createEntity({ id: 'video-conference', userId: 'user-1', status: 0, startTime: new Date(Date.now() - 1000), duration: 30, options: { setting: { record: 'video' } } });
      const audioMaster = createEntity({ id: 'audio-master', conferenceId: audioConference.id, isMaster: true });
      const videoMaster = createEntity({ id: 'video-master', conferenceId: videoConference.id, isMaster: true });
      conferences.set(audioConference.id, audioConference);
      conferences.set(videoConference.id, videoConference);
      members.set(audioMaster.id, audioMaster);
      members.set(videoMaster.id, videoMaster);

      await services.enterConference({ id: audioMaster.id, conferenceId: audioConference.id, isMaster: true });
      await services.enterConference({ id: videoMaster.id, conferenceId: videoConference.id, isMaster: true });

      expect(calls.trtc.startRecords[0].recordParams).to.deep.equal({ StreamType: 1 });
      expect(calls.trtc.startRecords[1].recordParams).to.deep.equal({ StreamType: 0 });
    });

    it('should remove members, end conference and create record task', async () => {
      const { services, conferences, members, calls } = await createServiceContext();
      const conference = createEntity({ id: 'conference-1', name: 'Weekly Meeting', userId: 'user-1', status: 0, options: { setting: { record: true, speech: true }, recordTaskId: 'record-task-id', aiTranscription: { id: 'ai-task-id' } } });
      const master = createEntity({ id: 'master-1', conferenceId: conference.id, isMaster: true });
      const guest = createEntity({ id: 'guest-1', conferenceId: conference.id, isMaster: false, shorten: 'guest-shorten' });
      conferences.set(conference.id, conference);
      members.set(master.id, master);
      members.set(guest.id, guest);

      await services.removeMember({ conferenceId: conference.id, isMaster: true }, { id: guest.id });
      await services.endConference({ id: master.id, conferenceId: conference.id, isMaster: true }, { id: conference.id });

      expect(guest.destroyed).to.be.true;
      expect(calls.removedShortens).to.deep.equal(['guest-shorten']);
      expect(conference.status).to.equal(1);
      expect(calls.trtc.dismisses[0]).to.deep.equal({ roomId: conference.id, options: conference.options.setting });
      expect(calls.trtc.stopRecords[0]).to.deep.equal({ id: 'record-task-id', roomId: conference.id, options: conference.options.setting });
      expect(calls.taskCreates[0]).to.include({ type: 'record-video', targetId: conference.id, targetType: 'conference', targetName: 'Weekly Meeting' });
      await expectReject(services.removeMember({ conferenceId: conference.id, isMaster: false }, { id: guest.id }), 'Only the master can remove members');
      await expectReject(services.endConference({ id: master.id, conferenceId: conference.id, isMaster: false }, { id: conference.id }), 'Only the master can end the conference');
      await expectReject(
        services.endConference({ id: master.id, conferenceId: conference.id, isMaster: true }, { id: 'another' }),
        'The current conference is invalid, possibly because multiple conferences were opened simultaneously. Please refresh the page to get the latest conference information'
      );
    });

    it('should cancel future conferences only by master or creator', async () => {
      const { services, conferences } = await createServiceContext();
      const conference = createEntity({ id: 'conference-1', userId: 'user-1', status: 0, startTime: new Date(Date.now() + 60 * 1000), options: {} });
      conferences.set(conference.id, conference);

      await services.cancelConference({ conferenceId: conference.id, isMaster: true }, { id: conference.id });
      expect(conference.status).to.equal(2);

      conference.status = 0;
      await services.cancelConference({ id: 'user-1' }, { id: conference.id });
      expect(conference.status).to.equal(2);

      conference.status = 1;
      conference.startTime = new Date(Date.now() + 60 * 1000);
      await services.cancelConference({ conferenceId: conference.id, isMaster: true }, { id: conference.id });
      expect(conference.status).to.equal(2);

      conference.status = 0;
      await expectReject(services.cancelConference({ id: 'user-2' }, { id: conference.id }), 'Only the conference creator can perform this operation');

      conference.startTime = new Date(Date.now() - 60 * 1000);
      await expectReject(services.cancelConference({ conferenceId: conference.id, isMaster: true }, { id: conference.id }), 'The conference has already started and cannot be canceled');
      await expectReject(services.cancelConference({ conferenceId: conference.id, isMaster: false }, { id: conference.id }), 'Only the master can cancel the conference');
      await expectReject(
        services.cancelConference({ conferenceId: conference.id, isMaster: true }, { id: 'another' }),
        'The current conference is invalid, possibly because multiple conferences were opened simultaneously. Please refresh the page to get the latest conference information'
      );
    });

    it('should end expired conference during cancel flow', async () => {
      const { services, conferences, calls } = await createServiceContext();
      const conference = createEntity({ id: 'conference-1', userId: 'user-1', status: 0, startTime: new Date(Date.now() - 60 * 60 * 1000), duration: 1, options: {} });
      conferences.set(conference.id, conference);

      await services.cancelConference({ conferenceId: conference.id, isMaster: true }, { id: conference.id });

      expect(conference.status).to.equal(1);
      expect(calls.trtc.dismisses[0]).to.deep.equal({ roomId: conference.id, options: undefined });
    });
  });

  describe('服务层 AI 与录像测试', () => {
    it('should start, record, stop and read AI transcription content', async () => {
      const { services, conferences, members, aiContents, calls } = await createServiceContext();
      const conference = createEntity({ id: 'conference-1', userId: 'user-1', status: 0, options: { setting: { speech: true, language: 'en' }, aiTranscription: { id: 'existing-task' } } });
      const master = createEntity({ id: 'master-1', conferenceId: conference.id, isMaster: true });
      conferences.set(conference.id, conference);
      members.set(master.id, master);

      await services.startAITranscription({ id: master.id, conferenceId: conference.id, isMaster: true });
      await services.recordAITranscription({ id: master.id, conferenceId: conference.id }, { messages: [{ records: [{ text: 'hello' }] }] });
      await services.stopAITranscription({ id: master.id, conferenceId: conference.id, isMaster: true });
      const content = await services.getAiTranscriptionContentById({ id: 'user-1' }, { id: conference.id });

      expect(calls.trtc.startAITranscriptions[0]).to.include({ roomId: conference.id, language: 'en', taskId: 'existing-task' });
      expect(Array.from(aiContents.values())[0].content).to.deep.equal([{ text: 'hello' }]);
      expect(calls.trtc.stopAITranscriptions[0]).to.deep.equal({ id: 'existing-task', roomId: conference.id, options: conference.options.setting });
      expect(content.content).to.deep.equal([{ text: 'hello' }]);
    });

    it('should skip AI operations when not enabled or empty and reject non-master actions', async () => {
      const { services, conferences, members, aiContents, calls } = await createServiceContext();
      const conference = createEntity({ id: 'conference-1', userId: 'user-1', status: 0, options: { setting: { speech: false } } });
      const member = createEntity({ id: 'member-1', conferenceId: conference.id, isMaster: false });
      conferences.set(conference.id, conference);
      members.set(member.id, member);

      await services.startAITranscription({ id: member.id, conferenceId: conference.id, isMaster: true });
      await services.recordAITranscription({ id: member.id, conferenceId: conference.id }, { records: [] });
      await services.stopAITranscription({ id: member.id, conferenceId: conference.id, isMaster: true });
      const content = await services.getAiTranscriptionContentById({ id: 'user-1' }, { id: conference.id });

      expect(calls.trtc.startAITranscriptions).to.have.length(0);
      expect(aiContents.size).to.equal(0);
      expect(content).to.deep.equal({});
      await expectReject(services.startAITranscription({ id: member.id, conferenceId: conference.id, isMaster: false }), 'Only the master can start the transcription');
      await expectReject(services.stopAITranscription({ id: member.id, conferenceId: conference.id, isMaster: false }), 'Only the master can stop the transcription');
    });

    it('should get trtc instance events by conference id', async () => {
      const { services, conferences, calls } = await createServiceContext();
      const conference = createEntity({ id: 'conference-1', userId: 'user-1', status: 1, options: {} });
      conferences.set(conference.id, conference);

      const result = await services.getTrtcInstanceEventsById({ id: 'user-1' }, { id: conference.id, perPage: 50, currentPage: 2 });

      expect(result).to.deep.equal({ pageData: [{ id: 'event-1' }], totalCount: 1 });
      expect(calls.trtc.instanceEventLists[0]).to.deep.equal({
        authenticatePayload: { id: 'user-1' },
        payload: { filter: { roomId: conference.id }, perPage: 50, currentPage: 2 }
      });
    });

    it('should allow masters but reject normal members when reading trtc instance events', async () => {
      const { services, conferences, members } = await createServiceContext();
      const conference = createEntity({ id: 'conference-1', userId: 'creator-1', status: 1, options: {} });
      const master = createEntity({ id: 'master-1', conferenceId: conference.id, isMaster: true });
      const attendee = createEntity({ id: 'attendee-1', conferenceId: conference.id, isMaster: false });
      conferences.set(conference.id, conference);
      members.set(master.id, master);
      members.set(attendee.id, attendee);

      const result = await services.getTrtcInstanceEventsById({ id: master.id }, { id: conference.id });

      expect(result).to.deep.equal({ pageData: [{ id: 'event-1' }], totalCount: 1 });
      await expectReject(
        services.getTrtcInstanceEventsById({ id: attendee.id }, { id: conference.id }),
        'Only the conference creator or master can view room events'
      );
    });

    it('should sync trtc instance events when list is empty', async () => {
      const { services, conferences, fastify } = await createServiceContext();
      const conference = createEntity({ id: 'conference-1', userId: 'user-1', status: 1, options: { setting: { region: 'ap-guangzhou' } } });
      const instanceCase = { id: 'case-1', roomId: conference.id };
      const syncCalls = [];
      let listCount = 0;
      conferences.set(conference.id, conference);
      fastify.trtc.models = {
        instanceCase: {
          async findOne(payload) {
            expect(payload).to.deep.equal({ where: { roomId: conference.id } });
            return instanceCase;
          }
        }
      };
      fastify.trtc.services.syncRoomUserEvents = async payload => {
        syncCalls.push(payload);
      };
      fastify.trtc.services.instanceEvent.list = async () => {
        listCount += 1;
        return listCount === 1 ? { pageData: [], totalCount: 0 } : { pageData: [{ id: 'event-1' }], totalCount: 1 };
      };

      const result = await services.getTrtcInstanceEventsById({ id: 'user-1' }, { id: conference.id });

      expect(result).to.deep.equal({ pageData: [{ id: 'event-1' }], totalCount: 1 });
      expect(listCount).to.equal(2);
      expect(syncCalls).to.deep.equal([{ instanceCase, options: conference.options.setting }]);
    });

    it('should record client trtc events and update instance user list', async () => {
      const { services, conferences, members, fastify } = await createServiceContext();
      const conference = createEntity({ id: 'conference-1', userId: 'user-1', status: 0, options: {} });
      const member = createEntity({ id: 'member-1', conferenceId: conference.id, isMaster: true });
      const instanceEvents = [];
      const instanceCase = createEntity({ id: 'case-1', roomId: conference.id, userList: {} });
      conferences.set(conference.id, conference);
      members.set(member.id, member);
      fastify.trtc.models = {
        instanceCase: {
          async findOne(payload) {
            expect(payload).to.deep.equal({ where: { roomId: conference.id } });
            return instanceCase;
          }
        },
        instanceEvent: {
          async findAll() {
            return instanceEvents;
          },
          async create(data) {
            const event = createEntity({ id: `event-${instanceEvents.length + 1}`, ...data });
            instanceEvents.push(event);
            return event;
          }
        }
      };

      await services.recordClientEvents(
        { id: member.id, conferenceId: conference.id },
        {
          events: [
            { type: 'enter', userId: member.id, time: '2026-06-08T05:00:00.000Z', data: { userType: 'local' } },
            { type: 'statistics', userId: member.id, time: '2026-06-08T05:00:02.000Z', data: { rtt: 20 } },
            { type: 'statistics', userId: member.id, time: '2026-06-08T05:00:02.000Z', data: { rtt: 20 } }
          ]
        }
      );

      expect(instanceEvents.map(item => item.code)).to.deep.equal(['Client.enter', 'Client.statistics']);
      expect(instanceEvents[1].payload.source).to.equal('ClientSDK');
      expect(instanceEvents[1].payload.reporterId).to.equal(member.id);
      expect(new Date(instanceCase.userList[member.id].startTime).toISOString()).to.equal('2026-06-08T05:00:00.000Z');
    });

    it('should ignore client trtc events when paid rest api query is enabled', async () => {
      const { services, conferences, members, fastify } = await createServiceContext({ enableRestApiQuery: true });
      const conference = createEntity({ id: 'conference-1', userId: 'user-1', status: 0, options: {} });
      const member = createEntity({ id: 'member-1', conferenceId: conference.id, isMaster: true });
      const instanceEvents = [];
      conferences.set(conference.id, conference);
      members.set(member.id, member);
      fastify.trtc.models = {
        instanceCase: {
          async findOne() {
            throw new Error('should not query instance case');
          }
        },
        instanceEvent: {
          async create(data) {
            instanceEvents.push(data);
          }
        }
      };

      await services.recordClientEvents({ id: member.id, conferenceId: conference.id }, { events: [{ type: 'enter', userId: member.id }] });

      expect(instanceEvents).to.have.length(0);
    });

    it('should save record files for all files and matching room members', async () => {
      const { services, conferences, fastify } = await createServiceContext();
      const encode = input => Buffer.from(input, 'utf8').toString('base64').replace(/\//g, '-').replace(/=/g, '.');
      const conference = createEntity({ id: 'conference-1', options: {} });
      conferences.set(conference.id, conference);
      fastify.fileManager.services.getFileInfo = async ({ id }) => ({ filename: id });
      const matching = `prefix_${encode('room-1')}_UserId_s_${encode('member-1')}_UserId_e_media.mp4`;
      const otherRoom = `prefix_${encode('room-2')}_UserId_s_${encode('member-2')}_UserId_e_media.mp4`;

      await services.saveRecordVideo({ conferenceId: conference.id, roomId: 'room-1', results: [matching, otherRoom, 'plain.mp4'] });

      expect(conference.options.recordFiles.all).to.have.length(3);
      expect(conference.options.recordFilesAchieved).to.be.true;
      expect(conference.options.recordFiles['member-1']).to.deep.equal([{ fileId: matching, filename: matching }]);
      expect(conference.options.recordFiles['member-2']).to.equal(undefined);
      await expectReject(services.saveRecordVideo({ conferenceId: 'missing', roomId: 'room-1', results: [] }), 'Conference does not exist');
    });
  });

  describe('录像任务测试', () => {
    it('should poll record task until result exists', async () => {
      const taskRunner = require('../libs/tasks/record-video');
      const fastify = {
        trtc: {
          services: {
            async checkRecord(payload) {
              expect(payload).to.deep.equal({ id: 'record-task-id', roomId: 'room-1' });
              return { result: ['file-1'] };
            }
          }
        }
      };
      const result = await taskRunner(
        fastify,
        {},
        {
          task: { input: { recordTaskId: 'record-task-id', conferenceId: 'conference-1', roomId: 'room-1' } },
          polling: async callback => callback()
        }
      );

      expect(result).to.deep.equal({ result: 'success', data: { results: ['file-1'], recordTaskId: 'record-task-id', conferenceId: 'conference-1', roomId: 'room-1' } });
    });

    it('should continue polling when record task has no result', async () => {
      const taskRunner = require('../libs/tasks/record-video');
      const result = await taskRunner(
        { trtc: { services: { checkRecord: async () => ({ result: [] }) } } },
        {},
        { task: { input: { recordTaskId: 'record-task-id', conferenceId: 'conference-1', roomId: 'room-1' } }, polling: async callback => callback() }
      );

      expect(result).to.deep.equal({});
    });
  });
});
