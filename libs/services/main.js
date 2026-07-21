const fp = require('fastify-plugin');
const dayjs = require('dayjs');
const duration = require('dayjs/plugin/duration');
const { Op } = require('sequelize');
dayjs.extend(duration);

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  const trtc = fastify.trtc.services;

  const isConferenceEndTimePassed = conference => {
    return conference.startTime && conference.duration && dayjs().isAfter(dayjs(conference.startTime).add(dayjs.duration(conference.duration, 'second')));
  };

  const isConferenceExpired = conference => {
    return conference.status === 0 && isConferenceEndTimePassed(conference);
  };

  const assertConferenceEndTimeValid = ({ startTime, duration }) => {
    if (startTime && duration && !dayjs().isBefore(dayjs(startTime).add(dayjs.duration(duration, 'second')))) {
      throw new Error('Conference end time must be in the future');
    }
  };

  const getRecordParams = record => {
    if (record === 'audio') {
      return { StreamType: 1 };
    }
    if (record === 'video' || record === true) {
      return { StreamType: 0 };
    }
    return {};
  };

  const getConferenceForMember = (conference, isMaster) => {
    const currentConference = conference.toJSON ? conference.toJSON() : conference;
    if (isMaster || currentConference.options?.documentVisibleAll) {
      return currentConference;
    }
    return Object.assign({}, currentConference, {
      options: Object.assign({}, currentConference.options, {
        document: []
      })
    });
  };

  const importExternalFile = async file => {
    if (!(file?.url && /^https?:\/\//.test(file.url) && fastify.fileManager?.services?.uploadFromUrl)) {
      return {
        id: file?.id,
        filename: file?.filename || file?.name
      };
    }
    const uploadResult = await fastify.fileManager.services.uploadFromUrl({
      url: file.url,
      filename: file.filename || file.name
    });
    const id = uploadResult?.id || uploadResult?.fileId || uploadResult;
    return {
      id,
      filename: uploadResult?.filename || file.filename || file.name
    };
  };

  const importConferenceOptionsFiles = async conferenceOptions => {
    if (!conferenceOptions?.document) {
      return conferenceOptions;
    }
    return Object.assign({}, conferenceOptions, {
      document: await Promise.all(conferenceOptions.document.map(importExternalFile))
    });
  };

  const importMemberAvatar = async member => {
    if (!member?.avatar) {
      return member;
    }
    const file = await importExternalFile({
      url: member.avatar,
      filename: `${member.nickname || member.name || member.email || 'member'}_avatar`
    });
    return Object.assign({}, member, {
      avatar: file.id || member.avatar
    });
  };

  const isRoomNotExistError = error => {
    const errorText = [error?.message, error?.code, error?.name, typeof error?.toString === 'function' ? error.toString() : String(error)].filter(Boolean).join(' ');
    return /room\s+not\s+exist/i.test(errorText) || /room.*not.*exist/i.test(errorText);
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

  const markConferenceFinished = async (conference, status = 1) => {
    if (conference.status === status) {
      return;
    }
    conference.status = status;
    await conference.save();
  };

  const finishConference = async (conference, status = 1) => {
    // 调用TRTC服务端API结束会议
    try {
      await trtc.dismiss({
        roomId: conference.id,
        options: conference.options?.setting
      });
    } catch (e) {
      if (!isRoomNotExistError(e)) {
        throw e;
      }
      console.warn(`TRTC room already absent while finishing conference: ${conference.id}`);
    }
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
        targetName: conference.name,
        runnerType: 'system',
        input: {
          conferenceId: conference.id,
          roomId: conference.id,
          recordTaskId: conference.options.recordTaskId
        },
        delay: 300
      });
    }
    await markConferenceFinished(conference, status);
  };

  const forceEndConference = async (conference, status = 1) => {
    await stopConferenceAITranscription(conference);
    await finishConference(conference, status);
  };

  const forceEndExpiredConference = async conference => {
    try {
      await forceEndConference(conference);
      return { success: true };
    } catch (error) {
      console.error('Failed to force end expired conference:', error);
      await markConferenceFinished(conference);
      return { success: false, error };
    }
  };

  const forceEndExpiredConferencesForRows = async conferences => {
    for (const conference of conferences.filter(conference => isConferenceExpired(conference))) {
      await forceEndExpiredConference(conference);
    }
  };

  const createConference = async (authenticatePayload, { includingMe, name, startTime, duration, isInvitationAllowed, origin, maxCount, options: conferenceOptions, members = [] }) => {
    const { id, nickname, email, avatar } = authenticatePayload;
    if (!includingMe && !(members && members.find(item => item.isMaster))) {
      throw new Error('At least one master is needed');
    }
    if (maxCount && members.length + (includingMe ? 1 : 0) > maxCount) {
      throw new Error('Members exceed the limit');
    }
    assertConferenceEndTimeValid({ startTime, duration });

    const localConferenceOptions = await importConferenceOptionsFiles(conferenceOptions);

    const conference = await models.conference.create({
      name,
      startTime,
      duration,
      isInvitationAllowed,
      origin,
      maxCount,
      options: localConferenceOptions,
      userId: id
    });

    const currentMembers = await Promise.all(
      members.map(async item =>
        Object.assign({}, await importMemberAvatar(item), {
          nickname: item.nickname || item.name,
          conferenceId: conference.id
        })
      )
    );
    if (includingMe) {
      currentMembers.push(
        await importMemberAvatar({
          avatar,
          email,
          nickname,
          conferenceId: conference.id,
          isMaster: true
        })
      );
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

  const buildConferenceListWhere = (userId, { keyword, date, record, speech } = {}) => {
    const where = { userId };
    const trimmedKeyword = typeof keyword === 'string' ? keyword.trim() : '';
    if (trimmedKeyword) {
      where.name = { [Op.like]: `%${trimmedKeyword}%` };
    }
    if (date) {
      const day = dayjs(date);
      if (day.isValid()) {
        where.startTime = {
          [Op.gte]: day.startOf('day').toDate(),
          [Op.lt]: day.add(1, 'day').startOf('day').toDate()
        };
      }
    }
    if (record === 'audio' || record === 'video') {
      where['options.setting.record'] = record;
    }
    if (typeof speech === 'boolean') {
      where['options.setting.speech'] = speech;
    }
    return where;
  };

  const getConferenceList = async (authenticatePayload, { perPage, currentPage, keyword, date, record, speech }) => {
    const { id } = authenticatePayload;
    const listWhere = buildConferenceListWhere(id, { keyword, date, record, speech });
    const activeRows = await models.conference.findAll({
      where: {
        userId: id,
        status: 0
      }
    });
    await forceEndExpiredConferencesForRows(activeRows);

    const count = await models.conference.count({
      where: listWhere
    });
    const rows = await models.conference.findAll({
      where: listWhere,
      include: models.member,
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [['startTime', 'DESC']]
    });

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

    if (isConferenceExpired(conference)) {
      await forceEndExpiredConference(conference);
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
    // findByPk 会覆盖 options.where，带 conferenceId 时必须用 findOne
    const member = conferenceId
      ? await models.member.findOne({ where: { id: memberId, conferenceId } })
      : await models.member.findByPk(memberId);
    if (!member) {
      throw new Error('Member not found');
    }
    return member;
  };

  const isConferenceMasterUser = (conference, authenticatePayload) => {
    if (!authenticatePayload) {
      return false;
    }
    if (String(conference.userId) === String(authenticatePayload.id)) {
      return true;
    }
    const payloadEmail = authenticatePayload.email && String(authenticatePayload.email).toLowerCase();
    return (conference.members || []).some(member => {
      if (!member?.isMaster) {
        return false;
      }
      // 兼容历史调用：payload.id 直接传成员 id
      if (String(member.id) === String(authenticatePayload.id)) {
        return true;
      }
      // userAuthenticate 场景：用账号邮箱匹配主持人成员
      return !!(payloadEmail && member.email && String(member.email).toLowerCase() === payloadEmail);
    });
  };

  const decodeShortenPayload = async shorten => {
    if (!shorten) {
      throw new Error('Invitation code is required');
    }
    const payload = await fastify[options.shortenName].services.decode(shorten);
    return typeof payload === 'string' ? JSON.parse(payload) : payload;
  };

  const getConferenceDetail = async authenticatePayload => {
    const { id, conferenceId, fromUser, inviterId, inviter: userInviter } = authenticatePayload;
    const conference = await getConference({ id: conferenceId });

    const member = id && (await getMember({ id }));
    const inviter = fromUser ? userInviter : inviterId && (await getMember({ id: inviterId }));
    return { conference: getConferenceForMember(conference, authenticatePayload.isMaster), member, inviter };
  };

  const getConferenceDetailByShorten = async shorten => {
    return getConferenceDetail(await decodeShortenPayload(shorten));
  };

  const mapRecordFileItem = item => ({
    fileId: item.fileId || item.id,
    filename: item.filename || item.name,
    url: item.url
  });

  const buildConferenceRecordings = conference => {
    const recordFiles = conference.options?.recordFiles;
    if (!recordFiles || typeof recordFiles !== 'object') {
      return null;
    }
    if (Array.isArray(recordFiles.all) && recordFiles.all.length > 0) {
      return recordFiles.all.map(mapRecordFileItem);
    }
    const flat = Object.entries(recordFiles)
      .filter(([key]) => key !== 'all')
      .flatMap(([, files]) => (Array.isArray(files) ? files : []));
    return flat.length > 0 ? flat.map(mapRecordFileItem) : null;
  };

  const buildTranscriptionText = (contentRecords, rounds) => {
    const parts = [];
    if (Array.isArray(contentRecords)) {
      contentRecords.forEach(record => {
        const text = typeof record === 'string' ? record : record?.text || record?.content;
        if (text) {
          parts.push(String(text).trim());
        }
      });
    }
    if (Array.isArray(rounds)) {
      rounds.forEach(round => {
        if (round?.text) {
          parts.push(String(round.text).trim());
        }
      });
    }
    return parts.filter(Boolean).join('\n') || null;
  };

  const getTrtcTranscriptionRounds = async conference => {
    const aiTranscription = conference.options?.aiTranscription;
    const taskRefId = aiTranscription?.id || aiTranscription?.taskId;
    if (!taskRefId || !fastify.trtc?.models?.task) {
      return [];
    }
    const taskModel = fastify.trtc.models.task;
    const task =
      (await taskModel.findByPk(taskRefId)) ||
      (await taskModel.findOne({
        where: { taskId: String(taskRefId) }
      }));
    return Array.isArray(task?.result?.rounds) ? task.result.rounds : [];
  };

  const getConferenceTranscriptionData = async conference => {
    if (!conference.options?.setting?.speech) {
      return null;
    }
    const aiTranscriptionContent = await models.aiTranscriptionContent.findOne({
      where: {
        conferenceId: conference.id
      }
    });
    const contentRecords = aiTranscriptionContent?.content || [];
    const rounds = await getTrtcTranscriptionRounds(conference);
    if (contentRecords.length === 0 && rounds.length === 0) {
      return null;
    }
    const text = buildTranscriptionText(contentRecords, rounds);
    return Object.assign(
      {},
      contentRecords.length > 0 && { content: contentRecords },
      rounds.length > 0 && { rounds },
      text && { text }
    );
  };

  const attachRecordingUrls = async recordings => {
    if (!(Array.isArray(recordings) && fastify.fileManager?.services?.getFileUrl)) {
      return recordings;
    }
    return Promise.all(
      recordings.map(async item => {
        if (item.url || !item.fileId) {
          return item;
        }
        try {
          const url = await fastify.fileManager.services.getFileUrl({ id: item.fileId });
          return Object.assign({}, item, url ? { url } : {});
        } catch (e) {
          return item;
        }
      })
    );
  };

  const enrichConferenceDetail = async conference => {
    const json = conference.toJSON ? conference.toJSON() : conference;
    const recordings = await attachRecordingUrls(buildConferenceRecordings(json));
    const transcription = await getConferenceTranscriptionData(conference);
    return Object.assign({}, json, recordings && { recordings }, transcription && { transcription });
  };

  const getConferenceDetailById = async (authenticatePayload, { id }) => {
    const { id: userId } = authenticatePayload;
    const conference = await getConference({ id });
    if (conference.userId !== userId) {
      throw new Error('Data has expired, please refresh the page and try again');
    }
    return enrichConferenceDetail(conference);
  };

  const getAiTranscriptionContentById = async (authenticatePayload, { id }) => {
    const conference = await getConference({ id });
    if (conference.userId !== authenticatePayload.id) {
      throw new Error('Data has expired, please refresh the page and try again');
    }
    if (!conference.options?.setting?.speech) {
      return {};
    }
    const transcription = await getConferenceTranscriptionData(conference);
    if (!transcription) {
      return {};
    }
    return transcription;
  };

  const updateConferenceDuration = async (authenticatePayload, { id, duration, extendSeconds }) => {
    await getConferenceDetailById(authenticatePayload, { id });
    const conference = await getConference({ id, status: 0 });
    let nextDuration = duration != null ? Number(duration) : null;
    if (extendSeconds != null) {
      nextDuration = Number(conference.duration || 0) + Number(extendSeconds);
    }
    if (!nextDuration || nextDuration <= 0 || Number.isNaN(nextDuration)) {
      throw new Error('Invalid duration');
    }
    conference.duration = nextDuration;
    await conference.save();
    return enrichConferenceDetail(conference);
  };

  const getConferenceRoomStatusById = async (authenticatePayload, { id }) => {
    const conference = await getConferenceDetailById(authenticatePayload, { id });
    if (!fastify.trtc?.services?.getRoomSnapshot) {
      throw new Error('TRTC room snapshot service is unavailable');
    }
    const snapshot = await fastify.trtc.services.getRoomSnapshot({ roomId: conference.id });
    const memberMap = new Map((conference.members || []).map(item => [String(item.id), item]));
    return Object.assign({}, snapshot, {
      conferenceId: conference.id,
      conferenceName: conference.name,
      conferenceStatus: conference.status,
      startTime: conference.startTime,
      duration: conference.duration,
      members: (snapshot.members || []).map(member =>
        Object.assign({}, member, {
          member: memberMap.get(String(member.userId)) || null
        })
      )
    });
  };

  const extendConferenceDurationByMember = async (authenticatePayload, { extendSeconds = 900 } = {}) => {
    const { id, conferenceId, isMaster } = authenticatePayload;
    if (!isMaster) {
      throw new Error('Only the master can extend the conference');
    }
    const conference = await getConference({ id: conferenceId, status: 0 });
    if (!conference.options?.allowExtend) {
      throw new Error('Conference extension is not allowed');
    }
    await getMember({ id, conferenceId });
    conference.duration = Number(conference.duration || 0) + Number(extendSeconds);
    await conference.save();
    return enrichConferenceDetail(conference);
  };

  const listTrtcInstanceEvents = async (authenticatePayload, conference, { perPage = 200, currentPage = 1 } = {}) => {
    const query = {
      filter: { roomId: conference.id },
      perPage: Number(perPage) || 200,
      currentPage: Number(currentPage) || 1
    };
    let result = await fastify.trtc.services.instanceEvent.list(authenticatePayload, query);
    if ((result.pageData || []).length > 0) {
      return result;
    }
    const instanceCaseModel = fastify.trtc.models?.instanceCase;
    const instanceCase = instanceCaseModel && (await instanceCaseModel.findOne({ where: { roomId: conference.id } }));
    if (instanceCase && fastify.trtc.services.syncRoomUserEvents) {
      await fastify.trtc.services.syncRoomUserEvents({
        instanceCase,
        options: conference.options?.setting
      });
      result = await fastify.trtc.services.instanceEvent.list(authenticatePayload, query);
    }
    return result;
  };

  const getTrtcInstanceEventsById = async (authenticatePayload, { id, perPage = 200, currentPage = 1 }) => {
    const conference = await getConference({ id });
    // 本接口走 userAuthenticate，payload.id 是账号 userId，不是 member 主键；
    // 此前用 getMember({ id: userId }) 会误报 Member not found
    if (!isConferenceMasterUser(conference, authenticatePayload)) {
      throw new Error('Only the conference creator or master can view room events');
    }
    return listTrtcInstanceEvents(authenticatePayload, conference, { perPage, currentPage });
  };

  const getTrtcInstanceEventsForOpenApi = async (authenticatePayload, { id, perPage = 200, currentPage = 1 }) => {
    const conference = await getConference({ id });
    if (conference.userId !== authenticatePayload.id) {
      throw new Error('Data has expired, please refresh the page and try again');
    }
    const result = await listTrtcInstanceEvents(authenticatePayload, conference, { perPage, currentPage });
    return Object.assign({}, result, {
      conferenceId: conference.id,
      conferenceName: conference.name,
      conferenceStatus: conference.status,
      startTime: conference.startTime,
      duration: conference.duration,
      members: conference.members || []
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

    if (!member.attended) {
      member.attended = true;
      await member.save();
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
        roomIdType: 0,
        options: conference.options?.setting,
        recordParams: getRecordParams(conference.options?.setting?.record)
      });
      conference.options = Object.assign({}, conference.options, {
        recordTaskId: recordTask.id
      });
      await conference.save();
    }

    if (authenticatePayload.isMaster && conference.options?.setting?.speech && !conference.options?.aiTranscription?.id) {
      try {
        await startAITranscription(authenticatePayload);
        await conference.reload();
      } catch (error) {
        console.error('Failed to auto-start AI transcription:', error);
      }
    }

    return Object.assign(
      {},
      {
        member,
        conference: getConferenceForMember(conference, authenticatePayload.isMaster),
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

  const recordClientEvents = async (authenticatePayload, { events = [] } = {}) => {
    if (options.enableRestApiQuery) {
      return;
    }
    const { id, conferenceId } = authenticatePayload;
    if (!Array.isArray(events) || events.length === 0) {
      return;
    }
    const conference = await getConference({ id: conferenceId });
    await getMember({ id, conferenceId });
    const instanceCaseModel = fastify.trtc.models?.instanceCase;
    const instanceEventModel = fastify.trtc.models?.instanceEvent;
    if (!instanceCaseModel || !instanceEventModel) {
      return;
    }
    const instanceCase = await instanceCaseModel.findOne({
      where: { roomId: conference.id }
    });
    if (!instanceCase) {
      return;
    }
    const userList = Object.assign({}, instanceCase.userList);
    const stableStringify = value => {
      if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
      }
      if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
      }
      return `{${Object.keys(value)
        .sort()
        .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(',')}}`;
    };
    const getEventKey = ({ eventType, reporterId, userId, time, data }) => {
      return [eventType, reporterId, userId, new Date(time).toISOString(), stableStringify(data || {})].join('|');
    };
    const existingEvents = instanceEventModel.findAll
      ? await instanceEventModel.findAll({
          where: { trtcInstanceCaseId: instanceCase.id }
        })
      : [];
    const eventKeys = new Set(
      existingEvents
        .filter(item => item.payload?.source === 'ClientSDK')
        .map(item =>
          getEventKey({
            eventType: item.payload.eventType,
            reporterId: item.payload.reporterId || item.payload.userId,
            userId: item.payload.userId,
            time: item.time,
            data: item.payload.event?.data
          })
        )
    );
    for (const event of events) {
      const time = event.time ? new Date(event.time) : new Date();
      const reporterId = id;
      const userId = event.userId || id;
      const eventType = event.type || 'client';
      const eventKey = getEventKey({ eventType, reporterId, userId, time, data: event.data });
      if (eventKeys.has(eventKey)) {
        continue;
      }
      eventKeys.add(eventKey);
      if (eventType === 'enter') {
        userList[userId] = Object.assign({}, userList[userId], {
          startTime: time,
          status: 0,
          client: event
        });
        const enterMember = await models.member.findByPk(userId).catch(() => null);
        if (enterMember && !enterMember.attended) {
          enterMember.attended = true;
          await enterMember.save();
        }
      }
      if (eventType === 'exit') {
        userList[userId] = Object.assign({}, userList[userId], {
          exitTime: time,
          status: 1,
          client: event
        });
      }
      await instanceEventModel.create({
        code: `Client.${eventType}`,
        time,
        payload: {
          source: 'ClientSDK',
          roomId: conference.id,
          reporterId,
          userId,
          eventType,
          event
        },
        trtcInstanceCaseId: instanceCase.id
      });
    }
    await instanceCase.update({ userList });
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
      const { success, error } = await forceEndExpiredConference(conference);
      results.push(Object.assign({ id: conference.id, success }, error ? { error } : {}));
    }
    return results;
  };

  const cancelConference = async (authenticatePayload, { id }) => {
    const { conferenceId, isMaster } = authenticatePayload;
    const conference = await getConference({ id: conferenceId || id });
    if (conference.status === 2) {
      throw new Error('Conference has been canceled');
    }
    if (conference.status === 1 && !conference.startTime) {
      throw new Error('Conference has ended');
    }
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
    if (conference.status === 1 && isConferenceEndTimePassed(conference)) {
      return;
    }
    if (conference.status === 0 && conference.startTime && !dayjs().isBefore(dayjs(conference.startTime))) {
      await forceEndConference(conference, 2);
      return;
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
    getConferenceDetailByShorten,
    getConferenceDetailById,
    getAiTranscriptionContentById,
    updateConferenceDuration,
    extendConferenceDurationByMember,
    getConferenceRoomStatusById,
    getTrtcInstanceEventsById,
    getTrtcInstanceEventsForOpenApi,
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
    recordAITranscription,
    recordClientEvents
  });
});
