const Fastify = require('fastify');

let expect;

describe('OpenAPI 文档完整性', function () {
  before(async () => {
    ({ expect } = await import('chai'));
  });

  it('所有路由都有 tags、summary，参数都有用途说明，并声明 200 响应', async () => {
    const fastify = Fastify({ logger: false });
    const routes = [];
    fastify.addHook('onRoute', route => route.method !== 'HEAD' && routes.push(route));
    const authenticate = async () => {};
    fastify.decorate('conference', { services: {}, models: {} });
    fastify.decorate('shorten', { authenticate: { code: authenticate }, services: {} });
    const options = {
      name: 'conference',
      shortenName: 'shorten',
      shortenHeaderName: 'x-trtc-conference-code',
      prefix: '/api/conference',
      getUserAuthenticate: () => authenticate,
      getOpenApiAuthenticate: () => authenticate,
      getUserInfo: request => request.userInfo
    };
    for (const file of ['main', 'open-api', 'im']) {
      await fastify.register(require(`../libs/controllers/${file}`), options);
    }
    await fastify.ready();

    const missing = [];
    const checkProps = (where, schema) => {
      if (!schema) return;
      [].concat(schema.oneOf || [], schema.anyOf || [], schema).forEach(item => {
        Object.entries(item.properties || {}).forEach(([key, prop]) => {
          if (!prop.description) missing.push(`${where}.${key}`);
          if (prop.type === 'object') checkProps(`${where}.${key}`, prop);
          if (prop.type === 'array' && prop.items) checkProps(`${where}.${key}[]`, prop.items);
        });
      });
    };
    routes.forEach(route => {
      const { schema = {} } = route;
      const name = `${route.method} ${route.url}`;
      if (!(schema.tags && schema.tags.length)) missing.push(`${name} tags`);
      if (!schema.summary) missing.push(`${name} summary`);
      if (!(schema.response && schema.response[200] && schema.response[200].description)) missing.push(`${name} response`);
      checkProps(`${name} body`, schema.body);
      checkProps(`${name} query`, schema.querystring || schema.query);
      checkProps(`${name} params`, schema.params);
      checkProps(`${name} headers`, schema.headers);
    });
    await fastify.close();
    expect(routes.length).to.equal(32);
    expect(missing).to.deep.equal([]);
  });
});
