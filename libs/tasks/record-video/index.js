module.exports = async (fastify, options, { task, polling }) => {
  const { conferenceId, sdkAppId, roomId } = task.input;
  return polling(async () => {
    const result = await fastify.trtcConference.services.getConferenceRecordVideo({ conferenceId, sdkAppId, roomId });
    if (result && result.length > 0) {
      return { result: 'success', data: { result, conferenceId, roomId } };
    }
    // 无结果，继续轮询
    return {};
  });
};
