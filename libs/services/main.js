const fp = require('fastify-plugin');
const dayjs = require('dayjs');
const duration = require('dayjs/plugin/duration');
dayjs.extend(duration);

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  const trtc = fastify[options.trtcName].services;

  const isConferenceExpired = conference => {
    return conference.status === 0 && conference.startTime && conference.duration && dayjs().isAfter(dayjs(conference.startTime).add(dayjs.duration(conference.duration, 'second')));
  };

  const stopConferenceAITranscription = async conference => {
    if (!conference.options?.setting?.speech) {
      return;
    }
    try {
      if (conference.options?.aiTranscription?.id) {
        await trtc.stopAITranscription({
          id: conference.options.aiTranscription.id,
          roomId: conference.id,
          options: conference.options?.setting
        });
      }
    } catch (e) {
      console.error('Failed to stop AI transcription:', e);
    }
  };

  const finishConference = async conference => {
    // 调用TRTC服务端API结束会议
    await trtc.dismiss({
      roomId: conference.id,
      options: conference.options?.setting
    });
    // 会议结束后如果开启了会议录像，添加一个获取录像的task
    if (conference.options?.setting?.record && conference.options?.recordTaskId) {
      // 停止录像任务
      try {
        await trtc.stopRecord({
          id: conference.options.recordTaskId,
          roomId: conference.id,
          options: conference.options?.setting
        });
      } catch (e) {
        console.error('Failed to stop record:', e);
      }
      await fastify.task.services.create({
        userId: conference.userId,
        type: 'record-video',
        targetId: conference.id,
        targetType: 'conference',
        runnerType: 'system',
        input: {
          conferenceId: conference.id,
          roomId: conference.id,
          recordTaskId: conference.options.recordTaskId
        },
        delay: 300
      });
    }
    conference.status = 1;
    await conference.save();
  };

  const forceEndConference = async conference => {
    await stopConferenceAITranscription(conference);
    await finishConference(conference);
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
        nickname: item.nickname || item.name,
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
    conference.options = Object.assign({}, conference.options, conferenceOptions);
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

    for (const conference of rows.filter(conference => isConferenceExpired(conference))) {
      try {
        await forceEndConference(conference);
      } catch (error) {
        console.error('Failed to force end expired conference:', error);
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

    if (status === 0 && conference.status === 2) {
      throw new Error('Conference has been canceled');
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
    if (isConferenceExpired(conference)) {
      await forceEndConference(conference);
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
    if (!conference.options?.setting?.speech) {
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
    if (Object.hasOwn(data, 'name') && !Object.hasOwn(data, 'nickname')) {
      data.nickname = data.name;
    }
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

  const inviteMemberFromUser = async (authenticatePayload, { id }) => {
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
    if (isConferenceExpired(conference)) {
      throw new Error('The conference has ended');
    }

    if (conference.maxCount && conference.members.length >= conference.maxCount) {
      throw new Error('The conference is full');
    }

    const newMember = await models.member.create({
      email: data.email,
      nickname: data.nickname || data.name,
      avatar: data.avatar,
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
      throw new Error('The conference has not yet started');
    }

    if (isConferenceExpired(conference)) {
      throw new Error('The conference has ended');
    }

    // 注册到TRTC房间并获取用户签名
    const joinResult = await trtc.join({
      roomId: conference.id,
      userId: id,
      options: conference.options?.setting
    });
    const sign = joinResult.userSig || joinResult;

    // 如果当前会议需要录像，开始录像
    if (authenticatePayload.isMaster && conference.options?.setting?.record && !conference.options?.recordTaskId) {
      const recordTask = await trtc.startRecord({
        roomId: conference.id,
        roomIdType: 1,
        options: conference.options?.setting
      });
      conference.options = Object.assign({}, conference.options, {
        recordTaskId: recordTask.id
      });
      await conference.save();
    }

    return Object.assign(
      {},
      {
        member,
        conference,
        sign
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

    const existingTaskId = conference.options?.aiTranscription?.id;
    const task = await trtc.startAITranscription({
      roomId: conference.id,
      language: conference.options?.setting?.language || options?.language,
      hotWordList: conference.options?.setting?.hotWordList || options?.hotWordList,
      taskId: existingTaskId,
      options: conference.options?.setting
    });

    conference.options = Object.assign({}, conference.options, {
      aiTranscription: task.toJSON ? task.toJSON() : task
    });

    await conference.save();
  };

  const recordAITranscription = async (authenticatePayload, { records, messages } = {}) => {
    const { id, conferenceId } = authenticatePayload;
    const currentRecords = records || (messages || []).flatMap(message => message.records || []);
    if (currentRecords.length === 0) {
      return;
    }
    const conference = await getConference({ id: conferenceId, status: 0 });
    if (!conference.options?.setting?.speech) {
      return;
    }
    await getMember({ id, conferenceId });

    let aiTranscriptionContent = await models.aiTranscriptionContent.findOne({
      where: {
        conferenceId: conference.id
      }
    });
    if (!aiTranscriptionContent) {
      aiTranscriptionContent = await models.aiTranscriptionContent.create({
        conferenceId: conference.id,
        content: []
      });
    }

    const newContent = (aiTranscriptionContent.content || []).slice(0);
    newContent.push(...currentRecords);

    aiTranscriptionContent.content = newContent;

    await aiTranscriptionContent.save();
  };

  const stopAITranscription = async authenticatePayload => {
    const { id, conferenceId, isMaster } = authenticatePayload;
    if (!isMaster) {
      throw new Error('Only the master can stop the transcription');
    }
    const conference = await getConference({ id: conferenceId });
    if (!conference.options?.setting?.speech) {
      return;
    }
    await getMember({ id, conferenceId });
    await stopConferenceAITranscription(conference);
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
    await trtc.removeMember({
      userId: member.id,
      roomId: conference.id,
      options: conference.options?.setting
    });
  };

  const endConference = async (authenticatePayload, { id }) => {
    const { conferenceId, isMaster } = authenticatePayload;
    if (id && String(conferenceId) !== String(id)) {
      throw new Error('The current conference is invalid, possibly because multiple conferences were opened simultaneously. Please refresh the page to get the latest conference information');
    }
    if (!isMaster) {
      throw new Error('Only the master can end the conference');
    }
    const conference = await getConference({ id: conferenceId, status: 0 });

    if (conference.options?.setting?.speech) {
      await getMember({ id: authenticatePayload.id, conferenceId });
    }
    await forceEndConference(conference);
  };

  const forceEndExpiredConferences = async () => {
    const rows = await models.conference.findAll({
      where: {
        status: 0
      },
      include: models.member
    });
    const expiredConferences = rows.filter(conference => isConferenceExpired(conference));
    const results = [];
    for (const conference of expiredConferences) {
      try {
        await forceEndConference(conference);
        results.push({ id: conference.id, success: true });
      } catch (error) {
        console.error('Failed to force end expired conference:', error);
        results.push({ id: conference.id, success: false, error });
      }
    }
    return results;
  };

  const cancelConference = async (authenticatePayload, { id }) => {
    const { conferenceId, isMaster } = authenticatePayload;
    const conference = await getConference({ id: conferenceId || id, status: 0 });
    if (conferenceId) {
      if (id && String(conferenceId) !== String(id)) {
        throw new Error('The current conference is invalid, possibly because multiple conferences were opened simultaneously. Please refresh the page to get the latest conference information');
      }
      if (!isMaster) {
        throw new Error('Only the master can cancel the conference');
      }
    } else if (conference.userId !== authenticatePayload.id) {
      throw new Error('Only the conference creator can perform this operation');
    }
    if (conference.startTime && dayjs().isAfter(dayjs(conference.startTime))) {
      throw new Error('The conference has already started and cannot be canceled');
    }
    conference.status = 2;
    await conference.save();
  };

  const saveRecordVideo = async ({ conferenceId, roomId, results }) => {
    const conference = await models.conference.findByPk(conferenceId);
    if (!conference) {
      throw new Error('Conference does not exist');
    }

    const recordFiles = {};
    await Promise.all(
      results.map(async fileId => {
        const file = await fastify.fileManager.services.getFileInfo({
          id: fileId
        });

        const filename = file.filename;
        const filenameWithoutExtension = filename.substring(0, filename.lastIndexOf('.'));
        const decode = input => {
          const replaced = input.replace(/-/g, '/').replace(/\./g, '=');
          return Buffer.from(replaced, 'base64').toString('utf8');
        };

        const match = filenameWithoutExtension.match(/^(.+)_(.+)_UserId_s_(.+)_UserId_e_(.+)$/);

        if (!recordFiles['all']) {
          recordFiles['all'] = [];
        }
        recordFiles['all'].push({ fileId, filename });
        if (!match) {
          return;
        }
        const [, , RoomId, UserId, MediaId] = match;
        const decodedRoomId = decode(RoomId);
        const memberId = decode(UserId);
        if (decodedRoomId !== String(roomId)) {
          return;
        }
        if (!recordFiles[memberId]) {
          recordFiles[memberId] = [];
        }
        recordFiles[memberId].push({ fileId, filename });
      })
    );

    conference.options = Object.assign({}, conference.options, {
      recordFilesAchieved: true,
      recordFiles
    });

    await conference.save();
  };

  Object.assign(fastify[options.name].services, {
    saveRecordVideo,
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
    inviteMemberFromUser,
    getMemberShorten,
    getConference,
    joinConference,
    removeMember,
    endConference,
    forceEndExpiredConferences,
    cancelConference,
    startAITranscription,
    stopAITranscription,
    recordAITranscription
  });
});
