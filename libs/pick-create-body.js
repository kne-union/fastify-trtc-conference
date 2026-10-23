const pick = require('lodash/pick');

// 创建会议时客户端只能设置这些字段，避免把 attended、shorten、id 等成员列写进数据库
const CREATE_FIELDS = ['name', 'startTime', 'duration', 'isInvitationAllowed', 'maxCount', 'includingMe', 'origin', 'options', 'members'];
const MEMBER_FIELDS = ['name', 'nickname', 'email', 'isMaster', 'avatar'];

const pickCreateBody = body => {
  const data = pick(body, CREATE_FIELDS);
  if (Array.isArray(data.members)) {
    data.members = data.members.map(member => pick(member, MEMBER_FIELDS));
  }
  return data;
};

module.exports = pickCreateBody;
