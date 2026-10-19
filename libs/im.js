const conversationName = conferenceId => `conference:${conferenceId}`;
const memberEmailKey = memberId => `conference-member:${memberId}`;

const assertActiveMember = async (fastify, options, request) => {
  const { id: memberId, conferenceId } = request.authenticatePayload || {};
  const member = await fastify[options.name].models.member.findByPk(memberId);
  if (!member || String(member.conferenceId) !== String(conferenceId)) {
    const error = new Error('会议成员无效');
    error.statusCode = 403;
    throw error;
  }
  const conference = await fastify[options.name].models.conference.findByPk(conferenceId);
  if (!conference || conference.status !== 0) {
    const error = new Error('会议未在进行中');
    error.statusCode = 403;
    throw error;
  }
  return { member, conference, memberId };
};

module.exports = { conversationName, memberEmailKey, assertActiveMember };
