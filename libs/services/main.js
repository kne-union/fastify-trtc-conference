const fp = require('fastify-plugin');
const TLSSigAPIv2 = require('tls-sig-api-v2');
const dayjs = require('dayjs');
const duration = require('dayjs/plugin/duration');
dayjs.extend(duration);

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  //SecretKey
  const getUserSig = userId => {
    const api = new TLSSigAPIv2.Api(options.appId, options.appSecret);
    const userSig = api.genUserSig(userId,options.expire);
    return {
      sdkAppId: fastify.config.APP_ID,
      userId,
      userSig
    };
  };

  const createConference = async (authenticatePayload, { includingMe, name, startTime, duration, isInvitationAllowed, origin, maxCount, options, members = [] }) => {
    const { id, nickname, email, avatar } = authenticatePayload;
    if (!includingMe && !(members && members.find(item => item.isMaster))) {
      throw new Error('At least one master is needed');
    }
    if (maxCount && members.length + (includingMe ? 1 : 0) > maxCount) {
      throw new Error('Members exceed the limit');
    }

    const conference = await models.conference.create({
      name,
      startTime,
      duration,
      isInvitationAllowed,
      origin,
      maxCount,
      options,
      userId: id
    });

    const currentMembers = members.map(item =>
      Object.assign({}, item, {
        conferenceId: conference.id
      })
    );
    if (includingMe) {
      currentMembers.push({
        avatar,
        email,
        nickname,
        conferenceId: conference.id,
        isMaster: true
      });
    }

    const memberList = await models.member.bulkCreate(currentMembers);

    return Object.assign({}, conference.toJSON(), {
      members: await Promise.all(
        memberList.map(async member => {
          member.shorten = await fastify[options.shortenName].services.sign(
            JSON.stringify({
              id: member.id,
              conferenceId: member.conferenceId,
              isMaster: member.isMaster
            })
          );
          await member.save();
          return Object.assign({}, member.toJSON());
        })
      )
    });
  };

  const getConferenceList = async (authenticatePayload, { perPage, currentPage }) => {
    const { id } = authenticatePayload;
    const { rows, count } = await models.conference.findAndCountAll({
      where: {
        userId: id
      },
      include: models.member,
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [['startTime', 'DESC']]
    });

    for (let conference of rows) {
      if (conference.startTime && conference.duration && dayjs().isAfter(dayjs(conference.startTime).add(dayjs.duration(conference.duration, 'minute')))) {
        conference.status = 1;
        await conference.save();
      }
    }

    return { pageData: rows, totalCount: count };
  };

  const getConference = async ({ shorten: currentShorten, id, status }) => {
    const conferenceId = currentShorten ? JSON.parse(await fastify[options.shortenName].services.decode(currentShorten)).conferenceId : id;
    if (!conferenceId) {
      throw new Error('Conference does not exist or has ended');
    }

    const conference = await models.conference.findByPk(conferenceId, {
      include: models.member
    });

    if (!conference) {
      throw new Error('Conference does not exist');
    }

    if (status === 0 && conference.status === 1) {
      throw new Error('Conference has ended');
    }

    return conference;
  };

  const getMember = async ({ shorten: currentShorten, id, conferenceId }) => {
    const memberId = currentShorten ? JSON.parse(await fastify[options.shortenName].services.decode(currentShorten)).id : id;
    if (!memberId) {
      throw new Error('Member not found');
    }
    const member = await models.member.findByPk(memberId, {
      where: Object.assign({}, conferenceId ? { conferenceId } : {})
    });
    if (!member) {
      throw new Error('Member not found');
    }
    return member;
  };

  const getConferenceDetail = async authenticatePayload => {
    const { id, conferenceId, inviterId } = authenticatePayload;
    const conference = await getConference({ id: conferenceId });
    if (conference.startTime && conference.duration && dayjs().isAfter(dayjs(conference.startTime).add(dayjs.duration(conference.duration, 'minute')))) {
      conference.status = 1;
      await conference.save();
    }

    const member = id && (await getMember({ id }));
    const inviter = inviterId && (await getMember({ id: inviterId }));
    return { conference, member, inviter };
  };

  const saveMember = async (authenticatePayload, data) => {
    const { id } = authenticatePayload;
    const member = await getMember({ id });
    ['email', 'nickname', 'avatar'].forEach(name => {
      Object.hasOwn(data, name) && (member[name] = data[name]);
    });
    await member.save();
  };

  const inviteMember = async authenticatePayload => {
    const { isMaster: currentIsMaster, conferenceId, id } = authenticatePayload;
    if (!currentIsMaster) {
      throw new Error('Only the master can invite members');
    }
    const conference = await getConference({ id: conferenceId, status: 0 });
    const member = await getMember({ id });
    const shorten = await fastify[options.shortenName].services.sign(
      JSON.stringify({
        conferenceId,
        inviterId: id
      }),
      dayjs().add(24, 'hour').toDate()
    );
    return {
      shorten,
      inviter: member,
      conference
    };
  };

  const joinConference = async (authenticatePayload, data) => {
    const { inviterId, conferenceId } = authenticatePayload;
    const member = await getMember({ id: inviterId, conferenceId });

    if (!member.isMaster) {
      throw new Error('Only the master can invite members');
    }

    //检查会议是不是已经开始
    const conference = await getConference({ id: conferenceId, status: 0 });
    /*if (confidence.startTime && dayjs().isBefore(dayjs(confidence.startTime))) {
      throw new Error('The confidence has not yet started');
    }*/
    if (conference.startTime && conference.duration && dayjs().isAfter(dayjs(conference.startTime).add(dayjs.duration(conference.duration, 'minute')))) {
      throw new Error('The conference has ended');
    }
    if (conference.maxCount && conference.members.length >= conference.maxCount) {
      throw new Error('The conference is full');
    }

    const newMember = await models.member.create({
      ...data,
      conferenceId,
      isMaster: false
    });

    const shorten = await fastify[options.shortenName].services.sign(
      JSON.stringify({
        id: newMember.id,
        conferenceId: newMember.conferenceId,
        isMaster: false
      })
    );

    return { shorten };
  };

  const enterConference = async authenticatePayload => {
    const { id, conferenceId } = authenticatePayload;
    const conference = await getConference({ id: conferenceId, status: 0 });
    const member = await getMember({ id, conferenceId });

    if (conference.startTime && dayjs().isBefore(dayjs(conference.startTime))) {
      throw new Error('The confidence has not yet started');
    }

    if (conference.startTime && conference.duration && dayjs().isAfter(dayjs(conference.startTime).add(dayjs.duration(conference.duration, 'minute')))) {
      throw new Error('The conference has ended');
    }

    return Object.assign({}, { member, conference, sign: getUserSig(id) });
  };

  const removeMember = async (authenticatePayload, { id }) => {
    const { isMaster, conferenceId } = authenticatePayload;
    if (!isMaster) {
      throw new Error('Only the master can remove members');
    }
    const conference = await getConference({ id: conferenceId, status: 0 });
    const member = await getMember({ conferenceId: conference.id, id });
    if (!member) {
      throw new Error('Member not found');
    }
    if (member.shorten) {
      await fastify[options.shortenName].services.remove(member.shorten);
    }
    await member.destroy();
    //检查成员是否已经进入会议，调用trtc服务端接口踢出用户
  };

  const endConference = async authenticatePayload => {
    const { conferenceId, isMaster } = authenticatePayload;
    if (!isMaster) {
      throw new Error('Only the master can end the conference');
    }
    const confidence = await getConference({ id: conferenceId });
    const memberList = await models.member.findAll({ where: { conferenceId: confidence.id } });
    await Promise.all(
      memberList.map(async member => {
        if (member.shorten) {
          await fastify[options.shortenName].services.remove(member.shorten);
        }
      })
    );
    confidence.status = 1;
    await confidence.save();
    //调用trtc服务端接口结束会议
  };

  Object.assign(fastify[options.name].services, {
    getUserSig,
    createConference,
    getConferenceList,
    getConferenceDetail,
    enterConference,
    saveMember,
    inviteMember,
    getConference,
    joinConference,
    removeMember,
    endConference
  });
});
