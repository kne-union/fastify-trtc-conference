const fp = require('fastify-plugin');
const TLSSigAPIv2 = require('tls-sig-api-v2');
const dayjs = require('dayjs');
const duration = require('dayjs/plugin/duration');
const tencentcloud = require('tencentcloud-sdk-nodejs-trtc');
const get = require('lodash/get');
const uniqBy = require('lodash/uniqBy');
dayjs.extend(duration);
const TrtcClient = tencentcloud.trtc.v20190722.Client;
const COS = require('cos-nodejs-sdk-v5');
const path = require('path');

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  const getTrtcParams = props => {
    return options.getParams(Object.assign({}, props));
  };

  const getUserSig = (userId, props) => {
    const { appId, appSecret, expire } = getTrtcParams(props);
    const api = new TLSSigAPIv2.Api(appId, appSecret);
    const userSig = api.genUserSig(userId, expire || 60 * 10);
    return {
      sdkAppId: appId,
      userId,
      userSig
    };
  };

  let trtcClient;

  const getTrtcClient = () => {
    if (trtcClient) {
      return trtcClient;
    }
    trtcClient = new TrtcClient(options.tencentcloud);
    return trtcClient;
  };

  let cosClient;

  const getCosClient = () => {
    if (cosClient) {
      return cosClient;
    }
    cosClient = new COS({
      SecretId: get(options, 'tencentcloud.credential.secretId'),
      SecretKey: get(options, 'tencentcloud.credential.secretKey')
    });
    return cosClient;
  };

  const createConference = async (authenticatePayload, { includingMe, name, startTime, duration, isInvitationAllowed, origin, maxCount, options: conferenceOptions, members = [] }) => {
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
      options: conferenceOptions,
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
            }),
            dayjs().add(1, 'month').toDate()
          );
          await member.save();
          return Object.assign({}, member.toJSON());
        })
      )
    });
  };

  const saveConference = async (authenticatePayload, { id, name, duration, isInvitationAllowed, maxCount, options: conferenceOptions }) => {
    const { id: userId } = authenticatePayload;
    const conference = await getConference({ id });
    if (conference.userId !== userId) {
      throw new Error('Data has expired, please refresh the page and try again');
    }
    conference.name = name;
    if (conference.duration > duration) {
      throw new Error('Duration cannot be less than before');
    }
    conference.duration = duration;
    conference.isInvitationAllowed = isInvitationAllowed;
    if (conference.maxCount > maxCount) {
      throw new Error('MaxCount cannot be less than before');
    }
    conference.maxCount = maxCount;
    conference.options = conferenceOptions;
    await conference.save();

    return Object.assign({}, conference.toJSON());
  };

  const deleteConference = async (authenticatePayload, { id }) => {
    const { id: userId } = authenticatePayload;
    const conference = await getConference({ id });
    if (conference.userId !== userId) {
      throw new Error('Data has expired, please refresh the page and try again');
    }
    await conference.destroy();
    return {};
  };

  const getConferenceList = async (authenticatePayload, { perPage, currentPage }) => {
    const { id } = authenticatePayload;
    const count = await models.conference.count({
      where: {
        userId: id
      }
    });
    const rows = await models.conference.findAll({
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
    const { id, conferenceId, fromUser, inviterId, inviter: userInviter } = authenticatePayload;
    const conference = await getConference({ id: conferenceId });
    if (conference.startTime && conference.duration && dayjs().isAfter(dayjs(conference.startTime).add(dayjs.duration(conference.duration, 'minute')))) {
      conference.status = 1;
      await conference.save();
    }

    const member = id && (await getMember({ id }));
    const inviter = fromUser ? userInviter : inviterId && (await getMember({ id: inviterId }));
    return { conference, member, inviter };
  };

  const getConferenceDetailById = async (authenticatePayload, { id }) => {
    const { id: userId } = authenticatePayload;
    const conference = await getConference({ id });
    if (conference.userId !== userId) {
      throw new Error('Data has expired, please refresh the page and try again');
    }
    return conference;
  };

  const getAiTranscriptionContentById = async (authenticatePayload, { id }) => {
    const conference = await getConferenceDetailById(authenticatePayload, { id });
    if (!conference.options?.settings?.speech) {
      return {};
    }
    return await models.aiTranscriptionContent.findOne({
      where: {
        conferenceId: conference.id
      }
    });
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
      dayjs().add(1, 'month').toDate()
    );
    return {
      shorten,
      inviter: member,
      conference
    };
  };

  const inviteMemberFormUser = async (authenticatePayload, { id }) => {
    const conference = await getConference({ id, status: 0 });
    if (conference.userId !== authenticatePayload.id) {
      throw new Error('Only the conference creator can perform this operation');
    }
    const shorten = await fastify[options.shortenName].services.sign(
      JSON.stringify({
        conferenceId: id,
        fromUser: true,
        inviter: {
          fromUser: true,
          nickname: authenticatePayload.nickname || authenticatePayload.email
        }
      }),
      dayjs().add(1, 'month').toDate()
    );
    return {
      shorten,
      inviter: {
        fromUser: true,
        nickname: authenticatePayload.nickname || authenticatePayload.email
      },
      conference
    };
  };

  const getMemberShorten = async (authenticatePayload, { id }) => {
    const { id: userId } = authenticatePayload;
    const member = await getMember({ id });
    const conference = await getConference({ id: member.conferenceId, status: 0 });
    if (conference.userId !== userId) {
      throw new Error('Only the conference creator can perform this operation');
    }

    const shorten = await fastify[options.shortenName].services.sign(
      JSON.stringify({
        id: member.id,
        conferenceId: member.conferenceId,
        isMaster: member.isMaster
      }),
      dayjs().add(1, 'month').toDate()
    );

    member.shorten = shorten;
    await member.save();
    return { shorten };
  };

  const joinConference = async (authenticatePayload, data) => {
    const { inviterId, conferenceId, fromUser } = authenticatePayload;
    if (!fromUser) {
      // fromUser为true说明是会议创建者邀请，否则为主持人邀请
      const member = await getMember({ id: inviterId, conferenceId });

      if (!member.isMaster) {
        throw new Error('Only the master can invite members');
      }
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
      }),
      dayjs().add(1, 'month').toDate()
    );

    newMember.shorten = shorten;
    await newMember.save();

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

    return Object.assign(
      {},
      {
        member,
        conference,
        sign: getUserSig(id, conference.options?.setting)
      }
    );
  };

  const startAITranscription = async authenticatePayload => {
    const { id, conferenceId, isMaster } = authenticatePayload;
    if (!isMaster) {
      throw new Error('Only the master can start the transcription');
    }
    const conference = await getConference({ id: conferenceId, status: 0 });
    if (!conference.options?.setting?.speech) {
      return;
    }
    await getMember({ id, conferenceId });
    const client = getTrtcClient();
    const robotUserSig = getUserSig(`robot_${conference.id}`, conference.options?.setting);

    if (conference.options?.aiTranscription) {
      const { Status } = await client.DescribeAIConversation({
        SdkAppId: robotUserSig.sdkAppId,
        TaskId: conference.options?.aiTranscription?.TaskId
      });
      if (Status !== 'Stopped') {
        return;
      }
    }

    const res = await client.StartAITranscription({
      SdkAppId: robotUserSig.sdkAppId,
      RoomId: conference.id,
      RoomIdType: 1,
      TranscriptionParams: {
        UserId: robotUserSig.userId,
        UserSig: robotUserSig.userSig
      }
    });

    conference.options = Object.assign({}, conference.options, {
      aiTranscription: res
    });

    await conference.save();
  };

  const recordAITranscription = async (authenticatePayload, { messages }) => {
    const { id, conferenceId } = authenticatePayload;
    if (messages.length === 0) {
      return;
    }
    const conference = await getConference({ id: conferenceId, status: 0 });
    if (!conference.options?.setting?.speech) {
      return;
    }
    await getMember({ id, conferenceId });

    const aiTranscriptionContent = await models.aiTranscriptionContent.findOrCreate({
      conferenceId: conference.id
    });
    const newContent = (aiTranscriptionContent.content || []).slice(0);
    newContent.push(...messages);

    aiTranscriptionContent.content = newContent;

    await aiTranscriptionContent.save();
  };

  const stopAITranscription = async authenticatePayload => {
    const { id, conferenceId, isMaster } = authenticatePayload;
    if (!isMaster) {
      throw new Error('Only the master can stop the transcription');
    }
    const conference = await getConference({ id: conferenceId, status: 0 });
    if (!conference.options?.setting?.speech) {
      return;
    }
    await getMember({ id, conferenceId });
    const client = getTrtcClient();
    if (conference.options?.aiTranscription) {
      await client.StopAITranscription({
        TaskId: conference.options?.aiTranscription.TaskId
      });
    }
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
    const client = getTrtcClient();
    const { appId } = getTrtcParams(conference.options?.setting);
    await client.RemoveUserByStrRoomId({
      SdkAppId: appId,
      RoomId: conference.id,
      UserIds: [member.id]
    });
  };

  const endConference = async (authenticatePayload, { id }) => {
    const { conferenceId, isMaster } = authenticatePayload;
    if (conferenceId !== id) {
      throw new Error('The current conference is invalid, possibly because multiple conferences were opened simultaneously. Please refresh the page to get the latest conference information');
    }
    if (!isMaster) {
      throw new Error('Only the master can end the conference');
    }
    const conference = await getConference({ id: conferenceId });

    await stopAITranscription(authenticatePayload);

    conference.status = 1;
    await conference.save();
    const client = getTrtcClient();
    // 调用TRTC服务端API结束会议
    const { appId } = getTrtcParams(conference.options?.setting);
    await client.DismissRoomByStrRoomId({
      SdkAppId: appId,
      RoomId: conferenceId
    });
  };

  const syncRecordFiles = async () => {
    const cosClient = getCosClient();
    try {
      const { Contents } = await cosClient.getBucket({
        Bucket: get(options, 'tencentcloud.cos.bucket'),
        Region: get(options, 'tencentcloud.cos.region')
      });
      await Promise.all(
        Contents.map(async item => {
          const url = cosClient.getObjectUrl({
            Bucket: get(options, 'tencentcloud.cos.bucket'),
            Region: get(options, 'tencentcloud.cos.region'),
            Key: item.Key,
            Sign: true
          });
          const filename = path.basename(url).split('?')[0];
          const filenameWithoutExtension = filename.substring(0, filename.lastIndexOf('.'));
          const [_, SdkAppId, RoomId, UserId, MediaId] = filenameWithoutExtension.match(/^(.+)_(.+)_UserId_s_(.+)_UserId_e_(.+)$/);

          const decode = input => {
            const replaced = input.replace(/-/g, '/').replace(/\./g, '=');
            return Buffer.from(replaced, 'base64').toString('utf8');
          };
          const { id: fileId } = await fastify.fileManager.services.uploadFromUrl({ url });
          const conferenceId = decode(RoomId);
          const memberId = decode(UserId);
          const conference = await getConference({ id: conferenceId });
          if (conference.status === 0 && conference.startTime && conference.duration && dayjs().isAfter(dayjs(conference.startTime).add(dayjs.duration(conference.duration, 'minute')))) {
            conference.status = 1;
            await conference.save();
            await stopAITranscription({ id: memberId, conferenceId: conference.id, isMaster: true });
          }

          if (conference.status === 0) {
            return;
          }

          const target = {
            fileId,
            filename
          };
          const list = get(conference.options, `recordFiles.${memberId}.${MediaId}`) || [];
          list.push(target);
          conference.options = Object.assign({}, conference.options, {
            recordFilesAchieved: true,
            recordFiles: Object.assign({}, get(conference.options, 'recordFiles'), {
              [memberId]: Object.assign({}, get(conference.options, `recordFiles.${memberId}`), {
                [`${MediaId}`]: uniqBy(list, 'fileId')
              })
            })
          });
          await conference.save();
          await cosClient.deleteObject({
            Bucket: get(options, 'tencentcloud.cos.bucket'),
            Region: get(options, 'tencentcloud.cos.region'),
            Key: item.Key
          });
        })
      );
    } catch (e) {
      console.error(e);
    }
  };

  Object.assign(fastify[options.name].services, {
    syncRecordFiles,
    getUserSig,
    createConference,
    saveConference,
    deleteConference,
    getConferenceList,
    getConferenceDetail,
    getConferenceDetailById,
    getAiTranscriptionContentById,
    enterConference,
    saveMember,
    inviteMember,
    inviteMemberFormUser,
    getMemberShorten,
    getConference,
    joinConference,
    removeMember,
    endConference,
    startAITranscription,
    stopAITranscription,
    recordAITranscription
  });
});
