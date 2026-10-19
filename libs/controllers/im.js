const fp = require('fastify-plugin');
const { assertActiveMember, conversationName, memberEmailKey } = require('../im');

module.exports = fp(async (fastify, options) => {
  const { authenticate } = fastify[options.shortenName];

  fastify.post(
    `${options.prefix}/im/session`,
    {
      onRequest: [authenticate.code],
      schema: {
        description: '进入当前会议的群聊。等待页与会中共用同一会话，参会人用邀请码身份加入。',
        summary: '获取会议 IM 会话'
      }
    },
    async request => {
      const { member } = await assertActiveMember(fastify, options, request);
      const { conversation: conversationModel, conversationMember } = fastify.im.models;
      const name = conversationName(member.conferenceId);
      let conversation = await conversationModel.findOne({ where: { type: 'group', name } });
      if (!conversation) {
        conversation = await conversationModel.create({
          type: 'group',
          name,
          options: { conferenceId: String(member.conferenceId) }
        });
      }

      const email = memberEmailKey(member.id);
      const nickname = member.nickname || member.email || `参会者${member.id}`;
      const avatar = typeof member.avatar === 'string' && /^(https?:)?\/\//.test(member.avatar) ? member.avatar : '';
      let imMember = await conversationMember.findOne({
        where: { conversationId: conversation.id, email }
      });
      if (!imMember) {
        imMember = await conversationMember.create({
          conversationId: conversation.id,
          userId: null,
          role: 'member',
          nickname,
          avatar,
          email
        });
      } else {
        await imMember.update({
          leftAt: null,
          nickname,
          avatar
        });
      }

      const wsToken = await fastify[options.shortenName].services.sign(
        JSON.stringify({
          target: 'im',
          conversationId: String(conversation.id),
          memberId: String(imMember.id)
        }),
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      );

      return {
        conversationId: String(conversation.id),
        memberId: String(imMember.id),
        wsToken,
        nickname
      };
    }
  );
});
